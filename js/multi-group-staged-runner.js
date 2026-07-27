const encoder = new TextEncoder();

function rString(value) {
  return JSON.stringify(String(value));
}

function rBool(value) {
  return value ? "TRUE" : "FALSE";
}

function rCharacterVector(values) {
  return `c(${values.map((value) => rString(value)).join(",")})`;
}

function rNamedVector(entries) {
  return `c(${entries.map(([name, value]) => `${rString(name)} = ${rString(value)}`).join(",")})`;
}

function sampleId(sample) {
  return sample.sample_id || sample.SRA || sample.sample || sample.id;
}

function safeStageToken(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "_");
}

function validateMultiGroupMatrix(matrixInput, groups, contrasts) {
  if (!matrixInput || !(matrixInput.counts instanceof Int32Array)) {
    throw new Error("The staged multi-group DESeq2 run requires an Int32 count matrix.");
  }
  if (
    matrixInput.sampleNames.length !== matrixInput.sampleCount ||
    matrixInput.geneIds.length !== matrixInput.geneCount ||
    matrixInput.counts.length !== matrixInput.geneCount * matrixInput.sampleCount
  ) {
    throw new Error("The staged multi-group count matrix has inconsistent dimensions.");
  }
  if (new Set(matrixInput.sampleNames).size !== matrixInput.sampleCount) {
    throw new Error("Selected sample names must be unique.");
  }
  if (new Set(matrixInput.geneIds).size !== matrixInput.geneCount) {
    throw new Error("Gene IDs must be unique.");
  }
  if (matrixInput.geneIds.some((geneId) => !geneId || /[\r\n]/.test(geneId))) {
    throw new Error("Gene IDs must be non-empty single-line values.");
  }

  const groupIds = groups.map((group) => group.id);
  if (groupIds.length < 3 || new Set(groupIds).size !== groupIds.length) {
    throw new Error("Multi-group DESeq2 requires at least three unique group IDs.");
  }

  const groupBySample = new Map();
  for (const group of groups) {
    for (const sample of group.samples) {
      const id = sampleId(sample);
      if (groupBySample.has(id)) {
        throw new Error(`Selected sample ${id} is assigned to multiple groups.`);
      }
      groupBySample.set(id, group.id);
    }
  }

  for (const sampleName of matrixInput.sampleNames) {
    if (!groupBySample.has(sampleName)) {
      throw new Error(`Selected sample ${sampleName} is missing from multi-group metadata.`);
    }
  }

  for (const contrast of contrasts) {
    if (!groupIds.includes(contrast.numeratorId) || !groupIds.includes(contrast.denominatorId)) {
      throw new Error(`Contrast ${contrast.label || contrast.id} references an unknown group.`);
    }
  }
}

function stageCode(stateName, label, body) {
  return `
    local({
      stage_status_path <- getOption("browser_deseq2_stage_status_path", NULL)
      mark_stage <- function(marker) {
        if (is.character(stage_status_path) && length(stage_status_path) == 1L) {
          try(writeLines(marker, con = stage_status_path, useBytes = TRUE), silent = TRUE)
        }
      }
      mark_stage("STAGE_ENTERED")
      mark_stage("STATE_LOOKUP")
      st <- get(${rString(stateName)}, envir = .GlobalEnv, inherits = FALSE)
      mark_stage("STATE_READY")
      add_log <- function(message) {
        st$logs <- c(
          st$logs,
          paste(format(Sys.time(), "%Y-%m-%d %H:%M:%S"), as.character(message))
        )
      }
      mark_stage("LOGGING_STAGE")
      add_log(${rString(label)})
      mark_stage("STAGE_SETUP_READY")

      mark_stage("ENTERING_STAGE_BODY")
      status <- tryCatch(
        withCallingHandlers(
          {
            ${body}
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

      try(writeLines(st$logs, con = st$log_path, useBytes = TRUE), silent = TRUE)
      status
    })
  `;
}

function initializeCode(stateName, logPath) {
  return `
    local({
      st <- new.env(parent = baseenv())
      st$logs <- paste(
        format(Sys.time(), "%Y-%m-%d %H:%M:%S"),
        "0. Multi-group staged R job initialized"
      )
      st$started_at <- Sys.time()
      st$log_path <- ${rString(logPath)}
      writeLines(st$logs, con = st$log_path, useBytes = TRUE)
      assign(${rString(stateName)}, st, envir = .GlobalEnv)
      "OK"
    })
  `;
}

function writeFullResultCode() {
  return `
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
  `;
}

function prepareCode(stateName, paths, parameters, matrixInput, groups) {
  const groupBySample = new Map();
  for (const group of groups) {
    for (const sample of group.samples) {
      groupBySample.set(sampleId(sample), group.id);
    }
  }
  const sampleGroups = matrixInput.sampleNames.map((sampleName) => groupBySample.get(sampleName));
  const groupIds = groups.map((group) => group.id);
  const groupLabels = groups.map((group) => group.label || group.id);
  const expectedCountValues = matrixInput.geneCount * matrixInput.sampleCount;

  return stageCode(stateName, "1. Loading binary multi-group count matrix", `
    sample_names <- ${rCharacterVector(matrixInput.sampleNames)}
    sample_groups <- ${rCharacterVector(sampleGroups)}
    group_ids <- ${rCharacterVector(groupIds)}
    group_labels <- ${rCharacterVector(groupLabels)}

    mark_stage("READING_GENE_IDS")
    gene_id <- base::readLines(
      ${rString(paths.geneIdsPath)},
      encoding = "UTF-8",
      warn = FALSE
    )
    if (length(gene_id) != ${matrixInput.geneCount}L) {
      stop("The transferred gene-ID file has an invalid length.")
    }
    mark_stage("GENE_IDS_LOADED")

    mark_stage("READING_BINARY_COUNTS")
    count_connection <- base::file(${rString(paths.countsPath)}, open = "rb")
    count_values <- tryCatch(
      base::readBin(
        count_connection,
        what = integer(),
        n = ${expectedCountValues}L,
        size = 4L,
        signed = TRUE,
        endian = "little"
      ),
      finally = base::close(count_connection)
    )
    if (length(count_values) != ${expectedCountValues}L) {
      stop("The transferred binary count matrix has an invalid length.")
    }
    mark_stage("BINARY_COUNTS_LOADED")

    count_matrix <- matrix(
      count_values,
      nrow = ${matrixInput.geneCount}L,
      ncol = ${matrixInput.sampleCount}L,
      byrow = FALSE,
      dimnames = list(gene_id, sample_names)
    )
    rm(count_values)
    gc(FALSE)

    if (anyNA(count_matrix)) {
      stop("The transferred count matrix contains an invalid integer.")
    }
    if (any(count_matrix < 0L)) {
      stop("Count values must be non-negative.")
    }

    col_data <- data.frame(
      sample = sample_names,
      group = sample_groups,
      check.names = FALSE,
      stringsAsFactors = FALSE
    )
    rownames(col_data) <- col_data$sample
    col_data$group <- factor(col_data$group, levels = group_ids)
    if (anyNA(col_data$group)) {
      stop("Sample metadata contains a group outside the selected group IDs.")
    }
    group_counts <- table(col_data$group)
    if (any(group_counts < 2L)) {
      stop("Each group requires at least two samples.")
    }

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

    st$count_matrix <- count_matrix
    st$gene_id <- gene_id
    st$sample_names <- sample_names
    st$col_data <- col_data
    st$group_ids <- group_ids
    st$group_labels <- group_labels
    st$keep <- keep
    st$input_genes <- input_genes
    st$selected_sample_count <- selected_sample_count
    st$genes_after_filtering <- genes_after_filtering

    rm(count_matrix, gene_id, sample_names, sample_groups, col_data, keep)
    gc(FALSE)
    add_log(paste(
      "Loaded binary multi-group matrix:",
      st$input_genes,
      "genes x",
      st$selected_sample_count,
      "samples"
    ))
  `);
}

function datasetCode(stateName) {
  return stageCode(stateName, "2. Creating multi-group DESeqDataSet", `
    count_matrix_for_deseq <- st$count_matrix[st$keep, , drop = FALSE]
    st$dds <- DESeq2::DESeqDataSetFromMatrix(
      countData = count_matrix_for_deseq,
      colData = st$col_data,
      design = ~ group
    )
    rm(count_matrix_for_deseq)
    gc(FALSE)
  `);
}

function normalizationCode(stateName, paths, parameters) {
  return stageCode(stateName, "3. Estimating size factors", `
    st$dds <- DESeq2::estimateSizeFactors(
      st$dds,
      type = ${rString(parameters.sfType)}
    )
    st$sample_size_factors <- DESeq2::sizeFactors(st$dds)
    names(st$sample_size_factors) <- colnames(st$dds)
    if (any(!is.finite(st$sample_size_factors)) || any(st$sample_size_factors <= 0)) {
      stop("DESeq2 produced invalid size factors.")
    }

    full_normalized <- sweep(
      st$count_matrix,
      2L,
      st$sample_size_factors[colnames(st$count_matrix)],
      "/"
    )
    normalized_df <- data.frame(
      gene_id = st$gene_id,
      full_normalized,
      check.names = FALSE
    )
    utils::write.csv(
      normalized_df,
      file = ${rString(paths.normalizedPath)},
      row.names = FALSE,
      na = ""
    )

    normalized_summary <- data.frame(
      sample = colnames(full_normalized),
      group = as.character(st$col_data[colnames(full_normalized), "group"]),
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
    utils::write.csv(
      normalized_summary,
      file = ${rString(paths.normalizedSummaryPath)},
      row.names = FALSE,
      na = ""
    )

    st$group_stats <- list(mean = list(), median = list())
    for (group_id in st$group_ids) {
      group_idx <- st$col_data$group == group_id
      st$group_stats$mean[[group_id]] <- rowMeans(full_normalized[, group_idx, drop = FALSE])
      st$group_stats$median[[group_id]] <- apply(full_normalized[, group_idx, drop = FALSE], 1L, stats::median)
    }

    size_factor_df <- data.frame(
      sample = names(st$sample_size_factors),
      group = as.character(st$col_data[names(st$sample_size_factors), "group"]),
      size_factor = as.numeric(st$sample_size_factors),
      check.names = FALSE
    )
    utils::write.csv(
      size_factor_df,
      file = ${rString(paths.sizeFactorPath)},
      row.names = FALSE,
      na = ""
    )

    rm(full_normalized, normalized_df, normalized_summary, size_factor_df)
    rm(list = "count_matrix", envir = st)
    gc(FALSE)
  `);
}

function dispersionCode(stateName, parameters) {
  return stageCode(stateName, "4. Estimating dispersions", `
    st$dispersion_fit_type_requested <- ${rString(parameters.fitType)}
    st$dispersion_fit_type_used <- st$dispersion_fit_type_requested
    st$dds <- tryCatch(
      DESeq2::estimateDispersions(
        st$dds,
        fitType = st$dispersion_fit_type_requested,
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
        add_log(paste(
          "Dispersion fit fallback: using gene-wise dispersion estimates because",
          dispersion_message
        ))
        st$dds <- DESeq2::estimateDispersionsGeneEst(st$dds, quiet = TRUE)
        dispersions(st$dds) <- S4Vectors::mcols(st$dds)$dispGeneEst
        st$dispersion_fit_type_used <- "gene-wise"
        st$dds
      }
    )
    gc(FALSE)
  `);
}

function globalCode(stateName, paths, parameters, runGlobal) {
  return stageCode(stateName, runGlobal ? "5. Running global LRT" : "5. Skipping global LRT", `
    ${writeFullResultCode()}
    st$global_tested_genes <- NA_integer_
    if (${rBool(runGlobal)}) {
      dds_lrt <- DESeq2::nbinomLRT(st$dds, reduced = ~ 1, quiet = TRUE)
      global_res <- DESeq2::results(
        dds_lrt,
        alpha = ${Number(parameters.fdrThreshold)},
        independentFiltering = ${rBool(parameters.independentFiltering)},
        cooksCutoff = ${rBool(parameters.cooksCutoff)}
      )
      st$global_tested_genes <- write_full_result(
        global_res,
        ${rString(paths.globalResultPath)},
        st$keep,
        st$gene_id,
        global = TRUE
      )
      rm(global_res, dds_lrt)
      gc(FALSE)
    }
  `);
}

function pairwiseCode(stateName, parameters, contrasts, contrastPaths) {
  const contrastIds = contrasts.map((contrast) => contrast.id);
  const contrastNumerators = contrasts.map((contrast) => contrast.numeratorId);
  const contrastDenominators = contrasts.map((contrast) => contrast.denominatorId);
  const contrastLabels = contrasts.map((contrast) => contrast.label);
  const contrastPathEntries = contrasts.map((contrast) => [contrast.id, contrastPaths[contrast.id]]);

  return stageCode(stateName, "6. Fitting Wald model and pairwise contrasts", `
    ${writeFullResultCode()}
    contrast_ids <- ${rCharacterVector(contrastIds)}
    contrast_numerators <- ${rCharacterVector(contrastNumerators)}
    contrast_denominators <- ${rCharacterVector(contrastDenominators)}
    contrast_labels <- ${rCharacterVector(contrastLabels)}
    contrast_paths <- ${rNamedVector(contrastPathEntries)}

    st$dds_wald <- DESeq2::nbinomWaldTest(st$dds, quiet = TRUE)
    st$tested_by_contrast <- c()
    requested_cooks_cutoff <- ${rBool(parameters.cooksCutoff)}
    st$cooks_cutoff_requested <- requested_cooks_cutoff
    st$cooks_cutoff_used <- requested_cooks_cutoff

    for (contrast_index in seq_along(contrast_ids)) {
      contrast_id <- contrast_ids[[contrast_index]]
      numerator_id <- contrast_numerators[[contrast_index]]
      denominator_id <- contrast_denominators[[contrast_index]]
      add_log(paste("Pairwise Wald contrast:", contrast_labels[[contrast_index]]))
      get_results <- function(cooks_cutoff) {
        DESeq2::results(
          st$dds_wald,
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
          st$cooks_cutoff_used <- FALSE
          get_results(FALSE)
        }
      )
      st$tested_by_contrast[[contrast_id]] <- write_full_result(
        res,
        contrast_paths[[contrast_id]],
        st$keep,
        st$gene_id,
        st$group_stats,
        numerator_id,
        denominator_id,
        global = FALSE
      )
      rm(res)
      gc(FALSE)
    }
  `);
}

function plotsCode(stateName, paths, plots) {
  return stageCode(stateName, "7. Calculating optional plots", `
    append_plot_warning <- function(label, err) {
      add_log(paste0("Plot warning [", label, "]: ", conditionMessage(err)))
    }

    if (${rBool(plots.dispersion)}) {
      tryCatch(
        {
          dispersion_df <- data.frame(
            gene_id = rownames(st$dds),
            mean = S4Vectors::mcols(st$dds)$baseMean,
            dispersion = DESeq2::dispersions(st$dds),
            check.names = FALSE
          )
          utils::write.csv(
            dispersion_df,
            file = ${rString(paths.dispersionPath)},
            row.names = FALSE,
            na = ""
          )
        },
        error = function(e) append_plot_warning("dispersion", e)
      )
    }

    if (${rBool(plots.pca)}) {
      tryCatch(
        {
          add_log("PCA selected: running vst() and prcomp()")
          vsd <- DESeq2::vst(st$dds_wald, blind = TRUE)
          vst_matrix <- SummarizedExperiment::assay(vsd)
          gene_variance <- matrixStats::rowVars(vst_matrix)
          top_n <- min(5000L, length(gene_variance))
          selected_gene_index <- order(gene_variance, decreasing = TRUE)[seq_len(top_n)]
          pca <- stats::prcomp(t(vst_matrix[selected_gene_index, , drop = FALSE]))
          percent <- pca$sdev^2 / sum(pca$sdev^2) * 100
          pca_df <- data.frame(
            sample = rownames(pca$x),
            group = as.character(st$col_data[rownames(pca$x), "group"]),
            PC1 = pca$x[, 1L],
            PC2 = pca$x[, 2L],
            PC1_percent = percent[1L],
            PC2_percent = percent[2L],
            genes_used = top_n,
            check.names = FALSE
          )
          utils::write.csv(
            pca_df,
            file = ${rString(paths.pcaPath)},
            row.names = FALSE,
            na = ""
          )
        },
        error = function(e) append_plot_warning("PCA", e)
      )
    }

    if (${rBool(plots.sampleCorrelation)} || ${rBool(plots.sampleDistance)}) {
      transformed <- log2(DESeq2::counts(st$dds_wald, normalized = TRUE) + 1)
    }

    if (${rBool(plots.sampleCorrelation)}) {
      tryCatch(
        {
          correlation_matrix <- stats::cor(transformed)
          correlation_df <- data.frame(sample = rownames(correlation_matrix), correlation_matrix, check.names = FALSE)
          utils::write.csv(
            correlation_df,
            file = ${rString(paths.correlationPath)},
            row.names = FALSE,
            na = ""
          )
        },
        error = function(e) append_plot_warning("sample correlation", e)
      )
    }

    if (${rBool(plots.sampleDistance)}) {
      tryCatch(
        {
          distance_matrix <- as.matrix(stats::dist(t(transformed)))
          distance_df <- data.frame(sample = rownames(distance_matrix), distance_matrix, check.names = FALSE)
          utils::write.csv(
            distance_df,
            file = ${rString(paths.distancePath)},
            row.names = FALSE,
            na = ""
          )
        },
        error = function(e) append_plot_warning("sample distance", e)
      )
    }
    gc(FALSE)
  `);
}

function summaryCode(stateName, paths, runGlobal, contrasts) {
  return stageCode(stateName, "8. Finalizing multi-group analysis", `
    execution_time <- as.numeric(difftime(Sys.time(), st$started_at, units = "secs"))
    summary_df <- data.frame(
      key = c(
        "input_genes",
        "genes_after_prefiltering",
        "samples",
        "group_count",
        "contrast_count",
        "global_lrt",
        "global_tested_genes",
        "staged_execution",
        "dispersion_fit_type_requested",
        "dispersion_fit_type_used",
        "cooks_cutoff_requested",
        "cooks_cutoff_used",
        "execution_time_seconds",
        "r_version",
        "deseq2_version"
      ),
      value = c(
        st$input_genes,
        st$genes_after_filtering,
        st$selected_sample_count,
        length(st$group_ids),
        ${contrasts.length},
        ${rBool(runGlobal)},
        st$global_tested_genes,
        TRUE,
        st$dispersion_fit_type_requested,
        st$dispersion_fit_type_used,
        st$cooks_cutoff_requested,
        st$cooks_cutoff_used,
        execution_time,
        R.version.string,
        as.character(utils::packageVersion("DESeq2"))
      ),
      check.names = FALSE
    )
    utils::write.csv(
      summary_df,
      file = ${rString(paths.summaryPath)},
      row.names = FALSE,
      na = ""
    )
    add_log("Completed")
  `);
}

function buildFileBackedStageCommand({ scriptPath, statusPath }) {
  return `
    local({
      browser_stage_status <- tryCatch(
        {
          base::writeLines("WRAPPER_STARTED", con = ${rString(statusPath)}, useBytes = TRUE)
          browser_stage_expressions <- base::parse(
            file = ${rString(scriptPath)},
            keep.source = FALSE
          )
          base::writeLines("STAGE_PARSED", con = ${rString(statusPath)}, useBytes = TRUE)
          base::options(browser_deseq2_stage_status_path = ${rString(statusPath)})
          browser_stage_value <- NULL
          for (browser_stage_expression in browser_stage_expressions) {
            browser_stage_value <- base::eval(
              browser_stage_expression,
              envir = .GlobalEnv
            )
          }
          if (length(browser_stage_value) != 1L) {
            base::stop("The staged R script returned an invalid status.")
          }
          base::as.character(browser_stage_value[[1L]])
        },
        error = function(e) {
          base::paste0("BRIDGE_ERROR|", base::conditionMessage(e))
        }
      )
      base::writeLines(browser_stage_status, con = ${rString(statusPath)}, useBytes = TRUE)
      base::invisible(NULL)
    })
  `;
}

async function removeFile(webR, path) {
  try {
    await webR.FS.unlink(path);
  } catch {
    // Missing temporary files are expected between stages.
  }
}

async function evaluateStage({
  webR,
  code,
  label,
  logPath,
  scriptPath,
  statusPath,
  readTextFile,
  onProgress
}) {
  onProgress(label);
  let bridgeError = null;

  await removeFile(webR, statusPath);
  try {
    await webR.FS.writeFile(scriptPath, encoder.encode(code));
    try {
      await webR.evalRVoid(
        buildFileBackedStageCommand({ scriptPath, statusPath }),
        {
          captureStreams: false,
          captureConditions: false
        }
      );
    } catch (error) {
      bridgeError = error;
    }

    const rawStatus = await readTextFile(webR, statusPath);
    const status = typeof rawStatus === "string" ? rawStatus.trim() : "";
    if (status === "OK") {
      return;
    }
    if (status.startsWith("ERROR|")) {
      const error = new Error(status.substring("ERROR|".length));
      error.analysisLog = await readTextFile(webR, logPath);
      error.rAnalysisError = true;
      throw error;
    }
    if (status.startsWith("BRIDGE_ERROR|")) {
      const error = new Error(status.substring("BRIDGE_ERROR|".length));
      error.analysisLog = await readTextFile(webR, logPath);
      throw error;
    }
    if (bridgeError) {
      bridgeError.stageTransportStatus = status || "NO_STAGE_STATUS";
      bridgeError.stageCodeBytes = encoder.encode(code).byteLength;
      bridgeError.analysisLog = await readTextFile(webR, logPath);
      throw bridgeError;
    }

    const error = new Error(
      `No valid R status was written during ${label}: ${status || "empty status"}.`
    );
    error.analysisLog = await readTextFile(webR, logPath);
    throw error;
  } finally {
    await removeFile(webR, scriptPath);
    await removeFile(webR, statusPath);
  }
}

export function buildStagedMultiGroupDeseq2Stages({
  stateName,
  paths,
  parameters,
  plots,
  matrixInput,
  groups,
  contrasts,
  contrastPaths,
  runGlobal
}) {
  validateMultiGroupMatrix(matrixInput, groups, contrasts);
  return [
    ["Initializing staged multi-group DESeq2 run", initializeCode(stateName, paths.logPath)],
    ["Loading binary multi-group count matrix", prepareCode(
      stateName,
      paths,
      parameters,
      matrixInput,
      groups
    )],
    ["Creating multi-group DESeqDataSet", datasetCode(stateName)],
    ["Estimating size factors", normalizationCode(stateName, paths, parameters)],
    ["Estimating dispersions", dispersionCode(stateName, parameters)],
    [runGlobal ? "Running global LRT" : "Skipping global LRT", globalCode(
      stateName,
      paths,
      parameters,
      runGlobal
    )],
    ["Running pairwise Wald contrasts", pairwiseCode(
      stateName,
      parameters,
      contrasts,
      contrastPaths
    )],
    ["Calculating optional plots", plotsCode(stateName, paths, plots)],
    ["Finalizing multi-group analysis", summaryCode(
      stateName,
      paths,
      runGlobal,
      contrasts
    )]
  ];
}

export async function runStagedMultiGroupDeseq2({
  webR,
  stateName,
  paths,
  parameters,
  plots,
  matrixInput,
  groups,
  contrasts,
  contrastPaths,
  runGlobal,
  readTextFile,
  onProgress
}) {
  const stages = buildStagedMultiGroupDeseq2Stages({
    stateName,
    paths,
    parameters,
    plots,
    matrixInput,
    groups,
    contrasts,
    contrastPaths,
    runGlobal
  });

  const stageToken = safeStageToken(stateName);
  for (const [index, [label, code]] of stages.entries()) {
    const stageBasePath = `/tmp/${stageToken}_multi_stage_${index + 1}`;
    await evaluateStage({
      webR,
      code,
      label,
      logPath: paths.logPath,
      scriptPath: `${stageBasePath}.R`,
      statusPath: `${stageBasePath}.status`,
      readTextFile,
      onProgress
    });
  }
}

export async function cleanupStagedMultiGroupDeseq2(webR, stateName) {
  try {
    await webR.evalRVoid(`
      if (exists(${rString(stateName)}, envir = .GlobalEnv, inherits = FALSE)) {
        rm(list = ${rString(stateName)}, envir = .GlobalEnv)
      }
      gc(FALSE)
    `);
  } catch {
    // A terminated webR worker cannot be cleaned up from JavaScript.
  }
}
