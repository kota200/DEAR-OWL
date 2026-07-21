import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFileBackedStageCommand,
  buildStagedDeseq2Stages,
  runStagedDeseq2
} from "../js/deseq-staged-runner.js";

const paths = {
  countsPath: "/tmp/counts.csv",
  geneIdsPath: "/tmp/gene_ids.txt",
  colDataPath: "/tmp/coldata.csv",
  resultPath: "/tmp/results.csv",
  normalizedPath: "/tmp/normalized.csv",
  normalizedSummaryPath: "/tmp/normalized_summary.csv",
  sizeFactorPath: "/tmp/size_factors.csv",
  summaryPath: "/tmp/summary.csv",
  logPath: "/tmp/analysis_log.txt",
  pcaPath: "/tmp/pca.csv",
  correlationPath: "/tmp/correlation.csv",
  distancePath: "/tmp/distance.csv",
  dispersionPath: "/tmp/dispersion.csv"
};

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

const plots = {
  dispersion: true,
  pca: true,
  sampleCorrelation: true,
  sampleDistance: true
};

const matrixInput = {
  sampleNames: ["C1", "C2", "T1", "T2"],
  geneIds: ["g1", "g2"],
  geneCount: 2,
  sampleCount: 4,
  counts: new Int32Array([1, 5, 2, 6, 3, 7, 4, 8])
};
const groups = ["control", "control", "treatment", "treatment"];

const stages = buildStagedDeseq2Stages({
  stateName: ".browser_test",
  paths,
  parameters,
  plots,
  matrixInput,
  groups
});

const lrtStages = buildStagedDeseq2Stages({
  stateName: ".browser_lrt_test",
  paths,
  parameters: { ...parameters, test: "LRT" },
  plots,
  matrixInput,
  groups
});

assert.equal(stages.length, 9);
assert.equal(stages[5][0], "Fitting Wald model");
assert.match(stages[4][1], /DESeq2::estimateDispersionsGeneEst/);
assert.match(stages[4][1], /st\$dispersion_fit_type_used <- "gene-wise"/);
assert.match(stages[5][1], /DESeq2::nbinomWaldTest/);
assert.doesNotMatch(stages[5][1], /DESeq2::nbinomLRT/);
assert.equal(lrtStages[5][0], "Fitting LRT model");
assert.match(lrtStages[5][1], /DESeq2::nbinomLRT/);
assert.match(lrtStages[5][1], /reduced = ~ 1/);
assert.doesNotMatch(lrtStages[5][1], /DESeq2::nbinomWaldTest/);
assert.doesNotMatch(stages[6][1], /parallel\s*=\s*FALSE/);
assert.doesNotMatch(lrtStages[6][1], /parallel\s*=\s*FALSE/);
assert.doesNotMatch(stages[1][1], /read\.csv/);
assert.match(stages[1][1], /count_matrix <- matrix/);
assert.match(stages[1][1], /base::readBin/);
assert.match(stages[1][1], /base::readLines/);

const largeMatrixInput = {
  sampleNames: ["C1", "C2", "C3", "T1", "T2", "T3"],
  geneIds: Array.from({ length: 3000 }, (_value, index) => `gene_${index + 1}`),
  geneCount: 3000,
  sampleCount: 6,
  counts: new Int32Array(18000)
};
const largeMatrixStage = buildStagedDeseq2Stages({
  stateName: ".browser_large_source_test",
  paths,
  parameters,
  plots,
  matrixInput: largeMatrixInput,
  groups: ["control", "control", "control", "treatment", "treatment", "treatment"]
})[1][1];
assert.ok(
  Buffer.byteLength(largeMatrixStage, "utf8") < 15000,
  "The 3,000 x 6 matrix stage must not expand counts or gene IDs into R source."
);

const initializationRun = spawnSync(
  "Rscript",
  [
    "--vanilla",
    "-e",
    "value <- eval(parse(file('stdin')), envir=.GlobalEnv); stopifnot(identical(value, 'OK'))"
  ],
  {
    input: stages[0][1],
    encoding: "utf8"
  }
);
if (initializationRun.error) {
  throw initializationRun.error;
}
assert.equal(
  initializationRun.status,
  0,
  `Staged initialization failed to execute:\n${initializationRun.stderr}`
);

const matrixTestDir = mkdtempSync(join(tmpdir(), "deseq2-matrix-"));
try {
  const countsPath = join(matrixTestDir, "counts.csv");
  const geneIdsPath = join(matrixTestDir, "gene_ids.txt");
  const colDataPath = join(matrixTestDir, "coldata.csv");
  const logPath = join(matrixTestDir, "analysis.log");
  writeFileSync(countsPath, Buffer.from(matrixInput.counts.buffer));
  writeFileSync(geneIdsPath, "g1\ng2\n", "utf8");
  writeFileSync(
    colDataPath,
    "sample,group\r\nC1,control\r\nC2,control\r\nT1,treatment\r\nT2,treatment\r\n",
    "utf8"
  );
  const executionStages = buildStagedDeseq2Stages({
    stateName: ".browser_execution_test",
    paths: {
      ...paths,
      countsPath,
      geneIdsPath,
      colDataPath,
      logPath
    },
    parameters,
    plots,
    matrixInput,
    groups
  });
  const matrixLoad = spawnSync(
    "Rscript",
    [
      "--vanilla",
      "-e",
      [
        "values <- lapply(parse(file('stdin')), eval, envir=.GlobalEnv)",
        "stopifnot(all(vapply(values, identical, logical(1), 'OK')))"
      ].join("; ")
    ],
    {
      input: `${executionStages[0][1]}\n${executionStages[1][1]}`,
      encoding: "utf8"
    }
  );
  if (matrixLoad.error) {
    throw matrixLoad.error;
  }
  assert.equal(
    matrixLoad.status,
    0,
    `The staged compact CSV matrix loader failed:\n${matrixLoad.stderr}`
  );
} finally {
  rmSync(matrixTestDir, { recursive: true, force: true });
}

for (const [label, code] of [...stages, ...lrtStages]) {
  const parsed = spawnSync(
    "Rscript",
    ["--vanilla", "-e", "invisible(parse(file('stdin')))"],
    {
      input: code,
      encoding: "utf8"
    }
  );

  if (parsed.error) {
    throw parsed.error;
  }
  assert.equal(
    parsed.status,
    0,
    `${label} contains invalid R syntax:\n${parsed.stderr}`
  );
}

const fileWrites = [];
const evaluatedCommands = [];
const progressLabels = [];
await runStagedDeseq2({
  webR: {
    FS: {
      async writeFile(path, bytes) {
        fileWrites.push({ path, bytes });
      },
      async unlink() {}
    },
    async evalRVoid(code, options) {
      evaluatedCommands.push({ code, options });
    }
  },
  stateName: ".browser_test",
  paths,
  parameters,
  plots,
  matrixInput,
  groups,
  readTextFile: async (_webR, path) => path.endsWith(".status") ? "OK\n" : "",
  onProgress: (label) => progressLabels.push(label)
});

assert.equal(fileWrites.length, stages.length);
assert.ok(fileWrites.every(({ path }) => path.endsWith(".R")));
assert.equal(evaluatedCommands.length, stages.length);
assert.ok(evaluatedCommands.every(({ code }) => !code.includes("DESeqDataSetFromMatrix")));
assert.ok(evaluatedCommands.every(({ code }) => code.includes("WRAPPER_STARTED")));
assert.ok(evaluatedCommands.every(({ code }) => code.includes("STAGE_PARSED")));
assert.ok(evaluatedCommands.every(({ options }) => options.captureStreams === false));
assert.ok(evaluatedCommands.every(({ options }) => options.captureConditions === false));
assert.deepEqual(progressLabels, stages.map(([label]) => label));

const fileBackedCommand = buildFileBackedStageCommand({
  scriptPath: "/tmp/browser_stage.R",
  statusPath: "/tmp/browser_stage.status"
});
const parsedCommand = spawnSync(
  "Rscript",
  ["--vanilla", "-e", "invisible(parse(file('stdin')))"],
  {
    input: fileBackedCommand,
    encoding: "utf8"
  }
);
if (parsedCommand.error) {
  throw parsedCommand.error;
}
assert.equal(
  parsedCommand.status,
  0,
  `The file-backed stage command contains invalid R syntax:\n${parsedCommand.stderr}`
);

console.log("staged R syntax passed");
