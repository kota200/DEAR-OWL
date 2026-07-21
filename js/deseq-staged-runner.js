function rString(value) {
  return JSON.stringify(String(value));
}

function rBool(value) {
  return value ? "TRUE" : "FALSE";
}

function resolveDeseqTest(value) {
  return value === "LRT" ? "LRT" : "Wald";
}

const encoder = new TextEncoder();

function safeStageToken(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "_");
}

function stageCode(stateName, label, body) {
  return `
    local({
      stage_status_path <- getOption("browser_deseq2_stage_status_path", NULL)
      mark_stage <- function(marker) {
        if (is.character(stage_status_path) && length(stage_status_path) == 1L) {
          try(
            writeLines(marker, con = stage_status_path, useBytes = TRUE),
            silent = TRUE
          )
        }
      }
      mark_stage("STAGE_ENTERED")
      mark_stage("STATE_LOOKUP")
      st <- get(${rString(stateName)}, envir = .GlobalEnv, inherits = FALSE)
      mark_stage("STATE_READY")
      add_log <- function(message) {
        st$logs <- c(st$logs, as.character(message))
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

      try(
        writeLines(st$logs, con = st$log_path, useBytes = TRUE),
        silent = TRUE
      )
      status
    })
  `;
}

function initializeCode(stateName, logPath) {
  return `
    local({
      st <- new.env(parent = baseenv())
      st$logs <- character()
      st$started_at <- Sys.time()
      st$log_path <- ${rString(logPath)}
      assign(${rString(stateName)}, st, envir = .GlobalEnv)
      "OK"
    })
  `;
}

function rCharacterVector(values) {
  return `c(${values.map((value) => rString(value)).join(",")})`;
}

function validateEmbeddedMatrix(matrixInput, groups) {
  if (!matrixInput || !(matrixInput.counts instanceof Int32Array)) {
    throw new Error("The staged DESeq2 run requires an Int32 count matrix.");
  }
  if (matrixInput.sampleNames.length !== matrixInput.sampleCount
      || matrixInput.geneIds.length !== matrixInput.geneCount
      || matrixInput.counts.length !== matrixInput.geneCount * matrixInput.sampleCount) {
    throw new Error("The staged DESeq2 count matrix has inconsistent dimensions.");
  }
  if (groups.length !== matrixInput.sampleCount) {
    throw new Error("The staged DESeq2 sample groups do not match the matrix.");
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
  if (groups.some((group) => group !== "control" && group !== "treatment")) {
    throw new Error("Groups must be control or treatment.");
  }
}

function prepareCode(stateName, paths, parameters, matrixInput, groups) {
  validateEmbeddedMatrix(matrixInput, groups);
  const sampleNames = rCharacterVector(matrixInput.sampleNames);
  const groupValues = rCharacterVector(groups);
  const expectedCountValues = matrixInput.geneCount * matrixInput.sampleCount;

  return stageCode(stateName, "1. Loading JavaScript-prefiltered count matrix", `
    sample_names <- ${sampleNames}
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

    mark_stage("BUILDING_COUNT_MATRIX")
    count_matrix <- matrix(
      count_values,
      nrow = ${matrixInput.geneCount}L,
      ncol = ${matrixInput.sampleCount}L,
      byrow = FALSE,
      dimnames = list(gene_id, sample_names)
    )
    rm(count_values)
    col_data <- data.frame(
      sample = sample_names,
      group = ${groupValues},
      check.names = FALSE,
      stringsAsFactors = FALSE
    )

    input_genes <- nrow(count_matrix)
    selected_sample_count <- ncol(count_matrix)
    if (anyNA(count_matrix)) {
      stop("The prefiltered count matrix contains an invalid integer.")
    }
    if (any(count_matrix < 0L)) {
      stop("Count values must be non-negative.")
    }
    mark_stage("COUNT_MATRIX_READY")
    rownames(col_data) <- col_data$sample
    col_data$group <- factor(col_data$group, levels = c("control", "treatment"))
    if (anyNA(col_data$group)) {
      stop("Groups must be control or treatment.")
    }

    safety_min_count <- NA_integer_
    safety_min_samples <- NA_integer_
    keep <- rep(TRUE, input_genes)
    genes_after_filtering <- input_genes

    st$count_matrix <- count_matrix
    st$gene_id <- gene_id
    st$sample_names <- sample_names
    st$col_data <- col_data
    st$keep <- keep
    st$input_genes <- input_genes
    st$selected_sample_count <- selected_sample_count
    st$genes_after_filtering <- genes_after_filtering
    st$safety_min_count <- safety_min_count
    st$safety_min_samples <- safety_min_samples
    st$control_idx <- col_data$group == "control"
    st$treatment_idx <- col_data$group == "treatment"

    rm(count_matrix, gene_id, sample_names, col_data, keep)
    gc(FALSE)
    add_log(paste(
      "Loaded JavaScript-prefiltered matrix:",
      nrow(st$count_matrix),
      "genes x",
      ncol(st$count_matrix),
      "samples"
    ))
  `);
}

function datasetCode(stateName) {
  return stageCode(stateName, "2. Creating DESeqDataSet", `
    st$dds <- DESeq2::DESeqDataSetFromMatrix(
      countData = st$count_matrix,
      colData = st$col_data,
      design = ~ group
    )
    rm(list = "count_matrix", envir = st)
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

    rm(size_factor_df)
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
        st$dds <- DESeq2::estimateDispersionsGeneEst(
          st$dds,
          quiet = TRUE
        )
        dispersions(st$dds) <- S4Vectors::mcols(st$dds)$dispGeneEst
        st$dispersion_fit_type_used <- "gene-wise"
        st$dds
      }
    )
    gc(FALSE)
  `);
}

function modelCode(stateName, parameters) {
  const test = resolveDeseqTest(parameters.test);
  const fitCode = test === "LRT"
    ? "st$dds <- DESeq2::nbinomLRT(st$dds, reduced = ~ 1, quiet = TRUE)"
    : "st$dds <- DESeq2::nbinomWaldTest(st$dds, quiet = TRUE)";

  return stageCode(stateName, `5. Fitting the ${test} model`, `
    ${fitCode}
    gc(FALSE)
  `);
}

function resultsCode(stateName, paths, parameters) {
  return stageCode(stateName, "6. Generating differential-expression results", `
    requested_cooks_cutoff <- ${rBool(parameters.cooksCutoff)}
    st$cooks_cutoff_requested <- requested_cooks_cutoff
    st$cooks_cutoff_used <- requested_cooks_cutoff

    get_results <- function(cooks_cutoff) {
      DESeq2::results(
        st$dds,
        contrast = c("group", "treatment", "control"),
        alpha = ${Number(parameters.fdrThreshold)},
        independentFiltering = ${rBool(parameters.independentFiltering)},
        cooksCutoff = cooks_cutoff
      )
    }

    res <- tryCatch(
      get_results(requested_cooks_cutoff),
      error = function(e) {
        if (!requested_cooks_cutoff) {
          stop(conditionMessage(e))
        }
        add_log(paste(
          "Cook's cutoff failed; retrying with cooksCutoff = FALSE:",
          conditionMessage(e)
        ))
        st$cooks_cutoff_used <- FALSE
        get_results(FALSE)
      }
    )

    result_df <- as.data.frame(res)
    st$tested_genes <- nrow(result_df)
    full_result <- data.frame(
      gene_id = st$gene_id,
      prefilter_pass = st$keep,
      stringsAsFactors = FALSE,
      check.names = FALSE
    )

    for (column_name in colnames(result_df)) {
      full_result[[column_name]] <- NA_real_
    }
    kept_index <- match(rownames(result_df), st$gene_id)
    for (column_name in colnames(result_df)) {
      full_result[[column_name]][kept_index] <- result_df[[column_name]]
    }

    utils::write.csv(
      full_result,
      file = ${rString(paths.resultPath)},
      row.names = FALSE,
      na = ""
    )

    rm(full_result, result_df, res, kept_index)
    gc(FALSE)
  `);
}

function plotsCode(stateName, paths, plots) {
  return stageCode(stateName, "7. Calculating optional plots", `
    append_plot_warning <- function(label, err) {
      add_log(paste0("Plot warning [", label, "]: ", conditionMessage(err)))
    }

    if (${rBool(plots.dispersion)}) {
      tryCatch({
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
      }, error = function(e) append_plot_warning("dispersion", e))
    }

    if (${rBool(plots.pca)}) {
      tryCatch({
        add_log("PCA selected: running vst() and prcomp()")
        vsd <- DESeq2::vst(st$dds, blind = TRUE)
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
      }, error = function(e) append_plot_warning("PCA", e))
    }

    if (${rBool(plots.sampleCorrelation)} || ${rBool(plots.sampleDistance)}) {
      transformed <- log2(DESeq2::counts(st$dds, normalized = TRUE) + 1)
    }

    if (${rBool(plots.sampleCorrelation)}) {
      tryCatch({
        correlation_matrix <- stats::cor(transformed)
        correlation_df <- data.frame(
          sample = rownames(correlation_matrix),
          correlation_matrix,
          check.names = FALSE
        )
        utils::write.csv(
          correlation_df,
          file = ${rString(paths.correlationPath)},
          row.names = FALSE,
          na = ""
        )
      }, error = function(e) append_plot_warning("sample correlation", e))
    }

    if (${rBool(plots.sampleDistance)}) {
      tryCatch({
        distance_matrix <- as.matrix(stats::dist(t(transformed)))
        distance_df <- data.frame(
          sample = rownames(distance_matrix),
          distance_matrix,
          check.names = FALSE
        )
        utils::write.csv(
          distance_df,
          file = ${rString(paths.distancePath)},
          row.names = FALSE,
          na = ""
        )
      }, error = function(e) append_plot_warning("sample distance", e))
    }

    gc(FALSE)
  `);
}

function summaryCode(stateName, paths) {
  return stageCode(stateName, "8. Finalizing analysis summary", `
    execution_time <- as.numeric(difftime(Sys.time(), st$started_at, units = "secs"))
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
        st$tested_genes,
        st$selected_sample_count,
        sum(st$control_idx),
        sum(st$treatment_idx),
        FALSE,
        st$safety_min_count,
        st$safety_min_samples,
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

export function buildFileBackedStageCommand({ scriptPath, statusPath }) {
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
      base::writeLines(
        browser_stage_status,
        con = ${rString(statusPath)},
        useBytes = TRUE
      )
      base::invisible(NULL)
    })
  `;
}

async function removeFile(webR, path) {
  try {
    await webR.FS.unlink(path);
  } catch {
    // Missing temporary files do not require cleanup.
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

export async function runStagedDeseq2({
  webR,
  stateName,
  paths,
  parameters,
  plots,
  matrixInput,
  groups,
  readTextFile,
  onProgress
}) {
  const stages = buildStagedDeseq2Stages({
    stateName,
    paths,
    parameters,
    plots,
    matrixInput,
    groups
  });

  const stageToken = safeStageToken(stateName);
  for (const [index, [label, code]] of stages.entries()) {
    const stageBasePath = `/tmp/${stageToken}_stage_${index + 1}`;
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

export function buildStagedDeseq2Stages({
  stateName,
  paths,
  parameters,
  plots,
  matrixInput,
  groups
}) {
  const test = resolveDeseqTest(parameters.test);

  return [
    ["Initializing staged DESeq2 run", initializeCode(stateName, paths.logPath)],
    ["Loading binary prefiltered count matrix", prepareCode(
      stateName,
      paths,
      parameters,
      matrixInput,
      groups
    )],
    ["Creating DESeqDataSet", datasetCode(stateName)],
    ["Estimating size factors", normalizationCode(stateName, paths, parameters)],
    ["Estimating dispersions", dispersionCode(stateName, parameters)],
    [`Fitting ${test} model`, modelCode(stateName, parameters)],
    ["Generating DESeq2 results", resultsCode(stateName, paths, parameters)],
    ["Calculating optional plots", plotsCode(stateName, paths, plots)],
    ["Finalizing analysis", summaryCode(stateName, paths)]
  ];
}

export async function cleanupStagedDeseq2(webR, stateName) {
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
