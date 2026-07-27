import { APP_CONFIG } from "./config.js";
import {
  csvEscape,
  fetchArrayBufferWithProgress,
  fetchGzipJson,
  fetchJson,
  gunzipArrayBuffer,
  objectsToCsv,
  parseDelimitedRows
} from "./utils.js";

export async function loadDatasetsCatalog() {
  return await fetchJson(APP_CONFIG.datasetCatalogUrl);
}

export async function loadDatasetBundle(dataset, onProgress = null, options = {}) {
  if (isDirectMatrixDataset(dataset)) {
    return await loadDirectMatrixBundle(dataset, onProgress, options);
  }

  emitProgress(onProgress, "Loading sample metadata", {
    stage: "Loading sample metadata",
    mode: "indeterminate"
  }, options);
  const samples = await fetchJson(dataset.sampleMetadataUrl, { signal: options.signal });

  emitProgress(onProgress, "Loading generated-data manifest", {
    stage: "Loading dataset configuration",
    mode: "indeterminate"
  }, options);
  const manifest = await fetchJson(
    dataset.manifestUrl || dataset.sampleMetadataUrl.replace(/samples\.json$/, "manifest.json"),
    { signal: options.signal }
  );

  emitProgress(onProgress, "Loading gene order", {
    stage: "Loading gene information",
    mode: "indeterminate"
  }, options);
  const genesPayload = await fetchGzipJson(dataset.geneListUrl, { signal: options.signal });
  const genes = Array.isArray(genesPayload) ? genesPayload : genesPayload.genes;

  emitProgress(onProgress, "Validating dataset", {
    stage: "Validating dataset",
    mode: "indeterminate"
  }, options);
  if (!Array.isArray(genes) || genes.length === 0) {
    throw new Error("Generated gene list is empty or invalid.");
  }

  if (manifest.geneOrderId && genesPayload.geneOrderId && manifest.geneOrderId !== genesPayload.geneOrderId) {
    throw new Error("Gene order mismatch between manifest and genes.json.gz.");
  }

  emitProgress(onProgress, "Finalizing dataset", {
    stage: "Finalizing dataset",
    mode: "indeterminate"
  }, options);
  return {
    dataset,
    manifest,
    samples,
    genes,
    geneOrderId: manifest.geneOrderId || genesPayload.geneOrderId || null
  };
}

function isDirectMatrixDataset(dataset) {
  return dataset.format === "gexa_matrix_csv" ||
    dataset.format === "gexa_matrix_tsv" ||
    dataset.format === "direct_matrix";
}

function resolveDatasetFileUrl(dataset, urlKey, fileKey) {
  if (dataset[urlKey]) {
    return dataset[urlKey];
  }

  if (!dataset[fileKey]) {
    return null;
  }

  const baseUrl = dataset.dataBaseUrl ||
    APP_CONFIG.externalDataBaseUrl ||
    "/RNADB/Download/files/";

  return new URL(dataset[fileKey], new URL(baseUrl, window.location.href)).href;
}

function gzipFallbackUrl(url) {
  const value = String(url || "");
  return /\.gz(?:[?#]|$)/i.test(value)
    ? value.replace(/\.gz(?=([?#]|$))/i, "")
    : null;
}

function missingResponse(response) {
  return response.status === 404 || response.status === 410;
}

function fallbackUrlKey(urlKey) {
  return urlKey.replace(/Url$/, "FallbackUrl");
}

function normalizeDirectDataset(dataset) {
  if (!isDirectMatrixDataset(dataset)) {
    return dataset;
  }

  const countUrl = resolveDatasetFileUrl(dataset, "countUrl", "countFile");
  const tpmUrl = resolveDatasetFileUrl(dataset, "tpmUrl", "tpmFile");
  const annotationUrl = resolveDatasetFileUrl(dataset, "annotationUrl", "annotationFile");
  const geneLengthUrl = resolveDatasetFileUrl(dataset, "geneLengthUrl", "geneLengthFile");

  const normalized = {
    ...dataset,
    countUrl,
    tpmUrl,
    annotationUrl,
    geneLengthUrl,
    countFallbackUrl: dataset.countFallbackUrl || gzipFallbackUrl(countUrl),
    tpmFallbackUrl: dataset.tpmFallbackUrl || gzipFallbackUrl(tpmUrl),
    geneLengthFallbackUrl: dataset.geneLengthFallbackUrl || gzipFallbackUrl(geneLengthUrl)
  };

  if (!normalized.countUrl) {
    throw new Error("Direct matrix datasets require countUrl or countFile in config/datasets.json.");
  }

  return normalized;
}

function detectConfiguredDelimiter(dataset, url) {
  const cleanUrl = String(url || "").split(/[?#]/, 1)[0];

  if (dataset.delimiter === "tab" || dataset.delimiter === "tsv") {
    return "\t";
  }

  if (dataset.delimiter === "comma" || dataset.delimiter === "csv") {
    return ",";
  }

  if (/\.(tsv|txt)(\.gz)?$/i.test(cleanUrl)) {
    return "\t";
  }

  if (/\.csv(\.gz)?$/i.test(cleanUrl)) {
    return ",";
  }

  return null;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function yieldToBrowser() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function abortError() {
  try {
    return new DOMException("Dataset load aborted", "AbortError");
  } catch {
    const error = new Error("Dataset load aborted");
    error.name = "AbortError";
    return error;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : abortError();
  }
}

function emitProgress(onProgress, message, event = {}, options = {}) {
  if (!onProgress) {
    return;
  }

  if (options.structuredProgress) {
    onProgress({
      message,
      stage: event.stage || message,
      mode: event.mode,
      loadedBytes: event.loadedBytes,
      totalBytes: event.totalBytes,
      percent: event.percent
    });
    return;
  }

  onProgress(message);
}

function emitDownloadProgress(onProgress, label, progress, options = {}) {
  const loaded = Number(progress.loadedBytes ?? progress.loaded);
  const total = Number(progress.totalBytes ?? progress.total);

  if (options.structuredProgress) {
    emitProgress(onProgress, label, {
      stage: "Downloading dataset files",
      mode: progress.mode,
      loadedBytes: Number.isFinite(loaded) ? loaded : null,
      totalBytes: Number.isFinite(total) && total > 0 ? total : null,
      percent: progress.percent
    }, options);
    return;
  }

  if (Number.isFinite(total) && total > 0) {
    const percent = Math.round(Math.min(100, Math.max(0, loaded / total * 100)));
    onProgress?.(`${label}: ${percent}% (${formatBytes(loaded)} / ${formatBytes(total)})`);
  } else if (Number.isFinite(loaded)) {
    onProgress?.(`${label}: ${formatBytes(loaded)} loaded`);
  } else {
    onProgress?.(label);
  }
}

async function fetchMaybeCompressedText(url, onProgress = null, label = "File", options = {}) {
  throwIfAborted(options.signal);
  const buffer = await fetchArrayBufferWithProgress(
    url,
    (progress) => emitDownloadProgress(onProgress, label, progress, options),
    {
      cache: "force-cache",
      signal: options.signal,
      progressMessage: label,
      progressStage: "Downloading dataset files"
    }
  );

  emitProgress(onProgress, `${label}: decoding`, {
    stage: "Decompressing data",
    mode: "indeterminate"
  }, options);
  await yieldToBrowser();
  throwIfAborted(options.signal);
  const raw = await gunzipArrayBuffer(buffer);
  return new TextDecoder("utf-8").decode(raw);
}

async function fetchResponseWithDatasetFallback(dataset, urlKey, label, options = {}) {
  throwIfAborted(options.signal);
  const primaryUrl = dataset[urlKey];
  const fallbackKey = fallbackUrlKey(urlKey);
  const fallbackUrl = dataset[fallbackKey];
  let response = await fetch(primaryUrl, { cache: "force-cache", signal: options.signal });

  if (!response.ok && fallbackUrl && missingResponse(response)) {
    const fallbackResponse = await fetch(fallbackUrl, { cache: "force-cache", signal: options.signal });
    if (fallbackResponse.ok) {
      dataset[urlKey] = fallbackUrl;
      dataset[fallbackKey] = null;
      return {
        response: fallbackResponse,
        url: fallbackUrl,
        usedFallback: true
      };
    }
    return {
      response: fallbackResponse,
      url: fallbackUrl,
      usedFallback: true
    };
  }

  return {
    response,
    url: primaryUrl,
    usedFallback: false
  };
}

async function fetchMaybeCompressedTextWithDatasetFallback(dataset, urlKey, onProgress = null, label = "File", options = {}) {
  const primaryUrl = dataset[urlKey];
  const fallbackKey = fallbackUrlKey(urlKey);
  const fallbackUrl = dataset[fallbackKey];

  try {
    return await fetchMaybeCompressedText(primaryUrl, onProgress, label, options);
  } catch (error) {
    if (!fallbackUrl || !/HTTP (404|410)\b/.test(error.message)) {
      throw error;
    }

    const text = await fetchMaybeCompressedText(fallbackUrl, onProgress, label, options);
    dataset[urlKey] = fallbackUrl;
    dataset[fallbackKey] = null;
    return text;
  }
}

async function fetchJsonMaybeCompressed(url, onProgress = null, label = "JSON", options = {}) {
  const text = await fetchMaybeCompressedText(url, onProgress, label, options);
  emitProgress(onProgress, `Parsing ${label}`, {
    stage: /sample/i.test(label) ? "Now loading datasets..." : "Validating dataset",
    mode: "indeterminate"
  }, options);
  return JSON.parse(text);
}

function normalizeHeaderNames(headers, fallbackPrefix) {
  const used = new Map();

  return headers.map((header, index) => {
    const base = String(header || `${fallbackPrefix}_${index + 1}`).trim() || `${fallbackPrefix}_${index + 1}`;
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function findColumnIndex(headers, requestedName, fallbackNames) {
  if (requestedName) {
    const index = headers.findIndex((header) => header === requestedName);
    if (index >= 0) {
      return index;
    }

    const lower = String(requestedName).toLowerCase();
    const caseInsensitive = headers.findIndex((header) => String(header).toLowerCase() === lower);
    if (caseInsensitive >= 0) {
      return caseInsensitive;
    }
  }

  for (const name of fallbackNames) {
    const index = headers.findIndex((header) => String(header).toLowerCase() === name.toLowerCase());
    if (index >= 0) {
      return index;
    }
  }

  return -1;
}

function ensureUnique(values, label) {
  const seen = new Set();

  for (const value of values) {
    if (!value) {
      throw new Error(`${label} contains an empty value.`);
    }

    if (seen.has(value)) {
      throw new Error(`${label} contains a duplicate value: ${value}`);
    }

    seen.add(value);
  }
}

function assertRowWidth(row, expectedWidth, rowNumber, label) {
  if (row.length !== expectedWidth) {
    throw new Error(`${label} row ${rowNumber} has ${row.length} columns; expected ${expectedWidth}.`);
  }
}

function parseCountValue(value, sampleId, geneId) {
  const text = String(value ?? "").trim();

  if (text === "") {
    throw new Error(`Missing count for sample ${sampleId}, gene ${geneId}.`);
  }

  const number = Number(text);

  if (!Number.isFinite(number)) {
    throw new Error(`Invalid count for sample ${sampleId}, gene ${geneId}: ${text}`);
  }

  if (number < 0) {
    throw new Error(`Negative count for sample ${sampleId}, gene ${geneId}: ${text}`);
  }

  if (!Number.isInteger(number)) {
    throw new Error(`Non-integer count for sample ${sampleId}, gene ${geneId}: ${text}`);
  }

  if (number > 2147483647) {
    throw new Error(`Count exceeds R integer range for sample ${sampleId}, gene ${geneId}: ${text}`);
  }

  return number;
}

function parseTpmValue(value) {
  const text = String(value ?? "").trim();

  if (text === "" || text.toUpperCase() === "NA") {
    return Number.NaN;
  }

  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : Number.NaN;
}

function assertGeneOrder(actualGenes, expectedGenes, label) {
  if (actualGenes.length !== expectedGenes.length) {
    throw new Error(`${label} gene count mismatch: ${actualGenes.length} vs ${expectedGenes.length}.`);
  }

  for (let index = 0; index < expectedGenes.length; index += 1) {
    if (actualGenes[index] !== expectedGenes[index]) {
      throw new Error(`${label} gene order mismatch at position ${index + 1}: ${actualGenes[index]} vs ${expectedGenes[index]}.`);
    }
  }
}

function parseGeneLengths(text, expectedGenes, dataset) {
  const delimiter = detectConfiguredDelimiter({
    delimiter: dataset.geneLengthDelimiter || dataset.delimiter
  }, dataset.geneLengthUrl) || "\t";
  const { rows } = parseDelimitedRows(text, delimiter);

  if (rows.length < 2) {
    throw new Error("Gene-length table must contain a header and at least one gene row.");
  }

  const headers = rows[0].map((header) => String(header || "").trim());
  const geneIndex = findColumnIndex(headers, dataset.geneLengthGeneColumn, [
    "Geneid",
    "GeneID",
    "gene_id",
    "gene",
    "Gene"
  ]);
  const lengthIndex = findColumnIndex(headers, dataset.geneLengthValueColumn, [
    "Length",
    "length",
    "gene_length",
    "GeneLength"
  ]);

  if (geneIndex < 0 || lengthIndex < 0) {
    throw new Error("Gene-length table must include Geneid and Length columns.");
  }

  const byGene = new Map();
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row.some((value) => value !== "")) {
      continue;
    }

    if (row.length <= Math.max(geneIndex, lengthIndex)) {
      throw new Error(`Gene-length row ${rowIndex + 1} is missing required columns.`);
    }

    const geneId = String(row[geneIndex] || "").trim();
    const textValue = String(row[lengthIndex] ?? "").trim();
    const length = Number(textValue);

    if (!geneId) {
      throw new Error(`Gene-length row ${rowIndex + 1} has an empty Geneid.`);
    }

    if (byGene.has(geneId)) {
      throw new Error(`Gene-length table contains a duplicate gene: ${geneId}.`);
    }

    if (!Number.isFinite(length) || length <= 0) {
      throw new Error(`Invalid gene length for ${geneId}: ${textValue || "empty"}.`);
    }

    byGene.set(geneId, length);
  }

  const geneLengths = new Float64Array(expectedGenes.length);
  const missing = [];
  for (let index = 0; index < expectedGenes.length; index += 1) {
    const geneId = expectedGenes[index];
    const length = byGene.get(geneId);

    if (!Number.isFinite(length) || length <= 0) {
      if (missing.length < 10) {
        missing.push(geneId);
      }
      continue;
    }

    geneLengths[index] = length;
  }

  if (missing.length > 0) {
    throw new Error(`Gene-length table is missing length values for selected gene order, including: ${missing.join(", ")}.`);
  }

  return geneLengths;
}

async function loadGeneLengths(bundle, onProgress) {
  if (!bundle.dataset.geneLengthUrl) {
    throw new Error("No gene-length URL is configured for this dataset.");
  }

  if (bundle.directMatrix?.geneLengths) {
    return bundle.directMatrix.geneLengths;
  }

  onProgress?.("Getting TPM data");
  const text = await fetchMaybeCompressedTextWithDatasetFallback(
    bundle.dataset,
    "geneLengthUrl",
    onProgress,
    "Getting TPM data"
  );
  const geneLengths = parseGeneLengths(text, bundle.genes, bundle.dataset);

  if (bundle.directMatrix) {
    bundle.directMatrix.geneLengths = geneLengths;
  }

  return geneLengths;
}

function calculateTpmVectorFromCounts(countVector, geneLengths, genes, sampleId) {
  if (!countVector || countVector.length !== geneLengths.length) {
    throw new Error(`Count vector length mismatch for ${sampleId}: ${countVector?.length ?? 0} vs ${geneLengths.length}.`);
  }

  let denominator = 0;
  for (let geneIndex = 0; geneIndex < geneLengths.length; geneIndex += 1) {
    const length = geneLengths[geneIndex];
    if (!Number.isFinite(length) || length <= 0) {
      throw new Error(`Invalid gene length for ${genes[geneIndex]}: ${length}.`);
    }
    denominator += countVector[geneIndex] / length;
  }

  const vector = new Float32Array(geneLengths.length);
  if (denominator <= 0) {
    return vector;
  }

  const scale = 1000000 / denominator;
  for (let geneIndex = 0; geneIndex < geneLengths.length; geneIndex += 1) {
    vector[geneIndex] = (countVector[geneIndex] / geneLengths[geneIndex]) * scale;
  }

  return vector;
}

async function calculateSelectedTpmVectorsFromGeneLengths(bundle, samples, onProgress, countVectorsBySample = null) {
  const geneLengths = await loadGeneLengths(bundle, onProgress);
  const ownCountVectors = !countVectorsBySample;
  const countVectors = countVectorsBySample || await loadSelectedCountVectors(bundle, samples, onProgress);
  const vectorsBySample = new Map();

  try {
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      const sampleId = directSampleId(sample);
      onProgress?.("Getting TPM data");
      vectorsBySample.set(
        sampleId,
        calculateTpmVectorFromCounts(countVectors.get(sampleId), geneLengths, bundle.genes, sampleId)
      );
    }
  } finally {
    if (ownCountVectors) {
      countVectors.clear();
    }
  }

  return vectorsBySample;
}

function parseDelimitedRecordAt(text, startIndex, delimiter, maxFields = Number.POSITIVE_INFINITY) {
  const fields = [];
  let field = "";
  let quoted = false;
  let index = startIndex;
  let collecting = true;

  for (; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        if (collecting) {
          field += '"';
        }
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else if (collecting) {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      if (collecting) {
        fields.push(field);
        field = "";
        if (fields.length >= maxFields) {
          collecting = false;
        }
      }
    } else if (char === "\n") {
      if (collecting) {
        fields.push(field.replace(/\r$/, ""));
      }
      return {
        fields,
        startIndex,
        nextIndex: index + 1,
        endIndex: index
      };
    } else if (collecting) {
      field += char;
    }
  }

  if (quoted) {
    throw new Error("Unclosed quoted field in delimited text.");
  }

  if (index > startIndex || field.length > 0 || fields.length > 0) {
    if (collecting) {
      fields.push(field.replace(/\r$/, ""));
    }
    return {
      fields,
      startIndex,
      nextIndex: index,
      endIndex: index
    };
  }

  return null;
}

function directSampleId(sample) {
  return sample.sample_id || sample.SRA || sample.sample || sample.id;
}

function directGenePayload(payload) {
  return Array.isArray(payload) ? payload : payload.genes;
}

function selectedSampleIds(samples) {
  return new Set(samples.map((sample) => directSampleId(sample)).filter(Boolean));
}

function genericTpmProgress(label) {
  return /^TPM\b/i.test(String(label || "")) ? "Getting TPM data" : null;
}

function firstLine(text) {
  const index = text.indexOf("\n");
  return (index < 0 ? text : text.slice(0, index)).replace(/\r$/, "");
}

async function loadDirectMatrixBundle(dataset, onProgress = null, options = {}) {
  emitProgress(onProgress, "Loading dataset configuration", {
    stage: "Loading dataset configuration",
    mode: "indeterminate"
  }, options);
  dataset = normalizeDirectDataset(dataset);
  throwIfAborted(options.signal);

  if (!dataset.countUrl) {
    throw new Error("Direct matrix datasets require countUrl in config/datasets.json.");
  }

  if (dataset.sampleMetadataUrl && dataset.geneListUrl) {
    emitProgress(onProgress, "Loading samples for selected dataset", {
      stage: "Loading sample metadata",
      mode: "indeterminate"
    }, options);
    const samplesPayload = await fetchJsonMaybeCompressed(
      dataset.sampleMetadataUrl,
      onProgress,
      "Loading sample metadata",
      options
    );

    emitProgress(onProgress, "Loading gene list for selected dataset", {
      stage: "Loading gene information",
      mode: "indeterminate"
    }, options);
    const genesPayload = await fetchJsonMaybeCompressed(
      dataset.geneListUrl,
      onProgress,
      "Loading gene list",
      options
    );
    const sampleRows = Array.isArray(samplesPayload) ? samplesPayload : samplesPayload.samples;
    const genes = directGenePayload(genesPayload);

    emitProgress(onProgress, "Validating dataset", {
      stage: "Validating dataset",
      mode: "indeterminate"
    }, options);
    if (!Array.isArray(sampleRows) || sampleRows.length === 0) {
      throw new Error("Sample metadata is empty or invalid.");
    }

    if (!Array.isArray(genes) || genes.length === 0) {
      throw new Error("Gene list is empty or invalid.");
    }

    if (dataset.tpmVectorManifestUrl) {
      emitProgress(onProgress, "Getting TPM data", {
        stage: "Loading dataset configuration",
        mode: "indeterminate"
      }, options);
      const vectorManifest = await fetchJsonMaybeCompressed(
        dataset.tpmVectorManifestUrl,
        onProgress,
        "Getting TPM data",
        options
      );
      if (vectorManifest.format !== "float32-gzip-v1") {
        throw new Error(`Unsupported TPM vector format: ${vectorManifest.format || "missing"}.`);
      }
      if (Number(vectorManifest.geneCount) !== genes.length) {
        throw new Error(`TPM vector gene count mismatch: ${vectorManifest.geneCount} vs ${genes.length}.`);
      }
      if (!vectorManifest.sampleFiles || typeof vectorManifest.sampleFiles !== "object") {
        throw new Error("TPM vector index has no sampleFiles map.");
      }
      for (const sample of sampleRows) {
        const sampleId = directSampleId(sample);
        const fileName = vectorManifest.sampleFiles[sampleId];
        if (!fileName) {
          throw new Error(`TPM vector index has no file for sample ${sampleId}.`);
        }
        sample.tpmFile = fileName;
      }
    }

    emitProgress(onProgress, `Loaded ${sampleRows.length.toLocaleString()} samples and ${genes.length.toLocaleString()} genes`, {
      stage: "Finalizing dataset",
      mode: "indeterminate"
    }, options);
    return {
      dataset,
      manifest: {
        sourceFormat: dataset.format,
        matrixOrientation: dataset.matrixOrientation || "samples_as_rows",
        metadataColumnCount: Number(dataset.metadataColumnCount ?? dataset.metadataColumnsCount ?? 10)
      },
      samples: { samples: sampleRows },
      sampleRows,
      genes,
      geneOrderId: dataset.geneOrderId || `direct:${dataset.id}:${genes.length}`,
      directMatrix: {
        orientation: dataset.matrixOrientation || "samples_as_rows",
        countRowsBySampleId: new Map(),
        countText: null,
        countDelimiter: null,
        tpmRowsBySampleId: null,
        tpmText: null,
        tpmDelimiter: null,
        geneLengths: null
      }
    };
  }

  if ((dataset.matrixOrientation || "samples_as_rows") === "samples_as_rows") {
    emitProgress(onProgress, "Reading sample metadata from count matrix", {
      stage: "Preparing count matrix header",
      mode: "indeterminate"
    }, options);
    return await loadSampleRowBundleFromCountUrl(dataset, onProgress, options);
  }

  emitProgress(onProgress, "Loading raw count matrix", {
    stage: "Preparing count matrix",
    mode: "indeterminate"
  }, options);
  const text = await fetchMaybeCompressedTextWithDatasetFallback(
    dataset,
    "countUrl",
    onProgress,
    "Downloading count matrix",
    options
  );
  const delimiter = detectConfiguredDelimiter(dataset, dataset.countUrl);
  emitProgress(onProgress, "Parsing count matrix", {
    stage: "Now loading datasets...",
    mode: "indeterminate"
  }, options);
  const { rows, delimiter: parsedDelimiter } = parseDelimitedRows(text, delimiter);

  emitProgress(onProgress, "Validating dataset", {
    stage: "Validating dataset",
    mode: "indeterminate"
  }, options);
  if (rows.length < 2) {
    throw new Error("Raw count matrix must contain a header and at least one data row.");
  }

  const orientation = dataset.matrixOrientation || "samples_as_rows";
  const bundle = orientation === "genes_as_rows"
    ? buildGeneRowBundle(dataset, rows)
    : buildSampleRowBundle(dataset, rows);

  bundle.directMatrix.countText = text;
  bundle.directMatrix.countDelimiter = parsedDelimiter;

  emitProgress(onProgress, "Raw count matrix ready", {
    stage: "Finalizing dataset",
    mode: "indeterminate"
  }, options);
  return bundle;
}

async function loadSampleRowBundleFromCountUrl(dataset, onProgress = null, options = {}) {
  const delimiter = detectConfiguredDelimiter(dataset, dataset.countUrl);

  if (!delimiter) {
    const text = await fetchMaybeCompressedTextWithDatasetFallback(
      dataset,
      "countUrl",
      onProgress,
      "Downloading count matrix metadata",
      options
    );
    return parseSampleRowBundleFromText(dataset, text, null, onProgress, options);
  }

  emitProgress(onProgress, "Preparing count matrix header", {
    stage: "Preparing count matrix header",
    mode: "indeterminate"
  }, options);
  const fetched = await fetchResponseWithDatasetFallback(dataset, "countUrl", "count matrix", options);
  const response = fetched.response;
  if (!response.ok) {
    throw new Error(`Failed to fetch ${fetched.url}: HTTP ${response.status}`);
  }

  if (!response.body) {
    const text = await fetchMaybeCompressedTextWithDatasetFallback(
      dataset,
      "countUrl",
      onProgress,
      "Downloading count matrix metadata",
      options
    );
    return parseSampleRowBundleFromText(dataset, text, delimiter, onProgress, options);
  }

  if (gzipUrl(fetched.url) && !gzipEncodedResponse(response)) {
    emitProgress(onProgress, "Decompressing data", {
      stage: "Decompressing data",
      mode: "indeterminate"
    }, options);
  }
  const reader = await textStreamReaderForResponse(response, fetched.url, onProgress, options);
  return await parseSampleRowBundleFromReader(dataset, reader, delimiter, onProgress, options);
}

function buildSampleRowMetadataBundle(dataset, metadataHeaders, genes, sampleRows, delimiter) {
  if (sampleRows.length === 0) {
    throw new Error("Raw count matrix must contain at least one sample row.");
  }

  return {
    dataset,
    manifest: {
      sourceFormat: dataset.format,
      matrixOrientation: "samples_as_rows",
      metadataColumnCount: Number(dataset.metadataColumnCount ?? dataset.metadataColumnsCount ?? 10)
    },
    samples: { samples: sampleRows },
    sampleRows,
    genes,
    geneOrderId: dataset.geneOrderId || `direct:${dataset.id}:${genes.length}`,
    directMatrix: {
      orientation: "samples_as_rows",
      metadataHeaders,
      countRowsBySampleId: new Map(),
      countText: null,
      countDelimiter: delimiter,
      tpmRowsBySampleId: null,
      tpmText: null,
      tpmDelimiter: null,
      geneLengths: null
    }
  };
}

function parseSampleRowBundleFromText(dataset, text, delimiter, onProgress = null, options = {}) {
  throwIfAborted(options.signal);
  emitProgress(onProgress, "Now loading datasets...", {
    stage: "Now loading datasets...",
    mode: "indeterminate"
  }, options);
  const parsed = parseDelimitedRows(text, delimiter);
  emitProgress(onProgress, "Validating dataset", {
    stage: "Validating dataset",
    mode: "indeterminate"
  }, options);
  const bundle = buildSampleRowBundle(dataset, parsed.rows);
  bundle.directMatrix.countRowsBySampleId = new Map();
  bundle.directMatrix.countText = null;
  bundle.directMatrix.countDelimiter = parsed.delimiter;
  emitProgress(onProgress, `Loaded ${bundle.sampleRows.length.toLocaleString()} samples and ${bundle.genes.length.toLocaleString()} genes`, {
    stage: "Finalizing dataset",
    mode: "indeterminate"
  }, options);
  return bundle;
}

async function parseSampleRowBundleFromReader(dataset, reader, delimiter, onProgress = null, options = {}) {
  const decoder = new TextDecoder("utf-8");
  const metadataColumnCount = Number(dataset.metadataColumnCount ?? dataset.metadataColumnsCount ?? 10);
  const expectedSamples = Number(dataset.sampleCount);
  const hasExpectedSamples = Number.isFinite(expectedSamples) && expectedSamples > 0;
  const sampleProgressInterval = hasExpectedSamples
    ? Math.max(1, Math.floor(expectedSamples / 100))
    : 100;
  const sampleRows = [];
  const sampleIds = new Set();

  let header = null;
  let metadataHeaders = null;
  let genes = null;
  let sampleIdIndex = -1;
  let expectedWidth = 0;
  let rowNumber = 1;
  let loaded = 0;
  let visited = 0;
  let field = "";
  let fieldCount = 0;
  let fields = [];
  let quoted = false;
  let collectLimit = Number.POSITIVE_INFINITY;

  function currentFieldIsCollected() {
    return fieldCount < collectLimit;
  }

  function resetRecord() {
    field = "";
    fieldCount = 0;
    fields = [];
    quoted = false;
  }

  function pushField() {
    fieldCount += 1;
    if (fieldCount <= collectLimit) {
      fields.push(field.replace(/\r$/, ""));
    }
    field = "";
  }

  function processHeader() {
    header = fields.map((value, index) => {
      const text = String(value || "").trim();
      return index === 0 ? text.replace(/^\uFEFF/, "") : text;
    });
    expectedWidth = fieldCount;

    if (!Number.isInteger(metadataColumnCount) || metadataColumnCount < 1 || metadataColumnCount >= expectedWidth) {
      throw new Error("metadataColumnCount must be a positive integer smaller than the number of columns.");
    }

    metadataHeaders = normalizeHeaderNames(header.slice(0, metadataColumnCount), "metadata");
    genes = header.slice(metadataColumnCount).map((gene) => String(gene).trim());
    ensureUnique(genes, "Gene IDs");

    sampleIdIndex = findColumnIndex(metadataHeaders, dataset.sampleIdColumn, [
      "SRA",
      "Run",
      "sample_id",
      "Sample ID",
      "Sample",
      "sample"
    ]);

    if (sampleIdIndex < 0) {
      throw new Error("Could not identify the sample ID column. Set sampleIdColumn in config/datasets.json.");
    }

    collectLimit = metadataColumnCount;
    rowNumber += 1;
    emitProgress(onProgress, `Count matrix header ready: ${genes.length.toLocaleString()} genes`, {
      stage: "Preparing count matrix header",
      mode: "indeterminate"
    }, options);
  }

  function processSampleRow() {
    if (!fields.some((value) => value !== "")) {
      rowNumber += 1;
      return;
    }

    if (fieldCount < metadataColumnCount) {
      throw new Error(`Count matrix row ${rowNumber} has ${fieldCount} metadata columns; expected ${metadataColumnCount}.`);
    }

    if (fieldCount !== expectedWidth) {
      throw new Error(`Count matrix row ${rowNumber} has ${fieldCount} columns; expected ${expectedWidth}.`);
    }

    const metadata = {};
    for (let columnIndex = 0; columnIndex < metadataColumnCount; columnIndex += 1) {
      metadata[metadataHeaders[columnIndex]] = fields[columnIndex];
    }

    const sampleId = String(fields[sampleIdIndex] || "").trim();
    if (!sampleId) {
      throw new Error(`Count matrix row ${rowNumber} has an empty sample ID.`);
    }

    if (sampleIds.has(sampleId)) {
      throw new Error(`Count matrix contains a duplicate sample ID: ${sampleId}`);
    }

    sampleIds.add(sampleId);
    sampleRows.push({
      ...metadata,
      sample_id: sampleId,
      SRA: metadata.SRA || sampleId
    });

    visited += 1;
    if (hasExpectedSamples && (visited === 1 || visited % sampleProgressInterval === 0 || visited >= expectedSamples)) {
      emitProgress(onProgress, `Now loading datasets... ${visited.toLocaleString()} / ${expectedSamples.toLocaleString()} samples`, {
        stage: "Now loading datasets...",
        mode: "determinate",
        percent: Math.min(100, visited / expectedSamples * 100),
        loadedBytes: loaded
      }, options);
    } else if (visited % 100 === 0) {
      emitProgress(onProgress, `Reading sample metadata: ${visited.toLocaleString()} samples scanned`, {
        stage: "Now loading datasets...",
        mode: "indeterminate",
        loadedBytes: loaded
      }, options);
    }

    rowNumber += 1;
  }

  function processRecord() {
    if (!header) {
      processHeader();
    } else {
      processSampleRow();
    }
  }

  function scanText(text) {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];

      if (quoted) {
        if (char === '"' && next === '"') {
          if (currentFieldIsCollected()) {
            field += '"';
          }
          index += 1;
        } else if (char === '"') {
          quoted = false;
        } else if (currentFieldIsCollected()) {
          field += char;
        }
        continue;
      }

      if (char === '"') {
        quoted = true;
      } else if (char === delimiter) {
        pushField();
      } else if (char === "\n") {
        pushField();
        processRecord();
        resetRecord();
      } else if (currentFieldIsCollected()) {
        field += char;
      }
    }
  }

  try {
    while (true) {
      throwIfAborted(options.signal);
      const { done, value } = await reader.read();

      if (done) {
        const rest = decoder.decode();
        if (rest) {
          scanText(rest);
        }
        if (quoted) {
          throw new Error("Unclosed quoted field in count matrix.");
        }
        if (field.length > 0 || fields.length > 0 || fieldCount > 0) {
          pushField();
          processRecord();
          resetRecord();
        }
        break;
      }

      loaded += value.byteLength;
      if (loaded % (8 * 1024 * 1024) < value.byteLength) {
        emitProgress(onProgress, `Reading count matrix metadata: ${formatBytes(loaded)} decoded`, {
          stage: "Now loading datasets...",
          mode: "indeterminate",
          loadedBytes: loaded
        }, options);
        await yieldToBrowser();
      }

      scanText(decoder.decode(value, { stream: true }));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may have been released by the browser after completion.
    }
  }

  if (!header || !genes) {
    throw new Error("Raw count matrix must contain a header and at least one data row.");
  }

  emitProgress(onProgress, "Validating dataset", {
    stage: "Validating dataset",
    mode: "indeterminate",
    loadedBytes: loaded
  }, options);
  emitProgress(onProgress, `Loaded ${sampleRows.length.toLocaleString()} samples and ${genes.length.toLocaleString()} genes`, {
    stage: "Finalizing dataset",
    mode: "indeterminate",
    loadedBytes: loaded
  }, options);
  return buildSampleRowMetadataBundle(dataset, metadataHeaders, genes, sampleRows, delimiter);
}

function buildSampleRowBundle(dataset, rows) {
  const header = rows[0].map((value) => String(value || "").trim());
  const metadataColumnCount = Number(dataset.metadataColumnCount ?? dataset.metadataColumnsCount ?? 10);

  if (!Number.isInteger(metadataColumnCount) || metadataColumnCount < 1 || metadataColumnCount >= header.length) {
    throw new Error("metadataColumnCount must be a positive integer smaller than the number of columns.");
  }

  const metadataHeaders = normalizeHeaderNames(header.slice(0, metadataColumnCount), "metadata");
  const genes = header.slice(metadataColumnCount).map((gene) => String(gene).trim());
  ensureUnique(genes, "Gene IDs");

  const sampleIdIndex = findColumnIndex(metadataHeaders, dataset.sampleIdColumn, [
    "SRA",
    "Run",
    "sample_id",
    "Sample ID",
    "Sample",
    "sample"
  ]);

  if (sampleIdIndex < 0) {
    throw new Error("Could not identify the sample ID column. Set sampleIdColumn in config/datasets.json.");
  }

  const sampleRows = [];
  const countRowsBySampleId = new Map();

  rows.slice(1).forEach((row, index) => {
    if (!row.some((value) => value !== "")) {
      return;
    }

    assertRowWidth(row, header.length, index + 2, "Count matrix");

    const metadata = {};
    for (let columnIndex = 0; columnIndex < metadataColumnCount; columnIndex += 1) {
      metadata[metadataHeaders[columnIndex]] = row[columnIndex];
    }

    const sampleId = String(row[sampleIdIndex] || "").trim();
    if (!sampleId) {
      throw new Error(`Count matrix row ${index + 2} has an empty sample ID.`);
    }

    if (countRowsBySampleId.has(sampleId)) {
      throw new Error(`Count matrix contains a duplicate sample ID: ${sampleId}`);
    }

    const sample = {
      ...metadata,
      sample_id: sampleId,
      SRA: metadata.SRA || sampleId
    };
    sampleRows.push(sample);
    countRowsBySampleId.set(sampleId, row.slice(metadataColumnCount));
  });

  return {
    dataset,
    manifest: {
      sourceFormat: dataset.format,
      matrixOrientation: "samples_as_rows",
      metadataColumnCount
    },
    samples: { samples: sampleRows },
    sampleRows,
    genes,
    geneOrderId: dataset.geneOrderId || `direct:${dataset.id}:${genes.length}`,
    directMatrix: {
      orientation: "samples_as_rows",
      metadataHeaders,
      countRowsBySampleId,
      tpmRowsBySampleId: null,
      geneLengths: null
    }
  };
}

function buildGeneRowBundle(dataset, rows) {
  const header = rows[0].map((value) => String(value || "").trim());
  const geneIdColumn = dataset.geneIdColumn || header[0];
  const geneIdIndex = findColumnIndex(header, geneIdColumn, ["gene_id", "gene", "Gene ID"]);

  if (geneIdIndex < 0) {
    throw new Error("Could not identify the gene ID column. Set geneIdColumn in config/datasets.json.");
  }

  const sampleNames = header.filter((_, index) => index !== geneIdIndex);
  ensureUnique(sampleNames, "Sample IDs");

  const genes = [];
  const valuesBySampleId = new Map(sampleNames.map((sampleName) => [sampleName, []]));

  rows.slice(1).forEach((row, index) => {
    if (!row.some((value) => value !== "")) {
      return;
    }

    assertRowWidth(row, header.length, index + 2, "Count matrix");
    const geneId = String(row[geneIdIndex] || "").trim();

    if (!geneId) {
      throw new Error(`Count matrix row ${index + 2} has an empty gene ID.`);
    }

    genes.push(geneId);

    header.forEach((columnName, columnIndex) => {
      if (columnIndex !== geneIdIndex) {
        valuesBySampleId.get(columnName).push(row[columnIndex]);
      }
    });
  });

  ensureUnique(genes, "Gene IDs");

  const sampleRows = sampleNames.map((sampleId) => ({
    sample_id: sampleId,
    SRA: sampleId
  }));

  return {
    dataset,
    manifest: {
      sourceFormat: dataset.format,
      matrixOrientation: "genes_as_rows"
    },
    samples: { samples: sampleRows },
    sampleRows,
    genes,
    geneOrderId: dataset.geneOrderId || `direct:${dataset.id}:${genes.length}`,
    directMatrix: {
      orientation: "genes_as_rows",
      countRowsBySampleId: valuesBySampleId,
      tpmRowsBySampleId: null,
      geneLengths: null
    }
  };
}

function parseDirectValueMatrix(bundle, rows, label) {
  const dataset = bundle.dataset;
  const orientation = bundle.directMatrix.orientation;

  if (orientation === "genes_as_rows") {
    return parseDirectGeneRowValues(bundle, rows, label);
  }

  const header = rows[0].map((value) => String(value || "").trim());
  const metadataColumnCount = Number(dataset.tpmMetadataColumnCount ?? bundle.manifest.metadataColumnCount);
  const metadataHeaders = normalizeHeaderNames(header.slice(0, metadataColumnCount), "metadata");
  const genes = header.slice(metadataColumnCount).map((gene) => String(gene).trim());
  assertGeneOrder(genes, bundle.genes, label);

  const sampleIdIndex = findColumnIndex(metadataHeaders, dataset.sampleIdColumn, [
    "SRA",
    "Run",
    "sample_id",
    "Sample ID",
    "Sample",
    "sample"
  ]);

  if (sampleIdIndex < 0) {
    throw new Error(`Could not identify the sample ID column in ${label}.`);
  }

  const valuesBySampleId = new Map();

  rows.slice(1).forEach((row, index) => {
    if (!row.some((value) => value !== "")) {
      return;
    }

    assertRowWidth(row, header.length, index + 2, label);
    const sampleId = String(row[sampleIdIndex] || "").trim();

    if (!sampleId) {
      throw new Error(`${label} row ${index + 2} has an empty sample ID.`);
    }

    if (valuesBySampleId.has(sampleId)) {
      throw new Error(`${label} contains a duplicate sample ID: ${sampleId}`);
    }

    valuesBySampleId.set(sampleId, row.slice(metadataColumnCount));
  });

  return valuesBySampleId;
}

function parseDirectGeneRowValues(bundle, rows, label) {
  const dataset = bundle.dataset;
  const header = rows[0].map((value) => String(value || "").trim());
  const geneIdColumn = dataset.geneIdColumn || header[0];
  const geneIdIndex = findColumnIndex(header, geneIdColumn, ["gene_id", "gene", "Gene ID"]);

  if (geneIdIndex < 0) {
    throw new Error(`Could not identify the gene ID column in ${label}.`);
  }

  const sampleNames = header.filter((_, index) => index !== geneIdIndex);
  const valuesBySampleId = new Map(sampleNames.map((sampleName) => [sampleName, []]));
  const genes = [];

  rows.slice(1).forEach((row, index) => {
    if (!row.some((value) => value !== "")) {
      return;
    }

    assertRowWidth(row, header.length, index + 2, label);
    genes.push(String(row[geneIdIndex] || "").trim());

    header.forEach((columnName, columnIndex) => {
      if (columnIndex !== geneIdIndex) {
        valuesBySampleId.get(columnName).push(row[columnIndex]);
      }
    });
  });

  assertGeneOrder(genes, bundle.genes, label);
  return valuesBySampleId;
}

async function indexSelectedSampleRows({
  bundle,
  text,
  delimiter,
  samples,
  targetMap,
  label,
  onProgress,
  metadataColumnCount = null
}) {
  if (bundle.directMatrix.orientation === "genes_as_rows") {
    const { rows } = parseDelimitedRows(text, delimiter);
    return parseDirectValueMatrix(bundle, rows, label);
  }

  const wanted = selectedSampleIds(samples);
  const missing = new Set([...wanted].filter((sampleId) => !targetMap.has(sampleId)));

  if (missing.size === 0) {
    return targetMap;
  }

  const headerRecord = parseDelimitedRecordAt(text, 0, delimiter);
  if (!headerRecord) {
    throw new Error(`${label} is empty.`);
  }

  const header = headerRecord.fields.map((value) => String(value || "").trim());
  const metadataCount = Number(metadataColumnCount ?? bundle.manifest.metadataColumnCount);

  if (!Number.isInteger(metadataCount) || metadataCount < 1 || metadataCount >= header.length) {
    throw new Error(`${label} has an invalid metadata column count.`);
  }

  const metadataHeaders = normalizeHeaderNames(header.slice(0, metadataCount), "metadata");
  const genes = header.slice(metadataCount).map((gene) => String(gene).trim());
  assertGeneOrder(genes, bundle.genes, label);

  const sampleIdIndex = findColumnIndex(metadataHeaders, bundle.dataset.sampleIdColumn, [
    "SRA",
    "Run",
    "sample_id",
    "Sample ID",
    "Sample",
    "sample"
  ]);

  if (sampleIdIndex < 0) {
    throw new Error(`Could not identify the sample ID column in ${label}.`);
  }

  let index = headerRecord.nextIndex;
  let rowNumber = 2;
  let visited = 0;

  while (index < text.length && missing.size > 0) {
    const recordStart = index;
    const record = parseDelimitedRecordAt(text, index, delimiter, metadataCount);
    if (!record) {
      break;
    }

    index = record.nextIndex;

    if (!record.fields.some((value) => value !== "")) {
      rowNumber += 1;
      continue;
    }

    if (record.fields.length < metadataCount) {
      throw new Error(`${label} row ${rowNumber} has ${record.fields.length} metadata columns; expected ${metadataCount}.`);
    }

    const sampleId = String(record.fields[sampleIdIndex] || "").trim();
    if (missing.has(sampleId)) {
      targetMap.set(sampleId, {
        startIndex: recordStart,
        rowNumber
      });
      missing.delete(sampleId);
    }

    visited += 1;
    if (visited % 100 === 0) {
      const percent = Math.round(index / text.length * 100);
      onProgress?.(`Reading sample rows from ${label}: ${percent}% (${missing.size} selected still pending)`);
      await yieldToBrowser();
    }

    rowNumber += 1;
  }

  if (missing.size > 0) {
    throw new Error(`${label} is missing selected samples: ${[...missing].slice(0, 10).join(", ")}`);
  }

  return targetMap;
}

function gzipUrl(url) {
  return /\.gz(?:[?#].*)?$/i.test(url || "");
}

function gzipEncodedResponse(response) {
  return /\bgzip\b/i.test(response.headers.get("content-encoding") || "");
}

function responseContentLength(response) {
  if (gzipEncodedResponse(response)) {
    return null;
  }

  const total = Number(response.headers.get("content-length") || 0);
  return Number.isFinite(total) && total > 0 ? total : null;
}

function streamWithResponseProgress(stream, response, onProgress = null, options = {}) {
  if (!stream || !onProgress || !options.structuredProgress) {
    return stream;
  }

  const sourceReader = stream.getReader();
  const totalBytes = responseContentLength(response);
  let loadedBytes = 0;

  function reportProgress() {
    emitProgress(onProgress, "Now loading datasets...", {
      stage: "Now loading datasets...",
      mode: totalBytes ? "determinate" : "indeterminate",
      loadedBytes,
      totalBytes,
      percent: totalBytes ? loadedBytes / totalBytes * 100 : null
    }, options);
  }

  reportProgress();

  return new ReadableStream({
    async pull(controller) {
      throwIfAborted(options.signal);
      const next = await sourceReader.read();

      if (next.done) {
        controller.close();
        try {
          sourceReader.releaseLock();
        } catch {
          // The stream may already be released after cancellation.
        }
        return;
      }

      loadedBytes += next.value.byteLength;
      reportProgress();
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return sourceReader.cancel(reason);
    }
  });
}

async function textStreamReaderForResponse(response, url, onProgress = null, options = {}) {
  const body = streamWithResponseProgress(response.body, response, onProgress, options);

  if (!gzipUrl(url) || gzipEncodedResponse(response)) {
    return body.getReader();
  }

  const sourceReader = body.getReader();
  const first = await sourceReader.read();

  if (first.done) {
    return new ReadableStream({
      start(controller) {
        controller.close();
      }
    }).getReader();
  }

  const firstChunk = first.value;
  const bodyLooksGzip = firstChunk.byteLength >= 2 &&
    firstChunk[0] === 0x1f &&
    firstChunk[1] === 0x8b;

  const replayStream = new ReadableStream({
    start(controller) {
      controller.enqueue(firstChunk);
    },
    async pull(controller) {
      const next = await sourceReader.read();

      if (next.done) {
        controller.close();
        try {
          sourceReader.releaseLock();
        } catch {
          // The stream may already be released after cancellation.
        }
        return;
      }

      controller.enqueue(next.value);
    },
    cancel(reason) {
      return sourceReader.cancel(reason);
    }
  });

  if (!bodyLooksGzip) {
    return replayStream.getReader();
  }

  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress gzip files. Use Chrome or Edge, or provide an uncompressed file.");
  }

  return replayStream
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
}

async function indexSelectedSampleRowsFromUrl({
  bundle,
  url,
  delimiter,
  samples,
  targetMap,
  label,
  onProgress,
  urlKey = null,
  metadataColumnCount = null
}) {
  if (bundle.directMatrix.orientation === "genes_as_rows" || !delimiter) {
    const text = urlKey
      ? await fetchMaybeCompressedTextWithDatasetFallback(bundle.dataset, urlKey, onProgress, `Downloading selected ${label}`)
      : await fetchMaybeCompressedText(url, onProgress, `Downloading selected ${label}`);
    return await indexSelectedSampleRows({
      bundle,
      text,
      delimiter: delimiter || parseDelimitedRows(firstLine(text)).delimiter,
      samples,
      targetMap,
      label,
      onProgress,
      metadataColumnCount
    });
  }

  const tpmProgress = genericTpmProgress(label);
  const wanted = selectedSampleIds(samples);
  const missing = new Set([...wanted].filter((sampleId) => !targetMap.has(sampleId)));

  if (missing.size === 0) {
    return targetMap;
  }

  const fetched = urlKey
    ? await fetchResponseWithDatasetFallback(bundle.dataset, urlKey, label)
    : { response: await fetch(url, { cache: "force-cache" }), url };
  const response = fetched.response;
  if (!response.ok) {
    throw new Error(`Failed to fetch ${fetched.url}: HTTP ${response.status}`);
  }

  if (!response.body) {
    const text = urlKey
      ? await fetchMaybeCompressedTextWithDatasetFallback(bundle.dataset, urlKey, onProgress, `Downloading selected ${label}`)
      : await fetchMaybeCompressedText(url, onProgress, `Downloading selected ${label}`);
    return await indexSelectedSampleRows({
      bundle,
      text,
      delimiter,
      samples,
      targetMap,
      label,
      onProgress,
      metadataColumnCount
    });
  }

  onProgress?.(tpmProgress || `Streaming selected rows from ${label}`);

  const reader = await textStreamReaderForResponse(response, fetched.url);
  const decoder = new TextDecoder("utf-8");
  const metadataCount = Number(metadataColumnCount ?? bundle.manifest.metadataColumnCount);

  let header = null;
  let sampleIdIndex = -1;
  let expectedWidth = 0;
  let rowNumber = 1;
  let visited = 0;
  let loaded = 0;
  let field = "";
  let fields = [];
  let quoted = false;
  let collecting = true;

  function shouldStopCollecting() {
    if (!header || !collecting || fields.length < metadataCount) {
      return false;
    }

    const sampleId = String(fields[sampleIdIndex] || "").trim();
    return sampleId && !missing.has(sampleId);
  }

  function resetRecord() {
    field = "";
    fields = [];
    quoted = false;
    collecting = true;
  }

  function pushField() {
    if (collecting) {
      fields.push(field.replace(/\r$/, ""));
      field = "";

      if (shouldStopCollecting()) {
        collecting = false;
      }
    } else {
      field = "";
    }
  }

  function processRecord() {
    if (!header) {
      header = fields.map((value) => String(value || "").trim());
      expectedWidth = header.length;

      if (!Number.isInteger(metadataCount) || metadataCount < 1 || metadataCount >= expectedWidth) {
        throw new Error(`${label} has an invalid metadata column count.`);
      }

      const metadataHeaders = normalizeHeaderNames(header.slice(0, metadataCount), "metadata");
      const genes = header.slice(metadataCount).map((gene) => String(gene).trim());
      assertGeneOrder(genes, bundle.genes, label);

      sampleIdIndex = findColumnIndex(metadataHeaders, bundle.dataset.sampleIdColumn, [
        "SRA",
        "Run",
        "sample_id",
        "Sample ID",
        "Sample",
        "sample"
      ]);

      if (sampleIdIndex < 0) {
        throw new Error(`Could not identify the sample ID column in ${label}.`);
      }

      rowNumber += 1;
      return;
    }

    if (!fields.some((value) => value !== "")) {
      rowNumber += 1;
      return;
    }

    if (fields.length < metadataCount) {
      throw new Error(`${label} row ${rowNumber} has ${fields.length} metadata columns; expected ${metadataCount}.`);
    }

    const sampleId = String(fields[sampleIdIndex] || "").trim();
    if (missing.has(sampleId)) {
      if (fields.length !== expectedWidth) {
        throw new Error(`${label} row ${rowNumber} has ${fields.length} columns; expected ${expectedWidth}.`);
      }

      targetMap.set(sampleId, fields.slice(metadataCount));
      missing.delete(sampleId);
      onProgress?.(tpmProgress || `Found ${label} row for ${sampleId} (${missing.size} selected still pending)`);
    }

    visited += 1;
    if (visited % 100 === 0) {
      onProgress?.(tpmProgress || `Streaming ${label}: ${visited.toLocaleString()} rows scanned (${missing.size} selected still pending)`);
    }

    rowNumber += 1;
  }

  function scanText(text) {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];

      if (quoted) {
        if (char === '"' && next === '"') {
          if (collecting) {
            field += '"';
          }
          index += 1;
        } else if (char === '"') {
          quoted = false;
        } else if (collecting) {
          field += char;
        }
        continue;
      }

      if (char === '"') {
        quoted = true;
      } else if (char === delimiter) {
        pushField();
      } else if (char === "\n") {
        pushField();
        processRecord();
        resetRecord();

        if (missing.size === 0) {
          return true;
        }
      } else if (collecting) {
        field += char;
      }
    }

    return false;
  }

  try {
    while (missing.size > 0) {
      const { done, value } = await reader.read();

      if (done) {
        const rest = decoder.decode();
        if (rest && scanText(rest)) {
          break;
        }
        if (quoted) {
          throw new Error(`Unclosed quoted field in ${label}.`);
        }
        if (field.length > 0 || fields.length > 0) {
          pushField();
          processRecord();
        }
        break;
      }

      loaded += value.byteLength;
      if (loaded % (4 * 1024 * 1024) < value.byteLength) {
        onProgress?.(tpmProgress || `Streaming ${label}: ${formatBytes(loaded)} decoded (${missing.size} selected still pending)`);
        await yieldToBrowser();
      }

      const text = decoder.decode(value, { stream: true });
      if (scanText(text)) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Some streams release their lock during cancelation.
    }
  }

  if (missing.size > 0) {
    throw new Error(`${label} is missing selected samples: ${[...missing].slice(0, 10).join(", ")}`);
  }

  return targetMap;
}

async function ensureDirectCountRows(bundle, samples, onProgress) {
  if (!bundle.directMatrix) {
    return;
  }

  const wanted = selectedSampleIds(samples);
  const haveAll = [...wanted].every((sampleId) => bundle.directMatrix.countRowsBySampleId.has(sampleId));
  if (haveAll) {
    return;
  }

  const delimiter = bundle.directMatrix.countDelimiter ||
    detectConfiguredDelimiter(bundle.dataset, bundle.dataset.countUrl);
  const result = await indexSelectedSampleRowsFromUrl({
    bundle,
    url: bundle.dataset.countUrl,
    delimiter,
    samples,
    targetMap: bundle.directMatrix.countRowsBySampleId,
    label: "count matrix",
    onProgress,
    urlKey: "countUrl"
  });
  bundle.directMatrix.countRowsBySampleId = result;
  bundle.directMatrix.countDelimiter = delimiter;
}

async function loadDirectTpmRows(bundle, samples, onProgress) {
  if (!bundle.dataset.tpmUrl) {
    return null;
  }

  if (!bundle.directMatrix.tpmRowsBySampleId) {
    bundle.directMatrix.tpmRowsBySampleId = new Map();
  }

  const wanted = selectedSampleIds(samples);
  const haveAll = [...wanted].every((sampleId) => bundle.directMatrix.tpmRowsBySampleId.has(sampleId));
  if (haveAll) {
    return bundle.directMatrix.tpmRowsBySampleId;
  }

  const delimiter = bundle.directMatrix.tpmDelimiter ||
    detectConfiguredDelimiter({
      delimiter: bundle.dataset.tpmDelimiter || bundle.dataset.delimiter
    }, bundle.dataset.tpmUrl);
  const result = await indexSelectedSampleRowsFromUrl({
    bundle,
    url: bundle.dataset.tpmUrl,
    delimiter,
    samples,
    targetMap: bundle.directMatrix.tpmRowsBySampleId,
    label: "TPM matrix",
    onProgress,
    urlKey: "tpmUrl",
    metadataColumnCount: bundle.dataset.tpmMetadataColumnCount ?? bundle.manifest.metadataColumnCount
  });

  bundle.directMatrix.tpmRowsBySampleId = result;
  bundle.directMatrix.tpmDelimiter = delimiter;
  return result;
}

function directCountVector(bundle, sampleId) {
  const entry = bundle.directMatrix.countRowsBySampleId.get(sampleId);

  if (!entry) {
    throw new Error(`Selected sample ${sampleId} was not found in the count matrix.`);
  }

  const row = Array.isArray(entry)
    ? entry
    : parseDelimitedRecordAt(bundle.directMatrix.countText, entry.startIndex, bundle.directMatrix.countDelimiter).fields;
  const values = Array.isArray(entry)
    ? row
    : row.slice(Number(bundle.manifest.metadataColumnCount));

  if (values.length !== bundle.genes.length) {
    throw new Error(`Count vector length mismatch for ${sampleId}: ${values.length} vs ${bundle.genes.length}.`);
  }

  const vector = new Uint32Array(bundle.genes.length);

  for (let geneIndex = 0; geneIndex < bundle.genes.length; geneIndex += 1) {
    vector[geneIndex] = parseCountValue(values[geneIndex], sampleId, bundle.genes[geneIndex]);
  }

  return vector;
}

function directTpmVector(bundle, sampleId, entry) {
  if (!entry) {
    throw new Error(`Selected sample ${sampleId} was not found in the TPM matrix.`);
  }

  const row = Array.isArray(entry)
    ? entry
    : parseDelimitedRecordAt(bundle.directMatrix.tpmText, entry.startIndex, bundle.directMatrix.tpmDelimiter).fields;
  const metadataColumnCount = Number(bundle.dataset.tpmMetadataColumnCount ?? bundle.manifest.metadataColumnCount);
  const values = Array.isArray(entry)
    ? row
    : row.slice(metadataColumnCount);

  if (values.length !== bundle.genes.length) {
    throw new Error(`TPM vector length mismatch for ${sampleId}: ${values.length} vs ${bundle.genes.length}.`);
  }

  const vector = new Float32Array(bundle.genes.length);

  for (let geneIndex = 0; geneIndex < bundle.genes.length; geneIndex += 1) {
    vector[geneIndex] = parseTpmValue(values[geneIndex]);
  }

  return vector;
}

function sampleFileName(sample) {
  return sample.fileStem || sample.sample_id || sample.SRA || sample.sample || sample.id;
}

export function releaseDirectMatrixCache(bundle, kind = "all") {
  if (!bundle?.directMatrix) {
    return;
  }

  if (kind === "all" || kind === "count") {
    bundle.directMatrix.countText = null;
    bundle.directMatrix.countDelimiter = null;
    bundle.directMatrix.countRowsBySampleId = new Map();
  }

  if (kind === "all" || kind === "tpm") {
    bundle.directMatrix.tpmText = null;
    bundle.directMatrix.tpmDelimiter = null;
    bundle.directMatrix.tpmRowsBySampleId = new Map();
  }
}

export async function fetchSampleVector(bundle, sample, kind, onProgress = null) {
  const dataset = bundle.dataset;
  const fileName = kind === "count"
    ? sample.countFile || `${sampleFileName(sample)}.bin.gz`
    : sample.tpmFile || `${sampleFileName(sample)}.bin.gz`;

  const baseUrl = kind === "count" ? dataset.countBaseUrl : dataset.tpmBaseUrl;
  const url = new URL(fileName, new URL(baseUrl, window.location.href)).href;

  const compressed = await fetchArrayBufferWithProgress(
    url,
    onProgress,
    { cache: "force-cache" }
  );
  const raw = await gunzipArrayBuffer(compressed);

  if (kind === "count") {
    const vector = new Uint32Array(raw);
    if (vector.length !== bundle.genes.length) {
      throw new Error(`Count vector length mismatch for ${sample.sample_id}: ${vector.length} vs ${bundle.genes.length}.`);
    }
    return vector;
  }

  const vector = new Float32Array(raw);
  if (vector.length !== bundle.genes.length) {
    throw new Error(`TPM vector length mismatch for ${sample.sample_id}: ${vector.length} vs ${bundle.genes.length}.`);
  }
  return vector;
}

export async function loadAnnotations(bundle) {
  if (!bundle.dataset.annotationUrl) {
    return { columns: [], byGene: new Map(), warnings: ["No annotation URL is configured."] };
  }

  if (bundle.directMatrix) {
    return await loadDirectAnnotations(bundle);
  }

  const payload = await fetchGzipJson(bundle.dataset.annotationUrl);
  const rows = payload.rows || [];
  const columns = payload.columns || [];
  const byGene = new Map();
  let duplicateCount = 0;

  for (const row of rows) {
    const geneId = row.gene_id || row.gene || row[columns[0]];
    if (!geneId) {
      continue;
    }

    if (byGene.has(geneId)) {
      duplicateCount += 1;
      continue;
    }

    byGene.set(geneId, row);
  }

  const warnings = [];
  if (duplicateCount > 0) {
    warnings.push(`${duplicateCount.toLocaleString()} duplicate annotation gene IDs were ignored after the first match.`);
  }

  return { columns, byGene, warnings };
}

async function loadDirectAnnotations(bundle) {
  const dataset = bundle.dataset;
  const text = await fetchMaybeCompressedText(dataset.annotationUrl);
  const delimiter = detectConfiguredDelimiter({
    delimiter: dataset.annotationDelimiter || dataset.delimiter
  }, dataset.annotationUrl);
  const { rows } = parseDelimitedRows(text, delimiter);

  if (rows.length === 0) {
    return { columns: [], byGene: new Map(), warnings: ["Annotation file is empty."] };
  }

  const hasHeader = dataset.annotationHasHeader !== false;
  let columns = hasHeader
    ? normalizeHeaderNames(rows[0], "annotation")
    : normalizeHeaderNames(dataset.annotationColumns || rows[0].map((_, index) => `annotation_${index + 1}`), "annotation");
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const geneColumnIndex = findColumnIndex(columns, dataset.annotationGeneIdColumn, [
    "gene_id",
    "gene",
    "Gene ID",
    "ID"
  ]);

  if (geneColumnIndex < 0) {
    throw new Error("Could not identify the annotation gene ID column. Set annotationGeneIdColumn or annotationColumns in config/datasets.json.");
  }

  const byGene = new Map();
  let duplicateCount = 0;

  for (const row of dataRows) {
    if (!row.some((value) => value !== "")) {
      continue;
    }

    if (row.length > columns.length) {
      const extraColumns = row.slice(columns.length).map((_, index) => `annotation_extra_${index + 1}`);
      columns = [...columns, ...extraColumns];
    }

    const geneId = String(row[geneColumnIndex] || "").trim();
    if (!geneId) {
      continue;
    }

    if (byGene.has(geneId)) {
      duplicateCount += 1;
      continue;
    }

    const record = {};
    columns.forEach((column, index) => {
      record[column] = row[index] ?? "";
    });
    record.gene_id = record.gene_id || geneId;
    byGene.set(geneId, record);
  }

  const warnings = [];
  if (duplicateCount > 0) {
    warnings.push(`${duplicateCount.toLocaleString()} duplicate annotation gene IDs were ignored after the first match.`);
  }

  return { columns, byGene, warnings };
}

export function buildCountCsvFromVectors(genes, samples, vectorsBySample) {
  const sampleIds = samples.map((sample) => sample.sample_id || sample.SRA || sample.sample);
  const lines = [`gene_id,${sampleIds.map((sample) => csvEscape(sample, { protectFormula: false })).join(",")}`];

  for (let geneIndex = 0; geneIndex < genes.length; geneIndex += 1) {
    const values = sampleIds.map((sampleId) => vectorsBySample.get(sampleId)[geneIndex]);
    lines.push(`${csvEscape(genes[geneIndex], { protectFormula: false })},${values.join(",")}`);
  }

  return lines.join("\n") + "\n";
}

export function buildCountCsvFromUpload(uploaded, samples) {
  const sampleIndexes = samples.map((sample) => uploaded.sampleNames.indexOf(sample.sample_id));

  if (sampleIndexes.some((index) => index < 0)) {
    throw new Error("Selected upload sample is not present in the parsed count matrix.");
  }

  const lines = [`gene_id,${samples.map((sample) => csvEscape(sample.sample_id, { protectFormula: false })).join(",")}`];
  const sampleCount = uploaded.sampleNames.length;

  for (let geneIndex = 0; geneIndex < uploaded.geneIds.length; geneIndex += 1) {
    const offset = geneIndex * sampleCount;
    const values = sampleIndexes.map((sampleIndex) => uploaded.counts[offset + sampleIndex]);
    lines.push(`${csvEscape(uploaded.geneIds[geneIndex], { protectFormula: false })},${values.join(",")}`);
  }

  return lines.join("\n") + "\n";
}

export function buildColDataCsv(controlSamples, treatmentSamples) {
  const rows = [
    ...controlSamples.map((sample) => ({ sample: sample.sample_id, group: "control" })),
    ...treatmentSamples.map((sample) => ({ sample: sample.sample_id, group: "treatment" }))
  ];

  return objectsToCsv(rows, ["sample", "group"]);
}

export async function loadSelectedCountVectors(bundle, samples, onProgress) {
  const vectorsBySample = new Map();

  try {
    if (bundle.directMatrix) {
      await ensureDirectCountRows(bundle, samples, onProgress);
    }

    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      const sampleId = sample.sample_id || sample.SRA || sample.sample;
      onProgress?.(bundle.directMatrix
        ? `Preparing selected count vectors (${index + 1}/${samples.length}): ${sampleId}`
        : `Loading selected count files (${index + 1}/${samples.length}): ${sampleId}`);
      const vector = bundle.directMatrix
        ? directCountVector(bundle, sampleId)
        : await fetchSampleVector(bundle, sample, "count");
      vectorsBySample.set(sampleId, vector);
    }
  } finally {
    releaseDirectMatrixCache(bundle, "count");
  }

  return vectorsBySample;
}

export async function loadSelectedTpmVectors(bundle, samples, onProgress, options = {}) {
  const vectorsBySample = new Map();
  const warnings = [];
  let directTpmRows = null;
  const hasSampleTpmVectors = Boolean(bundle.dataset.tpmBaseUrl);

  if (bundle.dataset.geneLengthUrl) {
    try {
      const calculatedVectors = await calculateSelectedTpmVectorsFromGeneLengths(
        bundle,
        samples,
        onProgress,
        options.countVectorsBySample
      );
      return {
        vectorsBySample: calculatedVectors,
        warnings
      };
    } catch (error) {
      warnings.push(`TPM calculation from gene lengths failed; falling back to TPM matrix: ${error.message}`);
    }
  }

  if (bundle.directMatrix && !hasSampleTpmVectors) {
    if (!bundle.dataset.tpmUrl) {
      return {
        vectorsBySample,
        warnings: [
          ...warnings,
          "No TPM URL is configured for this dataset."
        ]
      };
    }

    try {
      onProgress?.("Getting TPM data");
      directTpmRows = await loadDirectTpmRows(bundle, samples, onProgress);
    } catch (error) {
      releaseDirectMatrixCache(bundle, "tpm");
      return {
        vectorsBySample,
        warnings: [
          ...warnings,
          `TPM failed: ${error.message}`
        ]
      };
    }
  }

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const sampleId = sample.sample_id || sample.SRA || sample.sample;
    onProgress?.("Getting TPM data");

    try {
      const vector = bundle.directMatrix && !hasSampleTpmVectors
        ? directTpmVector(bundle, sampleId, directTpmRows.get(sampleId))
        : await fetchSampleVector(bundle, sample, "tpm");
      vectorsBySample.set(sampleId, vector);
    } catch (error) {
      warnings.push(`TPM failed for ${sampleId}: ${error.message}`);
    }
  }

  releaseDirectMatrixCache(bundle, "tpm");
  return { vectorsBySample, warnings };
}
