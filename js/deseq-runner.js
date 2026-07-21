import { APP_CONFIG } from "./config.js?v=20260717-gene-length";
import { webrManager } from "./webr-manager.js?v=wald-lrt";
import {
  cleanupStagedDeseq2,
  runStagedDeseq2
} from "./deseq-staged-runner.js?v=wald-lrt";
import {
  csvEscape,
  formatError,
  parseDelimitedRows,
  parseCsvObjects
} from "./utils.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

function rString(value) {
  return JSON.stringify(String(value));
}

function rBool(value) {
  return value ? "TRUE" : "FALSE";
}

function resolveDeseqTest(value) {
  return value === "LRT" ? "LRT" : "Wald";
}

function runId() {
  return `deseq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function countDataRows(text) {
  let rows = 0;
  let hasContent = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") {
      if (hasContent) {
        rows += 1;
      }
      hasContent = false;
    } else if (char !== "\r") {
      hasContent = true;
    }
  }

  if (hasContent) {
    rows += 1;
  }

  return Math.max(0, rows - 1);
}

export function buildBinaryCountMatrix(countCsv) {
  const { rows } = parseDelimitedRows(countCsv, ",");
  if (rows.length < 2) {
    throw new Error("The count matrix does not contain any gene rows.");
  }

  const sampleNames = rows[0].slice(1);
  if (new Set(sampleNames).size !== sampleNames.length) {
    throw new Error("Selected sample names must be unique.");
  }

  const dataRows = rows
    .slice(1)
    .filter((row) => row.length > 0 && row.some((value) => value !== ""));
  const geneCount = dataRows.length;
  const sampleCount = sampleNames.length;
  const geneIds = new Array(geneCount);
  const counts = new Int32Array(geneCount * sampleCount);
  const seenGenes = new Set();

  for (let geneIndex = 0; geneIndex < geneCount; geneIndex += 1) {
    const row = dataRows[geneIndex];
    if (row.length !== sampleCount + 1) {
      throw new Error(`Count matrix row ${geneIndex + 2} has ${row.length} columns; expected ${sampleCount + 1}.`);
    }

    const geneId = row[0];
    if (!geneId) {
      throw new Error(`Count matrix row ${geneIndex + 2} has an empty gene ID.`);
    }
    if (seenGenes.has(geneId)) {
      throw new Error(`Count matrix contains a duplicate gene ID: ${geneId}`);
    }
    seenGenes.add(geneId);
    geneIds[geneIndex] = geneId;

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const rawValue = row[sampleIndex + 1];
      const value = Number(rawValue);
      if (rawValue.trim() === "") {
        throw new Error(`Missing count for gene ${geneId}, sample ${sampleNames[sampleIndex]}.`);
      }
      if (!Number.isInteger(value) || value < 0 || value > 2147483647) {
        throw new Error(`Invalid count for gene ${geneId}, sample ${sampleNames[sampleIndex]}.`);
      }
      counts[sampleIndex * geneCount + geneIndex] = value;
    }
  }

  return {
    sampleNames,
    geneIds,
    geneCount,
    sampleCount,
    counts
  };
}

function selectedSampleId(sample) {
  return sample.sample_id || sample.SRA || sample.sample;
}

export function buildBinaryCountMatrixFromVectors(genes, samples, vectorsBySample) {
  const sampleNames = samples.map(selectedSampleId);
  const geneCount = genes.length;
  const sampleCount = sampleNames.length;
  const counts = new Int32Array(geneCount * sampleCount);

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const sampleName = sampleNames[sampleIndex];
    const vector = vectorsBySample.get(sampleName);
    if (!vector || vector.length !== geneCount) {
      throw new Error(`Selected sample ${sampleName} has an invalid count vector.`);
    }

    const offset = sampleIndex * geneCount;
    for (let geneIndex = 0; geneIndex < geneCount; geneIndex += 1) {
      const value = Number(vector[geneIndex]);
      if (!Number.isInteger(value) || value < 0 || value > 2147483647) {
        throw new Error(`Invalid count for gene ${genes[geneIndex]}, sample ${sampleName}.`);
      }
      counts[offset + geneIndex] = value;
    }
  }

  return {
    sampleNames,
    geneIds: [...genes],
    geneCount,
    sampleCount,
    counts
  };
}

export function buildBinaryCountMatrixFromUpload(uploaded, samples) {
  const sampleNames = samples.map(selectedSampleId);
  const sampleIndexes = sampleNames.map((sample) => uploaded.sampleNames.indexOf(sample));
  if (sampleIndexes.some((index) => index < 0)) {
    throw new Error("Selected upload sample is not present in the parsed count matrix.");
  }

  const geneCount = uploaded.geneIds.length;
  const sampleCount = sampleNames.length;
  const sourceSampleCount = uploaded.sampleNames.length;
  const counts = new Int32Array(geneCount * sampleCount);

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const sourceSampleIndex = sampleIndexes[sampleIndex];
    const outputOffset = sampleIndex * geneCount;
    for (let geneIndex = 0; geneIndex < geneCount; geneIndex += 1) {
      counts[outputOffset + geneIndex] = uploaded.counts[
        geneIndex * sourceSampleCount + sourceSampleIndex
      ];
    }
  }

  return {
    sampleNames,
    geneIds: [...uploaded.geneIds],
    geneCount,
    sampleCount,
    counts
  };
}

export function prefilterBinaryCountMatrix(
  matrix,
  parameters
) {
  const minimumCount = Number(parameters.minimumCount);
  const candidates = [];

  for (let geneIndex = 0; geneIndex < matrix.geneCount; geneIndex += 1) {
    let total = 0;
    for (let sampleIndex = 0; sampleIndex < matrix.sampleCount; sampleIndex += 1) {
      const value = matrix.counts[sampleIndex * matrix.geneCount + geneIndex];
      total += value;
    }

    const userFilterPass = !parameters.preFiltering || total >= minimumCount;
    if (userFilterPass) {
      candidates.push({ geneIndex, total });
    }
  }

  const selectedIndexes = candidates.map((candidate) => candidate.geneIndex);
  const keepMask = new Uint8Array(matrix.geneCount);
  const fitGeneCount = selectedIndexes.length;
  const fitCounts = new Int32Array(fitGeneCount * matrix.sampleCount);
  const fitGeneIds = new Array(fitGeneCount);

  for (let fitGeneIndex = 0; fitGeneIndex < fitGeneCount; fitGeneIndex += 1) {
    const sourceGeneIndex = selectedIndexes[fitGeneIndex];
    keepMask[sourceGeneIndex] = 1;
    fitGeneIds[fitGeneIndex] = matrix.geneIds[sourceGeneIndex];
    for (let sampleIndex = 0; sampleIndex < matrix.sampleCount; sampleIndex += 1) {
      fitCounts[sampleIndex * fitGeneCount + fitGeneIndex] = matrix.counts[
        sampleIndex * matrix.geneCount + sourceGeneIndex
      ];
    }
  }

  if (fitGeneCount < 1) {
    throw new Error("All genes were removed by low-expression filtering.");
  }

  return {
    fullMatrix: matrix,
    fitMatrix: {
      sampleNames: matrix.sampleNames,
      geneIds: fitGeneIds,
      geneCount: fitGeneCount,
      sampleCount: matrix.sampleCount,
      counts: fitCounts
    },
    keepMask,
    summary: {
      fittedGenes: fitGeneCount
    }
  };
}

export function buildCountCsvFromBinaryMatrix(matrix) {
  const lines = [["gene_id", ...matrix.sampleNames]
    .map((value) => csvEscape(value, { protectFormula: false }))
    .join(",")];

  for (let geneIndex = 0; geneIndex < matrix.geneCount; geneIndex += 1) {
    const values = new Array(matrix.sampleCount);
    for (let sampleIndex = 0; sampleIndex < matrix.sampleCount; sampleIndex += 1) {
      values[sampleIndex] = matrix.counts[
        sampleIndex * matrix.geneCount + geneIndex
      ];
    }
    lines.push([
      csvEscape(matrix.geneIds[geneIndex], { protectFormula: false }),
      ...values
    ].join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export function encodeInt32LittleEndian(values) {
  const bytes = new Uint8Array(values.length * Int32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index += 1) {
    view.setInt32(index * Int32Array.BYTES_PER_ELEMENT, values[index], true);
  }
  return bytes;
}

export function encodeGeneIdLines(geneIds) {
  for (const geneId of geneIds) {
    if (!geneId || /[\r\n]/.test(geneId)) {
      throw new Error("Gene IDs for a large browser run must be non-empty single-line values.");
    }
  }
  return encoder.encode(`${geneIds.join("\n")}\n`);
}

export function buildNormalizedCsvFromBinary(matrix, sizeFactors) {
  const { sampleNames, geneIds, geneCount, sampleCount, counts } = matrix;
  const factorsBySample = new Map(
    sizeFactors.map((row) => [row.sample, Number(row.size_factor)])
  );
  const factors = sampleNames.map((sample) => factorsBySample.get(sample));

  if (factors.some((factor) => !Number.isFinite(factor) || factor <= 0)) {
    throw new Error("Cannot build normalized counts because a size factor is missing or invalid.");
  }

  const lines = [
    ["gene_id", ...sampleNames]
      .map((value) => csvEscape(value, { protectFormula: false }))
      .join(",")
  ];

  for (let geneIndex = 0; geneIndex < geneCount; geneIndex += 1) {
    const normalized = new Array(sampleCount);
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const count = counts[sampleIndex * geneCount + geneIndex];
      normalized[sampleIndex] = String(count / factors[sampleIndex]);
    }
    lines.push([
      csvEscape(geneIds[geneIndex], { protectFormula: false }),
      ...normalized
    ].join(","));
  }

  return lines.join("\r\n") + "\r\n";
}

export function buildNormalizedCsv(countCsv, sizeFactors) {
  return buildNormalizedCsvFromBinary(
    buildBinaryCountMatrix(countCsv),
    sizeFactors
  );
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantileSorted(values, probability) {
  const position = (values.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return values[lower];
  }
  const weight = position - lower;
  return values[lower] * (1 - weight) + values[upper] * weight;
}

export function buildNormalizedOutputs(matrix, sizeFactors, colDataRecords) {
  const factorsBySample = new Map(
    sizeFactors.map((row) => [row.sample, Number(row.size_factor)])
  );
  const factors = matrix.sampleNames.map((sample) => factorsBySample.get(sample));
  if (factors.some((factor) => !Number.isFinite(factor) || factor <= 0)) {
    throw new Error("Cannot build normalized counts because a size factor is missing or invalid.");
  }

  const groupsBySample = new Map(colDataRecords.map((row) => [row.sample, row.group]));
  const groups = matrix.sampleNames.map((sample) => groupsBySample.get(sample));
  const controlIndexes = [];
  const treatmentIndexes = [];
  groups.forEach((group, index) => {
    if (group === "control") {
      controlIndexes.push(index);
    } else if (group === "treatment") {
      treatmentIndexes.push(index);
    }
  });
  if (controlIndexes.length === 0 || treatmentIndexes.length === 0) {
    throw new Error("Normalized summaries require control and treatment samples.");
  }

  const lines = [
    ["gene_id", ...matrix.sampleNames]
      .map((value) => csvEscape(value, { protectFormula: false }))
      .join(",")
  ];
  const logValuesBySample = Array.from(
    { length: matrix.sampleCount },
    () => new Array(matrix.geneCount)
  );
  const controlMean = new Float64Array(matrix.geneCount);
  const treatmentMean = new Float64Array(matrix.geneCount);
  const controlMedian = new Float64Array(matrix.geneCount);
  const treatmentMedian = new Float64Array(matrix.geneCount);

  for (let geneIndex = 0; geneIndex < matrix.geneCount; geneIndex += 1) {
    const normalized = new Array(matrix.sampleCount);
    for (let sampleIndex = 0; sampleIndex < matrix.sampleCount; sampleIndex += 1) {
      const count = matrix.counts[sampleIndex * matrix.geneCount + geneIndex];
      const value = count / factors[sampleIndex];
      normalized[sampleIndex] = value;
      logValuesBySample[sampleIndex][geneIndex] = Math.log10(value + 1);
    }

    const controlValues = controlIndexes.map((index) => normalized[index]);
    const treatmentValues = treatmentIndexes.map((index) => normalized[index]);
    controlMean[geneIndex] = controlValues.reduce((sum, value) => sum + value, 0) / controlValues.length;
    treatmentMean[geneIndex] = treatmentValues.reduce((sum, value) => sum + value, 0) / treatmentValues.length;
    controlMedian[geneIndex] = median(controlValues);
    treatmentMedian[geneIndex] = median(treatmentValues);

    lines.push([
      csvEscape(matrix.geneIds[geneIndex], { protectFormula: false }),
      ...normalized.map(String)
    ].join(","));
  }

  const boxplot = logValuesBySample.map((values, sampleIndex) => {
    values.sort((left, right) => left - right);
    return {
      sample: matrix.sampleNames[sampleIndex],
      group: groups[sampleIndex],
      min: values[0],
      q1: quantileSorted(values, 0.25),
      median: quantileSorted(values, 0.5),
      q3: quantileSorted(values, 0.75),
      max: values[values.length - 1]
    };
  });

  return {
    normalizedCsv: lines.join("\r\n") + "\r\n",
    normalizedBoxplot: boxplot,
    normalizedStats: {
      controlMean,
      treatmentMean,
      controlMedian,
      treatmentMedian
    }
  };
}

function expandLargeRunResults(resultRows, preparedMatrix, normalizedStats) {
  const byGene = new Map(resultRows.map((row) => [row.gene_id, row]));
  const statisticalColumns = [
    "baseMean",
    "log2FoldChange",
    "lfcSE",
    "stat",
    "pvalue",
    "padj"
  ];

  return preparedMatrix.fullMatrix.geneIds.map((geneId, geneIndex) => {
    const fitted = byGene.get(geneId);
    const row = fitted
      ? { ...fitted }
      : {
        gene_id: geneId,
        prefilter_pass: "FALSE"
      };
    for (const column of statisticalColumns) {
      if (!(column in row)) {
        row[column] = "";
      }
    }
    row.prefilter_pass = preparedMatrix.keepMask[geneIndex] ? "TRUE" : "FALSE";
    row.control_normalized_mean = String(normalizedStats.controlMean[geneIndex]);
    row.treatment_normalized_mean = String(normalizedStats.treatmentMean[geneIndex]);
    row.control_normalized_median = String(normalizedStats.controlMedian[geneIndex]);
    row.treatment_normalized_median = String(normalizedStats.treatmentMedian[geneIndex]);
    return row;
  });
}

export function buildDeseq2RunnerCode({
  countsPath,
  colDataPath,
  resultPath,
  normalizedPath,
  normalizedSummaryPath,
  sizeFactorPath,
  summaryPath,
  logPath,
  statusPath,
  pcaPath,
  correlationPath,
  distancePath,
  dispersionPath,
  parameters,
  plots,
  compactLargeRun = false
}) {
  const test = resolveDeseqTest(parameters.test);
  const fitCode = test === "LRT"
    ? `dds <- DESeq2::nbinomLRT(
              dds,
              reduced = ~ 1,
              quiet = TRUE
            )`
    : `dds <- DESeq2::nbinomWaldTest(
              dds,
              quiet = TRUE
            )`;

  return `
    writeLines(
      paste(format(Sys.time(), "%Y-%m-%d %H:%M:%S"), "0. R job file started"),
      con = ${rString(logPath)},
      useBytes = TRUE
    )

    run_browser_deseq2_app <- function() {
      logs <- readLines(${rString(logPath)}, warn = FALSE)
      add_log <- function(message) {
        logs <<- c(
          logs,
          paste(
            format(
              Sys.time(),
              "%Y-%m-%d %H:%M:%S"
            ),
            message
          )
        )
        write_log()
        progress_token <- getOption(
          "browser_deseq2_progress_token",
          ""
        )
        if (
          is.character(progress_token) &&
          length(progress_token) == 1L &&
          nzchar(progress_token)
        ) {
          progress_message <- gsub(
            "[\\r\\n]+",
            " ",
            as.character(message)
          )
          cat(
            "DESEQ2_PROGRESS|",
            progress_token,
            "|",
            progress_message,
            "\n",
            sep = ""
          )
          flush.console()
        }
      }

      write_log <- function() {
        writeLines(
          logs,
          con = ${rString(logPath)},
          useBytes = TRUE
        )
      }

      on.exit(
        write_log(),
        add = TRUE
      )

      append_plot_warning <- function(label, err) {
        add_log(
          paste0(
            "Plot warning [",
            label,
            "]: ",
            conditionMessage(err)
          )
        )
      }

      tryCatch(
        withCallingHandlers(
          {
            started_at <- Sys.time()
            add_log("1. Preparing count matrix")

            header_df <- utils::read.csv(
              ${rString(countsPath)},
              nrows = 0L,
              check.names = FALSE
            )

            if (ncol(header_df) < 5L) {
              stop("At least four selected samples are required.")
            }

            sample_names <- colnames(header_df)[
              -1L
            ]

            counts_df <- utils::read.csv(
              ${rString(countsPath)},
              check.names = FALSE,
              stringsAsFactors = FALSE,
              colClasses = c(
                "character",
                rep(
                  "integer",
                  length(sample_names)
                )
              )
            )

            gene_id <- as.character(
              counts_df[[1L]]
            )

            if (
              anyNA(gene_id) ||
              any(gene_id == "")
            ) {
              stop("Gene IDs must not be empty.")
            }

            if (anyDuplicated(gene_id)) {
              stop("Gene IDs must be unique.")
            }

            count_matrix <- as.matrix(
              counts_df[
                ,
                -1L,
                drop = FALSE
              ]
            )

            rm(
              counts_df,
              header_df
            )
            gc(FALSE)

            if (!is.integer(count_matrix)) {
              storage.mode(
                count_matrix
              ) <- "integer"
            }

            dimnames(count_matrix) <- list(
              gene_id,
              sample_names
            )

            if (anyDuplicated(sample_names)) {
              stop("Selected sample names must be unique.")
            }

            if (anyNA(count_matrix)) {
              stop("All count values must be finite integer numbers.")
            }

            if (any(count_matrix < 0L)) {
              stop("Count values must be non-negative.")
            }

            if (
              any(
                count_matrix >
                  .Machine$integer.max
              )
            ) {
              stop("A count value exceeds R's integer range.")
            }

            col_data <- utils::read.csv(
              ${rString(colDataPath)},
              check.names = FALSE,
              stringsAsFactors = FALSE
            )

            if (!"sample" %in% colnames(col_data)) {
              stop("Sample metadata requires a sample column.")
            }

            if (!"group" %in% colnames(col_data)) {
              stop("Sample metadata requires a group column.")
            }

            if (anyDuplicated(col_data$sample)) {
              stop("Sample metadata contains duplicate sample names.")
            }

            if (!setequal(sample_names, col_data$sample)) {
              stop("Sample names in count matrix and sample metadata do not match.")
            }

            col_data <- col_data[
              match(
                sample_names,
                col_data$sample
              ),
              ,
              drop = FALSE
            ]

            rownames(col_data) <- col_data$sample
            col_data$group <- factor(
              col_data$group,
              levels = c(
                "control",
                "treatment"
              )
            )

            if (anyNA(col_data$group)) {
              stop("Groups must be control or treatment.")
            }

            add_log("2. Applying low-expression filter")

            input_genes <- nrow(count_matrix)
            selected_sample_count <- ncol(count_matrix)
            pre_filtering <- ${rBool(parameters.preFiltering)}
            minimum_count <- as.integer(${Number(parameters.minimumCount)})
            browser_safety_filter <- FALSE
            browser_safety_min_count <- NA_integer_
            browser_safety_min_samples <- NA_integer_
            if (pre_filtering) {
              add_log(
                paste(
                  "Pre-filter: keeping genes with total count >=",
                  minimum_count,
                  "across selected samples."
                )
              )
              keep <- rowSums(count_matrix) >= minimum_count
            } else {
              keep <- rep(
                TRUE,
                nrow(count_matrix)
              )
            }

            genes_after_filtering <- sum(keep)

            if (genes_after_filtering < 1L) {
              stop("All genes were removed by low-expression pre-filtering.")
            }

            add_log("3. Creating DESeqDataSet")

            count_matrix_for_deseq <- count_matrix[
              keep,
              ,
              drop = FALSE
            ]

            add_log(
              paste(
                "Filtered matrix:",
                nrow(count_matrix_for_deseq),
                "genes x",
                ncol(count_matrix_for_deseq),
                "samples"
              )
            )

            dds <- DESeq2::DESeqDataSetFromMatrix(
              countData = count_matrix_for_deseq,
              colData = col_data,
              design = ~ group
            )

            rm(
              count_matrix_for_deseq
            )
            gc(FALSE)

            add_log("4. Estimating size factors")

            dds <- DESeq2::estimateSizeFactors(
              dds,
              type = ${rString(parameters.sfType)}
            )

            sample_size_factors <- DESeq2::sizeFactors(dds)
            names(sample_size_factors) <- colnames(dds)

            control_idx <- col_data$group == "control"
            treatment_idx <- col_data$group == "treatment"

            if (${rBool(!compactLargeRun)}) {
              full_normalized <- sweep(
                count_matrix,
                2L,
                sample_size_factors[colnames(count_matrix)],
                "/"
              )

              control_normalized_mean <- rowMeans(
                full_normalized[
                  ,
                  control_idx,
                  drop = FALSE
                ]
              )

              treatment_normalized_mean <- rowMeans(
                full_normalized[
                  ,
                  treatment_idx,
                  drop = FALSE
                ]
              )

              control_normalized_median <- apply(
                full_normalized[
                  ,
                  control_idx,
                  drop = FALSE
                ],
                1L,
                stats::median
              )

              treatment_normalized_median <- apply(
                full_normalized[
                  ,
                  treatment_idx,
                  drop = FALSE
                ],
                1L,
                stats::median
              )

              normalized_df <- data.frame(
                gene_id = gene_id,
                full_normalized,
                check.names = FALSE
              )

              utils::write.csv(
                normalized_df,
                file = ${rString(normalizedPath)},
                row.names = FALSE,
                na = ""
              )

              normalized_summary <- data.frame(
                sample = colnames(full_normalized),
                group = as.character(
                  col_data[
                    colnames(full_normalized),
                    "group"
                  ]
                ),
                min = NA_real_,
                q1 = NA_real_,
                median = NA_real_,
                q3 = NA_real_,
                max = NA_real_,
                check.names = FALSE
              )

              for (sample_index in seq_len(ncol(full_normalized))) {
                values <- log10(
                  full_normalized[
                    ,
                    sample_index
                  ] + 1
                )

                normalized_summary$min[sample_index] <- min(
                  values,
                  na.rm = TRUE
                )
                normalized_summary$q1[sample_index] <- stats::quantile(
                  values,
                  probs = 0.25,
                  na.rm = TRUE,
                  names = FALSE
                )
                normalized_summary$median[sample_index] <- stats::median(
                  values,
                  na.rm = TRUE
                )
                normalized_summary$q3[sample_index] <- stats::quantile(
                  values,
                  probs = 0.75,
                  na.rm = TRUE,
                  names = FALSE
                )
                normalized_summary$max[sample_index] <- max(
                  values,
                  na.rm = TRUE
                )
              }

              utils::write.csv(
                normalized_summary,
                file = ${rString(normalizedSummaryPath)},
                row.names = FALSE,
                na = ""
              )

              rm(
                count_matrix,
                full_normalized,
                normalized_df,
                normalized_summary
              )
            } else {
              rm(count_matrix)
            }
            gc(FALSE)

            add_log("5. Estimating dispersions")

            dispersion_fit_type_requested <- ${rString(parameters.fitType)}
            dispersion_fit_type_used <- dispersion_fit_type_requested
            dds <- tryCatch(
              DESeq2::estimateDispersions(
                dds,
                fitType = dispersion_fit_type_requested,
                quiet = TRUE
              ),
              error = function(e) {
                dispersion_message <- conditionMessage(e)
                if (!grepl(
                  "all gene-wise dispersion estimates are within 2 orders of magnitude|standard curve fitting techniques will not work",
                  dispersion_message,
                  ignore.case = TRUE
                )) {
                  stop(e)
                }

                add_log(
                  paste(
                    "Dispersion fit fallback: using gene-wise dispersion estimates because",
                    dispersion_message
                  )
                )
                dds <- DESeq2::estimateDispersionsGeneEst(
                  dds,
                  quiet = TRUE
                )
                dispersions(dds) <- S4Vectors::mcols(dds)$dispGeneEst
                dispersion_fit_type_used <<- "gene-wise"
                dds
              }
            )

            add_log(${rString(`6. Fitting ${test} model`)})

            ${fitCode}

            add_log("7. Generating results")

            requested_cooks_cutoff <- ${rBool(parameters.cooksCutoff)}
            cooks_cutoff_used <- requested_cooks_cutoff
            get_results <- function(cooks_cutoff) {
              DESeq2::results(
                dds,
                contrast = c(
                  "group",
                  "treatment",
                  "control"
                ),
                alpha = ${Number(parameters.fdrThreshold)},
                independentFiltering = ${rBool(parameters.independentFiltering)},
                cooksCutoff = cooks_cutoff
              )
            }

            res <- tryCatch(
              get_results(requested_cooks_cutoff),
              error = function(e) {
                if (!requested_cooks_cutoff) {
                  stop(e)
                }

                add_log(
                  paste(
                    "Cook's cutoff failed; retrying results() with cooksCutoff = FALSE:",
                    conditionMessage(e)
                  )
                )
                cooks_cutoff_used <<- FALSE
                get_results(FALSE)
              }
            )

            result_df <- as.data.frame(res)
            tested_genes <- nrow(result_df)

            full_result <- data.frame(
              gene_id = gene_id,
              prefilter_pass = keep,
              stringsAsFactors = FALSE,
              check.names = FALSE
            )

            for (column_name in colnames(result_df)) {
              full_result[[column_name]] <- NA_real_
            }

            kept_index <- match(
              rownames(result_df),
              gene_id
            )

            for (column_name in colnames(result_df)) {
              full_result[[column_name]][kept_index] <- result_df[[column_name]]
            }

            if (${rBool(!compactLargeRun)}) {
              full_result$control_normalized_mean <- control_normalized_mean
              full_result$treatment_normalized_mean <- treatment_normalized_mean
              full_result$control_normalized_median <- control_normalized_median
              full_result$treatment_normalized_median <- treatment_normalized_median
            }

            utils::write.csv(
              full_result,
              file = ${rString(resultPath)},
              row.names = FALSE,
              na = ""
            )

            if (${rBool(!compactLargeRun)}) {
              rm(
                full_result,
                result_df,
                control_normalized_mean,
                treatment_normalized_mean,
                control_normalized_median,
                treatment_normalized_median
              )
            } else {
              rm(full_result, result_df)
            }
            gc(FALSE)

            size_factor_df <- data.frame(
              sample = names(sample_size_factors),
              group = as.character(
                col_data[
                  names(sample_size_factors),
                  "group"
                ]
              ),
              size_factor = as.numeric(sample_size_factors),
              check.names = FALSE
            )

            utils::write.csv(
              size_factor_df,
              file = ${rString(sizeFactorPath)},
              row.names = FALSE,
              na = ""
            )

            add_log("8. Additional plot calculations")

            if (${rBool(plots.dispersion)}) {
              tryCatch(
                {
                  dispersion_df <- data.frame(
                    gene_id = rownames(dds),
                    mean = S4Vectors::mcols(dds)$baseMean,
                    dispersion = DESeq2::dispersions(dds),
                    check.names = FALSE
                  )

                  utils::write.csv(
                    dispersion_df,
                    file = ${rString(dispersionPath)},
                    row.names = FALSE,
                    na = ""
                  )
                },
                error = function(e) {
                  append_plot_warning("dispersion", e)
                }
              )
            }

            if (${rBool(plots.pca)}) {
              tryCatch(
                {
                  add_log("PCA selected: running vst() and prcomp()")
                  vsd <- DESeq2::vst(
                    dds,
                    blind = TRUE
                  )

                  vst_matrix <- SummarizedExperiment::assay(vsd)
                  gene_variance <- matrixStats::rowVars(vst_matrix)
                  top_n <- min(
                    5000L,
                    length(gene_variance)
                  )

                  selected_gene_index <- order(
                    gene_variance,
                    decreasing = TRUE
                  )[seq_len(top_n)]

                  add_log(
                    paste(
                      "PCA genes used:",
                      top_n
                    )
                  )

                  pca <- stats::prcomp(
                    t(
                      vst_matrix[
                        selected_gene_index,
                        ,
                        drop = FALSE
                      ]
                    )
                  )

                  percent <- pca$sdev^2 / sum(pca$sdev^2) * 100

                  pca_df <- data.frame(
                    sample = rownames(pca$x),
                    group = as.character(
                      col_data[
                        rownames(pca$x),
                        "group"
                      ]
                    ),
                    PC1 = pca$x[, 1L],
                    PC2 = pca$x[, 2L],
                    PC1_percent = percent[1L],
                    PC2_percent = percent[2L],
                    genes_used = top_n,
                    check.names = FALSE
                  )

                  utils::write.csv(
                    pca_df,
                    file = ${rString(pcaPath)},
                    row.names = FALSE,
                    na = ""
                  )
                },
                error = function(e) {
                  append_plot_warning("PCA", e)
                }
              )
            }

            if (${rBool(plots.sampleCorrelation)} || ${rBool(plots.sampleDistance)}) {
              transformed <- log2(
                DESeq2::counts(
                  dds,
                  normalized = TRUE
                ) + 1
              )
            }

            if (${rBool(plots.sampleCorrelation)}) {
              tryCatch(
                {
                  add_log("Sample correlation heatmap selected: running cor()")
                  correlation_matrix <- stats::cor(
                    transformed
                  )

                  correlation_df <- data.frame(
                    sample = rownames(correlation_matrix),
                    correlation_matrix,
                    check.names = FALSE
                  )

                  utils::write.csv(
                    correlation_df,
                    file = ${rString(correlationPath)},
                    row.names = FALSE,
                    na = ""
                  )
                },
                error = function(e) {
                  append_plot_warning("sample correlation", e)
                }
              )
            }

            if (${rBool(plots.sampleDistance)}) {
              tryCatch(
                {
                  add_log("Sample distance heatmap selected: running dist()")
                  distance_matrix <- as.matrix(
                    stats::dist(
                      t(transformed)
                    )
                  )

                  distance_df <- data.frame(
                    sample = rownames(distance_matrix),
                    distance_matrix,
                    check.names = FALSE
                  )

                  utils::write.csv(
                    distance_df,
                    file = ${rString(distancePath)},
                    row.names = FALSE,
                    na = ""
                  )
                },
                error = function(e) {
                  append_plot_warning("sample distance", e)
                }
              )
            }

            add_log("9. Rendering plots in browser")

            finished_at <- Sys.time()
            execution_time <- as.numeric(
              difftime(
                finished_at,
                started_at,
                units = "secs"
              )
            )

            summary_df <- data.frame(
              key = c(
                "input_genes",
                "genes_after_prefiltering",
                "tested_genes",
                "samples",
                "control_samples",
                "treatment_samples",
                "browser_safety_filter",
                "browser_safety_min_count",
                "browser_safety_min_samples",
                "dispersion_fit_type_requested",
                "dispersion_fit_type_used",
                "cooks_cutoff_requested",
                "cooks_cutoff_used",
                "execution_time_seconds",
                "r_version",
                "deseq2_version"
              ),
              value = c(
                input_genes,
                genes_after_filtering,
                tested_genes,
                selected_sample_count,
                sum(control_idx),
                sum(treatment_idx),
                browser_safety_filter,
                ifelse(
                  is.na(browser_safety_min_count),
                  "",
                  browser_safety_min_count
                ),
                ifelse(
                  is.na(browser_safety_min_samples),
                  "",
                  browser_safety_min_samples
                ),
                dispersion_fit_type_requested,
                dispersion_fit_type_used,
                requested_cooks_cutoff,
                cooks_cutoff_used,
                execution_time,
                R.version.string,
                as.character(
                  utils::packageVersion("DESeq2")
                )
              ),
              check.names = FALSE
            )

            utils::write.csv(
              summary_df,
              file = ${rString(summaryPath)},
              row.names = FALSE,
              na = ""
            )

            add_log("Completed")

            "OK"
          },
          warning = function(w) {
            add_log(
              paste(
                "Warning:",
                conditionMessage(w)
              )
            )
            invokeRestart("muffleWarning")
          },
          message = function(m) {
            add_log(
              paste(
                "Message:",
                conditionMessage(m)
              )
            )
            invokeRestart("muffleMessage")
          }
        ),
        error = function(e) {
          add_log(
            paste(
              "Error:",
              conditionMessage(e)
            )
          )
          paste0(
            "ERROR|",
            conditionMessage(e)
          )
        }
      )
    }

    browser_deseq2_status <- run_browser_deseq2_app()
    writeLines(
      as.character(browser_deseq2_status),
      con = ${rString(statusPath)},
      useBytes = TRUE
    )
    rm(run_browser_deseq2_app)
    rm(browser_deseq2_status)
    invisible(gc(FALSE))
  `;
}

async function readTextFile(webR, path) {
  try {
    const bytes = await webR.FS.readFile(path);
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

export function buildConsoleRJobCommand({ bootstrapPath, runToken }) {
  const parsedJobName = ".browser_deseq2_parsed_job";
  return [
    "invisible(local({",
    `base::writeLines("CONSOLE_STARTED", con = ${rString(bootstrapPath)}, useBytes = TRUE);`,
    '.old_progress_token <- base::getOption("browser_deseq2_progress_token", NULL);',
    `base::options(browser_deseq2_progress_token = ${rString(runToken)});`,
    `base::cat(${rString(`DESEQ2_PROGRESS|${runToken}|R console accepted job`)}, "\\n", sep = "");`,
    "base::flush.console();",
    ".browser_bootstrap_status <- tryCatch({",
    `if (!base::exists(${rString(parsedJobName)}, envir = .GlobalEnv, inherits = FALSE)) base::stop("The parsed R job is missing.");`,
    `.browser_parsed_job <- base::get(${rString(parsedJobName)}, envir = .GlobalEnv, inherits = FALSE);`,
    "for (.browser_expression in .browser_parsed_job) base::eval(.browser_expression, envir = .GlobalEnv);",
    '"CONSOLE_OK"',
    "}, error = function(e) {",
    'paste0("BOOTSTRAP_ERROR|", conditionMessage(e))',
    "});",
    `if (base::exists(${rString(parsedJobName)}, envir = .GlobalEnv, inherits = FALSE)) base::rm(list = ${rString(parsedJobName)}, envir = .GlobalEnv);`,
    "base::options(browser_deseq2_progress_token = .old_progress_token);",
    `base::writeLines(.browser_bootstrap_status, con = ${rString(bootstrapPath)}, useBytes = TRUE);`,
    `base::cat(${rString(`DESEQ2_CONSOLE_DONE|${runToken}|`)}, if (.browser_bootstrap_status == "CONSOLE_OK") "OK" else "ERROR", "\\n", sep = "");`,
    "base::flush.console();",
    "rm(.browser_bootstrap_status, .old_progress_token)",
    "}))"
  ].join(" ");
}

function readConsoleOutputWithHeartbeat(readPromise, heartbeatIntervalMs) {
  let timerId;
  const heartbeat = new Promise((resolve) => {
    timerId = setTimeout(
      () => resolve({ type: "heartbeat" }),
      heartbeatIntervalMs
    );
  });

  return Promise.race([
    readPromise.then((output) => ({ type: "output", output })),
    heartbeat
  ]).finally(() => clearTimeout(timerId));
}

export async function monitorConsoleRJob(
  webR,
  runToken,
  onProgress = null,
  heartbeatIntervalMs = 5000
) {
  const progressPrefix = `DESEQ2_PROGRESS|${runToken}|`;
  const donePrefix = `DESEQ2_CONSOLE_DONE|${runToken}|`;
  const startedAt = Date.now();
  let stageStartedAt = startedAt;
  let receivedRProgress = false;
  let lastStage = "Waiting for R console to accept DESeq2 job";
  let pendingRead = webR.read();

  while (true) {
    const event = await readConsoleOutputWithHeartbeat(
      pendingRead,
      heartbeatIntervalMs
    );

    if (event.type === "heartbeat") {
      const totalSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
      const stageSeconds = Math.max(1, Math.floor((Date.now() - stageStartedAt) / 1000));
      const totalElapsed = totalSeconds < 60
        ? `${totalSeconds} sec total`
        : `${Math.floor(totalSeconds / 60)} min total`;
      const stageElapsed = stageSeconds < 60
        ? `${stageSeconds} sec in this stage`
        : `${Math.floor(stageSeconds / 60)} min in this stage`;
      const detail = receivedRProgress
        ? `${stageElapsed}; ${totalElapsed}`
        : `${totalElapsed}; DESeq2 has not started`;
      onProgress?.(`${lastStage} (${detail})`);
      continue;
    }

    const output = event.output;
    if (output?.type === "closed") {
      throw new Error("The webR output channel closed while DESeq2 was running.");
    }

    pendingRead = webR.read();
    if (output?.type !== "stdout" && output?.type !== "stderr") {
      continue;
    }

    const lines = String(output.data ?? "").split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith(progressPrefix)) {
        const detail = line.slice(progressPrefix.length).trim();
        if (detail) {
          receivedRProgress = true;
          stageStartedAt = Date.now();
          lastStage = `DESeq2: ${detail}`;
          onProgress?.(lastStage);
        }
      }

      if (line.startsWith(donePrefix)) {
        return line.slice(donePrefix.length).trim();
      }
    }
  }
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function describeRuntimeError(error) {
  const details = [];
  const constructorName = error?.constructor?.name;
  if (constructorName) {
    details.push(`JavaScript error class: ${constructorName}`);
  }

  if (error?.stack) {
    const stackHead = String(error.stack)
      .split("\n")
      .slice(0, 4)
      .join(" | ");
    if (stackHead) {
      details.push(`JavaScript stack: ${stackHead}`);
    }
  }

  if (error?.cause) {
    details.push(`JavaScript cause: ${formatError(error.cause)}`);
  }

  return details;
}

export function isWebRBridgeError(error) {
  const diagnosticText = [
    error?.name,
    error?.message,
    error?.stack,
    error?.cause?.message,
    error?.cause?.stack
  ]
    .filter(Boolean)
    .join("\n");

  return /(?:R\.js|webr-worker|wasm-function|lengthBytesUTF8|stringToUTF8OnStack|allocateUTF8OnStack|emscripten|WebAssembly|SharedArrayBuffer|PostMessage)/i.test(
    diagnosticText
  );
}

async function assertWebRResponsive(webR) {
  const status = await webR.evalRString('"OK"');
  if (status !== "OK") {
    throw new Error(`Unexpected webR health-check result: ${String(status)}`);
  }
}

async function probeWebRResponsive(webR, timeoutMs = 3000) {
  let timeoutId;

  try {
    return await Promise.race([
      assertWebRResponsive(webR).then(() => true).catch(() => false),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseKeyValueCsv(text) {
  if (!text) {
    return {};
  }

  const { records } = parseCsvObjects(text);
  const result = {};

  for (const record of records) {
    result[record.key] = record.value;
  }

  return result;
}

async function cleanupTempFiles(webR, paths) {
  for (const path of Object.values(paths)) {
    try {
      await webR.FS.unlink(path);
    } catch {
      // Missing temp files are expected when optional plots are disabled.
    }
  }
}

export async function runDeseqAnalysis({
  countCsv,
  countMatrix = null,
  colDataCsv,
  parameters,
  plots,
  onProgress = null
}) {
  const id = runId();
  const stagedStateName = `.browser_${id}`;
  const colDataRecords = parseCsvObjects(colDataCsv).records;
  const selectedSampleCount = colDataRecords.length;
  const inputGeneCount = countMatrix?.geneCount ?? countDataRows(countCsv || "");
  const stagedMatrixRun = Boolean(countMatrix);
  const largeRun = stagedMatrixRun && selectedSampleCount >= 6 && inputGeneCount >= 25000;
  let webR = null;
  let fitMatrix = null;
  let preparedMatrix = null;
  let webRResponsive = true;
  const bridgeDiagnostics = [];
  let stage = "Initializing webR";
  const progress = (message) => {
    stage = message;
    onProgress?.(message);
  };

  const paths = {
    countsPath: `/tmp/${id}_counts.bin`,
    geneIdsPath: `/tmp/${id}_gene_ids.txt`,
    colDataPath: `/tmp/${id}_coldata.csv`,
    resultPath: `/tmp/${id}_results.csv`,
    normalizedPath: `/tmp/${id}_normalized.csv`,
    normalizedSummaryPath: `/tmp/${id}_normalized_summary.csv`,
    sizeFactorPath: `/tmp/${id}_size_factors.csv`,
    summaryPath: `/tmp/${id}_summary.csv`,
    logPath: `/tmp/${id}_analysis_log.txt`,
    statusPath: `/tmp/${id}_status.txt`,
    scriptPath: `/tmp/${id}_analysis.R`,
    bootstrapPath: `/tmp/${id}_bootstrap.txt`,
    pcaPath: `/tmp/${id}_pca.csv`,
    correlationPath: `/tmp/${id}_sample_correlation.csv`,
    distancePath: `/tmp/${id}_sample_distance.csv`,
    dispersionPath: `/tmp/${id}_dispersion.csv`
  };

  try {
    if (stagedMatrixRun) {
      bridgeDiagnostics.push(
        largeRun
          ? "Large-run webR channel requested: PostMessage compatibility mode"
          : "Uploaded count matrix uses staged PostMessage compatibility mode"
      );

      progress(largeRun
        ? "Filtering large count matrix in browser"
        : "Filtering uploaded count matrix in browser");
      const fullMatrix = countMatrix;
      preparedMatrix = prefilterBinaryCountMatrix(
        fullMatrix,
        parameters
      );
      fitMatrix = preparedMatrix.fitMatrix;

      const metadataSamples = colDataRecords.map((row) => row.sample);
      const sampleOrderMatches = fitMatrix.sampleNames.every(
        (sample, index) => sample === metadataSamples[index]
      );
      if (!sampleOrderMatches) {
        throw new Error("Sample order in the count matrix and metadata does not match.");
      }
    }

    progress(stagedMatrixRun
      ? "Initializing webR PostMessage compatibility mode"
      : "Initializing webR");
    webR = await webrManager.initialize({ forcePostMessage: stagedMatrixRun });

    const selectedChannel = webrManager.getChannelSummary();
    bridgeDiagnostics.push(`webR channel selected: ${selectedChannel.channelType}`);
    bridgeDiagnostics.push(
      `Cross-origin isolated: ${selectedChannel.crossOriginIsolated ? "yes" : "no"}`
    );
    bridgeDiagnostics.push(
      `SharedArrayBuffer available: ${selectedChannel.sharedArrayBufferAvailable ? "yes" : "no"}`
    );

    if (stagedMatrixRun) {
      progress("Reclaiming webR memory after package loading");
      await webR.evalRVoid("invisible(gc(FALSE))");
    }

    if (stagedMatrixRun) {
      progress("Transferring binary count matrix");
      const countBytes = encodeInt32LittleEndian(fitMatrix.counts);
      const geneIdBytes = encodeGeneIdLines(fitMatrix.geneIds);
      await webR.FS.writeFile(paths.countsPath, countBytes);
      await webR.FS.writeFile(paths.geneIdsPath, geneIdBytes);
      bridgeDiagnostics.push(
        `Binary fitting matrix transferred: ${fitMatrix.geneCount} genes x ${fitMatrix.sampleCount} samples, ${countBytes.byteLength} count bytes, ${geneIdBytes.byteLength} gene-ID bytes`
      );
    } else {
      progress("Preparing matrix");
      await webR.FS.writeFile(
        paths.countsPath,
        encoder.encode(countCsv)
      );
      await webR.FS.writeFile(
        paths.colDataPath,
        encoder.encode(colDataCsv)
      );

      progress("Transferring R job");
      const runnerScript = buildDeseq2RunnerCode({
        ...paths,
        parameters,
        plots,
        compactLargeRun: false
      });
      await webR.FS.writeFile(
        paths.scriptPath,
        encoder.encode(runnerScript)
      );

      progress("Verifying R job transfer");
      const expectedScriptBytes = encoder.encode(runnerScript);
      const transferredScriptBytes = await webR.FS.readFile(paths.scriptPath);
      if (!bytesEqual(expectedScriptBytes, transferredScriptBytes)) {
        throw new Error("The R job file changed while being transferred to webR.");
      }
      bridgeDiagnostics.push(`R job transfer verified: ${expectedScriptBytes.byteLength} bytes`);

      progress("Validating R job in webR");
      const preflightOk = await webR.evalRBoolean(`
        tryCatch(
          {
            parsed_job <- base::parse(
              file = ${rString(paths.scriptPath)},
              keep.source = FALSE
            )
            rm(parsed_job)
            base::writeLines(
              "PREFLIGHT_OK",
              con = ${rString(paths.bootstrapPath)},
              useBytes = TRUE
            )
            TRUE
          },
          error = function(e) {
            base::writeLines(
              paste0("PREFLIGHT_ERROR|", conditionMessage(e)),
              con = ${rString(paths.bootstrapPath)},
              useBytes = TRUE
            )
            FALSE
          }
        )
      `);
      const preflightStatus = await readTextFile(webR, paths.bootstrapPath);
      if (!preflightOk || preflightStatus?.trim() !== "PREFLIGHT_OK") {
        throw new Error(
          `R job preflight failed: ${preflightStatus?.trim() || "no bootstrap status was written"}`
        );
      }
      bridgeDiagnostics.push("R job parsed successfully inside webR");
      bridgeDiagnostics.push("R bootstrap file write verified");
    }

    let bootstrapOk;
    if (stagedMatrixRun) {
      progress("Starting binary staged DESeq2 analysis");
      bridgeDiagnostics.push(
        "CSV and numeric-literal loading disabled: counts use readBin() and gene IDs use readLines()"
      );
      await runStagedDeseq2({
        webR,
        stateName: stagedStateName,
        paths,
        parameters,
        plots,
        matrixInput: fitMatrix,
        groups: colDataRecords.map((row) => row.group),
        readTextFile,
        onProgress: progress
      });
      await webR.FS.writeFile(
        paths.statusPath,
        encoder.encode("OK")
      );
      bootstrapOk = true;
      bridgeDiagnostics.push("Staged R analysis completed successfully");
    } else {
      progress("Running DESeq2 job");
      bootstrapOk = await webR.evalRBoolean(`
        tryCatch(
          {
            base::sys.source(
              ${rString(paths.scriptPath)},
              envir = .GlobalEnv
            )
            TRUE
          },
          error = function(e) {
            base::writeLines(
              paste0("BOOTSTRAP_ERROR|", conditionMessage(e)),
              con = ${rString(paths.bootstrapPath)},
              useBytes = TRUE
            )
            FALSE
          }
        )
      `);
    }
    if (!bootstrapOk) {
      const bootstrapFailure = await readTextFile(webR, paths.bootstrapPath);
      throw new Error(
        `R job bootstrap failed: ${bootstrapFailure?.trim() || "no bootstrap error was written"}`
      );
    }
    const statusText = await readTextFile(webR, paths.statusPath);
    if (!statusText) {
      throw new Error("The R job returned without creating its status file.");
    }
    const status = statusText.trim();

    const analysisLog = await readTextFile(webR, paths.logPath);

    if (status.startsWith("ERROR|")) {
      const message = status.substring("ERROR|".length);
      const error = new Error(message);
      error.analysisLog = analysisLog;
      error.rAnalysisError = true;
      error.context = {
        selectedSamples: colDataCsv.split(/\r?\n/).length - 2,
        parameters
      };
      throw error;
    }

    if (status !== "OK") {
      throw new Error(`Unexpected R result: ${status}`);
    }

    const [
      resultCsv,
      normalizedCsv,
      normalizedSummaryCsv,
      sizeFactorCsv,
      summaryCsv,
      pcaCsv,
      correlationCsv,
      distanceCsv,
      dispersionCsv
    ] = await Promise.all([
      readTextFile(webR, paths.resultPath),
      readTextFile(webR, paths.normalizedPath),
      readTextFile(webR, paths.normalizedSummaryPath),
      readTextFile(webR, paths.sizeFactorPath),
      readTextFile(webR, paths.summaryPath),
      readTextFile(webR, paths.pcaPath),
      readTextFile(webR, paths.correlationPath),
      readTextFile(webR, paths.distancePath),
      readTextFile(webR, paths.dispersionPath)
    ]);

    const sizeFactors = parseCsvObjects(sizeFactorCsv).records;
    let resultRows = parseCsvObjects(resultCsv).records;
    let resolvedNormalizedCsv = normalizedCsv || "";
    let resolvedNormalizedBoxplot = normalizedSummaryCsv
      ? parseCsvObjects(normalizedSummaryCsv).records
      : [];
    let parsedSummary = parseKeyValueCsv(summaryCsv);

    if (stagedMatrixRun) {
      progress("Restoring all-gene normalized results");
      const normalizedOutputs = buildNormalizedOutputs(
        preparedMatrix.fullMatrix,
        sizeFactors,
        colDataRecords
      );
      resolvedNormalizedCsv = normalizedOutputs.normalizedCsv;
      resolvedNormalizedBoxplot = normalizedOutputs.normalizedBoxplot;
      resultRows = expandLargeRunResults(
        resultRows,
        preparedMatrix,
        normalizedOutputs.normalizedStats
      );
      parsedSummary = {
        ...parsedSummary,
        input_genes: String(preparedMatrix.fullMatrix.geneCount),
        genes_after_prefiltering: String(preparedMatrix.fitMatrix.geneCount),
        tested_genes: String(preparedMatrix.fitMatrix.geneCount),
        browser_safety_filter: "FALSE",
        browser_safety_min_count: "NA",
        browser_safety_min_samples: "NA",
        staged_execution: "TRUE",
        js_prefiltering: "TRUE"
      };
    }

    return {
      resultRows,
      normalizedCsv: resolvedNormalizedCsv,
      normalizedBoxplot: resolvedNormalizedBoxplot,
      sizeFactors,
      summary: {
        ...parsedSummary,
        appVersion: APP_CONFIG.appVersion,
        ...webrManager.getRuntimeSummary()
      },
      analysisLog,
      plotData: {
        pca: pcaCsv ? parseCsvObjects(pcaCsv).records : [],
        sampleCorrelation: correlationCsv ? parseCsvObjects(correlationCsv).records : [],
        sampleDistance: distanceCsv ? parseCsvObjects(distanceCsv).records : [],
        dispersion: dispersionCsv ? parseCsvObjects(dispersionCsv).records : []
      }
    };
  } catch (error) {
    let recoveredLog = error.analysisLog || "";

    if (!recoveredLog) {
      try {
        recoveredLog = webR ? await readTextFile(webR, paths.logPath) : "";
      } catch {
        recoveredLog = "";
      }
    }

    const rawMessage = error.message || error.name || formatError(error) || "";
    const genericRuntimeError = !rawMessage || rawMessage === "Error" || rawMessage === "[object Object]";
    const rAnalysisError = error.rAnalysisError || Boolean(recoveredLog && /(?:^|\n)Error:/i.test(recoveredLog));
    const bridgeRuntimeError = !rAnalysisError && (genericRuntimeError || isWebRBridgeError(error));
    const bootstrapStatus = webR
      ? await readTextFile(webR, paths.bootstrapPath)
      : null;
    if (bootstrapStatus) {
      bridgeDiagnostics.push(`R bootstrap status: ${bootstrapStatus.trim()}`);
    }
    if (error.stageTransportStatus) {
      bridgeDiagnostics.push(`Staged R transport status: ${error.stageTransportStatus}`);
    }
    if (error.stageCodeBytes) {
      bridgeDiagnostics.push(`Staged R source size: ${error.stageCodeBytes} bytes`);
    }
    bridgeDiagnostics.push(...describeRuntimeError(error));
    const managerSummary = webrManager.getRuntimeSummary();
    const managerMessage = managerSummary.failureStage || managerSummary.managerMessage;
    if (managerMessage) {
      bridgeDiagnostics.push(`webR manager stage: ${managerMessage}`);
    }
    if (/lengthBytesUTF8|allocateUTF8OnStack/i.test(String(error?.stack || rawMessage))) {
      bridgeDiagnostics.push(
        "webR masked the original JavaScript error while converting its error message to an R string."
      );
    }
    if (webR) {
      webRResponsive = await probeWebRResponsive(webR);
    }
    const baseMessage = bridgeRuntimeError
      ? [
        `webR communication failed during: ${stage}.`,
        genericRuntimeError ? null : rawMessage,
        webRResponsive
          ? "The R runtime is still responsive. This was a JavaScript/webR bridge error, not an R memory termination."
          : "The R runtime no longer responds. The browser or WebAssembly worker terminated unexpectedly.",
        recoveredLog
          ? "The last R log entries are included below."
          : "No R analysis log was captured.",
        ...bridgeDiagnostics
      ].filter(Boolean).join("\n")
      : rawMessage || "webR calculation failed without a detailed message.";
    error.analysisLog = recoveredLog;
    error.stage = stage;
    error.webRBridge = bridgeRuntimeError;
    error.userMessage = `${baseMessage}\n\n${formatError(recoveredLog || "")}`.trim();
    error.message = error.userMessage;
    throw error;
  } finally {
    if (webR && webRResponsive) {
      if (stagedMatrixRun) {
        await cleanupStagedDeseq2(webR, stagedStateName);
      }
      await cleanupTempFiles(webR, paths);
    }
  }
}
