import {
  APP_CONFIG,
  DEFAULT_PARAMETERS,
  DEFAULT_PLOTS
} from "./config.js?v=20260727";
import {
  buildColDataCsv,
  buildCountCsvFromVectors,
  loadAnnotations,
  loadDatasetBundle,
  loadDatasetsCatalog,
  loadSelectedCountVectors,
  loadSelectedTpmVectors
} from "./data-loader.js";
import { renderDownloads } from "./download.js";
import {
  buildBinaryCountMatrixFromUpload,
  buildBinaryCountMatrixFromVectors,
  runDeseqAnalysis
} from "./deseq-runner.js?v=20260727-defaults";
import { runPairwiseZTest } from "./fast-ztest.js";
import {
  buildGroupedColDataCsv,
  MultiGroupController
} from "./multi-group-controller.js";
import { runMultiGroupFastAnalysis } from "./multi-group-fast-runner.js";
import { runMultiGroupDeseqAnalysis } from "./multi-group-runner.js?v=20260727-defaults";
import {
  addGroupedTpmAndAnnotations,
  enrichMultiGroupResult,
  renderMultiGroupResults
} from "./multi-group-results.js";
import { renderPlots } from "./plots.js";
import { ResultTable } from "./result-table.js";
import { SampleSelector } from "./sample-selector.js";
import { webrManager } from "./webr-manager.js?v=20260727-defaults";
import {
  classifyDirection,
  countBy,
  downloadBlob,
  formatError,
  makeExternalLink,
  parseNumber,
  summarizeValues,
  unique
} from "./utils.js";
import { createDatasetLoadProgressController } from "./dataset-progress.js";

const state = {
  mode: "gexa",
  catalog: null,
  bundle: null,
  sampleRows: [],
  uploaded: null,
  analysisDesign: "two_group",
  controlSelector: null,
  treatmentSelector: null,
  multiGroupController: null,
  resultTable: null,
  cancelled: false,
  lastResult: null,
  analysisActive: false,
  analysisStartedAt: 0,
  analysisStageStartedAt: 0,
  analysisStageKey: "",
  analysisTimer: null,
  analysisControlStates: new Map(),
  datasetLoadId: 0,
  datasetLoadAbortController: null,
  datasetLoadProgress: null
};

const el = {};

const EXAMPLE_COUNT_MATRIX_HEADERS = [
  "gene_id",
  "control_1",
  "control_2",
  "control_3",
  "treatment_1",
  "treatment_2",
  "treatment_3"
];
const EXAMPLE_COUNT_MATRIX_GENE_COUNT = 200;

function $(id) {
  return document.getElementById(id);
}

function setText(target, message) {
  target.textContent = message;
}

function exampleCountsForGene(geneNumber) {
  const starterRows = new Map([
    [1, [10, 15, 12, 40, 51, 47]],
    [2, [0, 1, 0, 2, 1, 3]],
    [3, [102, 95, 110, 123, 118, 129]],
    [4, [50, 48, 52, 100, 110, 105]]
  ]);

  if (starterRows.has(geneNumber)) {
    return starterRows.get(geneNumber);
  }

  const base = 18 + geneNumber % 43;
  const effect = [22, 12, 0, -7, 16, 5][geneNumber % 6];
  const treatmentBase = Math.max(0, base + effect);

  return [
    base + geneNumber % 5,
    base + geneNumber * 2 % 7,
    base + geneNumber * 3 % 9,
    treatmentBase + geneNumber % 6,
    treatmentBase + geneNumber * 2 % 8,
    treatmentBase + geneNumber * 3 % 10
  ];
}

function buildExampleCountMatrixCsv() {
  const lines = [EXAMPLE_COUNT_MATRIX_HEADERS.join(",")];

  for (let geneNumber = 1; geneNumber <= EXAMPLE_COUNT_MATRIX_GENE_COUNT; geneNumber += 1) {
    const geneId = `gene${String(geneNumber).padStart(4, "0")}`;
    lines.push([geneId, ...exampleCountsForGene(geneNumber)].join(","));
  }

  return `${lines.join("\r\n")}\r\n`;
}

function toggleExampleMatrixPreview() {
  const shouldShow = el.exampleMatrixPreview.hidden;
  if (shouldShow) {
    el.exampleMatrixPreview.textContent = buildExampleCountMatrixCsv();
    el.exampleMatrixPreview.hidden = false;
    el.showExampleMatrix.textContent = "Hide example";
  } else {
    el.exampleMatrixPreview.hidden = true;
    el.showExampleMatrix.textContent = "Show example";
  }
}

function downloadExampleCountMatrix() {
  const csv = buildExampleCountMatrixCsv();
  downloadBlob(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
    "example_count_matrix_200_genes_6_samples.csv"
  );
}

function formatActivityDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} sec`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes} min ${seconds} sec` : `${minutes} min`;
}

function activityStageKey(message) {
  if (message.startsWith("Streaming count matrix:")) {
    return "Streaming selected count rows";
  }
  if (message.startsWith("Found count matrix row")) {
    return "Finding selected count rows";
  }
  if (message.startsWith("Preparing selected count vectors")) {
    return "Preparing selected count vectors";
  }
  if (message === "Getting TPM data" ||
    (/\bTPM\b/.test(message) && /^(Loading|Streaming|Found|Preparing)\b/.test(message))) {
    return "Getting TPM data";
  }

  const detailStart = message.lastIndexOf(" (");
  if (detailStart < 0) {
    return message;
  }

  const detail = message.slice(detailStart);
  return /(?:sec|min).*(?:stage|total)|DESeq2 has not started/.test(detail)
    ? message.slice(0, detailStart)
    : message;
}

function updateAnalysisClock() {
  if (!state.analysisActive) {
    return;
  }

  const now = Date.now();
  const total = formatActivityDuration(now - state.analysisStartedAt);
  const stage = formatActivityDuration(now - state.analysisStageStartedAt);
  el.analysisElapsed.textContent = `${total} total | ${stage} current stage`;
}

function appendAnalysisStage(message) {
  if (!state.analysisActive) {
    return;
  }

  const key = activityStageKey(message);
  if (!key || key === state.analysisStageKey) {
    updateAnalysisClock();
    return;
  }

  state.analysisStageKey = key;
  state.analysisStageStartedAt = Date.now();
  const item = document.createElement("li");
  const time = document.createElement("time");
  const label = document.createElement("span");
  time.textContent = formatActivityDuration(
    state.analysisStageStartedAt - state.analysisStartedAt
  );
  label.textContent = key;
  item.append(time, label);
  el.analysisStageList.append(item);

  while (el.analysisStageList.children.length > 30) {
    el.analysisStageList.firstElementChild?.remove();
  }
  updateAnalysisClock();
}

function startAnalysisActivity({ sampleCount, inputGeneCount }) {
  if (state.analysisTimer) {
    clearInterval(state.analysisTimer);
  }

  const now = Date.now();
  state.analysisActive = true;
  state.analysisStartedAt = now;
  state.analysisStageStartedAt = now;
  state.analysisStageKey = "";
  el.analysisStageList.replaceChildren();
  el.analysisActivity.hidden = false;
  appendAnalysisStage(
    `App ${APP_CONFIG.appVersion}: ${sampleCount} samples, ${inputGeneCount.toLocaleString("en-US")} input genes`
  );
  state.analysisTimer = setInterval(updateAnalysisClock, 1000);
}

function finishAnalysisActivity() {
  updateAnalysisClock();
  const total = formatActivityDuration(Date.now() - state.analysisStartedAt);
  el.analysisElapsed.textContent = `${total} total | finished`;
  state.analysisActive = false;
  if (state.analysisTimer) {
    clearInterval(state.analysisTimer);
    state.analysisTimer = null;
  }
  el.analysisActivity.hidden = true;
}

function setAnalysisControlsLocked(locked) {
  if (locked) {
    state.analysisControlStates.clear();
    for (const control of document.querySelectorAll("button, input, select")) {
      if (control === el.cancelButton) {
        continue;
      }
      state.analysisControlStates.set(control, control.disabled);
      control.disabled = true;
    }
    el.cancelButton.disabled = false;
    document.body.setAttribute("aria-busy", "true");
    return;
  }

  for (const [control, wasDisabled] of state.analysisControlStates) {
    control.disabled = wasDisabled;
  }
  state.analysisControlStates.clear();
  el.cancelButton.disabled = true;
  document.body.removeAttribute("aria-busy");
}

function progressMessage(progress) {
  if (typeof progress === "string") {
    return progress;
  }
  if (progress && typeof progress === "object") {
    return String(progress.message || progress.stage || "");
  }
  return String(progress || "");
}

function setProgress(progress) {
  const message = progressMessage(progress);
  setText(el.progressStatus, message);
  appendAnalysisStage(message);
}

function appendWarning(message) {
  const item = document.createElement("li");
  item.textContent = message;
  el.warningList.append(item);
  el.warningPanel.hidden = false;
}

function clearWarnings() {
  el.warningList.replaceChildren();
  el.warningPanel.hidden = true;
}

function selectedSamples() {
  return {
    control: state.controlSelector?.getSelected() || [],
    treatment: state.treatmentSelector?.getSelected() || []
  };
}

function selectedAnalysisEngine() {
  return $("analysisEngine")?.value || "deseq2";
}

function selectedAnalysisDesign() {
  return state.analysisDesign || "two_group";
}

function readParameters() {
  return {
    fdrThreshold: Number(el.fdrThreshold.value),
    log2FoldChangeThreshold: Number(el.log2fcThreshold.value),
    preFiltering: el.preFiltering.checked,
    preFilterMode: "total_count",
    minimumCount: Number(el.minimumCount.value),
    minimumSamples: Number(el.minimumSamples.value),
    independentFiltering: el.independentFiltering.checked,
    fitType: el.fitType.value,
    sfType: el.sfType.value,
    cooksCutoff: el.cooksCutoff.value === "true",
    test: el.testType.value
  };
}

function readPlots() {
  const plots = {};
  for (const key of Object.keys(DEFAULT_PLOTS)) {
    const checkbox = $(`plot-${key}`);
    plots[key] = Boolean(checkbox?.checked);
  }
  return plots;
}

function validParameters(parameters) {
  return Number.isFinite(parameters.fdrThreshold) &&
    parameters.fdrThreshold > 0 &&
    parameters.fdrThreshold < 1 &&
    Number.isFinite(parameters.log2FoldChangeThreshold) &&
    parameters.log2FoldChangeThreshold >= 0 &&
    Number.isFinite(parameters.minimumCount) &&
    parameters.minimumCount >= 0 &&
    Number.isInteger(parameters.minimumCount) &&
    Number.isFinite(parameters.minimumSamples) &&
    parameters.minimumSamples >= 1 &&
    Number.isInteger(parameters.minimumSamples) &&
    ["Wald", "LRT"].includes(parameters.test);
}

function sampleId(sample) {
  return sample.sample_id || sample.SRA || sample.sample || sample.id;
}

function hasGenePositiveInEverySample(genes, samples, vectorsBySample) {
  const sampleIds = samples.map(sampleId);

  if (sampleIds.length === 0 || genes.length === 0) {
    return false;
  }

  for (let geneIndex = 0; geneIndex < genes.length; geneIndex += 1) {
    let allPositive = true;

    for (const id of sampleIds) {
      const vector = vectorsBySample.get(id);
      if (!vector || vector[geneIndex] <= 0) {
        allPositive = false;
        break;
      }
    }

    if (allPositive) {
      return true;
    }
  }

  return false;
}

function selectedBioProjects() {
  if (selectedAnalysisDesign() === "multi_group") {
    const validation = state.multiGroupController?.validate({
      plots: readPlots(),
      parameters: readParameters()
    });
    return validation?.bioProjects || [];
  }

  const { control, treatment } = selectedSamples();
  return unique([...control, ...treatment].map((sample) => sample.BioProject));
}

function updateWarningsAndRunButton() {
  clearWarnings();

  const parameters = readParameters();
  const plots = readPlots();
  const currentEngine = selectedAnalysisEngine();
  const isJavascriptEngine = currentEngine === "javascript";
  const engineLabel = isJavascriptEngine ? "High-speed Z-test" : "DESeq2";
  const hasData = state.mode === "gexa"
    ? Boolean(state.bundle)
    : Boolean(state.uploaded);

  if (selectedAnalysisDesign() === "multi_group") {
    state.multiGroupController?.setEngine(currentEngine);
    const validation = state.multiGroupController?.validate({ plots, parameters }) || {
      ready: false,
      errors: ["Multi-group controls are not ready."],
      warnings: []
    };

    for (const error of validation.errors) {
      appendWarning(error);
    }
    for (const warning of validation.warnings) {
      appendWarning(warning);
    }

    el.runButton.disabled = state.analysisActive ||
      !hasData ||
      !validation.ready ||
      !validParameters(parameters);
    return;
  }

  const { control, treatment } = selectedSamples();
  const controlIds = new Set(control.map((sample) => sample.sample_id));
  const treatmentIds = new Set(treatment.map((sample) => sample.sample_id));
  const overlap = [...controlIds].filter((id) => treatmentIds.has(id));
  const totalSamples = control.length + treatment.length;
  const bioProjects = selectedBioProjects();

  if (control.length > 0 && control.length < 3) {
    appendWarning(`Control has fewer than 3 biological replicates. ${engineLabel} can run with 2, but 3 or more are recommended.`);
  }

  if (treatment.length > 0 && treatment.length < 3) {
    appendWarning(`Treatment has fewer than 3 biological replicates. ${engineLabel} can run with 2, but 3 or more are recommended.`);
  }

  if (bioProjects.length > 1) {
    appendWarning("Caution: Samples from different BioProjects may contain strong batch effects. Whenever possible, select control and treatment samples from the same BioProject.");
  }

  if (!isJavascriptEngine) {
    if (totalSamples > 30 && (plots.pca || plots.sampleCorrelation || plots.sampleDistance)) {
      appendWarning("More than 30 samples selected. PCA and heatmaps may be slow in the browser.");
    }

    if (parameters.cooksCutoff && control.length >= 3 && treatment.length >= 3) {
      appendWarning("Cook's cutoff can be memory intensive for 3 or more replicates per group in webR. If analysis fails, set Cook's cutoff to FALSE.");
    }

    if (totalSamples > 50 && (plots.sampleCorrelation || plots.sampleDistance)) {
      appendWarning("More than 50 samples selected. Sample heatmaps may be memory intensive.");
    }

    if (totalSamples > 100 && (plots.sampleCorrelation || plots.sampleDistance)) {
      appendWarning("More than 100 samples selected. Heatmap generation may be slow and memory intensive.");
    }
  }

  const ready = hasData &&
    control.length >= 2 &&
    treatment.length >= 2 &&
    overlap.length === 0 &&
    validParameters(parameters);

  el.runButton.disabled = state.analysisActive || !ready;
}

function renderDatasetInfo(dataset, bundle = null) {
  el.datasetInfo.replaceChildren();

  if (!dataset) {
    el.datasetInfo.textContent = "Select a dataset to view metadata.";
    return;
  }

  const rows = [
    ["Species", dataset.species],
    ["Reference genome", dataset.referenceDisplay || dataset.reference],
    ["Number of samples", bundle?.sampleRows?.length || dataset.sampleCount || "Not loaded"],
    ["Number of genes", bundle?.genes?.length || dataset.geneCount || "Not loaded"]
  ];

  const dl = document.createElement("dl");
  dl.className = "dataset-details";
  for (const [key, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value == null ? "NA" : String(value);
    dl.append(dt, dd);
  }
  el.datasetInfo.append(dl);
}

function abortCurrentDatasetLoad() {
  if (!state.datasetLoadAbortController) {
    return;
  }

  state.datasetLoadAbortController.abort();
  state.datasetLoadAbortController = null;
}

function handleDatasetLoadProgress(loadId, progress) {
  if (loadId !== state.datasetLoadId) {
    return;
  }

  setProgress(progress);
  state.datasetLoadProgress?.update(loadId, progress);
}

async function loadSelectedDataset() {
  abortCurrentDatasetLoad();
  const loadId = state.datasetLoadId + 1;
  state.datasetLoadId = loadId;

  const datasetId = el.datasetSelect.value;
  const dataset = state.catalog.datasets.find((entry) => entry.id === datasetId);

  if (!dataset) {
    state.bundle = null;
    state.sampleRows = [];
    state.datasetLoadProgress?.reset();
    renderDatasetInfo(null);
    setSampleRows([]);
    updateWarningsAndRunButton();
    return;
  }

  const abortController = new AbortController();
  state.datasetLoadAbortController = abortController;
  el.datasetSelect.disabled = true;
  el.errorPanel.hidden = true;
  setProgress("Loading samples from selected dataset");
  renderDatasetInfo(dataset);
  el.datasetInfo.textContent = "Loading sample metadata for this dataset. Large datasets may take a little while...";
  state.datasetLoadProgress?.start(loadId, {
    message: "Preparing dataset...",
    stage: "Preparing dataset...",
    mode: "indeterminate"
  });

  try {
    const bundle = await loadDatasetBundle(
      dataset,
      (progress) => handleDatasetLoadProgress(loadId, progress),
      {
        signal: abortController.signal,
        structuredProgress: true
      }
    );

    if (loadId !== state.datasetLoadId) {
      return;
    }

    bundle.sampleRows = Array.isArray(bundle.samples)
      ? bundle.samples
      : bundle.samples.samples;
    state.bundle = bundle;
    state.sampleRows = bundle.sampleRows;
    renderDatasetInfo(dataset, bundle);
    setSampleRows(state.sampleRows);
    setProgress(`Dataset ready: ${state.sampleRows.length.toLocaleString()} samples loaded`);
    state.datasetLoadProgress?.complete(loadId, {
      message: "Dataset ready",
      stage: "Dataset ready",
      mode: "determinate",
      percent: 100
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      state.datasetLoadProgress?.reset(loadId);
      return;
    }

    if (loadId !== state.datasetLoadId) {
      return;
    }

    state.bundle = null;
    state.sampleRows = [];
    setSampleRows([]);
    setProgress("Dataset load failed");
    state.datasetLoadProgress?.fail(loadId, error);
    el.datasetInfo.textContent = "Dataset metadata could not be loaded. Check the error message below.";
    el.errorPanel.hidden = false;
    el.errorText.textContent = formatError(error);
  } finally {
    if (loadId === state.datasetLoadId) {
      el.datasetSelect.disabled = false;
      state.datasetLoadAbortController = null;
      updateWarningsAndRunButton();
    }
  }
}

function setSampleRows(rows) {
  state.controlSelector.setRows(rows);
  state.treatmentSelector.setRows(rows);
  state.multiGroupController?.setRows(rows);
  updateWarningsAndRunButton();
}

function handleModeChange() {
  state.mode = document.querySelector('input[name="data-mode"]:checked').value;
  if (state.mode !== "gexa") {
    abortCurrentDatasetLoad();
    state.datasetLoadId += 1;
    state.datasetLoadProgress?.reset();
  }
  el.gexaPanel.hidden = state.mode !== "gexa";
  el.uploadPanel.hidden = state.mode !== "upload";
  state.sampleRows = state.mode === "gexa"
    ? state.bundle?.sampleRows || []
    : state.uploaded?.sampleRows || [];
  setSampleRows(state.sampleRows);
  updateWarningsAndRunButton();
}

function handleAnalysisDesignChange() {
  state.analysisDesign = document.querySelector('input[name="analysis-design"]:checked')?.value || "two_group";
  const multiGroup = state.analysisDesign === "multi_group";

  el.twoGroupControlSection.hidden = multiGroup;
  el.twoGroupTreatmentSection.hidden = multiGroup;
  el.multiGroupSection.hidden = !multiGroup;

  estimateMemory();
  updateWarningsAndRunButton();
}

async function handleUploadFile() {
  const file = el.countFile.files?.[0];
  if (!file) {
    return;
  }

  state.uploaded = null;
  setProgress("Parsing uploaded matrix");
  el.uploadStatus.textContent = "Starting worker...";

  const worker = new Worker(
    new URL("./workers/matrix-parser-worker.js", import.meta.url),
    { type: "module" }
  );

  worker.addEventListener("message", (event) => {
    const data = event.data;

    if (data.type === "progress") {
      el.uploadStatus.textContent = data.message;
      return;
    }

    if (data.type === "error") {
      worker.terminate();
      el.uploadStatus.textContent = data.message;
      setProgress("Upload validation failed");
      updateWarningsAndRunButton();
      return;
    }

    if (data.type === "done") {
      worker.terminate();
      state.uploaded = {
        fileName: data.fileName,
        sampleNames: data.sampleNames,
        sampleRows: data.sampleRows,
        geneIds: data.geneIds,
        geneCount: data.geneCount,
        sampleCount: data.sampleCount,
        counts: new Uint32Array(data.counts),
        warnings: data.warnings || []
      };
      state.sampleRows = state.uploaded.sampleRows;
      setSampleRows(state.sampleRows);
      el.uploadStatus.textContent = `Validated ${data.geneCount.toLocaleString()} genes x ${data.sampleCount.toLocaleString()} samples.`;
      for (const warning of state.uploaded.warnings) {
        appendWarning(warning);
      }
      setProgress("Upload count matrix ready");
      updateWarningsAndRunButton();
    }
  });

  const buffer = await file.arrayBuffer();
  worker.postMessage({
    type: "parse",
    buffer,
    fileName: file.name
  }, [buffer]);
}

function estimateMemory() {
  const sampleCount = selectedAnalysisDesign() === "multi_group"
    ? state.multiGroupController?.validate({
        plots: readPlots(),
        parameters: readParameters()
      }).totalSamples || 0
    : (() => {
        const { control, treatment } = selectedSamples();
        return control.length + treatment.length;
      })();
  const geneCount = state.mode === "gexa"
    ? state.bundle?.genes?.length || 0
    : state.uploaded?.geneCount || 0;
  const bytes = geneCount * sampleCount * 12;
  el.memoryEstimate.textContent = geneCount && sampleCount
    ? `Estimated in-browser matrix memory: ${(bytes / 1024 / 1024).toFixed(1)} MB before webR overhead.`
    : "Estimated memory will appear after data and samples are selected.";
}

function enrichWithDirection(rows, parameters, dataset) {
  return rows.map((row) => {
    const direction = classifyDirection(row, parameters.fdrThreshold, parameters.log2FoldChangeThreshold);
    const significant = direction === "Up" || direction === "Down";
    return {
      ...row,
      direction,
      significant: significant ? "yes" : "no",
      control_tpm_mean: "",
      treatment_tpm_mean: "",
      control_tpm_median: "",
      treatment_tpm_median: "",
      arabidopsis_homolog: "",
      rice_homolog: "",
      gexa_link: makeExternalLink(dataset?.gexaGeneUrlTemplate, row.gene_id) || "",
      tgif_link: makeExternalLink(dataset?.tgifGeneUrlTemplate, row.gene_id) || ""
    };
  });
}

async function addTpmAndAnnotations(rows, bundle, selected, onProgress, countVectorsBySample = null) {
  const warnings = [];
  const allSamples = [...selected.control, ...selected.treatment];
  const geneIndex = new Map(bundle.genes.map((gene, index) => [gene, index]));

  onProgress("Getting TPM data");
  const { vectorsBySample, warnings: tpmWarnings } = await loadSelectedTpmVectors(
    bundle,
    allSamples,
    onProgress,
    { countVectorsBySample }
  );
  warnings.push(...tpmWarnings);

  for (const row of rows) {
    const index = geneIndex.get(row.gene_id);
    if (index == null) {
      continue;
    }

    const controlValues = selected.control
      .map((sample) => vectorsBySample.get(sample.sample_id)?.[index])
      .filter((value) => value != null);
    const treatmentValues = selected.treatment
      .map((sample) => vectorsBySample.get(sample.sample_id)?.[index])
      .filter((value) => value != null);

    const controlSummary = summarizeValues(controlValues);
    const treatmentSummary = summarizeValues(treatmentValues);
    row.control_tpm_mean = controlSummary.mean ?? "";
    row.control_tpm_median = controlSummary.median ?? "";
    row.treatment_tpm_mean = treatmentSummary.mean ?? "";
    row.treatment_tpm_median = treatmentSummary.median ?? "";

    for (const sample of allSamples) {
      const vector = vectorsBySample.get(sample.sample_id);
      row[`TPM:${sample.sample_id}`] = vector ? vector[index] : "";
    }
  }

  onProgress("Loading homologs");
  try {
    const annotation = await loadAnnotations(bundle);
    warnings.push(...annotation.warnings);

    for (const row of rows) {
      const hit = annotation.byGene.get(row.gene_id);
      if (!hit) {
        continue;
      }

      row.arabidopsis_homolog = hit.arabidopsis_homolog || hit.arabidopsis_annotation || hit.annotation || hit.description || "";
      row.rice_homolog = hit.rice_homolog || hit.rice_annotation || "";
    }
  } catch (error) {
    warnings.push(`Annotation failed: ${error.message}`);
  }

  return warnings;
}

function renderSummaryCards(rows, summary, selected) {
  const up = rows.filter((row) => row.direction === "Up").length;
  const down = rows.filter((row) => row.direction === "Down").length;
  const filtered = rows.filter((row) => row.direction === "Filtered / NA").length;
  const notSignificant = rows.length - up - down - filtered;
  const bioProjects = selectedBioProjects();

  const cards = [
    ["Input genes", summary.input_genes || rows.length],
    ["Genes after pre-filtering", summary.genes_after_prefiltering || "NA"],
    ["Tested genes", summary.tested_genes || "NA"],
    ["Upregulated genes", up],
    ["Downregulated genes", down],
    ["Not significant genes", notSignificant],
    ["Genes with NA adjusted p-value", filtered],
    ["Control samples", selected.control.length],
    ["Treatment samples", selected.treatment.length],
    ["BioProjects included", bioProjects.join(", ") || "NA"],
    ["Analysis time", `${Number(summary.execution_time_seconds || 0).toFixed(1)} sec`]
  ];

  el.summaryCards.replaceChildren();

  for (const [label, value] of cards) {
    const card = document.createElement("div");
    card.className = "summary-card";
    const strong = document.createElement("strong");
    strong.textContent = value;
    const span = document.createElement("span");
    span.textContent = label;
    card.append(strong, span);
    el.summaryCards.append(card);
  }
}

function getTargetMatrixDataForJS(allSamples) {
  let geneNames = [];
  const sampleIds = allSamples.map(sampleId);
  const vectorsMap = new Map();

  if (state.mode === "upload" && state.uploaded) {
    geneNames = state.uploaded.geneIds || [];
    const totalGenes = state.uploaded.geneCount;
    const totalSamples = state.uploaded.sampleCount;
    const uCounts = state.uploaded.counts;

    sampleIds.forEach((id) => {
      const sIdx = state.uploaded.sampleNames.indexOf(id);
      if (sIdx >= 0) {
        const vec = new Float64Array(totalGenes);
        for (let g = 0; g < totalGenes; g += 1) {
          vec[g] = uCounts[g * totalSamples + sIdx] || 0;
        }
        vectorsMap.set(id, vec);
      }
    });
  } else if (state.mode === "gexa" && state.bundle) {
    geneNames = state.bundle.genes || [];
    sampleIds.forEach((id) => {
      if (state.bundle.vectorsBySample?.has(id)) {
        vectorsMap.set(id, state.bundle.vectorsBySample.get(id));
      }
    });
  }
  return { geneNames, sampleIds, vectorsMap };
}

function runFastJsEngine(selected, parameters, inputGeneCount) {
  const allSamples = [...selected.control, ...selected.treatment];
  const { geneNames, vectorsMap } = getTargetMatrixDataForJS(allSamples);

  return runPairwiseZTest({
    geneNames,
    vectorsMap,
    numeratorSamples: selected.treatment,
    denominatorSamples: selected.control,
    parameters,
    pAdjustmentMode: $("p-mode")?.value || "fdr",
    inputGeneCount
  });
}

async function runJavascriptAnalysis({ selected, parameters, allSamples, inputGeneCount }) {
  const startedAt = performance.now();
  let vectors = null;
  let originalVectorsBySample;
  let hadOriginalVectorsBySample = false;

  if (state.mode === "gexa") {
    setProgress("Loading selected count files");
    vectors = await loadSelectedCountVectors(state.bundle, allSamples, setProgress);
    hadOriginalVectorsBySample = Object.prototype.hasOwnProperty.call(state.bundle, "vectorsBySample");
    originalVectorsBySample = state.bundle.vectorsBySample;
    state.bundle.vectorsBySample = vectors;
  }

  try {
    if (state.cancelled) {
      throw new Error("Analysis was cancelled before the high-speed Z-test started.");
    }

    setProgress("Running local high-speed edgeR-like Z-test");
    const jsOut = runFastJsEngine(selected, parameters, inputGeneCount);
    jsOut.summary.execution_time_seconds = (performance.now() - startedAt) / 1000;

    return {
      resultRows: jsOut.resultRows,
      summary: jsOut.summary,
      analysisLog: `[JS FAST ENGINE REPORT]\nCalculations ran successfully in millisecond metrics.\nPre-filtering count: ${parameters.minimumCount} threshold applied.`,
      normalizedCsv: "",
      normalizedBoxplot: null,
      plotData: {},
      sizeFactors: null,
      runtimeSummary: { channelType: "Native JavaScript Z-test" }
    };
  } finally {
    if (state.mode === "gexa") {
      if (hadOriginalVectorsBySample) {
        state.bundle.vectorsBySample = originalVectorsBySample;
      } else {
        delete state.bundle.vectorsBySample;
      }
      vectors?.clear();
    }
  }
}

function renderAnalysisLog(logText, warnings) {
  const lines = [
    logText || "No R log was captured.",
    "",
    ...warnings.map((warning) => `Warning: ${warning}`)
  ];
  el.analysisLog.textContent = lines.join("\n");
}

function allSamplesFromGroups(groups) {
  return groups.flatMap((group) => group.samples);
}

async function runMultiGroupJavascriptAnalysis({
  validation,
  parameters,
  allSamples,
  inputGeneCount
}) {
  const startedAt = performance.now();
  let vectors = null;
  let originalVectorsBySample;
  let hadOriginalVectorsBySample = false;

  if (state.mode === "gexa") {
    setProgress("Loading selected count files");
    vectors = await loadSelectedCountVectors(state.bundle, allSamples, setProgress);
    hadOriginalVectorsBySample = Object.prototype.hasOwnProperty.call(state.bundle, "vectorsBySample");
    originalVectorsBySample = state.bundle.vectorsBySample;
    state.bundle.vectorsBySample = vectors;
  }

  try {
    if (state.cancelled) {
      throw new Error("Analysis was cancelled before the ultrafast multi-group test started.");
    }

    const { geneNames, vectorsMap } = getTargetMatrixDataForJS(allSamples);
    setProgress("Running ultrafast pairwise Z-tests");
    const result = runMultiGroupFastAnalysis({
      geneNames,
      vectorsMap,
      groups: validation.groups,
      contrasts: validation.contrasts,
      parameters,
      pAdjustmentMode: $("p-mode")?.value || "fdr",
      inputGeneCount
    });
    result.summary.execution_time_seconds = (performance.now() - startedAt) / 1000;
    return result;
  } finally {
    if (state.mode === "gexa") {
      if (hadOriginalVectorsBySample) {
        state.bundle.vectorsBySample = originalVectorsBySample;
      } else {
        delete state.bundle.vectorsBySample;
      }
      vectors?.clear();
    }
  }
}

async function runMultiGroupAnalysis() {
  const parameters = readParameters();
  const plots = readPlots();
  const currentEngine = selectedAnalysisEngine();
  state.multiGroupController?.setEngine(currentEngine);
  const validation = state.multiGroupController?.validate({ plots, parameters });
  const allSamples = allSamplesFromGroups(validation?.groups || []);
  const inputGeneCount = state.mode === "gexa"
    ? state.bundle.genes.length
    : state.uploaded.geneCount;

  state.cancelled = false;
  state.lastResult = null;
  el.resultsSection.hidden = true;
  el.errorPanel.hidden = true;
  clearWarnings();
  startAnalysisActivity({
    sampleCount: allSamples.length,
    inputGeneCount
  });
  setAnalysisControlsLocked(true);

  let countVectorsForTpm = null;

  try {
    if (!validation?.ready) {
      throw new Error((validation?.errors || ["Multi-group comparison is not ready."]).join("\n"));
    }

    let result;
    if (currentEngine === "javascript") {
      result = await runMultiGroupJavascriptAnalysis({
        validation,
        parameters,
        allSamples,
        inputGeneCount
      });
    } else {
      let countCsv;
      let countMatrix;

      if (state.mode === "gexa") {
        setProgress("Loading selected count files");
        const vectors = await loadSelectedCountVectors(state.bundle, allSamples, setProgress);
        countVectorsForTpm = vectors;
        if (parameters.sfType === "ratio" && !hasGenePositiveInEverySample(state.bundle.genes, allSamples, vectors)) {
          throw new Error([
            "Size-factor estimation failed before starting multi-group DESeq2.",
            "",
            "The selected samples have no gene with positive counts in every selected sample.",
            "DESeq2 sfType='ratio' requires at least one gene without zeros across all selected samples.",
            "",
            "Use Size-factor estimation: poscounts for sparse GExA matrices."
          ].join("\n"));
        }
        if (state.cancelled) {
          throw new Error("Analysis was cancelled before DESeq2 started.");
        }
        setProgress("Building binary multi-group count matrix");
        countMatrix = buildBinaryCountMatrixFromVectors(state.bundle.genes, allSamples, vectors);
      } else {
        setProgress("Building uploaded binary multi-group count matrix");
        countMatrix = buildBinaryCountMatrixFromUpload(state.uploaded, allSamples);
      }

      result = await runMultiGroupDeseqAnalysis({
        countCsv,
        countMatrix,
        colDataCsv: buildGroupedColDataCsv(validation.groups),
        groups: validation.groups,
        contrasts: validation.contrasts,
        parameters,
        plots,
        runGlobal: validation.runGlobal,
        onProgress: setProgress
      });
    }

    if (state.cancelled) {
      setProgress("Analysis cancelled. Reload the page before starting another webR calculation.");
      return;
    }

    const dataset = state.mode === "gexa" ? state.bundle.dataset : null;
    const enrichmentWarnings = [];
    enrichMultiGroupResult(result, parameters, dataset);

    if (state.mode === "gexa") {
      try {
        enrichmentWarnings.push(...await addGroupedTpmAndAnnotations(
          result,
          state.bundle,
          setProgress,
          countVectorsForTpm
        ));
      } catch (error) {
        enrichmentWarnings.push(`TPM/homolog enrichment was skipped: ${formatError(error)}`);
      }
    }

    setProgress("Creating multi-group results");
    state.lastResult = {
      result,
      parameters,
      plots,
      selected: validation.groups
    };

    renderMultiGroupResults({
      containers: {
        summaryCards: el.summaryCards,
        resultTable: el.resultTable,
        plotsContainer: el.plotsContainer,
        downloadsContainer: el.downloadsContainer,
        analysisLog: el.analysisLog
      },
      result,
      parameters,
      plots,
      context: {
        appVersion: APP_CONFIG.appVersion,
        dataset: dataset || { id: "uploaded", species: "uploaded", reference: "matrix" }
      },
      analysisLogWarnings: enrichmentWarnings,
      runtimeSummary: result.runtimeSummary || webrManager.getRuntimeSummary()
    });

    el.resultsSection.hidden = false;
    setProgress("Completed");
  } catch (error) {
    if (state.cancelled) {
      setProgress("Analysis stopped");
      return;
    }
    console.error(error);
    setProgress("Analysis failed");
    el.errorPanel.hidden = false;
    const runtimeSummary = currentEngine === "javascript"
      ? {
          channelType: "Native JavaScript Z-test",
          crossOriginIsolated: window.crossOriginIsolated,
          sharedArrayBufferAvailable: typeof SharedArrayBuffer === "function"
        }
      : webrManager.getRuntimeSummary();
    el.errorText.textContent = [
      "Multi-group analysis failed.",
      "",
      error.userMessage || formatError(error),
      "",
      `App version: ${APP_CONFIG.appVersion}`,
      "Analysis design: Multi-group comparison",
      `Analysis engine: ${currentEngine === "javascript" ? "Ultrafast pairwise Z-test" : "R / DESeq2"}`,
      `Group count: ${validation?.groups?.length || 0}`,
      `Groups: ${(validation?.groups || []).map((group) => `${group.label} (${group.samples.length})`).join(", ") || "NA"}`,
      `Contrasts: ${(validation?.contrasts || []).map((contrast) => contrast.label).join("; ") || "NA"}`,
      `Total selected samples: ${allSamples.length}`,
      `Input genes: ${inputGeneCount}`,
      `Size-factor estimation: ${currentEngine === "javascript" ? "not used" : parameters.sfType}`,
      `webR channel: ${runtimeSummary.channelType || "unknown"}`,
      `Cross-origin isolated: ${runtimeSummary.crossOriginIsolated ? "yes" : "no"}`,
      `SharedArrayBuffer available: ${runtimeSummary.sharedArrayBufferAvailable ? "yes" : "no"}`,
      "",
      currentEngine === "javascript"
        ? "Suggested actions: check group assignment, keep the minimum count threshold reasonable, and reduce the number of contrasts."
        : "Suggested actions: use poscounts for sparse matrices, set Cook's cutoff to FALSE, keep low-expression filtering enabled, reduce optional heavy plots, or reduce the number of contrasts."
    ].filter((line) => line !== "").join("\n");
  } finally {
    countVectorsForTpm?.clear();
    finishAnalysisActivity();
    setAnalysisControlsLocked(false);
    updateWarningsAndRunButton();
  }
}

async function runAnalysis() {
  const parameters = readParameters();
  const plots = readPlots();
  const selected = selectedSamples();
  const allSamples = [...selected.control, ...selected.treatment];
  const currentEngine = selectedAnalysisEngine();
  const inputGeneCount = state.mode === "gexa"
    ? state.bundle.genes.length
    : state.uploaded.geneCount;

  state.cancelled = false;
  state.lastResult = null;
  el.resultsSection.hidden = true;
  el.errorPanel.hidden = true;
  clearWarnings();
  startAnalysisActivity({
    sampleCount: allSamples.length,
    inputGeneCount
  });
  setProgress("Loading selected count files");
  setAnalysisControlsLocked(true);
  let countVectorsForTpm = null;

  try {
    let result;

    if (currentEngine === "javascript") {
      result = await runJavascriptAnalysis({
        selected,
        parameters,
        allSamples,
        inputGeneCount
      });
    } else {
      let countCsv;
      let countMatrix;
      const colDataCsv = buildColDataCsv(selected.control, selected.treatment);
      const useLargeMatrixPath = allSamples.length >= 6 && inputGeneCount >= 25000;

      if (state.mode === "gexa") {
        const vectors = await loadSelectedCountVectors(state.bundle, allSamples, setProgress);
        countVectorsForTpm = vectors;
        if (parameters.sfType === "ratio" && !hasGenePositiveInEverySample(state.bundle.genes, allSamples, vectors)) {
          throw new Error([
            "Size-factor estimation failed before starting DESeq2.",
            "",
            "The selected samples have no gene with positive counts in every selected sample.",
            "DESeq2 sfType='ratio' requires at least one gene without zeros across all selected samples.",
            "",
            "Use Size-factor estimation: poscounts for sparse GExA matrices, especially with 6 or more samples."
          ].join("\n"));
        }
        if (state.cancelled) {
          throw new Error("Analysis was cancelled before DESeq2 started.");
        }
        if (useLargeMatrixPath) {
          setProgress("Building memory-safe count matrix");
          countMatrix = buildBinaryCountMatrixFromVectors(
            state.bundle.genes,
            allSamples,
            vectors
          );
        } else {
          countCsv = buildCountCsvFromVectors(state.bundle.genes, allSamples, vectors);
        }
      } else {
        setProgress("Building upload count matrix");
        countMatrix = buildBinaryCountMatrixFromUpload(state.uploaded, allSamples);
      }

      result = await runDeseqAnalysis({
        countCsv,
        countMatrix,
        colDataCsv,
        parameters,
        plots,
        onProgress: setProgress
      });
    }

    if (state.cancelled) {
      setProgress("Analysis cancelled. Reload the page before starting another webR calculation.");
      return;
    }

    const dataset = state.mode === "gexa" ? state.bundle.dataset : null;
    let rows = enrichWithDirection(result.resultRows, parameters, dataset);
    const enrichmentWarnings = [];

    if (state.mode === "gexa") {
      try {
        enrichmentWarnings.push(...await addTpmAndAnnotations(rows, state.bundle, selected, setProgress, countVectorsForTpm));
      } catch (error) {
        enrichmentWarnings.push(`TPM/homolog enrichment was skipped: ${formatError(error)}`);
      }
    }

    setProgress("Creating plots");

    state.lastResult = {
      rows,
      normalizedCsv: result.normalizedCsv,
      normalizedBoxplot: result.normalizedBoxplot,
      result,
      parameters,
      plots,
      selected
    };

    renderSummaryCards(rows, result.summary, selected);
    state.resultTable.setRows(rows);
    renderPlots({
      container: el.plotsContainer,
      rows,
      plots,
      thresholds: parameters,
      plotData: result.plotData,
      sizeFactors: result.sizeFactors,
      normalizedBoxplot: result.normalizedBoxplot,
      onGeneClick: (geneId) => state.resultTable.focusGene(geneId)
    });
    renderAnalysisLog(result.analysisLog, enrichmentWarnings);
    renderDownloads({
      container: el.downloadsContainer,
      rows,
      normalizedCsv: result.normalizedCsv,
      context: {
        appVersion: APP_CONFIG.appVersion,
        dataset: dataset || { id: "uploaded", species: "uploaded", reference: "matrix" },
        controlSamples: selected.control,
        treatmentSamples: selected.treatment
      },
      parameters: {
        ...parameters,
        plots
      },
      summary: result.summary,
      analysisLog: result.analysisLog,
      runtimeSummary: result.runtimeSummary || webrManager.getRuntimeSummary()
    });

    el.resultsSection.hidden = false;
    setProgress("Completed");
  } catch (error) {
    if (state.cancelled) {
      setProgress("Analysis stopped");
      return;
    }
    console.error(error);
    setProgress("Analysis failed");
    el.errorPanel.hidden = false;
    const runtimeSummary = currentEngine === "javascript"
      ? {
          channelType: "Native JavaScript Z-test",
          crossOriginIsolated: window.crossOriginIsolated,
          sharedArrayBufferAvailable: typeof SharedArrayBuffer === "function"
        }
      : webrManager.getRuntimeSummary();
    const suggestedActions = currentEngine === "javascript"
      ? "Suggested actions: check sample grouping, keep the minimum count threshold at a reasonable value, and confirm that selected samples contain valid count data."
      : error.webRBridge
        ? "Suggested action: reload the browser tab once before retrying. The selected DESeq2 settings were not the cause of this JavaScript/webR bridge failure."
        : "Suggested actions: use poscounts for sparse GExA matrices, set Cook's cutoff to FALSE, keep low-expression filtering enabled, check sample grouping, and disable optional heavy plots.";
    el.errorText.textContent = [
      "Analysis failed.",
      "",
      error.userMessage || formatError(error),
      "",
      `App version: ${APP_CONFIG.appVersion}`,
      `Analysis engine: ${currentEngine === "javascript" ? "High-speed edgeR-like Z-test" : "R / DESeq2"}`,
      `Control samples: ${selected.control.length}`,
      `Treatment samples: ${selected.treatment.length}`,
      `Input genes: ${inputGeneCount}`,
      `Size-factor estimation: ${currentEngine === "javascript" ? "not used" : parameters.sfType}`,
      `webR channel: ${runtimeSummary.channelType || "unknown"}`,
      `Cross-origin isolated: ${runtimeSummary.crossOriginIsolated ? "yes" : "no"}`,
      `SharedArrayBuffer available: ${runtimeSummary.sharedArrayBufferAvailable ? "yes" : "no"}`,
      "",
      suggestedActions
    ].filter((line) => line !== "").join("\n");
  } finally {
    countVectorsForTpm?.clear();
    finishAnalysisActivity();
    setAnalysisControlsLocked(false);
    updateWarningsAndRunButton();
  }
}

function initializePlotControls() {
  for (const [key, enabled] of Object.entries(DEFAULT_PLOTS)) {
    const checkbox = $(`plot-${key}`);
    if (checkbox) {
      checkbox.checked = enabled;
      checkbox.addEventListener("change", updateWarningsAndRunButton);
    }
  }
}

function updatePThresholdLabel() {
  const label = $("pThreshLabel");
  const mode = $("p-mode")?.value || "fdr";

  if (!label) {
    return;
  }

  label.textContent = mode === "raw"
    ? "Raw p-value threshold"
    : mode === "bonferroni"
      ? "Bonferroni adjusted p-value threshold"
      : "FDR threshold";
}

function setAnalysisEngineMode(engine) {
  const isJavascriptEngine = engine === "javascript";
  const pModeField = $("pModeField");
  state.multiGroupController?.setEngine(engine);

  if (pModeField) {
    pModeField.hidden = !isJavascriptEngine;
  }
  updatePThresholdLabel();

  document.querySelectorAll(".deseq2-only-param").forEach((container) => {
    container.classList.toggle("engine-muted", isJavascriptEngine);
    container.querySelectorAll("input, select").forEach((input) => {
      input.disabled = isJavascriptEngine;
    });
  });

  document.querySelectorAll(".plot-heavy").forEach((container) => {
    container.classList.toggle("engine-muted", isJavascriptEngine);
    const checkbox = container.querySelector("input[type='checkbox']");
    if (!checkbox) {
      return;
    }
    if (isJavascriptEngine) {
      checkbox.checked = false;
      checkbox.disabled = true;
    } else {
      checkbox.disabled = false;
    }
  });

  if (el.runtimeStatus && isJavascriptEngine) {
    el.runtimeStatus.textContent = `App ${APP_CONFIG.appVersion} | Engine: High-speed edgeR-like Z-test`;
  }

  updateWarningsAndRunButton();
}

function handleRunButtonClick() {
  if (selectedAnalysisDesign() === "multi_group") {
    runMultiGroupAnalysis();
  } else {
    runAnalysis();
  }
}

async function initializeApp() {
  for (const id of [
    "datasetSelect",
    "datasetInfo",
    "datasetLoadProgress",
    "datasetLoadProgressLabel",
    "datasetLoadProgressPercent",
    "datasetLoadProgressTrack",
    "datasetLoadProgressBar",
    "datasetLoadProgressStage",
    "datasetLoadProgressBytes",
    "datasetLoadProgressLive",
    "gexaPanel",
    "uploadPanel",
    "countFile",
    "showExampleMatrix",
    "downloadExampleMatrix",
    "exampleMatrixPreview",
    "uploadStatus",
    "twoGroupControlSection",
    "twoGroupTreatmentSection",
    "controlSelector",
    "treatmentSelector",
    "multiGroupSection",
    "multiGroupBuilder",
    "multiGroupSampleSelector",
    "warningPanel",
    "warningList",
    "memoryEstimate",
    "analysisEngine",
    "fdrThreshold",
    "log2fcThreshold",
    "p-mode",
    "preFiltering",
    "minimumCount",
    "minimumSamples",
    "independentFiltering",
    "fitType",
    "sfType",
    "cooksCutoff",
    "testType",
    "runButton",
    "cancelButton",
    "progressStatus",
    "runtimeStatus",
    "analysisActivity",
    "analysisElapsed",
    "analysisStageList",
    "errorPanel",
    "errorText",
    "resultsSection",
    "summaryCards",
    "resultTable",
    "plotsContainer",
    "downloadsContainer",
    "analysisLog"
  ]) {
    el[id] = $(id);
  }

  state.datasetLoadProgress = createDatasetLoadProgressController({
    root: el.datasetLoadProgress,
    label: el.datasetLoadProgressLabel,
    percent: el.datasetLoadProgressPercent,
    track: el.datasetLoadProgressTrack,
    bar: el.datasetLoadProgressBar,
    stage: el.datasetLoadProgressStage,
    bytes: el.datasetLoadProgressBytes,
    live: el.datasetLoadProgressLive
  });

  state.resultTable = new ResultTable(el.resultTable);
  state.controlSelector = new SampleSelector({
    root: el.controlSelector,
    title: "STEP 3. Select control samples",
    role: "control",
    getBlockedIds: () => state.treatmentSelector?.getSelectedIds() || new Set(),
    onChange: () => {
      state.treatmentSelector.refreshBlockedState();
      estimateMemory();
      updateWarningsAndRunButton();
    }
  });
  state.treatmentSelector = new SampleSelector({
    root: el.treatmentSelector,
    title: "STEP 4. Select treatment samples",
    role: "treatment",
    getBlockedIds: () => state.controlSelector?.getSelectedIds() || new Set(),
    onChange: () => {
      state.controlSelector.refreshBlockedState();
      estimateMemory();
      updateWarningsAndRunButton();
    }
  });
  state.multiGroupController = new MultiGroupController({
    root: el.multiGroupBuilder,
    selectorRoot: el.multiGroupSampleSelector,
    onChange: () => {
      estimateMemory();
      updateWarningsAndRunButton();
    }
  });

  webrManager.onStatus((status) => {
    if (selectedAnalysisEngine() === "javascript") {
      if (el.runtimeStatus) {
        el.runtimeStatus.textContent = `App ${APP_CONFIG.appVersion} | Engine: High-speed edgeR-like Z-test`;
      }
      return;
    }

    const suffix = status.total
      ? ` (${Math.round(status.loaded / status.total * 100)}%)`
      : "";
    if (el.runtimeStatus) {
      el.runtimeStatus.textContent = `App ${APP_CONFIG.appVersion} | ${status.message}${suffix}`;
    }
  });

  initializePlotControls();

  if (el.analysisEngine) {
    el.analysisEngine.addEventListener("change", () => {
      setAnalysisEngineMode(selectedAnalysisEngine());
    });
  }
  $("p-mode")?.addEventListener("change", () => {
    updatePThresholdLabel();
    updateWarningsAndRunButton();
  });

  Object.entries(DEFAULT_PARAMETERS).forEach(([key, value]) => {
    const id = {
      fdrThreshold: "fdrThreshold",
      log2FoldChangeThreshold: "log2fcThreshold",
      preFiltering: "preFiltering",
      minimumCount: "minimumCount",
      minimumSamples: "minimumSamples",
      independentFiltering: "independentFiltering",
      fitType: "fitType",
      sfType: "sfType",
      cooksCutoff: "cooksCutoff",
      test: "testType"
    }[key];
    const input = id ? $(id) : null;
    if (!input) {
      return;
    }
    if (input.type === "checkbox") {
      input.checked = Boolean(value);
    } else {
      input.value = String(value);
    }
  });

  document.querySelectorAll('input[name="data-mode"]').forEach((input) => {
    input.addEventListener("change", handleModeChange);
  });
  document.querySelectorAll('input[name="analysis-design"]').forEach((input) => {
    input.addEventListener("change", handleAnalysisDesignChange);
  });
  el.datasetSelect.addEventListener("change", () => {
    loadSelectedDataset();
  });
  el.countFile.addEventListener("change", handleUploadFile);
  el.showExampleMatrix.addEventListener("click", toggleExampleMatrixPreview);
  el.downloadExampleMatrix.addEventListener("click", downloadExampleCountMatrix);

  for (const input of [
    el.fdrThreshold,
    el.log2fcThreshold,
    $("p-mode"),
    el.preFiltering,
    el.minimumCount,
    el.minimumSamples,
    el.independentFiltering,
    el.fitType,
    el.sfType,
    el.cooksCutoff,
    el.testType
  ]) {
    if (!input) {
      continue;
    }
    input.addEventListener("input", updateWarningsAndRunButton);
    input.addEventListener("change", updateWarningsAndRunButton);
  }

  el.runButton.addEventListener("click", handleRunButtonClick);
  el.cancelButton.addEventListener("click", () => {
    state.cancelled = true;
    el.cancelButton.disabled = true;
    setProgress("Stopping analysis");
    window.location.reload();
  });

  setProgress("Loading dataset catalog");
  state.catalog = await loadDatasetsCatalog();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a dataset...";
  placeholder.selected = true;
  el.datasetSelect.append(placeholder);

  for (const dataset of state.catalog.datasets) {
    const opt = document.createElement("option");
    opt.value = dataset.id;
    opt.textContent = dataset.label;
    el.datasetSelect.append(opt);
  }

  handleModeChange();
  handleAnalysisDesignChange();
  setAnalysisEngineMode(selectedAnalysisEngine());
  setProgress("Ready");
}

document.addEventListener("DOMContentLoaded", () => {
  initializeApp().catch((error) => {
    console.error(error);
    setProgress("Initialization failed");
    el.errorPanel.hidden = false;
    el.errorText.textContent = formatError(error);
  });
});
