import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBinaryCountMatrixFromVectors,
  buildConsoleRJobCommand,
  buildDeseq2RunnerCode
} from "../js/deseq-runner.js";
import { buildMultiGroupDeseq2RunnerCode } from "../js/multi-group-runner.js";
import { buildStagedMultiGroupDeseq2Stages } from "../js/multi-group-staged-runner.js";

const runnerSource = readFileSync(
  new URL("../js/deseq-runner.js", import.meta.url),
  "utf8"
);
const managerSource = readFileSync(
  new URL("../js/webr-manager.js", import.meta.url),
  "utf8"
);
const stagedRunnerSource = readFileSync(
  new URL("../js/deseq-staged-runner.js", import.meta.url),
  "utf8"
);
const multiGroupRunnerSource = readFileSync(
  new URL("../js/multi-group-runner.js", import.meta.url),
  "utf8"
);
const multiGroupStagedRunnerSource = readFileSync(
  new URL("../js/multi-group-staged-runner.js", import.meta.url),
  "utf8"
);
const htaccessSource = readFileSync(
  new URL("../.htaccess", import.meta.url),
  "utf8"
);
assert.match(runnerSource, /deseq-staged-runner|runStagedDeseq2/);
assert.doesNotMatch(
  runnerSource,
  /evalRString\(\s*buildDeseq2RunnerCode/,
  "Production analysis must not send the full R program through evalRString()."
);
assert.match(runnerSource, /evalRVoid/);
assert.match(runnerSource, /evalRBoolean/);
assert.match(runnerSource, /scriptPath/);
assert.match(runnerSource, /PREFLIGHT_OK/);
assert.doesNotMatch(runnerSource, /format\s*\(\s*Sys\.time\s*\(/);
assert.match(runnerSource, /BOOTSTRAP_ERROR/);
assert.doesNotMatch(runnerSource, /webR\.writeConsole\(/);
assert.doesNotMatch(stagedRunnerSource, /webR\.writeConsole\(/);
assert.match(stagedRunnerSource, /WRAPPER_STARTED/);
assert.match(stagedRunnerSource, /STAGE_PARSED/);
assert.doesNotMatch(stagedRunnerSource, /utils::read\.csv/);
assert.doesNotMatch(stagedRunnerSource, /format\(Sys\.time/);
assert.match(stagedRunnerSource, /STATE_READY/);
assert.match(stagedRunnerSource, /STAGE_SETUP_READY/);
assert.match(multiGroupRunnerSource, /runStagedMultiGroupDeseq2/);
assert.match(multiGroupRunnerSource, /PostMessage compatibility mode/);
assert.match(multiGroupStagedRunnerSource, /WRAPPER_STARTED/);
assert.match(multiGroupStagedRunnerSource, /readBin/);
assert.doesNotMatch(multiGroupStagedRunnerSource, /format\s*\(\s*Sys\.time\s*\(/);
assert.doesNotMatch(multiGroupRunnerSource, /format\s*\(\s*Sys\.time\s*\(/);
assert.match(multiGroupStagedRunnerSource, /DESeq2::nbinomLRT/);
assert.match(multiGroupStagedRunnerSource, /DESeq2::nbinomWaldTest/);
assert.match(runnerSource, /CONSOLE_OK/);
assert.match(runnerSource, /\.browser_deseq2_parsed_job/);
assert.match(runnerSource, /forcePostMessage: stagedMatrixRun/);
assert.match(runnerSource, /PostMessage compatibility mode/);
assert.doesNotMatch(runnerSource, /requires the SharedArrayBuffer webR channel/);
assert.match(managerSource, /ChannelType\.SharedArrayBuffer/);
assert.match(managerSource, /ChannelType\.PostMessage/);
assert.match(managerSource, /forcePostMessage/);
assert.match(managerSource, /crossOriginIsolated/);
assert.match(managerSource, /webr::mount/);
assert.match(managerSource, /workerLibraryDataUrl/);
assert.match(managerSource, /Mounting uncompressed DESeq2 library inside the webR worker/);
assert.match(htaccessSource, /Cross-Origin-Opener-Policy "same-origin"/);
assert.match(htaccessSource, /Cross-Origin-Embedder-Policy "require-corp"/);

const workerMetadata = JSON.parse(
  readFileSync(
    new URL("../library/library-uncompressed.js.metadata", import.meta.url),
    "utf8"
  )
);
const workerLibraryData = readFileSync(
  new URL("../library/library-uncompressed.data", import.meta.url)
);
assert.equal(workerMetadata.gzip, false);
assert.equal(workerLibraryData.byteLength, workerMetadata.remote_package_size);
assert.notDeepEqual(
  [...workerLibraryData.subarray(0, 2)],
  [0x1f, 0x8b],
  "The SharedArrayBuffer worker image must already be uncompressed."
);

const parameters = {
  minimumCount: 5,
  preFiltering: true,
  sfType: "poscounts",
  fitType: "parametric",
  cooksCutoff: false,
  fdrThreshold: 0.05,
  independentFiltering: true,
  test: "Wald"
};

const consoleCommand = buildConsoleRJobCommand({
  scriptPath: "/tmp/analysis.R",
  bootstrapPath: "/tmp/bootstrap.txt",
  runToken: "syntax-test"
});
const consoleCommandDir = mkdtempSync(join(tmpdir(), "deseq2-console-command-"));
try {
  const consoleCommandPath = join(consoleCommandDir, "console-command.R");
  writeFileSync(consoleCommandPath, consoleCommand, "utf8");
  const parsedConsoleCommand = spawnSync(
    "Rscript",
    [
      "--vanilla",
      "-e",
      "invisible(parse(file=commandArgs(trailingOnly=TRUE)[1]))",
      consoleCommandPath
    ],
    { encoding: "utf8" }
  );
  if (parsedConsoleCommand.error) {
    throw parsedConsoleCommand.error;
  }
  assert.equal(
    parsedConsoleCommand.status,
    0,
    `The R console command did not parse:\n${parsedConsoleCommand.stderr}`
  );
} finally {
  rmSync(consoleCommandDir, { recursive: true, force: true });
}

const code = buildDeseq2RunnerCode({
  countsPath: "/tmp/counts.csv",
  colDataPath: "/tmp/coldata.csv",
  resultPath: "/tmp/results.csv",
  normalizedPath: "/tmp/normalized.csv",
  normalizedSummaryPath: "/tmp/normalized_summary.csv",
  sizeFactorPath: "/tmp/size_factors.csv",
  summaryPath: "/tmp/summary.csv",
  logPath: "/tmp/analysis_log.txt",
  statusPath: "/tmp/status.txt",
  scriptPath: "/tmp/analysis.R",
  pcaPath: "/tmp/pca.csv",
  correlationPath: "/tmp/correlation.csv",
  distancePath: "/tmp/distance.csv",
  dispersionPath: "/tmp/dispersion.csv",
  parameters,
  plots: {
    dispersion: true,
    pca: true,
    sampleCorrelation: true,
    sampleDistance: true
  }
});

const compactCode = buildDeseq2RunnerCode({
  countsPath: "/tmp/counts.csv",
  colDataPath: "/tmp/coldata.csv",
  resultPath: "/tmp/results.csv",
  normalizedPath: "/tmp/normalized.csv",
  normalizedSummaryPath: "/tmp/normalized_summary.csv",
  sizeFactorPath: "/tmp/size_factors.csv",
  summaryPath: "/tmp/summary.csv",
  logPath: "/tmp/analysis_log.txt",
  statusPath: "/tmp/status.txt",
  pcaPath: "/tmp/pca.csv",
  correlationPath: "/tmp/correlation.csv",
  distancePath: "/tmp/distance.csv",
  dispersionPath: "/tmp/dispersion.csv",
  parameters,
  plots: {
    dispersion: false,
    pca: false,
    sampleCorrelation: false,
    sampleDistance: false
  },
  compactLargeRun: true
});

const lrtCode = buildDeseq2RunnerCode({
  countsPath: "/tmp/counts.csv",
  colDataPath: "/tmp/coldata.csv",
  resultPath: "/tmp/results.csv",
  normalizedPath: "/tmp/normalized.csv",
  normalizedSummaryPath: "/tmp/normalized_summary.csv",
  sizeFactorPath: "/tmp/size_factors.csv",
  summaryPath: "/tmp/summary.csv",
  logPath: "/tmp/analysis_log.txt",
  statusPath: "/tmp/status.txt",
  pcaPath: "/tmp/pca.csv",
  correlationPath: "/tmp/correlation.csv",
  distancePath: "/tmp/distance.csv",
  dispersionPath: "/tmp/dispersion.csv",
  parameters: { ...parameters, test: "LRT" },
  plots: {
    dispersion: false,
    pca: false,
    sampleCorrelation: false,
    sampleDistance: false
  }
});

const multiGroups = [
  { id: "g1", label: "A", samples: [{ sample_id: "A1" }, { sample_id: "A2" }] },
  { id: "g2", label: "B", samples: [{ sample_id: "B1" }, { sample_id: "B2" }] },
  { id: "g3", label: "C", samples: [{ sample_id: "C1" }, { sample_id: "C2" }] }
];
const multiContrasts = [
  { id: "g2_vs_g1", numeratorId: "g2", denominatorId: "g1", label: "B vs A" },
  { id: "g3_vs_g1", numeratorId: "g3", denominatorId: "g1", label: "C vs A" },
  { id: "g3_vs_g2", numeratorId: "g3", denominatorId: "g2", label: "C vs B" }
];
const multiCode = buildMultiGroupDeseq2RunnerCode({
  countsPath: "/tmp/multi_counts.csv",
  colDataPath: "/tmp/multi_coldata.csv",
  globalResultPath: "/tmp/multi_global.csv",
  normalizedPath: "/tmp/multi_normalized.csv",
  normalizedSummaryPath: "/tmp/multi_normalized_summary.csv",
  sizeFactorPath: "/tmp/multi_size_factors.csv",
  summaryPath: "/tmp/multi_summary.csv",
  logPath: "/tmp/multi_analysis_log.txt",
  statusPath: "/tmp/multi_status.txt",
  pcaPath: "/tmp/multi_pca.csv",
  correlationPath: "/tmp/multi_correlation.csv",
  distancePath: "/tmp/multi_distance.csv",
  dispersionPath: "/tmp/multi_dispersion.csv",
  parameters,
  plots: {
    dispersion: true,
    pca: true,
    sampleCorrelation: true,
    sampleDistance: true
  },
  groups: multiGroups,
  contrasts: multiContrasts,
  contrastPaths: {
    g2_vs_g1: "/tmp/multi_g2_vs_g1.csv",
    g3_vs_g1: "/tmp/multi_g3_vs_g1.csv",
    g3_vs_g2: "/tmp/multi_g3_vs_g2.csv"
  },
  runGlobal: true
});
const multiMatrix = buildBinaryCountMatrixFromVectors(
  ["g1", "g2", "g3"],
  multiGroups.flatMap((group) => group.samples),
  new Map([
    ["A1", new Int32Array([10, 20, 30])],
    ["A2", new Int32Array([12, 22, 31])],
    ["B1", new Int32Array([30, 18, 32])],
    ["B2", new Int32Array([32, 19, 33])],
    ["C1", new Int32Array([11, 40, 29])],
    ["C2", new Int32Array([13, 42, 28])]
  ])
);
const multiStagedStages = buildStagedMultiGroupDeseq2Stages({
  stateName: ".browser_multi_validation",
  paths: {
    countsPath: "/tmp/multi_counts.bin",
    geneIdsPath: "/tmp/multi_gene_ids.txt",
    globalResultPath: "/tmp/multi_global.csv",
    normalizedPath: "/tmp/multi_normalized.csv",
    normalizedSummaryPath: "/tmp/multi_normalized_summary.csv",
    sizeFactorPath: "/tmp/multi_size_factors.csv",
    summaryPath: "/tmp/multi_summary.csv",
    logPath: "/tmp/multi_analysis_log.txt",
    pcaPath: "/tmp/multi_pca.csv",
    correlationPath: "/tmp/multi_correlation.csv",
    distancePath: "/tmp/multi_distance.csv",
    dispersionPath: "/tmp/multi_dispersion.csv"
  },
  parameters,
  plots: {
    dispersion: true,
    pca: true,
    sampleCorrelation: true,
    sampleDistance: true
  },
  matrixInput: multiMatrix,
  groups: multiGroups,
  contrasts: multiContrasts,
  contrastPaths: {
    g2_vs_g1: "/tmp/multi_g2_vs_g1.csv",
    g3_vs_g1: "/tmp/multi_g3_vs_g1.csv",
    g3_vs_g2: "/tmp/multi_g3_vs_g2.csv"
  },
  runGlobal: true
});

assert.match(code, /run_browser_deseq2_app <- function/);
assert.match(code, /browser_deseq2_status <- run_browser_deseq2_app\(\)/);
assert.match(code, /writeLines\(\s*as\.character\(browser_deseq2_status\)/);
assert.match(code, /rm\(run_browser_deseq2_app\)/);
assert.match(code, /if \(TRUE\) \{\s+full_normalized <- sweep/);
assert.match(compactCode, /if \(FALSE\) \{\s+full_normalized <- sweep/);
assert.match(code, /DESeq2::nbinomWaldTest/);
assert.doesNotMatch(code, /DESeq2::nbinomLRT/);
assert.match(code, /DESeq2::estimateDispersionsGeneEst/);
assert.match(code, /dispersion_fit_type_used <<- "gene-wise"/);
assert.match(lrtCode, /DESeq2::nbinomLRT/);
assert.match(lrtCode, /reduced = ~ 1/);
assert.doesNotMatch(lrtCode, /DESeq2::nbinomWaldTest/);
assert.match(lrtCode, /DESeq2::estimateDispersionsGeneEst/);
assert.doesNotMatch(code, /parallel\s*=\s*FALSE/);
assert.doesNotMatch(lrtCode, /parallel\s*=\s*FALSE/);
assert.match(multiCode, /run_browser_deseq2_multi_group_app <- function/);
assert.match(multiCode, /design = ~ group/);
assert.match(multiCode, /DESeq2::nbinomLRT/);
assert.match(multiCode, /DESeq2::nbinomWaldTest/);
assert.match(multiCode, /contrast = c\("group", numerator_id, denominator_id\)/);
assert.match(multiCode, /levels = group_ids/);
assert.equal(multiStagedStages.length, 9);

for (const [label, runnerCode] of [
  ["Wald", code],
  ["LRT", lrtCode],
  ["multi-group", multiCode],
  ...multiStagedStages.map(([label, stageCode], index) => [`multi-group staged ${index + 1}: ${label}`, stageCode])
]) {
  const parsed = spawnSync(
    "Rscript",
    ["--vanilla", "-e", "invisible(parse(file('stdin')))"],
    {
      input: runnerCode,
      encoding: "utf8"
    }
  );

  if (parsed.error) {
    throw parsed.error;
  }

  assert.equal(
    parsed.status,
    0,
    `The production ${label} runner contains invalid R syntax:\n${parsed.stderr}`
  );
}

const executionDir = mkdtempSync(join(tmpdir(), "deseq2-runner-"));
try {
  const executionPaths = {
    countsPath: join(executionDir, "counts.csv"),
    colDataPath: join(executionDir, "coldata.csv"),
    resultPath: join(executionDir, "results.csv"),
    normalizedPath: join(executionDir, "normalized.csv"),
    normalizedSummaryPath: join(executionDir, "normalized_summary.csv"),
    sizeFactorPath: join(executionDir, "size_factors.csv"),
    summaryPath: join(executionDir, "summary.csv"),
    logPath: join(executionDir, "analysis.log"),
    statusPath: join(executionDir, "status.txt"),
    scriptPath: join(executionDir, "analysis.R"),
    pcaPath: join(executionDir, "pca.csv"),
    correlationPath: join(executionDir, "correlation.csv"),
    distancePath: join(executionDir, "distance.csv"),
    dispersionPath: join(executionDir, "dispersion.csv")
  };
  const executionCode = buildDeseq2RunnerCode({
    ...executionPaths,
    parameters,
    plots: {
      dispersion: false,
      pca: false,
      sampleCorrelation: false,
      sampleDistance: false
    }
  });
  writeFileSync(
    executionPaths.countsPath,
    "gene_id,C1,C2,T1,T2\ng1,10,12,30,32\ng2,20,22,18,19\n",
    "utf8"
  );
  writeFileSync(
    executionPaths.colDataPath,
    "sample,group\nC1,control\nC2,control\nT1,treatment\nT2,treatment\n",
    "utf8"
  );
  writeFileSync(executionPaths.scriptPath, executionCode, "utf8");

  const executed = spawnSync(
    "Rscript",
    [
      "--vanilla",
      "-e",
      "invisible(sys.source(commandArgs(TRUE)[1], envir=.GlobalEnv))",
      executionPaths.scriptPath
    ],
    { encoding: "utf8" }
  );
  if (executed.error) {
    throw executed.error;
  }
  assert.equal(
    executed.status,
    0,
    `The production R job did not preserve its error as a status file:\n${executed.stderr}`
  );

  const executionStatus = readFileSync(executionPaths.statusPath, "utf8").trim();
  const executionLog = readFileSync(executionPaths.logPath, "utf8");
  assert.match(executionStatus, /^(?:OK|ERROR\|)/);
  assert.match(executionLog, /0\. R job file started/);
  assert.match(executionLog, /1\. Preparing count matrix/);
  assert.match(executionLog, /3\. Creating DESeqDataSet/);
} finally {
  rmSync(executionDir, { recursive: true, force: true });
}

const multiExecutionDir = mkdtempSync(join(tmpdir(), "deseq2-multi-runner-"));
try {
  const executionPaths = {
    countsPath: join(multiExecutionDir, "counts.csv"),
    colDataPath: join(multiExecutionDir, "coldata.csv"),
    globalResultPath: join(multiExecutionDir, "global.csv"),
    normalizedPath: join(multiExecutionDir, "normalized.csv"),
    normalizedSummaryPath: join(multiExecutionDir, "normalized_summary.csv"),
    sizeFactorPath: join(multiExecutionDir, "size_factors.csv"),
    summaryPath: join(multiExecutionDir, "summary.csv"),
    logPath: join(multiExecutionDir, "analysis.log"),
    statusPath: join(multiExecutionDir, "status.txt"),
    pcaPath: join(multiExecutionDir, "pca.csv"),
    correlationPath: join(multiExecutionDir, "correlation.csv"),
    distancePath: join(multiExecutionDir, "distance.csv"),
    dispersionPath: join(multiExecutionDir, "dispersion.csv")
  };
  const contrastPaths = {
    g2_vs_g1: join(multiExecutionDir, "g2_vs_g1.csv"),
    g3_vs_g1: join(multiExecutionDir, "g3_vs_g1.csv"),
    g3_vs_g2: join(multiExecutionDir, "g3_vs_g2.csv")
  };
  const executionCode = buildMultiGroupDeseq2RunnerCode({
    ...executionPaths,
    parameters,
    plots: {
      dispersion: false,
      pca: false,
      sampleCorrelation: false,
      sampleDistance: false
    },
    groups: multiGroups,
    contrasts: multiContrasts,
    contrastPaths,
    runGlobal: true
  });
  writeFileSync(
    executionPaths.countsPath,
    "gene_id,A1,A2,B1,B2,C1,C2\ng1,10,12,30,32,11,13\ng2,20,22,18,19,40,42\ng3,100,101,102,99,98,103\n",
    "utf8"
  );
  writeFileSync(
    executionPaths.colDataPath,
    "sample,group\nA1,g1\nA2,g1\nB1,g2\nB2,g2\nC1,g3\nC2,g3\n",
    "utf8"
  );
  const scriptPath = join(multiExecutionDir, "analysis.R");
  writeFileSync(scriptPath, executionCode, "utf8");

  const executed = spawnSync(
    "Rscript",
    [
      "--vanilla",
      "-e",
      "invisible(sys.source(commandArgs(TRUE)[1], envir=.GlobalEnv))",
      scriptPath
    ],
    { encoding: "utf8" }
  );
  if (executed.error) {
    throw executed.error;
  }
  assert.equal(
    executed.status,
    0,
    `The multi-group R job did not preserve its error as a status file:\n${executed.stderr}`
  );

  const executionStatus = readFileSync(executionPaths.statusPath, "utf8").trim();
  const executionLog = readFileSync(executionPaths.logPath, "utf8");
  assert.match(executionStatus, /^(?:OK|ERROR\|)/);
  assert.match(executionLog, /0\. Multi-group R job file started/);
  assert.match(executionLog, /1\. Preparing multi-group count matrix/);
  assert.match(executionLog, /3\. Creating multi-group DESeqDataSet/);
} finally {
  rmSync(multiExecutionDir, { recursive: true, force: true });
}

console.log("production R runner syntax and status-file execution passed");
