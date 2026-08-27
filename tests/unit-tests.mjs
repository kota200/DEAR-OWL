import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  classifyDirection,
  csvEscape,
  detectDelimiter,
  fetchArrayBufferWithProgress,
  makeExternalLink,
  objectsToCsv,
  parseDelimitedRows,
  rowsToObjects
} from "../js/utils.js";
import {
  calculateProgressPercent,
  createDatasetLoadProgressController
} from "../js/dataset-progress.js";
import { runAfterDomReady } from "../js/dom-ready.js";
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
import { runPairwiseZTest } from "../js/fast-ztest.js";
import {
  buildGroupedColDataCsv,
  MAX_MULTI_GROUP_CONTRASTS,
  MultiGroupController
} from "../js/multi-group-controller.js";
import { runMultiGroupFastAnalysis } from "../js/multi-group-fast-runner.js";
import { buildStagedMultiGroupDeseq2Stages } from "../js/multi-group-staged-runner.js";
import {
  buildDirectionMatrix,
  buildGeneSet,
  computeExclusiveIntersections,
  describeIntersectionMembership
} from "../js/intersections.js";
import {
  chooseWebRChannel,
  getWebRChannelSupport,
  getWebROfflineAssetUrls,
  WebRManager,
  webrManager
} from "../js/webr-manager.js";
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
const fetchedUrls = [];
globalThis.window = { location: { href: appRoot.href } };

const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const helpHtml = fs.readFileSync(new URL("../help.html", import.meta.url), "utf8");
const appSource = fs.readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const fastZTestSource = fs.readFileSync(new URL("../js/fast-ztest.js", import.meta.url), "utf8");
const cssSource = fs.readFileSync(new URL("../css/deseq-app.css", import.meta.url), "utf8");
const runnerSource = fs.readFileSync(new URL("../js/deseq-runner.js", import.meta.url), "utf8");
const stagedRunnerSource = fs.readFileSync(new URL("../js/deseq-staged-runner.js", import.meta.url), "utf8");
const multiGroupRunnerSource = fs.readFileSync(new URL("../js/multi-group-runner.js", import.meta.url), "utf8");
const multiGroupStagedRunnerSource = fs.readFileSync(new URL("../js/multi-group-staged-runner.js", import.meta.url), "utf8");
const multiGroupControllerSource = fs.readFileSync(new URL("../js/multi-group-controller.js", import.meta.url), "utf8");
const multiGroupResultsSource = fs.readFileSync(new URL("../js/multi-group-results.js", import.meta.url), "utf8");
const offlineSupportSource = fs.readFileSync(new URL("../js/offline-support.js", import.meta.url), "utf8");
const serviceWorkerSource = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const webRRuntimeSource = fs.readFileSync(new URL("../webr/R.js", import.meta.url), "utf8");
const appBootstrapSource = fs.readFileSync(new URL("../js/app-bootstrap-20260810-shared-webr-manager.js", import.meta.url), "utf8");
const localLaunchGuardSource = fs.readFileSync(new URL("../js/local-launch-guard.js", import.meta.url), "utf8");
const localPowerShellServerSource = fs.readFileSync(new URL("../scripts/serve-local.ps1", import.meta.url), "utf8");
const localPythonServerSource = fs.readFileSync(new URL("../scripts/serve-local.py", import.meta.url), "utf8");
const localNodeServerSource = fs.readFileSync(new URL("../scripts/serve-local.mjs", import.meta.url), "utf8");
const localShellLauncherSource = fs.readFileSync(new URL("../start-local.sh", import.meta.url), "utf8");

function readFixture(name) {
  return fs.readFileSync(new URL(name, fixtureDir), "utf8");
}

globalThis.fetch = async (specifier) => {
  const url = new URL(specifier, appRoot);
  fetchedUrls.push(url.href);

  if (virtualFiles.has(url.href)) {
    const body = virtualFiles.get(url.href);
    const length = typeof body === "string"
      ? Buffer.byteLength(body)
      : body.byteLength;
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(length) }
    });
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

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  toggle(className, force) {
    const shouldHaveClass = force === undefined ? !this.values.has(className) : Boolean(force);
    if (shouldHaveClass) {
      this.values.add(className);
    } else {
      this.values.delete(className);
    }
  }

  contains(className) {
    return this.values.has(className);
  }
}

class FakeElement {
  constructor({ hidden = false } = {}) {
    this.hidden = hidden;
    this.textContent = "";
    this.style = {};
    this.attributes = new Map();
    this.classList = new FakeClassList();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }
}

function progressElements() {
  return {
    root: new FakeElement({ hidden: true }),
    label: new FakeElement(),
    percent: new FakeElement(),
    track: new FakeElement(),
    bar: new FakeElement(),
    stage: new FakeElement(),
    bytes: new FakeElement(),
    live: new FakeElement()
  };
}

function progressController(elements, timers = [], options = {}) {
  return createDatasetLoadProgressController(elements, {
    hideDelayMs: 500,
    scheduleFrame(callback) {
      callback();
      return null;
    },
    cancelFrame() {},
    setTimer(callback) {
      timers.push(callback);
      return timers.length - 1;
    },
    clearTimer(timerId) {
      timers[timerId] = null;
    },
    ...options
  });
}

async function withMockFetch(mockFetch, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

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

assert.equal(calculateProgressPercent(25, 100), 25, "progress percent is calculated from loaded and total bytes");
assert.equal(calculateProgressPercent(150, 100), 100, "progress percent is clamped at 100");
assert.equal(calculateProgressPercent(-10, 100), 0, "progress percent is clamped at 0");
assert.equal(calculateProgressPercent(10, 0), null, "zero total bytes does not produce a percent");
assert.equal(chooseWebRChannel({
  forcePostMessage: true,
  managerStatus: "ready",
  currentChannel: "SharedArrayBuffer",
  supportedChannel: "SharedArrayBuffer"
}), "PostMessage", "staged matrices can require PostMessage explicitly");
assert.equal(chooseWebRChannel({
  managerStatus: "ready",
  currentChannel: "PostMessage",
  supportedChannel: "SharedArrayBuffer"
}), "PostMessage", "a ready compatibility runtime is reused instead of restarted");
assert.equal(chooseWebRChannel({
  managerStatus: "not-started",
  currentChannel: "PostMessage",
  supportedChannel: "SharedArrayBuffer"
}), "SharedArrayBuffer", "a fresh manager uses the browser-supported default when not forced");

{
  const manager = new WebRManager();
  const preparedRuntime = { id: "prepared-postmessage-runtime" };
  manager.status = "ready";
  manager.webR = preparedRuntime;
  manager.channelType = "PostMessage";
  assert.equal(
    await manager.initialize(),
    preparedRuntime,
    "analysis reuses the PostMessage runtime completed during preparation"
  );
  assert.equal(
    await manager.initialize({ forcePostMessage: true }),
    preparedRuntime,
    "staged matrix analysis does not restart an already prepared PostMessage runtime"
  );
}

{
  const managerFromAppUrl = await import("../js/webr-manager.js?v=20260727-defaults");
  const managerFromRunnerUrl = await import("../js/webr-manager.js?v=20260727-defaults");
  const managerFromAlternateUrl = await import("../js/webr-manager.js?v=singleton-alternate-test");
  assert.equal(
    managerFromAppUrl.webrManager,
    webrManager,
    "a versioned app import shares the prepared webR manager"
  );
  assert.equal(
    managerFromRunnerUrl.webrManager,
    webrManager,
    "the unchanged runner import shares the prepared webR manager"
  );
  assert.equal(
    managerFromAlternateUrl.webrManager,
    webrManager,
    "even an accidentally different module URL shares the prepared webR manager"
  );

  const originalStatus = webrManager.status;
  const originalRuntime = webrManager.webR;
  const originalChannel = webrManager.channelType;
  const preparedRuntime = { id: "app-prepared-runtime" };
  try {
    webrManager.status = "ready";
    webrManager.webR = preparedRuntime;
    webrManager.channelType = "PostMessage";
    assert.equal(
      await managerFromRunnerUrl.webrManager.initialize({ forcePostMessage: true }),
      preparedRuntime,
      "the unchanged DEG runner receives the exact webR prepared by app.js"
    );
  } finally {
    webrManager.status = originalStatus;
    webrManager.webR = originalRuntime;
    webrManager.channelType = originalChannel;
  }
}

{
  let readyStartCount = 0;
  const result = runAfterDomReady({ readyState: "complete" }, () => {
    readyStartCount += 1;
  });
  assert.equal(result, "started", "an app imported after DOMContentLoaded starts immediately");
  assert.equal(readyStartCount, 1, "late dynamic import does not miss app initialization");

  let listener = null;
  let listenerOptions = null;
  const loadingResult = runAfterDomReady({
    readyState: "loading",
    addEventListener(type, callback, options) {
      assert.equal(type, "DOMContentLoaded");
      listener = callback;
      listenerOptions = options;
    }
  }, () => {
    readyStartCount += 1;
  });
  assert.equal(loadingResult, "waiting", "an app imported during parsing waits for DOMContentLoaded");
  assert.equal(listenerOptions?.once, true, "DOMContentLoaded startup listener only runs once");
  listener();
  assert.equal(readyStartCount, 2, "DOMContentLoaded starts an app imported during parsing");
}

{
  const elements = progressElements();
  const controller = progressController(elements);
  assert.equal(elements.root.hidden, true, "dataset progress UI starts hidden");
  assert.equal(controller.getState().active, false, "dataset progress state starts inactive");

  controller.start(1);
  assert.equal(elements.root.hidden, false, "dataset progress UI is shown on start");
  assert.equal(elements.label.textContent, "Preparing dataset...", "dataset progress initial stage is shown");
  assert.equal(elements.percent.textContent, "Estimated progress: 0%", "dataset progress starts at zero percent");

  controller.update(1, {
    message: "Preparing count matrix header",
    stage: "Preparing count matrix header",
    mode: "indeterminate"
  });
  assert.equal(elements.percent.textContent, "Estimated progress: 1%", "count matrix header preparation stays near the start");

  controller.update(1, {
    message: "Downloading dataset files",
    stage: "Downloading dataset files",
    loadedBytes: 42,
    totalBytes: 100
  });
  assert.equal(elements.percent.textContent, "Estimated progress: 24%", "estimated dataset download progress percent is shown");
  assert.ok(elements.bar.style.width.startsWith("23."), "estimated dataset progress bar width is updated");
  assert.equal(elements.track.getAttribute("aria-valuenow"), "24", "estimated dataset progress sets aria-valuenow");
  assert.match(elements.track.getAttribute("aria-valuetext"), /estimated/, "estimated progress is exposed to assistive technology");
  assert.equal(elements.bytes.textContent, "42 B / 100 B", "determinate progress bytes are shown");

  controller.update(1, {
    message: "Downloading dataset files",
    stage: "Downloading dataset files",
    loadedBytes: 180,
    totalBytes: 100
  });
  assert.equal(elements.percent.textContent, "Estimated progress: 55%", "estimated dataset progress stays below ready before completion");
  assert.equal(elements.bar.style.width, "55%", "estimated dataset progress width stays below ready before completion");

  controller.update(1, {
    message: "Decompressing data",
    stage: "Decompressing data",
    loadedBytes: 180,
    totalBytes: null,
    mode: "indeterminate"
  });
  assert.equal(elements.percent.textContent, "Estimated progress: 55%", "unknown byte totals keep the current estimated dataset progress");
  assert.equal(elements.track.getAttribute("aria-valuenow"), "55", "estimated progress keeps aria-valuenow");
  assert.equal(elements.root.classList.contains("is-determinate"), true, "estimated progress uses determinate bar state");

  controller.update(1, {
    message: "Parsing sample information",
    stage: "Parsing sample information",
    mode: "indeterminate"
  });
  assert.equal(elements.label.textContent, "Now loading datasets...", "sample parsing stage uses the requested simple label");
  assert.equal(elements.percent.textContent, "Estimated progress: 55%", "sample parsing stage keeps the byte-based estimate until new bytes arrive");

  controller.update(1, {
    message: "Now loading datasets...",
    stage: "Now loading datasets...",
    loadedBytes: 70,
    totalBytes: 100
  });
  assert.equal(elements.percent.textContent, "Estimated progress: 60%", "sample loading percent follows loaded bytes when total bytes are known");
  assert.equal(elements.bytes.textContent, "70 B / 100 B", "sample loading keeps byte details visible");

  controller.update(1, {
    message: "Loading R package: DESeq2",
    stage: "Loading R package: DESeq2",
    mode: "determinate",
    percent: 88
  });
  assert.equal(elements.percent.textContent, "Estimated progress: 88%", "explicit preparation progress is shown for custom stages");
}

{
  const elements = progressElements();
  const timers = [];
  const controller = progressController(elements, timers);
  controller.start(10);
  controller.complete(10);
  assert.equal(elements.percent.textContent, "100%", "completion shows 100 percent once");
  assert.equal(elements.label.textContent, "Dataset ready", "completion shows ready text");
  timers.forEach((callback) => callback?.());
  assert.equal(elements.root.hidden, true, "completion hides progress UI after the delay");

  controller.start(11);
  controller.complete(11);
  controller.start(12);
  timers.forEach((callback) => callback?.());
  assert.equal(elements.root.hidden, false, "old completion timer does not hide a new dataset load");
}

{
  const elements = progressElements();
  const timers = [];
  const controller = progressController(elements, timers, {
    hideOnComplete: false,
    completeStage: "Analysis preparation complete"
  });
  controller.start(13);
  controller.complete(13);
  assert.equal(elements.label.textContent, "Analysis preparation complete", "preparation completion has a distinct label");
  assert.equal(elements.root.hidden, false, "completed preparation stays visible");
  assert.equal(timers.length, 0, "persistent completion does not schedule hiding");
}

{
  const elements = progressElements();
  const controller = progressController(elements);
  controller.start(21);
  controller.fail(21, new Error("broken"));
  assert.equal(elements.root.classList.contains("is-error"), true, "error state is displayed");
  assert.equal(elements.label.textContent, "Dataset loading failed", "error stage is displayed");

  controller.start(22);
  const abort = new DOMException("aborted", "AbortError");
  assert.equal(controller.fail(22, abort), false, "AbortError is not displayed as a dataset failure");
  assert.equal(elements.root.classList.contains("is-error"), false, "AbortError does not set error state");
}

await withMockFetch(
  async () => new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode("abc"));
      controller.enqueue(encoder.encode("def"));
      controller.close();
    }
  }), {
    status: 200,
    headers: { "content-length": "6" }
  }),
  async () => {
    const events = [];
    const buffer = await fetchArrayBufferWithProgress("https://example.test/data.bin", (event) => {
      events.push(event);
    });
    assert.equal(buffer.byteLength, 6, "fetchWithProgress returns the fetched ArrayBuffer");
    assert.equal(events.at(-1).loadedBytes, 6, "fetchWithProgress reports loaded bytes");
    assert.equal(events.at(-1).totalBytes, 6, "fetchWithProgress reports total bytes from Content-Length");
    assert.equal(events.at(-1).percent, 100, "fetchWithProgress reports determinate percent");
    assert.equal(events.at(-1).mode, "determinate", "fetchWithProgress reports determinate mode");
  }
);

await withMockFetch(
  async () => new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode("abcdef"));
      controller.close();
    }
  }), { status: 200 }),
  async () => {
    const events = [];
    const buffer = await fetchArrayBufferWithProgress("https://example.test/no-length.bin", (event) => {
      events.push(event);
    });
    assert.equal(buffer.byteLength, 6, "fetchWithProgress handles stream bodies without Content-Length");
    assert.equal(events.at(-1).totalBytes, null, "missing Content-Length keeps total bytes unknown");
    assert.equal(events.at(-1).percent, null, "missing Content-Length does not produce a fake percent");
    assert.equal(events.at(-1).mode, "indeterminate", "missing Content-Length uses indeterminate mode");
  }
);

await withMockFetch(
  async () => new Response(null, { status: 200 }),
  async () => {
    const events = [];
    const buffer = await fetchArrayBufferWithProgress("https://example.test/empty.bin", (event) => {
      events.push(event);
    });
    assert.equal(buffer.byteLength, 0, "fetchWithProgress handles empty bodies");
    assert.equal(events.at(-1).loadedBytes, 0, "empty body reports zero loaded bytes");
    assert.equal(events.at(-1).percent, null, "empty body does not create a percent without a positive total");
  }
);

await withMockFetch(
  async () => new Response("missing", { status: 404 }),
  async () => {
    await assert.rejects(
      () => fetchArrayBufferWithProgress("https://example.test/missing.bin", () => {}),
      /HTTP 404/,
      "fetchWithProgress rejects HTTP errors"
    );
  }
);

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
assert.equal(APP_CONFIG.appVersion, "20260826-staged-pairwise");
assert.match(indexHtml, /id="offlineStatus"/);
assert.match(indexHtml, /id="localLaunchNotice"/);
assert.match(indexHtml, /start-local\.cmd/);
assert.match(indexHtml, /sh start-local\.sh/);
assert.match(indexHtml, /id="datasetPreparationProgress"/);
assert.match(indexHtml, /Analysis preparation/);
assert.doesNotMatch(indexHtml, /<span class="status-label">Local analysis<\/span>/);
assert.match(indexHtml, /app-bootstrap-20260810-shared-webr-manager\.js/);
assert.match(indexHtml, /app-bootstrap-20260810-shared-webr-manager\.js\?v=20260826-staged-pairwise/);
assert.match(appBootstrapSource, /20260826-staged-pairwise-1/);
assert.equal(APP_CONFIG.datasetCatalogUrl, "./config/datasets.json");
assert.match(appBootstrapSource, /location\.reload\(\)/);
assert.match(appSource, /runAfterDomReady\(document, startApp\)/);
const initializeAppSource = appSource.slice(appSource.indexOf("async function initializeApp"));
assert.ok(
  initializeAppSource.indexOf("await loadDatasetsCatalog()") <
    initializeAppSource.indexOf("await offlineSupportPromise"),
  "dataset catalog loads independently before waiting for local analysis storage"
);
assert.match(localLaunchGuardSource, /window\.location\.protocol === "file:"/);
assert.match(localLaunchGuardSource, /get\("mode"\) === "upload"/);
assert.match(localPowerShellServerSource, /127\.0\.0\.1/);
assert.match(localPowerShellServerSource, /Cross-Origin-Embedder-Policy: require-corp/);
assert.match(localPythonServerSource, /ThreadingHTTPServer/);
assert.match(localPythonServerSource, /LOCAL_HOST = "127\.0\.0\.1"/);
assert.match(localPythonServerSource, /Cross-Origin-Embedder-Policy/);
assert.match(localNodeServerSource, /server\.listen\(port, "127\.0\.0\.1"/);
assert.match(localNodeServerSource, /Cross-Origin-Embedder-Policy/);
assert.match(localShellLauncherSource, /command -v python3/);
assert.match(localShellLauncherSource, /command -v node/);
assert.match(appSource, /setAnalysisNetworkLock\(true\)/);
assert.match(appSource, /prepareDatasetForOfflineAnalysis/);
assert.doesNotMatch(appSource, /useLargeMatrixPath|buildCountCsvFromVectors/);
assert.match(appSource, /Building memory-safe count matrix/);
assert.match(appSource, /countMatrix = buildBinaryCountMatrixFromVectors/);
assert.match(appSource, /const preparedWebRChannel = "PostMessage"/);
assert.match(appSource, /webrManager\.initialize\(\{ forcePostMessage: true \}\)/);
const appManagerSpecifier = appSource.match(/from "(\.\/webr-manager\.js[^"]*)"/)?.[1];
const runnerManagerSpecifier = runnerSource.match(/from "(\.\/webr-manager\.js[^"]*)"/)?.[1];
assert.equal(appManagerSpecifier, runnerManagerSpecifier, "app and DEG runner import the same webR manager URL");
const uploadHandlerSource = appSource.slice(
  appSource.indexOf("async function handleUploadFile"),
  appSource.indexOf("function estimateMemory")
);
assert.match(uploadHandlerSource, /await file\.arrayBuffer\(\)/);
assert.doesNotMatch(uploadHandlerSource, /FormData|XMLHttpRequest/);
assert.match(offlineSupportSource, /navigator\.storage\.persist\(\)/);
assert.match(serviceWorkerSource, /Local analysis blocked an uncached network request/);
assert.match(serviceWorkerSource, /SET_OFFLINE_ONLY/);
assert.match(serviceWorkerSource, /app-bootstrap-20260810-shared-webr-manager\.js/);
assert.doesNotMatch(serviceWorkerSource, /ignoreSearch/);
const sharedArrayBufferAssets = getWebROfflineAssetUrls("SharedArrayBuffer");
const postMessageAssets = getWebROfflineAssetUrls("PostMessage");
assert.equal(sharedArrayBufferAssets.some((url) => url.includes("library-uncompressed.data")), true);
assert.equal(sharedArrayBufferAssets.some((url) => url.includes("library.data.gz")), false);
assert.equal(postMessageAssets.some((url) => url.includes("library.data.gz")), true);
assert.equal(postMessageAssets.some((url) => url.includes("library-uncompressed.data")), false);
const lazyFilePaths = [...webRRuntimeSource.matchAll(
  /loadFile\(\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'([^']+)'/g
)].map((match) => match[1]);
const lazyImagePaths = [...webRRuntimeSource.matchAll(
  /loadImage\(\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'([^']+)'/g
)].map((match) => match[1]);
const lazyRuntimePaths = [
  ...lazyFilePaths,
  ...lazyImagePaths,
  ...lazyImagePaths.map((path) => path.replace(/\.data(?:\.gz)?$/, ".js.metadata"))
];
assert.ok(lazyFilePaths.length > 0, "webR lazy files were discovered from R.js");
assert.ok(lazyImagePaths.length > 0, "webR filesystem images were discovered from R.js");
for (const runtimeAssets of [sharedArrayBufferAssets, postMessageAssets]) {
  for (const relativePath of lazyRuntimePaths) {
    const matchingUrl = runtimeAssets.find((assetUrl) => {
      const pathname = decodeURIComponent(new URL(assetUrl).pathname).replaceAll("\\", "/");
      return pathname.endsWith(`/webr/${relativePath}`);
    });
    assert.ok(matchingUrl, `offline runtime includes webR lazy asset: ${relativePath}`);
    assert.equal(new URL(matchingUrl).search, "", `webR lazy asset uses its exact worker URL: ${relativePath}`);
  }
}
for (const assetUrl of [...new Set([...sharedArrayBufferAssets, ...postMessageAssets])]) {
  const localAsset = new URL(assetUrl);
  localAsset.search = "";
  assert.equal(fs.existsSync(localAsset), true, `offline runtime asset exists: ${localAsset.pathname}`);
}
assert.equal(DEFAULT_PARAMETERS.sfType, "ratio");
assert.equal(DEFAULT_PARAMETERS.cooksCutoff, true);
assert.match(indexHtml, /<option value="ratio" selected>ratio<\/option>/);
assert.match(indexHtml, /<option value="true" selected>TRUE<\/option>/);
assert.equal(DEFAULT_PARAMETERS.test, "Wald");
assert.equal(Object.hasOwn(DEFAULT_PARAMETERS, "parallel"), false);
assert.match(indexHtml, /id="runDeseq2Button"[^>]*>[\s\S]*?run-button-title">Run DEG analysis<[\s\S]*?run-button-engine">DESeq2 \(standard\)</);
assert.match(indexHtml, /id="runZTestButton"[^>]*>[\s\S]*?run-button-title">Run DEG analysis<[\s\S]*?run-button-engine">Pairwise Z-test \(for fast screening\)</);
assert.match(indexHtml, />Stop analysis<\/button>/);
assert.match(indexHtml, /STEP 1\.[\s\S]*?Select data/);
assert.match(indexHtml, /STEP 2\.[\s\S]*?Select analysis design/);
assert.match(indexHtml, /Two-group comparison/);
assert.match(indexHtml, /Multi-group comparison/);
assert.match(indexHtml, /id="controlSelector"[^>]*>[\s\S]*?STEP 3\. Select control samples/);
assert.match(indexHtml, /id="treatmentSelector"[^>]*>[\s\S]*?STEP 4\. Select treatment samples/);
assert.match(indexHtml, /id="multiGroupSection"[\s\S]*?STEP 3\.[\s\S]*?Build multi-group comparison/);
assert.match(indexHtml, /STEP 5\.[\s\S]*?Set analysis parameters/);
assert.doesNotMatch(indexHtml, /Analysis Engine|id="analysisEngine"/);
assert.doesNotMatch(indexHtml, /Correction mode|P-value correction mode|id="p-mode"/i);
assert.match(indexHtml, /<div class="parameter-with-help prefilter-parameter">[\s\S]*?Low-expression pre-filtering[\s\S]*?Minimum total count across selected samples/);
assert.doesNotMatch(indexHtml, /Low-expression pre-filtering \(DESeq2 only\)/);
assert.match(appSource, /el\.minimumCount\.disabled = !enabled/);
assert.match(indexHtml, /DESeq2 independent filtering \(DESeq2 only\)/);
assert.match(indexHtml, /Fit type \(DESeq2 only\)/);
assert.match(indexHtml, /Size-factor estimation \(DESeq2 only\)/);
assert.match(indexHtml, /Cook's cutoff \(DESeq2 only\)/);
assert.match(indexHtml, /Test \(DESeq2 only\)/);
assert.match(indexHtml, /STEP 6\.[\s\S]*?Select plots/);
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
assert.match(appSource, /runSelectedAnalysis\(ANALYSIS_ENGINES\.DESEQ2\)/);
assert.match(appSource, /runSelectedAnalysis\(ANALYSIS_ENGINES\.ZTEST\)/);
assert.match(appSource, /runMultiGroupAnalysis\(engine\)/);
assert.match(appSource, /runAnalysis\(engine\)/);
assert.match(appSource, /if \(state\.analysisActive\) \{\s*return;\s*\}/);
assert.match(appSource, /if \(engine === ANALYSIS_ENGINES\.ZTEST\) \{\s*return commonParameters;\s*\}/);
assert.doesNotMatch(appSource, /selectedAnalysisEngine|analysisEngine|p-mode|pAdjustmentMode/);
assert.doesNotMatch(fastZTestSource, /bonferroni|pAdjustmentMode|mode === "raw"/i);
assert.match(fastZTestSource, /adjustPValuesBenjaminiHochberg/);
assert.match(helpHtml, /The analysis engine is not selected in Step 5\./);
assert.match(helpHtml, /Run DEG analysis R\/DESeq2 \(standard\)/);
assert.match(helpHtml, /Run DEG analysis High speed pairwise Z-test \(ultrafast\)/);
assert.match(helpHtml, /Multiple-testing correction is always Benjamini-Hochberg FDR/);
assert.match(helpHtml, /Parameters labeled[\s\S]*?\(DESeq2 only\)[\s\S]*?do not affect High speed pairwise Z-test results\./);
assert.match(appSource, /el\.analysisActivity\.hidden = true/);
assert.match(appSource, /window\.location\.reload\(\)/);
assert.match(appSource, /Building upload count matrix/);
assert.match(appSource, /buildBinaryCountMatrixFromUpload\(state\.uploaded, allSamples\)/);
assert.match(appSource, /runMultiGroupDeseqAnalysis/);
assert.match(appSource, /Building binary multi-group count matrix/);
assert.match(appSource, /Building uploaded binary multi-group count matrix/);
assert.doesNotMatch(appSource, /buildCountCsvFromUpload\(state\.uploaded, allSamples\)/);
assert.match(runnerSource, /const stagedMatrixRun = Boolean\(countMatrix\)/);
assert.match(runnerSource, /Uploaded count matrix uses staged PostMessage compatibility mode/);
assert.match(multiGroupRunnerSource, /const stagedMatrixRun = Boolean\(countMatrix\)/);
assert.match(multiGroupRunnerSource, /runStagedMultiGroupDeseq2/);
assert.match(multiGroupRunnerSource, /PostMessage compatibility mode/);
assert.match(multiGroupStagedRunnerSource, /readBin/);
assert.match(multiGroupStagedRunnerSource, /DESeq2::nbinomLRT/);
assert.match(multiGroupStagedRunnerSource, /DESeq2::nbinomWaldTest/);
assert.match(multiGroupStagedRunnerSource, /error\.rAnalysisError = true/);
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
assert.match(cssSource, /\.run-engine-buttons\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,/s);
assert.match(cssSource, /\.run-engine-buttons\s*\{[^}]*flex:\s*0 1 550px[^}]*width:\s*min\(100%,\s*550px\)/s);
assert.match(cssSource, /\.run-engine-buttons button\s*\{[^}]*place-content:\s*center[^}]*min-height:\s*64px[^}]*text-align:\s*center/s);
assert.match(cssSource, /@media \(max-width:\s*720px\)[\s\S]*?\.run-engine-buttons\s*\{[^}]*grid-template-columns:\s*1fr/s);

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
assert.equal(publishedCatalog.datasets.length, 10);
const expectedGexaTemplates = new Map([
  ["barley", "https://webpark2116.sakura.ne.jp/RNADB/HV/HV.html?gene={gene}"],
  ["finger_millet", "https://webpark2116.sakura.ne.jp/RNADB/EC/EC.html?gene={gene}"],
  ["foxtail_millet__t2t", "https://webpark2116.sakura.ne.jp/RNADB/SI_T2T/SI_T2T.html?gene={gene}"],
  ["foxtail_millet", "https://webpark2116.sakura.ne.jp/RNADB/SI/SI.html?gene={gene}"],
  ["pearl_millet__06777R", "https://webpark2116.sakura.ne.jp/RNADB/PM_06777R/PM_06777R.html"],
  ["pearl_millet__843B", "https://webpark2116.sakura.ne.jp/RNADB/PM_843B/PM_843B.html"],
  ["pearl_millet__tift", "https://webpark2116.sakura.ne.jp/RNADB/PM/PM.html?gene={gene}"],
  ["proso_millet", "https://webpark2116.sakura.ne.jp/RNADB/Pmi/Pmi.html?gene={gene}"],
  ["rice", "https://webpark2116.sakura.ne.jp/RNADB/OS/OS.html?gene={gene}"],
  ["sorghum", "https://webpark2116.sakura.ne.jp/RNADB/SB/SB.html?gene={gene}"]
]);
const expectedReferenceDisplays = new Map([
  ["barley", "Morex (Mascher et al. 2021)"],
  ["finger_millet", "KNE796-S (Devos et al. 2023)"],
  ["foxtail_millet__t2t", "Yugu1 (T2T) (He et al. 2024; http://www.setariadb.com/)"],
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
  ["foxtail_millet__t2t", ["Foxtail_millet_T2T_count_data.csv.gz", "Foxtail_millet_T2T_TPM_data.csv.gz", "Foxtail_millet_T2T_gene_length.tsv", "Foxtail_millet_T2T_annotation.tsv"]],
  ["foxtail_millet", ["Foxtail_millet_count_data.csv.gz", "Foxtail_millet_TPM_data.csv.gz", "Foxtail_millet_gene_length.tsv", "Foxtail_millet_annotation.tsv"]],
  ["pearl_millet__06777R", ["Pearl_millet_count_data_cv_06777R.csv.gz", "Pearl_millet_TPM_data_cv_06777R.csv.gz", "Pearl_millet_gene_length_cv_06777R.tsv", "Pearl_millet_annotation_cv_06777R.tsv"]],
  ["pearl_millet__843B", ["Pearl_millet_count_data_cv_843B.csv.gz", "Pearl_millet_TPM_data_cv_843B.csv.gz", "Pearl_millet_gene_length_cv_843B.tsv", "Pearl_millet_annotation_cv_843B.tsv"]],
  ["pearl_millet__tift", ["Pearl_millet_count_data_cv_Tift.csv.gz", "Pearl_millet_TPM_data_cv_Tift.csv.gz", "Pearl_millet_gene_length_cv_Tift.tsv", "Pearl_millet_annotation_cv_Tift.tsv"]],
  ["proso_millet", ["Proso_millet_count_data.csv.gz", "Proso_millet_TPM_data.csv.gz", "Proso_millet_gene_length.tsv", "Proso_millet_annotation.tsv"]],
  ["rice", ["Rice_count_data.csv.gz", "Rice_TPM_data.csv.gz", "Rice_gene_length.tsv", "rice_annotation.tsv"]],
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
  assert.equal(dataset.countBaseUrl, undefined);
  assert.equal(dataset.countVectorManifestUrl, undefined);
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
const rawDatasetFetchStart = fetchedUrls.length;
const rawBundle = await loadDatasetBundle(rawDataset);
const rawDatasetLoadFetches = fetchedUrls.slice(rawDatasetFetchStart);
assert.equal(rawBundle.sampleRows.length, 6, "direct GExA-style sample row count");
assert.equal(rawBundle.genes.length, 8, "direct GExA-style gene count");
assert.deepEqual(rawBundle.genes.slice(0, 3), ["gene0001", "gene0002", "gene0003"]);
assert.match(rawDataset.tpmVectorManifestUrl, /tpm-vectors\/manifest\.json$/);
assert.equal(rawBundle.sampleRows[0].tpmFile, "000000.bin.gz", "TPM manifest maps sample IDs to vector files");
assert.equal(
  rawDatasetLoadFetches.includes(new URL(rawDataset.countUrl, appRoot).href),
  false,
  "dataset selection does not fetch the monolithic count matrix"
);

const selectedRawSamples = rawBundle.sampleRows.slice(0, 2);
const selectedCountFetchStart = fetchedUrls.length;
const rawCountVectors = await loadSelectedCountVectors(rawBundle, selectedRawSamples);
const selectedCountFetches = fetchedUrls.slice(selectedCountFetchStart);
assert.equal(rawCountVectors.get("control_1")[0], 100);
assert.equal(rawCountVectors.get("control_2")[3], 480);
assert.deepEqual(
  selectedCountFetches.map((url) => url.split("/").pop()).sort(),
  ["count.csv.gz"],
  "selected count rows are streamed from the server CSV"
);
assert.equal(rawBundle.directMatrix.countText, null, "direct count matrix text cache is released after vector extraction");
assert.equal(rawBundle.directMatrix.countRowsBySampleId.size, 0, "direct count row cache is released after vector extraction");
const repeatCountFetchStart = fetchedUrls.length;
const repeatedRawCountVectors = await loadSelectedCountVectors(rawBundle, selectedRawSamples);
assert.equal(fetchedUrls.length, repeatCountFetchStart, "the same selected counts are reused without rescanning the CSV");
repeatedRawCountVectors.clear();
assert.equal(rawBundle.selectedCountVectorCache.size, 2, "clearing a runner map does not discard the selected-row cache");

const decodedGzipDataset = {
  ...rawDataset,
  countUrl: `${rawDataset.countUrl}?decoded-gzip=1`
};
const decodedGzipBundle = await loadDatasetBundle(decodedGzipDataset);
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
delete csvOnlyDataset.countBaseUrl;
delete csvOnlyDataset.countVectorManifestUrl;
delete csvOnlyDataset.countVectorFormat;
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

const structuredCsvOnlyDataset = {
  ...csvOnlyDataset,
  id: "example_fixture_csv_only_structured",
  countFile: "count.csv.gz",
  tpmFile: "tpm.csv.gz",
  annotationFile: "annotation.tsv",
  dataBaseUrl: "./test-virtual/csv-only/"
};
delete structuredCsvOnlyDataset.countUrl;
delete structuredCsvOnlyDataset.tpmUrl;
delete structuredCsvOnlyDataset.annotationUrl;
const structuredProgress = [];
const structuredBundle = await loadDatasetBundle(
  structuredCsvOnlyDataset,
  (event) => structuredProgress.push(event),
  { structuredProgress: true }
);
assert.equal(structuredBundle.sampleRows.length, csvOnlyBundle.sampleRows.length, "structured progress preserves dataset sample count");
assert.equal(structuredBundle.genes.length, csvOnlyBundle.genes.length, "structured progress preserves dataset gene count");
assert.equal(structuredBundle.directMatrix.countRowsBySampleId.size, 0, "structured progress does not retain Step 1 count rows");
assert.ok(structuredProgress.every((event) => typeof event === "object"), "structured progress emits structured events when requested");
assert.ok(
  structuredProgress.some((event) => event.stage === "Preparing count matrix header"),
  "structured progress includes count header stage"
);
const structuredCountVectors = await loadSelectedCountVectors(structuredBundle, csvOnlySamples);
assert.equal(structuredCountVectors.get("control_1")[0], 100, "structured progress preserves selected count vectors");
structuredCountVectors.clear();

const structuredGzipStreamDataset = {
  ...rawDataset,
  id: "example_fixture_gzip_stream_structured",
  sampleCount: virtualSampleRows.length
};
delete structuredGzipStreamDataset.sampleMetadataUrl;
delete structuredGzipStreamDataset.geneListUrl;
delete structuredGzipStreamDataset.tpmBaseUrl;
delete structuredGzipStreamDataset.tpmVectorManifestUrl;
delete structuredGzipStreamDataset.tpmVectorFormat;
const gzipStreamProgress = [];
const gzipStreamBundle = await loadDatasetBundle(
  structuredGzipStreamDataset,
  (event) => gzipStreamProgress.push(event),
  { structuredProgress: true }
);
assert.equal(gzipStreamBundle.sampleRows.length, rawBundle.sampleRows.length, "gzip stream load preserves sample count");
assert.equal(gzipStreamBundle.genes.length, rawBundle.genes.length, "gzip stream load preserves gene count");
assert.ok(
  gzipStreamProgress.some((event) => event.stage === "Decompressing data"),
  "structured progress includes decompression stage for gzip count matrix"
);
assert.ok(
  gzipStreamProgress.some((event) =>
    event.stage === "Now loading datasets..." &&
    Number.isFinite(event.loadedBytes) &&
    Number.isFinite(event.totalBytes) &&
    event.totalBytes > 0 &&
    Number.isFinite(event.percent)
  ),
  "structured progress includes byte-based loading progress for streamed count matrix"
);
assert.ok(
  gzipStreamProgress.some((event) =>
    event.stage === "Now loading datasets..." &&
    /samples/.test(event.message) &&
    event.mode === "determinate" &&
    Number.isFinite(event.percent) &&
    event.percent > 0
  ),
  "structured progress includes sample-count fallback progress for streamed count matrix"
);

{
  const abortedDataset = {
    ...structuredCsvOnlyDataset,
    id: "example_fixture_csv_only_abort"
  };
  delete abortedDataset.countUrl;
  const abortController = new AbortController();
  abortController.abort();
  await assert.rejects(
    () => loadDatasetBundle(abortedDataset, () => {}, {
      structuredProgress: true,
      signal: abortController.signal
    }),
    (error) => error?.name === "AbortError",
    "aborted dataset load rejects with AbortError"
  );
}

{
  const samples = {
    A1: { sample_id: "A1", BioProject: "BP1" },
    A2: { sample_id: "A2", BioProject: "BP1" },
    B1: { sample_id: "B1", BioProject: "BP1" },
    B2: { sample_id: "B2", BioProject: "BP1" },
    C1: { sample_id: "C1", BioProject: "BP1" },
    C2: { sample_id: "C2", BioProject: "BP1" }
  };
  const geneNames = ["gene_up_b", "gene_up_c", "gene_flat", "gene_low"];
  const vectorsMap = new Map([
    ["A1", new Float64Array([10, 10, 25, 0])],
    ["A2", new Float64Array([12, 11, 26, 0])],
    ["B1", new Float64Array([90, 10, 24, 0])],
    ["B2", new Float64Array([88, 12, 25, 0])],
    ["C1", new Float64Array([12, 95, 27, 0])],
    ["C2", new Float64Array([11, 92, 25, 0])]
  ]);
  const parameters = {
    preFiltering: true,
    minimumCount: 1,
    fdrThreshold: 0.99,
    log2FoldChangeThreshold: 0.1
  };
  const groups = [
    { id: "g1", label: "A", samples: [samples.A1, samples.A2] },
    { id: "g2", label: "B", samples: [samples.B1, samples.B2] },
    { id: "g3", label: "C", samples: [samples.C1, samples.C2] }
  ];
  const contrasts = [
    { id: "g2_vs_g1", numeratorId: "g2", denominatorId: "g1", numeratorLabel: "B", denominatorLabel: "A", label: "B vs A" },
    { id: "g3_vs_g1", numeratorId: "g3", denominatorId: "g1", numeratorLabel: "C", denominatorLabel: "A", label: "C vs A" },
    { id: "g3_vs_g2", numeratorId: "g3", denominatorId: "g2", numeratorLabel: "C", denominatorLabel: "B", label: "C vs B" }
  ];

  const allPairwiseController = Object.create(MultiGroupController.prototype);
  Object.assign(allPairwiseController, {
    groups,
    scope: "all_pairwise",
    referenceId: "g1",
    customContrasts: []
  });
  assert.deepEqual(
    allPairwiseController.getContrasts().map((contrast) => contrast.label),
    ["B vs A", "C vs A", "C vs B"],
    "three-group all-pairwise mode uses later groups as numerators"
  );
  assert.match(
    multiGroupControllerSource,
    /this\.scope = "all_pairwise"/,
    "multi-group comparison defaults to all pairwise contrasts"
  );

  const directBvA = runPairwiseZTest({
    geneNames,
    vectorsMap,
    numeratorSamples: groups[1].samples,
    denominatorSamples: groups[0].samples,
    parameters
  });
  const multi = runMultiGroupFastAnalysis({
    geneNames,
    vectorsMap,
    groups,
    contrasts,
    parameters
  });

  assert.equal(MAX_MULTI_GROUP_CONTRASTS, 12, "multi-group contrast cap is exported");
  assert.deepEqual(
    multi.contrasts[0].rows,
    directBvA.resultRows,
    "multi-group ultrafast B vs A reuses the same pairwise Z-test calculation as two-group"
  );
  assert.ok(
    Number(multi.contrasts[0].rows.find((row) => row.gene_id === "gene_up_b").log2FoldChange) > 0,
    "positive log2FC points toward the numerator group"
  );
  assert.ok(
    Number(multi.contrasts[2].rows.find((row) => row.gene_id === "gene_up_b").log2FoldChange) < 0,
    "C vs B is negative for a B-up gene"
  );
  assert.equal(
    directBvA.resultRows.find((row) => row.gene_id === "gene_low").direction,
    "Filtered / NA",
    "ultrafast analysis applies the minimum total count filter"
  );
  const unfilteredZTest = runPairwiseZTest({
    geneNames,
    vectorsMap,
    numeratorSamples: groups[1].samples,
    denominatorSamples: groups[0].samples,
    parameters: {
      ...parameters,
      preFiltering: false,
      minimumCount: 1000000
    }
  });
  assert.equal(
    unfilteredZTest.resultRows.find((row) => row.gene_id === "gene_low").prefilter_pass,
    true,
    "ultrafast analysis tests low-count genes when pre-filtering is disabled"
  );
  assert.equal(
    unfilteredZTest.summary.genes_after_prefiltering,
    geneNames.length,
    "disabled ultrafast pre-filter retains every input gene"
  );
  const bhRows = directBvA.resultRows
    .filter((row) => Number.isFinite(row.pvalue))
    .slice()
    .sort((a, b) => a.pvalue - b.pvalue);
  let bhMinimum = 1;
  const expectedBhByGene = new Map();
  for (let index = bhRows.length - 1; index >= 0; index -= 1) {
    bhMinimum = Math.min(bhMinimum, bhRows[index].pvalue * bhRows.length / (index + 1));
    expectedBhByGene.set(bhRows[index].gene_id, Math.max(bhRows[index].pvalue, bhMinimum));
  }
  assert.deepEqual(
    bhRows.map((row) => row.padj),
    bhRows.map((row) => expectedBhByGene.get(row.gene_id)),
    "ultrafast analysis applies Benjamini-Hochberg adjustment"
  );

  const legacyRawStateAttempt = runPairwiseZTest({
    geneNames,
    vectorsMap,
    numeratorSamples: groups[1].samples,
    denominatorSamples: groups[0].samples,
    parameters,
    pAdjustmentMode: "raw"
  });
  assert.deepEqual(
    legacyRawStateAttempt.resultRows.map((row) => row.padj),
    directBvA.resultRows.map((row) => row.padj),
    "legacy correction state cannot bypass fixed Benjamini-Hochberg adjustment"
  );

  const reversed = runMultiGroupFastAnalysis({
    geneNames,
    vectorsMap,
    groups,
    contrasts: contrasts.slice().reverse(),
    parameters
  });
  assert.deepEqual(
    reversed.contrasts.find((contrast) => contrast.id === "g2_vs_g1").rows,
    multi.contrasts.find((contrast) => contrast.id === "g2_vs_g1").rows,
    "contrast order does not change per-contrast ultrafast results"
  );

  const colDataCsv = buildGroupedColDataCsv(groups);
  assert.match(colDataCsv, /^sample,group\r\nA1,g1\r\nA2,g1/m, "grouped colData uses stable internal group IDs");
  assert.doesNotMatch(colDataCsv, /Treatment|Control/, "grouped colData does not use display labels");

  const matrixInput = buildBinaryCountMatrixFromVectors(
    geneNames,
    groups.flatMap((group) => group.samples),
    vectorsMap
  );
  const stagedStages = buildStagedMultiGroupDeseq2Stages({
    stateName: ".browser_multi_unit",
    paths: {
      countsPath: "/tmp/counts.bin",
      geneIdsPath: "/tmp/gene_ids.txt",
      globalResultPath: "/tmp/global.csv",
      normalizedPath: "/tmp/normalized.csv",
      normalizedSummaryPath: "/tmp/normalized_summary.csv",
      sizeFactorPath: "/tmp/size_factors.csv",
      summaryPath: "/tmp/summary.csv",
      logPath: "/tmp/analysis.log",
      pcaPath: "/tmp/pca.csv",
      correlationPath: "/tmp/correlation.csv",
      distancePath: "/tmp/distance.csv",
      dispersionPath: "/tmp/dispersion.csv"
    },
    parameters: {
      minimumCount: 1,
      preFiltering: true,
      sfType: "poscounts",
      fitType: "parametric",
      cooksCutoff: false,
      fdrThreshold: 0.05,
      independentFiltering: true
    },
    plots: {
      dispersion: false,
      pca: false,
      sampleCorrelation: false,
      sampleDistance: false
    },
    matrixInput,
    groups,
    contrasts,
    contrastPaths: Object.fromEntries(contrasts.map((contrast) => [contrast.id, `/tmp/${contrast.id}.csv`])),
    runGlobal: true
  });
  assert.equal(stagedStages.length, 9, "multi-group staged DESeq2 uses discrete R stages");
  assert.match(stagedStages.map(([, code]) => code).join("\n"), /readBin[\s\S]*nbinomLRT[\s\S]*nbinomWaldTest/);
  assert.doesNotMatch(
    multiGroupStagedRunnerSource,
    /format\s*\(\s*Sys\.time\s*\(/,
    "multi-group staged logging avoids webR clock-string conversion"
  );
  assert.doesNotMatch(
    multiGroupRunnerSource,
    /format\s*\(\s*Sys\.time\s*\(/,
    "multi-group fallback logging avoids webR clock-string conversion"
  );

  const directionMatrix = buildDirectionMatrix(multi.contrasts);
  assert.equal(directionMatrix.length, geneNames.length, "direction matrix has one row per gene");
  assert.ok("g2_vs_g1" in directionMatrix[0], "direction matrix has one column per contrast");

  const upB = buildGeneSet(multi.contrasts[0], "Up");
  const upC = buildGeneSet(multi.contrasts[1], "Up");
  const intersections = computeExclusiveIntersections([
    { label: "B vs A Up", genes: upB },
    { label: "C vs A Up", genes: upC }
  ]);
  assert.ok(intersections.some((entry) => entry.membership[0] && !entry.membership[1]), "exclusive intersections include set-specific genes");
  assert.equal(
    describeIntersectionMembership(
      [{ label: "A vs Control Down" }, { label: "B vs Control Up" }, { label: "B vs Control Down" }],
      [false, true, false]
    ),
    "B vs Control Up only",
    "binary Venn membership is rendered as a human-readable set name"
  );
  assert.equal(
    describeIntersectionMembership(
      [{ label: "A vs Control Down" }, { label: "B vs Control Up" }, { label: "B vs Control Down" }],
      [true, false, true]
    ),
    "A vs Control Down + B vs Control Down only (not in B vs Control Up)",
    "multi-set Venn membership names included and excluded sets"
  );
  assert.match(multiGroupResultsSource, /title\.textContent = "Gene-set overlap visualizations"/);
  assert.match(multiGroupResultsSource, /const MAX_OVERLAP_SETS = 12/);
  assert.match(multiGroupResultsSource, /const MAX_EULER_SETS = 9/);
  assert.match(multiGroupResultsSource, /title: "Euler diagram"/);
  assert.match(multiGroupResultsSource, /title: "UpSet plot"/);
  assert.match(multiGroupResultsSource, /Venn and Euler diagrams are not displayed for 10 or more comparisons/);
  assert.match(multiGroupResultsSource, /intersections\.slice\(0, MAX_UPSET_INTERSECTIONS\)/);
  assert.match(multiGroupResultsSource, /availableContrasts\.slice\(0, MAX_OVERLAP_SETS\)/);
  assert.match(multiGroupResultsSource, /directionSelect\.value = "Up"/);
  assert.match(multiGroupResultsSource, /directionSelect\.addEventListener\("change", renderOutput\)/);
  assert.doesNotMatch(multiGroupResultsSource, /for \(const direction of \["Up", "Down"\]\)/);
  assert.match(multiGroupResultsSource, /label: `\$\{contrast\.label\} \$\{direction\}`/);
  assert.match(multiGroupResultsSource, /downloadSvg\.textContent = "SVG"/);
  assert.match(multiGroupResultsSource, /downloadPng\.textContent = "PNG"/);
  assert.match(multiGroupResultsSource, /downloadCsv\.textContent = "CSV"/);
  assert.match(multiGroupResultsSource, /appendEulerExportLegend/);
  assert.match(multiGroupResultsSource, /objectsToCsv\(rows, columns, \{ bom: true \}\)/);
  assert.match(multiGroupResultsSource, /membership_pattern: `binary_\$\{entry\.key\}`/);
  assert.match(multiGroupResultsSource, /const scale = 2/);
  assert.match(multiGroupResultsSource, /venn_diagram_\$\{direction\.toLowerCase\(\)\}_genes/);
  assert.match(multiGroupResultsSource, /euler_diagram_\$\{direction\.toLowerCase\(\)\}_genes/);
  assert.match(multiGroupResultsSource, /upset_plot_\$\{direction\.toLowerCase\(\)\}_genes/);
  assert.doesNotMatch(multiGroupResultsSource, /textContent = `\$\{entry\.key\}:/);
  assert.match(cssSource, /\.venn-svg[\s\S]*?min-width:\s*900px/);
  assert.match(cssSource, /\.euler-svg/);
  assert.match(cssSource, /\.upset-svg/);
}

console.log("unit tests passed");
