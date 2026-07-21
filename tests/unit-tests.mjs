import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  classifyDirection,
  csvEscape,
  detectDelimiter,
  makeExternalLink,
  objectsToCsv,
  parseDelimitedRows,
  rowsToObjects
} from "../js/utils.js";
import {
  loadAnnotations,
  loadDatasetBundle,
  releaseDirectMatrixCache,
  loadSelectedCountVectors,
  loadSelectedTpmVectors
} from "../js/data-loader.js";
import {
  buildBinaryCountMatrix,
  buildBinaryCountMatrixFromVectors,
  buildConsoleRJobCommand,
  buildCountCsvFromBinaryMatrix,
  encodeGeneIdLines,
  encodeInt32LittleEndian,
  buildNormalizedCsv,
  buildNormalizedOutputs,
  isWebRBridgeError,
  monitorConsoleRJob,
  prefilterBinaryCountMatrix
} from "../js/deseq-runner.js";
import { getWebRChannelSupport } from "../js/webr-manager.js";
import {
  APP_CONFIG,
  COLUMN_LABELS,
  DEFAULT_PARAMETERS,
  DEFAULT_PLOTS,
  RESULT_COLUMN_LABELS,
  RESULT_COLUMNS,
  SAMPLE_COLUMNS
} from "../js/config.js";

const fixtureDir = new URL("./fixtures/", import.meta.url);
const appRoot = new URL("../", import.meta.url);
const virtualFiles = new Map();
globalThis.window = { location: { href: appRoot.href } };

const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const appSource = fs.readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const cssSource = fs.readFileSync(new URL("../css/deseq-app.css", import.meta.url), "utf8");
const runnerSource = fs.readFileSync(new URL("../js/deseq-runner.js", import.meta.url), "utf8");
const stagedRunnerSource = fs.readFileSync(new URL("../js/deseq-staged-runner.js", import.meta.url), "utf8");

function readFixture(name) {
  return fs.readFileSync(new URL(name, fixtureDir), "utf8");
}

globalThis.fetch = async (specifier) => {
  const url = new URL(specifier, appRoot);

  if (virtualFiles.has(url.href)) {
    return new Response(virtualFiles.get(url.href), { status: 200 });
  }

  if (url.protocol !== "file:") {
    throw new Error(`Unexpected test fetch URL: ${url.href}`);
  }

  const fileUrl = new URL(url.href);
  const decodedGzip = fileUrl.searchParams.get("decoded-gzip") === "1";
  fileUrl.search = "";

  if (!fs.existsSync(fileUrl)) {
    return new Response("not found", { status: 404 });
  }

  const bytes = fs.readFileSync(fileUrl);

  if (decodedGzip) {
    return new Response(zlib.gunzipSync(bytes), {
      status: 200,
      headers: {
        "content-encoding": "gzip"
      }
    });
  }

  return new Response(bytes, { status: 200 });
};

function validateCountMatrix(text) {
  const { rows } = parseDelimitedRows(text);
  const { headers } = rowsToObjects(rows);
  assert.ok(headers.length >= 3);
  assert.equal(new Set(headers.slice(1)).size, headers.slice(1).length, "sample name duplicate detection");

  const seenGenes = new Set();
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const gene = row[0];
    assert.ok(!seenGenes.has(gene), "gene ID duplicate detection");
    seenGenes.add(gene);
    for (let columnIndex = 1; columnIndex < row.length; columnIndex += 1) {
      const value = row[columnIndex];
      assert.notEqual(value, "", "missing count detection");
      assert.ok(!value.startsWith("-"), "negative count detection");
      assert.ok(!value.includes("."), "decimal count detection");
      const number = Number(value);
      assert.ok(Number.isFinite(number) && Number.isInteger(number), "count validation");
    }
  }
}

assert.deepEqual(
  getWebRChannelSupport({
    crossOriginIsolated: true,
    SharedArrayBuffer: class SharedArrayBuffer {}
  }),
  {
    crossOriginIsolated: true,
    sharedArrayBufferAvailable: true,
    channelType: "SharedArrayBuffer"
  }
);
assert.equal(
  getWebRChannelSupport({
    crossOriginIsolated: false,
    SharedArrayBuffer: class SharedArrayBuffer {}
  }).channelType,
  "PostMessage"
);

assert.equal(
  isWebRBridgeError({
    name: "TypeError",
    message: "Cannot read properties of undefined (reading 'length')",
    stack: "at lengthBytesUTF8 (https://example.test/deseq2/webr/R.js:1:2)"
  }),
  true,
  "Emscripten string-conversion failures are classified as webR bridge errors"
);
assert.equal(
  isWebRBridgeError(new Error("DESeq2 rejected the design formula")),
  false,
  "ordinary analysis errors are not mislabeled as bridge failures"
);

const consoleRJobCommand = buildConsoleRJobCommand({
  scriptPath: "/tmp/analysis.R",
  bootstrapPath: "/tmp/bootstrap.txt",
  runToken: "unit-test"
});
assert.match(consoleRJobCommand, /CONSOLE_STARTED/);
assert.match(consoleRJobCommand, /CONSOLE_OK/);
assert.match(consoleRJobCommand, /\.browser_deseq2_parsed_job/);
assert.match(consoleRJobCommand, /base::eval/);
assert.doesNotMatch(consoleRJobCommand, /base::sys\.source/);
assert.match(consoleRJobCommand, /browser_deseq2_progress_token/);
assert.match(consoleRJobCommand, /R console accepted job/);
assert.match(consoleRJobCommand, /DESEQ2_CONSOLE_DONE\|unit-test\|/);
assert.equal(consoleRJobCommand.includes("\n"), false);

const consoleProgress = [];
const consoleMessages = [
  { type: "stdout", data: "DESEQ2_PROGRESS|unit-test|5. Estimating dispersions" },
  { type: "stdout", data: "DESEQ2_CONSOLE_DONE|unit-test|OK" }
];
assert.equal(
  await monitorConsoleRJob(
    { read: async () => consoleMessages.shift() },
    "unit-test",
    (message) => consoleProgress.push(message),
    1000
  ),
  "OK"
);
assert.deepEqual(consoleProgress, ["DESeq2: 5. Estimating dispersions"]);
const encodedIntegers = encodeInt32LittleEndian(new Int32Array([1, 256, 2147483647]));
const encodedIntegerView = new DataView(
  encodedIntegers.buffer,
  encodedIntegers.byteOffset,
  encodedIntegers.byteLength
);
assert.equal(encodedIntegers.byteLength, 12);
assert.equal(encodedIntegerView.getInt32(0, true), 1);
assert.equal(encodedIntegerView.getInt32(4, true), 256);
assert.equal(encodedIntegerView.getInt32(8, true), 2147483647);
assert.equal(new TextDecoder().decode(encodeGeneIdLines(["g1", "g2"])), "g1\ng2\n");
assert.throws(() => encodeGeneIdLines(["g1\nbad"]), /single-line/);

assert.equal(detectDelimiter("gene_id,A,B,C"), ",");
assert.equal(detectDelimiter("gene_id\tA\tB\tC"), "\t");

validateCountMatrix(readFixture("valid_counts.csv"));
validateCountMatrix(readFixture("valid_counts.tsv"));

assert.throws(() => validateCountMatrix(readFixture("duplicate_gene.csv")), /duplicate/i);
assert.throws(() => validateCountMatrix(readFixture("duplicate_sample.csv")), /duplicate/i);
assert.throws(() => validateCountMatrix(readFixture("decimal_count.csv")), /decimal/i);
assert.throws(() => validateCountMatrix(readFixture("negative_count.csv")), /negative/i);
assert.throws(() => validateCountMatrix(readFixture("missing_count.csv")), /missing/i);

assert.equal(
  classifyDirection({ padj: "0.01", log2FoldChange: "2" }, 0.05, 1),
  "Up"
);
assert.equal(
  classifyDirection({ padj: "0.01", log2FoldChange: "-2" }, 0.05, 1),
  "Down"
);
assert.equal(
  classifyDirection({ padj: "0.2", log2FoldChange: "2" }, 0.05, 1),
  "Not significant"
);
assert.equal(
  classifyDirection({ padj: "", log2FoldChange: "2" }, 0.05, 1),
  "Filtered / NA"
);

assert.equal(csvEscape("plain"), "plain");
assert.equal(csvEscape("a,b"), '"a,b"');
assert.equal(csvEscape("=SUM(A1:A2)"), "'=SUM(A1:A2)");
assert.equal(
  objectsToCsv([{ a: "<b>", b: "@x" }], ["a", "b"]),
  "a,b\r\n<b>,'@x\r\n"
);

assert.equal(
  buildNormalizedCsv(
    "gene_id,A,B\r\ngene1,10,20\r\ngene2,3,9\r\n",
    [
      { sample: "A", size_factor: "2" },
      { sample: "B", size_factor: "3" }
    ]
  ),
  "gene_id,A,B\r\ngene1,5,6.666666666666667\r\ngene2,1.5,3\r\n"
);

assert.throws(
  () => buildNormalizedCsv(
    "gene_id,A\r\ngene1,10\r\n",
    [{ sample: "A", size_factor: "0" }]
  ),
  /size factor/i
);

const binaryMatrix = buildBinaryCountMatrix(
  "gene_id,A,B,C,D\r\ngene1,1,2,3,4\r\ngene2,5,6,7,8\r\n"
);
assert.deepEqual(binaryMatrix.sampleNames, ["A", "B", "C", "D"]);
assert.deepEqual(binaryMatrix.geneIds, ["gene1", "gene2"]);
assert.equal(binaryMatrix.geneCount, 2);
assert.equal(binaryMatrix.sampleCount, 4);
assert.deepEqual(
  [...binaryMatrix.counts],
  [1, 5, 2, 6, 3, 7, 4, 8],
  "binary counts must use R-compatible column-major order"
);
assert.equal(
  buildCountCsvFromBinaryMatrix(binaryMatrix),
  "gene_id,A,B,C,D\r\ngene1,1,2,3,4\r\ngene2,5,6,7,8\r\n"
);

const vectorGenes = ["g1", "g2", "g3", "g4"];
const vectorSamples = ["C1", "C2", "C3", "T1", "T2", "T3"].map(
  (sample_id) => ({ sample_id })
);
const vectorValues = [
  [10, 20, 30, 40],
  [10, 20, 30, 40],
  [10, 20, 30, 40],
  [10, 20, 30, 40],
  [10, 20, 30, 40],
  [10, 20, 30, 40]
];
const vectors = new Map(
  vectorSamples.map((sample, index) => [sample.sample_id, Uint32Array.from(vectorValues[index])])
);
const vectorMatrix = buildBinaryCountMatrixFromVectors(
  vectorGenes,
  vectorSamples,
  vectors
);
const filteredMatrix = prefilterBinaryCountMatrix(
  vectorMatrix,
  { preFiltering: true, minimumCount: 5 }
);
assert.deepEqual(filteredMatrix.fitMatrix.geneIds, vectorGenes);
assert.deepEqual([...filteredMatrix.keepMask], [1, 1, 1, 1]);
assert.equal(filteredMatrix.summary.fittedGenes, vectorGenes.length);

const uncappedGeneCount = 9002;
const uncappedCounts = new Int32Array(uncappedGeneCount * 6).fill(10);
for (let sampleIndex = 0; sampleIndex < 6; sampleIndex += 1) {
  uncappedCounts[sampleIndex * uncappedGeneCount + uncappedGeneCount - 1] = 0;
}
const uncappedMatrix = prefilterBinaryCountMatrix(
  {
    sampleNames: ["C1", "C2", "C3", "T1", "T2", "T3"],
    geneIds: Array.from({ length: uncappedGeneCount }, (_value, index) => `uncapped_${index + 1}`),
    geneCount: uncappedGeneCount,
    sampleCount: 6,
    counts: uncappedCounts
  },
  { preFiltering: true, minimumCount: 5 }
);
assert.equal(uncappedMatrix.fitMatrix.geneCount, 9001);
assert.equal(uncappedMatrix.fitMatrix.geneIds.at(-1), "uncapped_9001");
assert.equal(uncappedMatrix.keepMask.at(-1), 0);

const smallStagedMatrix = prefilterBinaryCountMatrix(
  {
    sampleNames: ["C1", "C2", "C3", "T1", "T2", "T3"],
    geneIds: ["low_but_valid"],
    geneCount: 1,
    sampleCount: 6,
    counts: new Int32Array([1, 1, 1, 1, 1, 1])
  },
  { preFiltering: true, minimumCount: 5 }
);
assert.equal(smallStagedMatrix.fitMatrix.geneCount, 1);
assert.equal(smallStagedMatrix.fitMatrix.geneIds[0], "low_but_valid");

const normalizedOutputs = buildNormalizedOutputs(
  vectorMatrix,
  vectorSamples.map((sample) => ({
    sample: sample.sample_id,
    size_factor: "1"
  })),
  vectorSamples.map((sample, index) => ({
    sample: sample.sample_id,
    group: index < 3 ? "control" : "treatment"
  }))
);
assert.equal(normalizedOutputs.normalizedBoxplot.length, 6);
assert.equal(normalizedOutputs.normalizedStats.controlMean[3], 40);
assert.equal(normalizedOutputs.normalizedStats.treatmentMedian[0], 10);

assert.equal(
  makeExternalLink("https://webpark2116.sakura.ne.jp/RNADB/PM/PM.html?gene={gene}", "dpca0g000640.840"),
  "https://webpark2116.sakura.ne.jp/RNADB/PM/PM.html?gene=dpca0g000640.840"
);
assert.equal(
  makeExternalLink("https://webpark2116.sakura.ne.jp/rlgpr/result.php?geneid={gene}", "dpca0g000640.840"),
  "https://webpark2116.sakura.ne.jp/rlgpr/result.php?geneid=dpca0g000640.840"
);
assert.equal(makeExternalLink("javascript:alert(1)", "x"), null);
assert.equal(Object.hasOwn(DEFAULT_PLOTS, "dispersion"), false);
assert.equal(Object.hasOwn(DEFAULT_PLOTS, "sizeFactor"), false);
assert.equal(Object.hasOwn(DEFAULT_PLOTS, "normalizedCountBoxplot"), false);
assert.equal(COLUMN_LABELS.sample_id, "Sample ID");
assert.equal(COLUMN_LABELS.SRA, "Sample ID");
assert.equal(SAMPLE_COLUMNS.includes("sample_id"), true);
assert.equal(SAMPLE_COLUMNS.includes("SRA"), false);
assert.equal(RESULT_COLUMNS.includes("annotation"), false);
assert.equal(RESULT_COLUMNS.includes("arabidopsis_homolog"), true);
assert.equal(RESULT_COLUMNS.includes("rice_homolog"), true);
assert.equal(RESULT_COLUMNS.includes("stat"), true);
assert.equal(RESULT_COLUMNS.includes("control_normalized_mean"), false);
assert.equal(RESULT_COLUMNS.includes("treatment_normalized_mean"), false);
assert.equal(RESULT_COLUMNS.includes("control_normalized_median"), false);
assert.equal(RESULT_COLUMNS.includes("treatment_normalized_median"), false);
assert.equal(RESULT_COLUMN_LABELS.gene_id, "Gene ID");
assert.equal(RESULT_COLUMN_LABELS.gexa_link, "GExA link");
assert.equal(RESULT_COLUMN_LABELS.tgif_link, "TGIF-DB link");
assert.equal(RESULT_COLUMN_LABELS.control_tpm_mean, "Control TPM mean");
assert.equal(RESULT_COLUMN_LABELS.treatment_tpm_mean, "Treatment TPM mean");
assert.equal(RESULT_COLUMN_LABELS.control_tpm_median, "Control TPM median");
assert.equal(RESULT_COLUMN_LABELS.treatment_tpm_median, "Treatment TPM median");
assert.equal(RESULT_COLUMN_LABELS.arabidopsis_homolog, "Arabidopsis homolog");
assert.equal(RESULT_COLUMN_LABELS.rice_homolog, "Rice homolog");
assert.equal(APP_CONFIG.appVersion, "20260717");
assert.equal(DEFAULT_PARAMETERS.test, "Wald");
assert.equal(Object.hasOwn(DEFAULT_PARAMETERS, "parallel"), false);
assert.match(indexHtml, />Run DEG analysis<\/button>/);
assert.match(indexHtml, />Stop analysis<\/button>/);
assert.match(indexHtml, /STEP 1\.[\s\S]*?Select data/);
assert.match(indexHtml, /id="controlSelector"[^>]*>[\s\S]*?STEP 2\. Select control samples/);
assert.match(indexHtml, /id="treatmentSelector"[^>]*>[\s\S]*?STEP 3\. Select treatment samples/);
assert.match(indexHtml, /STEP 4\.[\s\S]*?Set analysis parameters/);
assert.match(indexHtml, /id="analysisEngine"[\s\S]*?R \/ DESeq2 \(standard\)/);
assert.match(indexHtml, /High-speed edgeR-like Z-test/);
assert.match(indexHtml, /id="p-mode"[\s\S]*?FDR \(Benjamini-Hochberg\)/);
assert.match(indexHtml, /STEP 5\.[\s\S]*?Select plots/);
assert.doesNotMatch(indexHtml, /DESeq2-normalized count boxplot/);
assert.match(indexHtml, /Use a raw integer count matrix/);
assert.match(indexHtml, /Put Gene ID in the first column and sample names in all remaining columns/);
assert.match(indexHtml, /id="showExampleMatrix"/);
assert.match(indexHtml, /id="downloadExampleMatrix"/);
assert.match(appSource, /EXAMPLE_COUNT_MATRIX_GENE_COUNT = 200/);
assert.match(appSource, /example_count_matrix_200_genes_6_samples\.csv/);
assert.match(appSource, /Getting TPM data/);
assert.doesNotMatch(appSource, /Streaming selected TPM rows/);
assert.doesNotMatch(appSource, /Preparing selected TPM vectors/);
assert.match(indexHtml, /DESeq2 independent filtering[\s\S]*?multiple-testing adjustment\./);
assert.match(indexHtml, /<select id="testType">[\s\S]*?<option value="Wald">Wald<\/option>[\s\S]*?<option value="LRT">LRT<\/option>/);
assert.doesNotMatch(indexHtml, /Parallel processing/i);
assert.equal(indexHtml.includes(["20260715", "37"].join("-")), false);
assert.doesNotMatch(indexHtml, /Large-run fitting limit/);
assert.doesNotMatch(indexHtml, />3,000 - Fast<|>5,000 - Balanced<|>8,000 - Comprehensive</);
assert.doesNotMatch(indexHtml, /I understand the BioProject batch-effect warning/);
assert.doesNotMatch(indexHtml, /I understand the heatmap performance warning/);
assert.doesNotMatch(appSource, /Large browser run: genes must also have count/);
assert.doesNotMatch(appSource, /largeRunGeneLimit|fitting limit/);
assert.doesNotMatch(runnerSource, /largeRunGeneLimit|maxGenes|browser_safety_max_genes|genes_before_browser_cap/);
assert.doesNotMatch(stagedRunnerSource, /maxGenes|browser_safety_max_genes|safety_max_genes/);
assert.doesNotMatch(appSource, /\bparallel\b/i);
assert.doesNotMatch(runnerSource, /parallel\s*=\s*FALSE/i);
assert.doesNotMatch(stagedRunnerSource, /parallel\s*=\s*FALSE/i);
assert.match(runnerSource, /DESeq2::nbinomLRT/);
assert.match(stagedRunnerSource, /DESeq2::nbinomLRT/);
assert.match(appSource, /document\.querySelectorAll\("button, input, select"\)/);
assert.match(appSource, /el\.analysisActivity\.hidden = true/);
assert.match(appSource, /window\.location\.reload\(\)/);
assert.match(appSource, /Building upload count matrix/);
assert.match(appSource, /buildBinaryCountMatrixFromUpload\(state\.uploaded, allSamples\)/);
assert.doesNotMatch(appSource, /buildCountCsvFromUpload\(state\.uploaded, allSamples\)/);
assert.match(runnerSource, /const stagedMatrixRun = Boolean\(countMatrix\)/);
assert.match(runnerSource, /Uploaded count matrix uses staged PostMessage compatibility mode/);
assert.doesNotMatch(runnerSource, /safetyFilter|samplesAtSafetyCount|Browser safety filter|count_matrix >= browser_safety_min_count/);
assert.match(runnerSource, /browser_safety_filter: "FALSE"/);
assert.match(runnerSource, /estimateDispersionsGeneEst/);
assert.match(runnerSource, /dispersion_fit_type_used <<- "gene-wise"/);
assert.match(runnerSource, /const bridgeRuntimeError = !rAnalysisError/);
assert.match(stagedRunnerSource, /estimateDispersionsGeneEst/);
assert.match(stagedRunnerSource, /error\.rAnalysisError = true/);
assert.match(cssSource, /--base-font-size: 15px/);
assert.match(cssSource, /html\s*\{[^}]*font-size: var\(--base-font-size\)/s);
assert.match(cssSource, /\.site-header nav a\s*\{[^}]*font-size: 1\.6rem/s);
assert.match(cssSource, /\.step-head h2\s*\{[^}]*font-size: 1\.6rem/s);
assert.match(cssSource, /\[hidden\]\s*\{[^}]*display: none !important/s);
assert.match(cssSource, /\.selector-heading h3\s*\{[^}]*font-size: 1\.6rem/s);
assert.match(cssSource, /body\s*\{[^}]*font-size: 1rem/s);

const samples = JSON.parse(readFixture("gexa_samples_fixture.json")).samples;
const leaf = samples.filter((row) => row.tissue === "leaf");
assert.equal(leaf.length, 2, "GExA sample metadata filtering");
assert.equal(new Set(samples.map((row) => row.BioProject)).size, 2, "BioProject grouping");

const geneOrderA = ["gene1", "gene2", "gene3"];
const geneOrderB = ["gene1", "gene2", "gene3"];
const geneOrderC = ["gene1", "gene3", "gene2"];
assert.deepEqual(geneOrderA, geneOrderB, "gene order match check");
assert.notDeepEqual(geneOrderA, geneOrderC, "gene order mismatch check");

const publishedCatalog = JSON.parse(fs.readFileSync(new URL("../config/datasets.json", import.meta.url), "utf8"));
assert.equal(publishedCatalog.datasets.some((dataset) => dataset.id === "example"), false);
assert.equal(publishedCatalog.datasets.length, 9);
const expectedGexaTemplates = new Map([
  ["barley", "https://webpark2116.sakura.ne.jp/RNADB/HV/HV.html?gene={gene}"],
  ["finger_millet", "https://webpark2116.sakura.ne.jp/RNADB/EC/EC.html?gene={gene}"],
  ["foxtail_millet", "https://webpark2116.sakura.ne.jp/RNADB/SI/SI.html?gene={gene}"],
  ["pearl_millet__06777R", "https://webpark2116.sakura.ne.jp/RNADB/PM_06777R/PM_06777R.html"],
  ["pearl_millet__843B", "https://webpark2116.sakura.ne.jp/RNADB/PM_843B/PM_843B.html"],
  ["pearl_millet__tift", "https://webpark2116.sakura.ne.jp/RNADB/PM/PM.html?gene={gene}"],
  ["proso_millet", "https://webpark2116.sakura.ne.jp/RNADB/Pmi/Pmi.html?gene={gene}"],
  ["rice", "https://webpark2116.sakura.ne.jp/RNADB/OS/OS.html?gene={gene}"],
  ["sorghum", "https://webpark2116.sakura.ne.jp/RNADB/SB/SB.html?gene={gene}"]
]);
const expectedReferenceDisplays = new Map([
  ["barley", "Morex (Navr\u00e1tilov\u00e1 et al. 2022)"],
  ["finger_millet", "KNE796-S (Devos et al. 2023)"],
  ["foxtail_millet", "Yugu1 (Bennetzen et al. 2012)"],
  ["pearl_millet__06777R", "06777R (Ramu et al. 2023)"],
  ["pearl_millet__843B", "843B (Ramu et al. 2023)"],
  ["pearl_millet__tift", "Tift (Ramu et al. 2023)"],
  ["proso_millet", "AJ8 (Wang et al. 2024)"],
  ["rice", "Nipponbare (Kawahara et al. 2013)"],
  ["sorghum", "BTx623 (Paterson et al. 2009)"]
]);
const expectedExternalFiles = new Map([
  ["barley", ["Barley_count_data.csv.gz", "Barley_TPM_data.csv.gz", "Barley_gene_length.tsv", "Barley_annotation.tsv"]],
  ["finger_millet", ["Finger_millet_count_data.csv.gz", "Finger_millet_TPM_data.csv.gz", "Finger_millet_gene_length.tsv", "Finger_millet_annotation.tsv"]],
  ["foxtail_millet", ["Foxtail_millet_count_data.csv.gz", "Foxtail_millet_TPM_data.csv.gz", "Foxtail_millet_gene_length.tsv", "Foxtail_millet_annotation.tsv"]],
  ["pearl_millet__06777R", ["Pearl_millet_count_data_cv_06777R.csv.gz", "Pearl_millet_TPM_data_cv_06777R.csv.gz", "Pearl_millet_gene_length_cv_06777R.tsv", "Pearl_millet_annotation_cv_06777R.tsv"]],
  ["pearl_millet__843B", ["Pearl_millet_count_data_cv_843B.csv.gz", "Pearl_millet_TPM_data_cv_843B.csv.gz", "Pearl_millet_gene_length_cv_843B.tsv", "Pearl_millet_annotation_cv_843B.tsv"]],
  ["pearl_millet__tift", ["Pearl_millet_count_data_cv_Tift.csv.gz", "Pearl_millet_TPM_data_cv_Tift.csv.gz", "Pearl_millet_gene_length_cv_Tift.tsv", "Pearl_millet_annotation_cv_Tift.tsv"]],
  ["proso_millet", ["Proso_millet_count_data.csv.gz", "Proso_millet_TPM_data.csv.gz", "Proso_millet_gene_length.tsv", "Proso_millet_annotation.tsv"]],
  ["rice", ["rice_count_data.csv.gz", "rice_TPM_data.csv.gz", "Rice_gene_length.tsv", "rice_annotation.tsv"]],
  ["sorghum", ["Sorghum_count_data.csv.gz", "Sorghum_TPM_data.csv.gz", "Sorghum_gene_length.tsv", "Sorghum_annotation.tsv"]]
]);
assert.equal(APP_CONFIG.externalDataBaseUrl, "/RNADB/Download/files/");
for (const dataset of publishedCatalog.datasets) {
  assert.equal(dataset.gexaGeneUrlTemplate, expectedGexaTemplates.get(dataset.id));
  assert.equal(dataset.referenceDisplay, expectedReferenceDisplays.get(dataset.id));
  assert.deepEqual(
    [dataset.countFile, dataset.tpmFile, dataset.geneLengthFile, dataset.annotationFile],
    expectedExternalFiles.get(dataset.id)
  );
  assert.equal(dataset.countUrl, undefined);
  assert.equal(dataset.tpmUrl, undefined);
  assert.equal(dataset.geneLengthUrl, undefined);
  assert.equal(dataset.annotationUrl, undefined);
  assert.equal(dataset.sampleMetadataUrl, undefined);
  assert.equal(dataset.geneListUrl, undefined);
  assert.equal(dataset.tpmBaseUrl, undefined);
  assert.equal(dataset.tpmVectorManifestUrl, undefined);
  if (dataset.id === "rice") {
    assert.equal(dataset.tgifGeneUrlTemplate, null);
  } else {
    assert.equal(dataset.tgifGeneUrlTemplate, "https://webpark2116.sakura.ne.jp/rlgpr/result.php?geneid={gene}");
  }
}

const virtualSampleRows = [
  ["PRJNA_DEMO", "control_1", "SAMN_DEMO_1", "control", "leaf", "seedling", "Demo", "C1", "NA", "control replicate 1"],
  ["PRJNA_DEMO", "control_2", "SAMN_DEMO_2", "control", "leaf", "seedling", "Demo", "C2", "NA", "control replicate 2"],
  ["PRJNA_DEMO", "control_3", "SAMN_DEMO_3", "control", "leaf", "seedling", "Demo", "C3", "NA", "control replicate 3"],
  ["PRJNA_DEMO", "treatment_1", "SAMN_DEMO_4", "treated", "leaf", "seedling", "Demo", "T1", "NA", "treatment replicate 1"],
  ["PRJNA_DEMO", "treatment_2", "SAMN_DEMO_5", "treated", "leaf", "seedling", "Demo", "T2", "NA", "treatment replicate 2"],
  ["PRJNA_DEMO", "treatment_3", "SAMN_DEMO_6", "treated", "leaf", "seedling", "Demo", "T3", "NA", "treatment replicate 3"]
];
const virtualSampleColumns = ["BioProject", "SRA", "BioSample", "treatment", "tissue", "stage", "cultivar", "code", "temperature", "attributes"];
const virtualGenes = ["gene0001", "gene0002", "gene0003", "gene0004", "gene0005", "gene0006", "gene0007", "gene0008"];
const virtualCounts = [
  [100, 200, 300, 400, 500, 600, 700, 800],
  [110, 210, 310, 480, 510, 610, 710, 810],
  [120, 220, 320, 420, 520, 620, 720, 820],
  [400, 300, 200, 100, 800, 700, 600, 500],
  [410, 310, 210, 110, 810, 710, 610, 510],
  [420, 320, 220, 120, 820, 720, 620, 520]
];
const virtualTpms = [
  [10.1, 20.2, 30.3, 40.4, 50.5, 60.6, 70.7, 80.8],
  [11.1, 21.2, 31.3, 41.4, 51.5, 61.6, 71.7, 81.8],
  [12.1, 22.2, 32.3, 42.4, 52.5, 62.6, 72.7, 82.8],
  [40.1, 30.2, 20.3, 10.4, 80.5, 70.6, 60.7, 50.8],
  [41.1, 31.2, 21.3, 11.4, 81.5, 71.6, 61.7, 51.8],
  [42.1, 32.2, 22.3, 12.4, 82.5, 72.6, 62.7, 52.8]
];
const virtualSampleObjects = virtualSampleRows.map((row) => {
  const sample = {};
  virtualSampleColumns.forEach((column, index) => {
    sample[column] = row[index];
  });
  sample.sample_id = sample.SRA;
  return sample;
});
const virtualCountCsv = [
  [...virtualSampleColumns, ...virtualGenes].join(","),
  ...virtualSampleRows.map((row, index) => [...row, ...virtualCounts[index]].join(","))
].join("\n") + "\n";
const virtualTpmCsv = [
  [...virtualSampleColumns, ...virtualGenes].join(","),
  ...virtualSampleRows.map((row, index) => [...row, ...virtualTpms[index]].join(","))
].join("\n") + "\n";
const virtualGeneLengthTsv = [
  "Geneid\tLength",
  ...virtualGenes.map((gene) => `${gene}\t1000`)
].join("\n") + "\n";
const virtualAnnotationTsv = [
  "gene0001\tExample upregulated gene\tOsDemo1",
  "gene0002\tExample stable gene\tOsDemo2"
].join("\n") + "\n";

function setVirtualFile(specifier, body) {
  virtualFiles.set(new URL(specifier, appRoot).href, body);
}

setVirtualFile("./test-virtual/example/samples.json", JSON.stringify({ samples: virtualSampleObjects }));
setVirtualFile("./test-virtual/example/genes.json", JSON.stringify({ genes: virtualGenes }));
setVirtualFile("./test-virtual/example/count.csv.gz", zlib.gzipSync(virtualCountCsv));
setVirtualFile("./test-virtual/example/count.csv.gz?decoded-gzip=1", virtualCountCsv);
setVirtualFile("./test-virtual/example/tpm.csv.gz", zlib.gzipSync(virtualTpmCsv));
setVirtualFile("./test-virtual/example/gene_length.tsv", virtualGeneLengthTsv);
setVirtualFile("./test-virtual/example/annotation.tsv", virtualAnnotationTsv);
setVirtualFile("./test-virtual/example/tpm-vectors/manifest.json", JSON.stringify({
  format: "float32-gzip-v1",
  geneCount: virtualGenes.length,
  sampleFiles: Object.fromEntries(virtualSampleObjects.map((sample, index) => [
    sample.sample_id,
    `${index.toString().padStart(6, "0")}.bin.gz`
  ]))
}));
virtualTpms.forEach((values, index) => {
  const vector = Float32Array.from(values);
  setVirtualFile(
    `./test-virtual/example/tpm-vectors/${index.toString().padStart(6, "0")}.bin.gz`,
    zlib.gzipSync(Buffer.from(vector.buffer))
  );
});
setVirtualFile("./test-virtual/csv-only/count.csv", virtualCountCsv);
setVirtualFile("./test-virtual/csv-only/tpm.csv", virtualTpmCsv);
setVirtualFile("./test-virtual/csv-only/annotation.tsv", virtualAnnotationTsv);

const rawDataset = {
  id: "example_fixture",
  label: "Example fixture",
  species: "Example",
  reference: "fixture",
  format: "direct_matrix",
  countUrl: "./test-virtual/example/count.csv.gz",
  matrixOrientation: "samples_as_rows",
  metadataColumnCount: 10,
  sampleIdColumn: "SRA",
  sampleMetadataUrl: "./test-virtual/example/samples.json",
  geneListUrl: "./test-virtual/example/genes.json",
  tpmBaseUrl: "./test-virtual/example/tpm-vectors/",
  tpmVectorManifestUrl: "./test-virtual/example/tpm-vectors/manifest.json",
  tpmVectorFormat: "float32-gzip-v1",
  tpmUrl: "./test-virtual/example/tpm.csv.gz",
  annotationUrl: "./test-virtual/example/annotation.tsv",
  annotationHasHeader: false,
  annotationColumns: ["gene_id", "arabidopsis_homolog", "rice_homolog"]
};
const rawBundle = await loadDatasetBundle(rawDataset);
assert.equal(rawBundle.sampleRows.length, 6, "direct GExA-style sample row count");
assert.equal(rawBundle.genes.length, 8, "direct GExA-style gene count");
assert.deepEqual(rawBundle.genes.slice(0, 3), ["gene0001", "gene0002", "gene0003"]);
assert.match(rawDataset.tpmVectorManifestUrl, /tpm-vectors\/manifest\.json$/);
assert.equal(rawBundle.sampleRows[0].tpmFile, "000000.bin.gz", "TPM manifest maps sample IDs to vector files");

const selectedRawSamples = rawBundle.sampleRows.slice(0, 2);
const rawCountVectors = await loadSelectedCountVectors(rawBundle, selectedRawSamples);
assert.equal(rawCountVectors.get("control_1")[0], 100);
assert.equal(rawCountVectors.get("control_2")[3], 480);
assert.equal(rawBundle.directMatrix.countText, null, "direct count matrix text cache is released after vector extraction");
assert.equal(rawBundle.directMatrix.countRowsBySampleId.size, 0, "direct count row cache is released after vector extraction");

const decodedGzipBundle = await loadDatasetBundle({
  ...rawDataset,
  countUrl: `${rawDataset.countUrl}?decoded-gzip=1`
});
const decodedGzipVectors = await loadSelectedCountVectors(decodedGzipBundle, selectedRawSamples);
assert.equal(decodedGzipVectors.get("control_1")[0], 100, "server-decoded gzip count matrix is not decompressed twice");

const { vectorsBySample: rawTpmVectors, warnings: rawTpmWarnings } = await loadSelectedTpmVectors(rawBundle, selectedRawSamples);
assert.deepEqual(rawTpmWarnings, []);
assert.equal(Number(rawTpmVectors.get("control_1")[0].toFixed(1)), 10.1);
assert.equal(rawBundle.directMatrix.tpmText, null, "direct TPM matrix text cache is released after vector extraction");
assert.equal(rawBundle.directMatrix.tpmRowsBySampleId.size, 0, "direct TPM row cache is released after vector extraction");

const geneLengthDataset = {
  ...rawDataset,
  id: "example_fixture_gene_length",
  geneLengthUrl: "./test-virtual/example/gene_length.tsv",
  tpmUrl: "./test-virtual/example/must-not-fetch-tpm.csv.gz"
};
delete geneLengthDataset.tpmBaseUrl;
delete geneLengthDataset.tpmVectorManifestUrl;
delete geneLengthDataset.tpmVectorFormat;
const geneLengthBundle = await loadDatasetBundle(geneLengthDataset);
const geneLengthCountVectors = await loadSelectedCountVectors(geneLengthBundle, selectedRawSamples);
const { vectorsBySample: calculatedTpmVectors, warnings: calculatedTpmWarnings } = await loadSelectedTpmVectors(
  geneLengthBundle,
  selectedRawSamples,
  null,
  { countVectorsBySample: geneLengthCountVectors }
);
assert.deepEqual(calculatedTpmWarnings, []);
assert.ok(
  Math.abs(calculatedTpmVectors.get("control_1")[0] - (100 / virtualCounts[0].reduce((sum, count) => sum + count, 0) * 1000000)) < 0.01,
  "TPM is calculated from counts and gene length when geneLengthUrl is available"
);
assert.ok(
  Math.abs(calculatedTpmVectors.get("control_2")[3] - (480 / virtualCounts[1].reduce((sum, count) => sum + count, 0) * 1000000)) < 0.01
);
assert.equal(geneLengthBundle.directMatrix.tpmRowsBySampleId?.size || 0, 0, "TPM matrix rows are not read when gene-length calculation succeeds");
geneLengthCountVectors.clear();

const badGeneLengthDataset = {
  ...geneLengthDataset,
  id: "example_fixture_bad_gene_length",
  geneLengthUrl: "./test-virtual/example/missing_gene_length.tsv",
  tpmUrl: "./test-virtual/example/tpm.csv.gz"
};
const badGeneLengthBundle = await loadDatasetBundle(badGeneLengthDataset);
const badGeneLengthCountVectors = await loadSelectedCountVectors(badGeneLengthBundle, selectedRawSamples);
const { vectorsBySample: fallbackTpmVectors, warnings: fallbackTpmWarnings } = await loadSelectedTpmVectors(
  badGeneLengthBundle,
  selectedRawSamples,
  null,
  { countVectorsBySample: badGeneLengthCountVectors }
);
assert.equal(fallbackTpmWarnings.length, 1);
assert.match(fallbackTpmWarnings[0], /TPM calculation from gene lengths failed; falling back to TPM matrix/);
assert.equal(Number(fallbackTpmVectors.get("control_1")[0].toFixed(1)), 10.1);
badGeneLengthCountVectors.clear();

const vectorBaseUrl = new URL("./fixtures/tpm-vectors/", appRoot).href;
const vectorSamplesWithFiles = selectedRawSamples.map((sample, index) => ({
  ...sample,
  tpmFile: `${index.toString().padStart(6, "0")}.bin.gz`
}));
for (let index = 0; index < vectorSamplesWithFiles.length; index += 1) {
  const values = Float32Array.from(rawBundle.genes, (_, geneIndex) => index * 100 + geneIndex + 0.25);
  virtualFiles.set(
    new URL(vectorSamplesWithFiles[index].tpmFile, vectorBaseUrl).href,
    zlib.gzipSync(Buffer.from(values.buffer))
  );
}
const vectorProgress = [];
const { vectorsBySample: fastTpmVectors, warnings: fastTpmWarnings } = await loadSelectedTpmVectors(
  {
    ...rawBundle,
    dataset: {
      ...rawBundle.dataset,
      tpmBaseUrl: vectorBaseUrl,
      tpmVectorFormat: "float32-gzip-v1"
    }
  },
  vectorSamplesWithFiles,
  (message) => vectorProgress.push(message)
);
assert.deepEqual(fastTpmWarnings, []);
assert.equal(fastTpmVectors.get("control_1")[0], 0.25);
assert.equal(fastTpmVectors.get("control_2")[3], 103.25);
assert.equal(vectorProgress.some((message) => /Loading TPM matrix/.test(message)), false);

releaseDirectMatrixCache(rawBundle);
assert.equal(rawBundle.directMatrix.countRowsBySampleId.size, 0, "explicit cache release is idempotent");

const rawAnnotations = await loadAnnotations(rawBundle);
assert.equal(rawAnnotations.byGene.get("gene0001").arabidopsis_homolog, "Example upregulated gene");
assert.equal(rawAnnotations.byGene.get("gene0001").rice_homolog, "OsDemo1");

const csvOnlyDataset = {
  ...rawDataset,
  id: "example_fixture_csv_only",
  countFile: "count.csv.gz",
  tpmFile: "tpm.csv.gz",
  annotationFile: "annotation.tsv",
  dataBaseUrl: "./test-virtual/csv-only/"
};
delete csvOnlyDataset.countUrl;
delete csvOnlyDataset.tpmUrl;
delete csvOnlyDataset.annotationUrl;
delete csvOnlyDataset.sampleMetadataUrl;
delete csvOnlyDataset.geneListUrl;
delete csvOnlyDataset.tpmBaseUrl;
delete csvOnlyDataset.tpmVectorManifestUrl;
delete csvOnlyDataset.tpmVectorFormat;

const csvOnlyProgress = [];
const csvOnlyBundle = await loadDatasetBundle(csvOnlyDataset, (message) => csvOnlyProgress.push(message));
assert.equal(csvOnlyBundle.sampleRows.length, 6, "CSV-only sample metadata row count");
assert.equal(csvOnlyBundle.genes.length, 8, "CSV-only gene count from count header");
assert.equal(csvOnlyBundle.directMatrix.countRowsBySampleId.size, 0, "CSV-only load does not retain count rows at Step 1");
assert.equal(csvOnlyBundle.dataset.countUrl.endsWith("/test-virtual/csv-only/count.csv"), true);
assert.equal(csvOnlyBundle.dataset.countFallbackUrl, null);
assert.equal(csvOnlyBundle.dataset.tpmUrl.endsWith("/test-virtual/csv-only/tpm.csv.gz"), true);
assert.equal(csvOnlyProgress.some((message) => message.includes("Count matrix header ready")), true);

const csvOnlySamples = csvOnlyBundle.sampleRows.slice(0, 2);
const csvOnlyCountVectors = await loadSelectedCountVectors(csvOnlyBundle, csvOnlySamples);
assert.equal(csvOnlyCountVectors.get("control_1")[0], 100);
assert.equal(csvOnlyCountVectors.get("control_2")[3], 480);
const { vectorsBySample: csvOnlyTpmVectors, warnings: csvOnlyTpmWarnings } = await loadSelectedTpmVectors(csvOnlyBundle, csvOnlySamples);
assert.deepEqual(csvOnlyTpmWarnings, []);
assert.equal(Number(csvOnlyTpmVectors.get("control_1")[0].toFixed(1)), 10.1);
assert.equal(csvOnlyBundle.dataset.tpmUrl.endsWith("/test-virtual/csv-only/tpm.csv"), true);
assert.equal(csvOnlyBundle.dataset.tpmFallbackUrl, null);
const csvOnlyAnnotations = await loadAnnotations(csvOnlyBundle);
assert.equal(csvOnlyAnnotations.byGene.get("gene0001").rice_homolog, "OsDemo1");

console.log("unit tests passed");
