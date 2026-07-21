import {
  gunzipArrayBuffer,
  parseDelimitedRows
} from "../utils.js";

const R_INTEGER_MAX = 2147483647;

function fail(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  throw error;
}

function parseCountToken(token, lineNumber, columnName) {
  const value = String(token ?? "").trim();

  if (value === "") {
    fail(`Missing count at line ${lineNumber}, column "${columnName}".`, {
      lineNumber,
      columnName
    });
  }

  if (value.startsWith("-")) {
    fail(`Negative count at line ${lineNumber}, column "${columnName}".`, {
      lineNumber,
      columnName
    });
  }

  if (/[.]/.test(value)) {
    fail(`Decimal count at line ${lineNumber}, column "${columnName}".`, {
      lineNumber,
      columnName
    });
  }

  if (!/^\+?\d+(?:[eE][+-]?\d+)?$/.test(value)) {
    fail(`Invalid count "${value}" at line ${lineNumber}, column "${columnName}".`, {
      lineNumber,
      columnName
    });
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    fail(`Non-finite count at line ${lineNumber}, column "${columnName}".`, {
      lineNumber,
      columnName
    });
  }

  if (!Number.isInteger(number)) {
    fail(`Scientific notation is not an integer at line ${lineNumber}, column "${columnName}".`, {
      lineNumber,
      columnName
    });
  }

  if (number > R_INTEGER_MAX) {
    fail(`Count exceeds R integer range at line ${lineNumber}, column "${columnName}".`, {
      lineNumber,
      columnName
    });
  }

  return number;
}

function duplicateName(values) {
  const seen = new Set();

  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }

  return null;
}

async function parseUpload({ buffer, fileName }) {
  const decompressed = await gunzipArrayBuffer(buffer);
  const text = new TextDecoder("utf-8").decode(decompressed);
  const { rows, delimiter } = parseDelimitedRows(text);

  if (rows.length < 2) {
    fail("The count matrix must contain a header row and at least one gene row.");
  }

  const headers = rows[0].map((header) => header.trim());
  if (headers.length < 3) {
    fail("The count matrix needs one gene ID column and at least two sample columns.");
  }

  if (!headers[0]) {
    fail("The first header cell must be the gene ID column.");
  }

  const sampleNames = headers.slice(1);
  const duplicateSample = duplicateName(sampleNames);
  if (duplicateSample) {
    fail(`Duplicate sample name: ${duplicateSample}`, {
      columnName: duplicateSample
    });
  }

  if (sampleNames.some((sampleName) => sampleName === "")) {
    fail("Sample names must not be empty.");
  }

  const geneIds = [];
  const seenGenes = new Set();
  const sampleCount = sampleNames.length;
  const geneCount = rows.length - 1;
  const counts = new Uint32Array(geneCount * sampleCount);
  const warnings = [];
  let maxCount = 0;
  let nonZeroCount = 0;

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const lineNumber = rowIndex + 1;
    const row = rows[rowIndex];

    if (row.length === 1 && row[0] === "") {
      continue;
    }

    if (row.length !== headers.length) {
      fail(`Line ${lineNumber} has ${row.length} columns; expected ${headers.length}.`, {
        lineNumber
      });
    }

    const geneId = row[0].trim();
    if (!geneId) {
      fail(`Gene ID is empty at line ${lineNumber}.`, { lineNumber });
    }

    if (seenGenes.has(geneId)) {
      fail(`Duplicate gene ID "${geneId}" at line ${lineNumber}.`, {
        lineNumber,
        geneId
      });
    }

    if (geneId.length > 240) {
      warnings.push(`Very long gene ID at line ${lineNumber}: ${geneId.slice(0, 40)}...`);
    }

    seenGenes.add(geneId);
    geneIds.push(geneId);

    const outputOffset = (geneIds.length - 1) * sampleCount;

    for (let columnIndex = 1; columnIndex < headers.length; columnIndex += 1) {
      const value = parseCountToken(row[columnIndex], lineNumber, headers[columnIndex]);
      counts[outputOffset + columnIndex - 1] = value;
      maxCount = Math.max(maxCount, value);
      if (value !== 0) {
        nonZeroCount += 1;
      }
    }

    if (rowIndex % 1000 === 0) {
      self.postMessage({
        type: "progress",
        message: `Parsed ${rowIndex.toLocaleString()} genes`,
        loaded: rowIndex,
        total: geneCount
      });
    }
  }

  if (geneIds.length === 0) {
    fail("The count matrix does not contain any gene rows.");
  }

  if (nonZeroCount === 0) {
    warnings.push("All count values are zero. DESeq2 size-factor estimation is expected to fail.");
  }

  const sampleRows = sampleNames.map((sampleName) => ({
    sample_id: sampleName,
    SRA: sampleName
  }));

  return {
    type: "done",
    fileName,
    delimiter,
    sampleNames,
    sampleRows,
    geneIds,
    geneCount: geneIds.length,
    sampleCount,
    maxCount,
    nonZeroCount,
    warnings,
    counts: counts.buffer
  };
}

self.addEventListener("message", async (event) => {
  try {
    if (event.data?.type !== "parse") {
      return;
    }

    self.postMessage({
      type: "progress",
      message: "Reading uploaded count matrix"
    });

    const result = await parseUpload(event.data);
    self.postMessage(result, [result.counts]);
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error.message || String(error),
      lineNumber: error.lineNumber || null,
      columnName: error.columnName || null,
      geneId: error.geneId || null
    });
  }
});
