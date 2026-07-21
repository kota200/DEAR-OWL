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
  buildConsoleRJobCommand,
  buildDeseq2RunnerCode
} from "../js/deseq-runner.js";

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
assert.match(runnerSource, /BOOTSTRAP_ERROR/);
assert.doesNotMatch(runnerSource, /webR\.writeConsole\(/);
assert.doesNotMatch(stagedRunnerSource, /webR\.writeConsole\(/);
assert.match(stagedRunnerSource, /WRAPPER_STARTED/);
assert.match(stagedRunnerSource, /STAGE_PARSED/);
assert.doesNotMatch(stagedRunnerSource, /utils::read\.csv/);
assert.doesNotMatch(stagedRunnerSource, /format\(Sys\.time/);
assert.match(stagedRunnerSource, /STATE_READY/);
assert.match(stagedRunnerSource, /STAGE_SETUP_READY/);
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

for (const [label, runnerCode] of [["Wald", code], ["LRT", lrtCode]]) {
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

console.log("production R runner syntax and status-file execution passed");
