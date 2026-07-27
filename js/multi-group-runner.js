import { APP_CONFIG } from "./config.js?v=20260727-defaults";
import {
  formatError,
  parseCsvObjects
} from "./utils.js";
import { webrManager } from "./webr-manager.js?v=20260727-defaults";
import { buildDirectionMatrix } from "./intersections.js";
import {
  encodeGeneIdLines,
  encodeInt32LittleEndian,
  isWebRBridgeError
} from "./deseq-runner.js?v=20260727-defaults";
import {
  cleanupStagedMultiGroupDeseq2,
  runStagedMultiGroupDeseq2
} from "./multi-group-staged-runner.js?v=20260727-defaults";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function rString(value) {
  return JSON.stringify(String(value));
}

function rBool(value) {
  return value ? "TRUE" : "FALSE";
}

function rVector(values) {
  return `c(${values.map((value) => rString(value)).join(", ")})`;
}

function rNamedVector(entries) {
  return `c(${entries.map(([name, value]) => `${rString(name)} = ${rString(value)}`).join(", ")})`;
}

function runId() {
  return `multi_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function countDataRows(text) {
  if (!text) {
    return 0;
  }
  const rows = text.trim().split(/\r?\n/);
  return Math.max(0, rows.length - 1);
}

async function readTextFile(webR, path) {
  try {
    const bytes = await webR.FS.readFile(path);
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

async function cleanupTempFiles(webR, paths) {
  for (const path of paths.filter(Boolean)) {
    try {
      await webR.FS.unlink(path);
    } catch {
      // Optional output files may not exist after an R-side error.
    }
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

export function buildMultiGroupDeseq2RunnerCode({
  countsPath,
  colDataPath,
  globalResultPath,
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
  groups,
  contrasts,
  contrastPaths,
  runGlobal
}) {
  const groupIds = groups.map((group) => group.id);
  const contrastIds = contrasts.map((contrast) => contrast.id);
  const contrastNumerators = contrasts.map((contrast) => contrast.numeratorId);
  const contrastDenominators = contrasts.map((contrast) => contrast.denominatorId);
  const contrastLabels = contrasts.map((contrast) => contrast.label);
  const contrastPathEntries = contrasts.map((contrast) => [contrast.id, contrastPaths[contrast.id]]);

  return `
    writeLines(
      paste(format(Sys.time(), "%Y-%m-%d %H:%M:%S"), "0. Multi-group R job file started"),
      con = ${rString(logPath)},
      useBytes = TRUE
    )

    run_browser_deseq2_multi_group_app <- function() {
      logs <- readLines(${rString(logPath)}, warn = FALSE)
      add_log <- function(message) {
        logs <<- c(
          logs,
          paste(format(Sys.time(), "%Y-%m-%d %H:%M:%S"), message)
        )
        write_log()
        progress_token <- getOption("browser_deseq2_progress_token", "")
        if (
          is.character(progress_token) &&
          length(progress_token) == 1L &&
          nzchar(progress_token)
        ) {
          progress_message <- gsub("[\\r\\n]+", " ", as.character(message))
          cat("DESEQ2_PROGRESS|", progress_token, "|", progress_message, "\n", sep = "")
          flush.console()
        }
      }

      write_log <- function() {
        writeLines(logs, con = ${rString(logPath)}, useBytes = TRUE)
      }

      append_plot_warning <- function(label, err) {
        add_log(paste0("Plot warning [", label, "]: ", conditionMessage(err)))
      }

      write_full_result <- function(res, path, keep, gene_id, group_stats = NULL, numerator_id = NULL, denominator_id = NULL, global = FALSE) {
        result_df <- as.data.frame(res)
        if (global) {
          keep_columns <- intersect(c("baseMean", "stat", "pvalue", "padj"), colnames(result_df))
          result_df <- result_df[, keep_columns, drop = FALSE]
        }
        full_result <- data.frame(
          gene_id = gene_id,
          prefilter_pass = keep,
          stringsAsFactors = FALSE,
          check.names = FALSE
        )
        for (column_name in colnames(result_df)) {
          full_result[[column_name]] <- NA_real_
        }
        kept_index <- match(rownames(result_df), gene_id)
        for (column_name in colnames(result_df)) {
          full_result[[column_name]][kept_index] <- result_df[[column_name]]
        }
        if (!is.null(group_stats) && !is.null(numerator_id) && !is.null(denominator_id)) {
          full_result$numerator_normalized_mean <- group_stats$mean[[numerator_id]]
          full_result$denominator_normalized_mean <- group_stats$mean[[denominator_id]]
          full_result$numerator_normalized_median <- group_stats$median[[numerator_id]]
          full_result$denominator_normalized_median <- group_stats$median[[denominator_id]]
        }
        utils::write.csv(full_result, file = path, row.names = FALSE, na = "")
        invisible(nrow(result_df))
      }

      tryCatch(
        withCallingHandlers(
          {
            started_at <- Sys.time()
            group_ids <- ${rVector(groupIds)}
            contrast_ids <- ${rVector(contrastIds)}
            contrast_numerators <- ${rVector(contrastNumerators)}
            contrast_denominators <- ${rVector(contrastDenominators)}
            contrast_labels <- ${rVector(contrastLabels)}
            contrast_paths <- ${rNamedVector(contrastPathEntries)}

            add_log("1. Preparing multi-group count matrix")
            header_df <- utils::read.csv(
              ${rString(countsPath)},
              nrows = 0L,
              check.names = FALSE
            )

            if (ncol(header_df) < 7L) {
              stop("At least six selected samples are required for 3 groups with 2 samples each.")
            }

            sample_names <- colnames(header_df)[-1L]
            counts_df <- utils::read.csv(
              ${rString(countsPath)},
              check.names = FALSE,
              stringsAsFactors = FALSE,
              colClasses = c("character", rep("integer", length(sample_names)))
            )

            gene_id <- as.character(counts_df[[1L]])
            if (anyNA(gene_id) || any(gene_id == "")) {
              stop("Gene IDs must not be empty.")
            }
            if (anyDuplicated(gene_id)) {
              stop("Gene IDs must be unique.")
            }

            count_matrix <- as.matrix(counts_df[, -1L, drop = FALSE])
            rm(counts_df, header_df)
            gc(FALSE)
            if (!is.integer(count_matrix)) {
              storage.mode(count_matrix) <- "integer"
            }
            dimnames(count_matrix) <- list(gene_id, sample_names)
            if (anyDuplicated(sample_names)) {
              stop("Selected sample names must be unique.")
            }
            if (anyNA(count_matrix)) {
              stop("All count values must be finite integer numbers.")
            }
            if (any(count_matrix < 0L)) {
              stop("Count values must be non-negative.")
            }

            col_data <- utils::read.csv(
              ${rString(colDataPath)},
              check.names = FALSE,
              stringsAsFactors = FALSE
            )
            if (!"sample" %in% colnames(col_data) || !"group" %in% colnames(col_data)) {
              stop("Sample metadata requires sample and group columns.")
            }
            if (anyDuplicated(col_data$sample)) {
              stop("Sample metadata contains duplicate sample names.")
            }
            if (!setequal(sample_names, col_data$sample)) {
              stop("Sample names in count matrix and sample metadata do not match.")
            }
            col_data <- col_data[match(sample_names, col_data$sample), , drop = FALSE]
            rownames(col_data) <- col_data$sample
            col_data$group <- factor(col_data$group, levels = group_ids)
            if (anyNA(col_data$group)) {
              stop("Sample metadata contains a group outside the selected group IDs.")
            }
            group_counts <- table(col_data$group)
            if (any(group_counts < 2L)) {
              stop("Each group requires at least two samples.")
            }

            add_log("2. Applying low-expression filter")
            input_genes <- nrow(count_matrix)
            selected_sample_count <- ncol(count_matrix)
            pre_filtering <- ${rBool(parameters.preFiltering)}
            minimum_count <- as.integer(${Number(parameters.minimumCount)})
            if (pre_filtering) {
              keep <- rowSums(count_matrix) >= minimum_count
            } else {
              keep <- rep(TRUE, nrow(count_matrix))
            }
            genes_after_filtering <- sum(keep)
            if (genes_after_filtering < 1L) {
              stop("All genes were removed by low-expression pre-filtering.")
            }

            add_log("3. Creating multi-group DESeqDataSet")
            count_matrix_for_deseq <- count_matrix[keep, , drop = FALSE]
            dds <- DESeq2::DESeqDataSetFromMatrix(
              countData = count_matrix_for_deseq,
              colData = col_data,
              design = ~ group
            )
            rm(count_matrix_for_deseq)
            gc(FALSE)

            add_log("4. Estimating size factors")
            dds <- DESeq2::estimateSizeFactors(dds, type = ${rString(parameters.sfType)})
            sample_size_factors <- DESeq2::sizeFactors(dds)
            names(sample_size_factors) <- colnames(dds)

            full_normalized <- sweep(
              count_matrix,
              2L,
              sample_size_factors[colnames(count_matrix)],
              "/"
            )
            normalized_df <- data.frame(gene_id = gene_id, full_normalized, check.names = FALSE)
            utils::write.csv(normalized_df, file = ${rString(normalizedPath)}, row.names = FALSE, na = "")

            normalized_summary <- data.frame(
              sample = colnames(full_normalized),
              group = as.character(col_data[colnames(full_normalized), "group"]),
              min = NA_real_,
              q1 = NA_real_,
              median = NA_real_,
              q3 = NA_real_,
              max = NA_real_,
              check.names = FALSE
            )
            for (sample_index in seq_len(ncol(full_normalized))) {
              values <- log10(full_normalized[, sample_index] + 1)
              normalized_summary$min[sample_index] <- min(values, na.rm = TRUE)
              normalized_summary$q1[sample_index] <- stats::quantile(values, probs = 0.25, na.rm = TRUE, names = FALSE)
              normalized_summary$median[sample_index] <- stats::median(values, na.rm = TRUE)
              normalized_summary$q3[sample_index] <- stats::quantile(values, probs = 0.75, na.rm = TRUE, names = FALSE)
              normalized_summary$max[sample_index] <- max(values, na.rm = TRUE)
            }
            utils::write.csv(normalized_summary, file = ${rString(normalizedSummaryPath)}, row.names = FALSE, na = "")

            group_stats <- list(mean = list(), median = list())
            for (group_id in group_ids) {
              group_idx <- col_data$group == group_id
              group_stats$mean[[group_id]] <- rowMeans(full_normalized[, group_idx, drop = FALSE])
              group_stats$median[[group_id]] <- apply(full_normalized[, group_idx, drop = FALSE], 1L, stats::median)
            }
            rm(normalized_df, normalized_summary)
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
                add_log(paste("Dispersion fit fallback: using gene-wise dispersion estimates because", dispersion_message))
                dds <- DESeq2::estimateDispersionsGeneEst(dds, quiet = TRUE)
                dispersions(dds) <- S4Vectors::mcols(dds)$dispGeneEst
                dispersion_fit_type_used <<- "gene-wise"
                dds
              }
            )

            global_tested_genes <- NA_integer_
            if (${rBool(runGlobal)}) {
              add_log("6. Running global LRT")
              dds_lrt <- DESeq2::nbinomLRT(dds, reduced = ~ 1, quiet = TRUE)
              global_res <- DESeq2::results(
                dds_lrt,
                alpha = ${Number(parameters.fdrThreshold)},
                independentFiltering = ${rBool(parameters.independentFiltering)},
                cooksCutoff = ${rBool(parameters.cooksCutoff)}
              )
              global_tested_genes <- write_full_result(
                global_res,
                ${rString(globalResultPath)},
                keep,
                gene_id,
                global = TRUE
              )
              rm(global_res, dds_lrt)
              gc(FALSE)
            } else {
              add_log("6. Global LRT skipped")
            }

            add_log("7. Fitting Wald model for pairwise contrasts")
            dds_wald <- DESeq2::nbinomWaldTest(dds, quiet = TRUE)
            tested_by_contrast <- c()
            requested_cooks_cutoff <- ${rBool(parameters.cooksCutoff)}
            cooks_cutoff_used <- requested_cooks_cutoff

            for (contrast_index in seq_along(contrast_ids)) {
              contrast_id <- contrast_ids[[contrast_index]]
              numerator_id <- contrast_numerators[[contrast_index]]
              denominator_id <- contrast_denominators[[contrast_index]]
              add_log(paste("Pairwise Wald contrast:", contrast_labels[[contrast_index]]))
              get_results <- function(cooks_cutoff) {
                DESeq2::results(
                  dds_wald,
                  contrast = c("group", numerator_id, denominator_id),
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
                  add_log(paste("Cook's cutoff failed; retrying results() with cooksCutoff = FALSE:", conditionMessage(e)))
                  cooks_cutoff_used <<- FALSE
                  get_results(FALSE)
                }
              )
              tested_by_contrast[[contrast_id]] <- write_full_result(
                res,
                contrast_paths[[contrast_id]],
                keep,
                gene_id,
                group_stats,
                numerator_id,
                denominator_id,
                global = FALSE
              )
              rm(res)
              gc(FALSE)
            }

            size_factor_df <- data.frame(
              sample = names(sample_size_factors),
              group = as.character(col_data[names(sample_size_factors), "group"]),
              size_factor = as.numeric(sample_size_factors),
              check.names = FALSE
            )
            utils::write.csv(size_factor_df, file = ${rString(sizeFactorPath)}, row.names = FALSE, na = "")

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
                  utils::write.csv(dispersion_df, file = ${rString(dispersionPath)}, row.names = FALSE, na = "")
                },
                error = function(e) append_plot_warning("dispersion", e)
              )
            }

            if (${rBool(plots.pca)}) {
              tryCatch(
                {
                  add_log("PCA selected: running vst() and prcomp()")
                  vsd <- DESeq2::vst(dds_wald, blind = TRUE)
                  vst_matrix <- SummarizedExperiment::assay(vsd)
                  gene_variance <- matrixStats::rowVars(vst_matrix)
                  top_n <- min(5000L, length(gene_variance))
                  selected_gene_index <- order(gene_variance, decreasing = TRUE)[seq_len(top_n)]
                  pca <- stats::prcomp(t(vst_matrix[selected_gene_index, , drop = FALSE]))
                  percent <- pca$sdev^2 / sum(pca$sdev^2) * 100
                  pca_df <- data.frame(
                    sample = rownames(pca$x),
                    group = as.character(col_data[rownames(pca$x), "group"]),
                    PC1 = pca$x[, 1L],
                    PC2 = pca$x[, 2L],
                    PC1_percent = percent[1L],
                    PC2_percent = percent[2L],
                    genes_used = top_n,
                    check.names = FALSE
                  )
                  utils::write.csv(pca_df, file = ${rString(pcaPath)}, row.names = FALSE, na = "")
                },
                error = function(e) append_plot_warning("PCA", e)
              )
            }

            if (${rBool(plots.sampleCorrelation)} || ${rBool(plots.sampleDistance)}) {
              transformed <- log2(DESeq2::counts(dds_wald, normalized = TRUE) + 1)
            }

            if (${rBool(plots.sampleCorrelation)}) {
              tryCatch(
                {
                  add_log("Sample correlation heatmap selected: running cor()")
                  correlation_matrix <- stats::cor(transformed)
                  correlation_df <- data.frame(sample = rownames(correlation_matrix), correlation_matrix, check.names = FALSE)
                  utils::write.csv(correlation_df, file = ${rString(correlationPath)}, row.names = FALSE, na = "")
                },
                error = function(e) append_plot_warning("sample correlation", e)
              )
            }

            if (${rBool(plots.sampleDistance)}) {
              tryCatch(
                {
                  add_log("Sample distance heatmap selected: running dist()")
                  distance_matrix <- as.matrix(stats::dist(t(transformed)))
                  distance_df <- data.frame(sample = rownames(distance_matrix), distance_matrix, check.names = FALSE)
                  utils::write.csv(distance_df, file = ${rString(distancePath)}, row.names = FALSE, na = "")
                },
                error = function(e) append_plot_warning("sample distance", e)
              )
            }

            finished_at <- Sys.time()
            execution_time <- as.numeric(difftime(finished_at, started_at, units = "secs"))
            summary_df <- data.frame(
              key = c(
                "input_genes",
                "genes_after_prefiltering",
                "samples",
                "group_count",
                "contrast_count",
                "global_lrt",
                "global_tested_genes",
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
                selected_sample_count,
                length(group_ids),
                length(contrast_ids),
                ${rBool(runGlobal)},
                global_tested_genes,
                dispersion_fit_type_requested,
                dispersion_fit_type_used,
                requested_cooks_cutoff,
                cooks_cutoff_used,
                execution_time,
                R.version.string,
                as.character(utils::packageVersion("DESeq2"))
              ),
              check.names = FALSE
            )
            utils::write.csv(summary_df, file = ${rString(summaryPath)}, row.names = FALSE, na = "")

            add_log("Completed")
            "OK"
          },
          warning = function(w) {
            add_log(paste("Warning:", conditionMessage(w)))
            invokeRestart("muffleWarning")
          },
          message = function(m) {
            add_log(paste("Message:", conditionMessage(m)))
            invokeRestart("muffleMessage")
          }
        ),
        error = function(e) {
          add_log(paste("Error:", conditionMessage(e)))
          paste0("ERROR|", conditionMessage(e))
        }
      )
    }

    browser_deseq2_multi_group_status <- run_browser_deseq2_multi_group_app()
    writeLines(
      as.character(browser_deseq2_multi_group_status),
      con = ${rString(statusPath)},
      useBytes = TRUE
    )
    rm(run_browser_deseq2_multi_group_app)
    rm(browser_deseq2_multi_group_status)
    invisible(gc(FALSE))
  `;
}

export async function runMultiGroupDeseqAnalysis({
  countCsv,
  countMatrix = null,
  colDataCsv,
  groups,
  contrasts,
  parameters,
  plots,
  runGlobal = true,
  onProgress = null
}) {
  const id = runId();
  const stagedStateName = `.browser_${id}`;
  const stagedMatrixRun = Boolean(countMatrix);
  const inputGeneCount = countMatrix?.geneCount ?? countDataRows(countCsv || "");
  const contrastPaths = Object.fromEntries(
    contrasts.map((contrast) => [contrast.id, `/tmp/${id}_${contrast.id}_results.csv`])
  );
  let webR = null;
  let webRResponsive = true;
  const bridgeDiagnostics = [];
  let stage = "Initializing webR";
  const progress = (message) => {
    stage = message;
    onProgress?.(message);
  };

  const paths = {
    countsPath: stagedMatrixRun ? `/tmp/${id}_counts.bin` : `/tmp/${id}_counts.csv`,
    geneIdsPath: `/tmp/${id}_gene_ids.txt`,
    colDataPath: `/tmp/${id}_coldata.csv`,
    globalResultPath: `/tmp/${id}_global_results.csv`,
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
      bridgeDiagnostics.push("Multi-group webR channel requested: PostMessage compatibility mode");
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

      progress("Transferring binary multi-group count matrix");
      const countBytes = encodeInt32LittleEndian(countMatrix.counts);
      const geneIdBytes = encodeGeneIdLines(countMatrix.geneIds);
      await webR.FS.writeFile(paths.countsPath, countBytes);
      await webR.FS.writeFile(paths.geneIdsPath, geneIdBytes);
      bridgeDiagnostics.push(
        `Binary multi-group matrix transferred: ${countMatrix.geneCount} genes x ${countMatrix.sampleCount} samples, ${countBytes.byteLength} count bytes, ${geneIdBytes.byteLength} gene-ID bytes`
      );

      progress("Starting staged multi-group DESeq2 analysis");
      bridgeDiagnostics.push(
        "CSV and numeric-literal loading disabled: counts use readBin() and gene IDs use readLines()"
      );
      await runStagedMultiGroupDeseq2({
        webR,
        stateName: stagedStateName,
        paths,
        parameters,
        plots,
        matrixInput: countMatrix,
        groups,
        contrasts,
        contrastPaths,
        runGlobal,
        readTextFile,
        onProgress: progress
      });
      await webR.FS.writeFile(paths.statusPath, encoder.encode("OK"));
    } else {
      progress("Preparing multi-group matrix");
      await webR.FS.writeFile(paths.countsPath, encoder.encode(countCsv));
      await webR.FS.writeFile(paths.colDataPath, encoder.encode(colDataCsv));

      progress("Transferring multi-group R job");
      const runnerScript = buildMultiGroupDeseq2RunnerCode({
        ...paths,
        parameters,
        plots,
        groups,
        contrasts,
        contrastPaths,
        runGlobal
      });
      await webR.FS.writeFile(paths.scriptPath, encoder.encode(runnerScript));

      progress("Validating multi-group R job");
      const preflightOk = await webR.evalRBoolean(`
        tryCatch(
          {
            parsed_job <- base::parse(file = ${rString(paths.scriptPath)}, keep.source = FALSE)
            rm(parsed_job)
            base::writeLines("PREFLIGHT_OK", con = ${rString(paths.bootstrapPath)}, useBytes = TRUE)
            TRUE
          },
          error = function(e) {
            base::writeLines(paste0("PREFLIGHT_ERROR|", conditionMessage(e)), con = ${rString(paths.bootstrapPath)}, useBytes = TRUE)
            FALSE
          }
        )
      `);
      const preflightStatus = await readTextFile(webR, paths.bootstrapPath);
      if (!preflightOk || preflightStatus?.trim() !== "PREFLIGHT_OK") {
        throw new Error(`R job preflight failed: ${preflightStatus?.trim() || "no bootstrap status was written"}`);
      }

      progress("Running multi-group DESeq2 job");
      const bootstrapOk = await webR.evalRBoolean(`
        tryCatch(
          {
            base::sys.source(${rString(paths.scriptPath)}, envir = .GlobalEnv)
            TRUE
          },
          error = function(e) {
            base::writeLines(paste0("BOOTSTRAP_ERROR|", conditionMessage(e)), con = ${rString(paths.bootstrapPath)}, useBytes = TRUE)
            FALSE
          }
        )
      `);
      if (!bootstrapOk) {
        const bootstrapFailure = await readTextFile(webR, paths.bootstrapPath);
        throw new Error(`R job bootstrap failed: ${bootstrapFailure?.trim() || "no bootstrap error was written"}`);
      }
    }

    const statusText = await readTextFile(webR, paths.statusPath);
    if (!statusText) {
      throw new Error("The R job returned without creating its status file.");
    }
    const status = statusText.trim();
    const analysisLog = await readTextFile(webR, paths.logPath);

    if (status.startsWith("ERROR|")) {
      const error = new Error(status.substring("ERROR|".length));
      error.analysisLog = analysisLog;
      throw error;
    }
    if (status !== "OK") {
      throw new Error(`Unexpected R result: ${status}`);
    }

    progress("Reading multi-group outputs");
    const [
      globalCsv,
      normalizedCsv,
      normalizedSummaryCsv,
      sizeFactorCsv,
      summaryCsv,
      pcaCsv,
      correlationCsv,
      distanceCsv,
      dispersionCsv,
      ...contrastCsvs
    ] = await Promise.all([
      runGlobal ? readTextFile(webR, paths.globalResultPath) : Promise.resolve(null),
      readTextFile(webR, paths.normalizedPath),
      readTextFile(webR, paths.normalizedSummaryPath),
      readTextFile(webR, paths.sizeFactorPath),
      readTextFile(webR, paths.summaryPath),
      readTextFile(webR, paths.pcaPath),
      readTextFile(webR, paths.correlationPath),
      readTextFile(webR, paths.distancePath),
      readTextFile(webR, paths.dispersionPath),
      ...contrasts.map((contrast) => readTextFile(webR, contrastPaths[contrast.id]))
    ]);

    const contrastResults = contrasts.map((contrast, index) => {
      const rows = parseCsvObjects(contrastCsvs[index] || "").records;
      return {
        ...contrast,
        rows,
        summary: {
          tested_genes: rows.filter((row) => row.prefilter_pass === "TRUE" || row.prefilter_pass === true).length,
          numerator_samples: groups.find((group) => group.id === contrast.numeratorId)?.samples.length || 0,
          denominator_samples: groups.find((group) => group.id === contrast.denominatorId)?.samples.length || 0
        }
      };
    });
    const summary = parseKeyValueCsv(summaryCsv);

    return {
      mode: "multi_group",
      engine: "deseq2",
      groups,
      contrasts: contrastResults,
      globalResult: runGlobal && globalCsv
        ? {
            rows: parseCsvObjects(globalCsv).records,
            summary: {
              tested_genes: summary.global_tested_genes || "NA"
            }
          }
        : null,
      directionMatrix: buildDirectionMatrix(contrastResults),
      groupSummaries: groups.map((group) => ({
        id: group.id,
        label: group.label,
        samples: group.samples.length
      })),
      normalizedCsv: normalizedCsv || "",
      normalizedBoxplot: normalizedSummaryCsv ? parseCsvObjects(normalizedSummaryCsv).records : [],
      sizeFactors: sizeFactorCsv ? parseCsvObjects(sizeFactorCsv).records : [],
      summary: {
        ...summary,
        input_genes: summary.input_genes || inputGeneCount,
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
        recoveredLog = webR ? await readTextFile(webR, paths.logPath) || "" : "";
      } catch {
        recoveredLog = "";
      }
    }

    const rawMessage = error.message || error.name || formatError(error) || "";
    const genericRuntimeError = !rawMessage || rawMessage === "Error" || rawMessage === "[object Object]";
    const rAnalysisError = error.rAnalysisError || Boolean(recoveredLog && /(?:^|\n).*Error:/i.test(recoveredLog));
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
      : [
        `Multi-group DESeq2 failed during: ${stage}.`,
        rawMessage || "webR calculation failed without a detailed message.",
        recoveredLog ? "The last R log entries are included below." : "No R analysis log was captured."
      ].join("\n");

    error.analysisLog = recoveredLog;
    error.stage = stage;
    error.webRBridge = bridgeRuntimeError;
    error.userMessage = `${baseMessage}\n\n${formatError(recoveredLog || "")}`.trim();
    error.message = error.userMessage;
    throw error;
  } finally {
    if (webR && webRResponsive) {
      if (stagedMatrixRun) {
        await cleanupStagedMultiGroupDeseq2(webR, stagedStateName);
      }
      await cleanupTempFiles(webR, [
        paths.countsPath,
        paths.geneIdsPath,
        paths.colDataPath,
        paths.globalResultPath,
        paths.normalizedPath,
        paths.normalizedSummaryPath,
        paths.sizeFactorPath,
        paths.summaryPath,
        paths.logPath,
        paths.statusPath,
        paths.scriptPath,
        paths.bootstrapPath,
        paths.pcaPath,
        paths.correlationPath,
        paths.distancePath,
        paths.dispersionPath,
        ...Object.values(contrastPaths)
      ]);
    }
  }
}
