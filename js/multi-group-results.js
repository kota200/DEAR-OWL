import { APP_CONFIG } from "./config.js";
import { loadAnnotations, loadSelectedTpmVectors } from "./data-loader.js";
import { ResultTable } from "./result-table.js";
import { renderPlots } from "./plots.js";
import {
  classifyDirection,
  downloadBlob,
  makeExternalLink,
  objectsToCsv,
  parseNumber,
  sanitizeFileName,
  summarizeValues
} from "./utils.js";
import {
  buildGeneSet,
  computeExclusiveIntersections
} from "./intersections.js";

function sampleId(sample) {
  return sample.sample_id || sample.SRA || sample.sample || sample.id;
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "")
    .replace("T", "_")
    .slice(0, 15);
}

function allResultColumns(rows) {
  const columns = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) {
        columns.push(key);
      }
    }
  }
  return columns.length ? columns : ["message"];
}

function rowsToCsv(rows, bom = true) {
  if (!rows.length) {
    return objectsToCsv([{ message: "No rows" }], ["message"], { bom });
  }
  return objectsToCsv(rows, allResultColumns(rows), { bom });
}

function downloadText(text, filename, type = "text/csv;charset=utf-8") {
  downloadBlob(new Blob([text], { type }), filename);
}

function baseName(context) {
  const dataset = context.dataset?.species || context.dataset?.id || "uploaded";
  const reference = context.dataset?.reference || "matrix";
  return sanitizeFileName(`${dataset}_${reference}_multi_group_${timestamp()}`);
}

function enrichPairwiseRows(rows, parameters, dataset) {
  return rows.map((row) => {
    const direction = classifyDirection(row, parameters.fdrThreshold, parameters.log2FoldChangeThreshold);
    return {
      ...row,
      direction,
      significant: direction === "Up" || direction === "Down" ? "yes" : "no",
      arabidopsis_homolog: row.arabidopsis_homolog || "",
      rice_homolog: row.rice_homolog || "",
      gexa_link: makeExternalLink(dataset?.gexaGeneUrlTemplate, row.gene_id) || "",
      tgif_link: makeExternalLink(dataset?.tgifGeneUrlTemplate, row.gene_id) || ""
    };
  });
}

function enrichGlobalRows(rows, parameters, dataset) {
  return rows.map((row) => {
    const padj = parseNumber(row.padj);
    const direction = padj == null
      ? "Filtered / NA"
      : padj <= parameters.fdrThreshold
        ? "Significant"
        : "Not significant";
    return {
      ...row,
      direction,
      significant: direction === "Significant" ? "yes" : "no",
      log2FoldChange: "",
      lfcSE: "",
      arabidopsis_homolog: row.arabidopsis_homolog || "",
      rice_homolog: row.rice_homolog || "",
      gexa_link: makeExternalLink(dataset?.gexaGeneUrlTemplate, row.gene_id) || "",
      tgif_link: makeExternalLink(dataset?.tgifGeneUrlTemplate, row.gene_id) || ""
    };
  });
}

export function enrichMultiGroupResult(result, parameters, dataset) {
  for (const contrast of result.contrasts) {
    contrast.rows = enrichPairwiseRows(contrast.rows, parameters, dataset);
  }

  if (result.globalResult) {
    result.globalResult.rows = enrichGlobalRows(result.globalResult.rows, parameters, dataset);
  }

  return result;
}

export async function addGroupedTpmAndAnnotations(result, bundle, onProgress, countVectorsBySample = null) {
  const warnings = [];
  const allSamples = result.groups.flatMap((group) => group.samples);
  const geneIndex = new Map(bundle.genes.map((gene, index) => [gene, index]));
  const allRows = [
    ...(result.globalResult?.rows || []),
    ...result.contrasts.flatMap((contrast) => contrast.rows)
  ];

  onProgress("Getting TPM data");
  const { vectorsBySample, warnings: tpmWarnings } = await loadSelectedTpmVectors(
    bundle,
    allSamples,
    onProgress,
    { countVectorsBySample }
  );
  warnings.push(...tpmWarnings);

  for (const row of allRows) {
    const index = geneIndex.get(row.gene_id);
    if (index == null) {
      continue;
    }

    for (const group of result.groups) {
      const values = group.samples
        .map((sample) => vectorsBySample.get(sampleId(sample))?.[index])
        .filter((value) => value != null);
      const summary = summarizeValues(values);
      row[`TPM:${group.label} mean`] = summary.mean ?? "";
      row[`TPM:${group.label} median`] = summary.median ?? "";
    }

    for (const sample of allSamples) {
      const vector = vectorsBySample.get(sampleId(sample));
      row[`TPM:${sampleId(sample)}`] = vector ? vector[index] : "";
    }
  }

  onProgress("Loading homologs");
  try {
    const annotation = await loadAnnotations(bundle);
    warnings.push(...annotation.warnings);
    for (const row of allRows) {
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

function renderSummaryCards(container, result) {
  const cards = [
    ["Input genes", result.summary.input_genes || "NA"],
    ["Groups", result.groups.length],
    ["Pairwise contrasts", result.contrasts.length],
    ["Global LRT", result.globalResult ? "Run" : "Not run"],
    ["Engine", result.engine === "javascript" ? "Ultrafast Z-test" : "DESeq2"],
    ["Samples", result.groups.reduce((sum, group) => sum + group.samples.length, 0)],
    ["Analysis time", `${Number(result.summary.execution_time_seconds || 0).toFixed(1)} sec`]
  ];

  container.replaceChildren();
  for (const [label, value] of cards) {
    const card = document.createElement("div");
    card.className = "summary-card";
    const strong = document.createElement("strong");
    strong.textContent = value;
    const span = document.createElement("span");
    span.textContent = label;
    card.append(strong, span);
    container.append(card);
  }
}

function renderDirectionMatrix(container, result) {
  const details = document.createElement("details");
  details.className = "direction-matrix";
  const summary = document.createElement("summary");
  summary.textContent = "Gene-by-contrast direction matrix";
  details.append(summary);

  const wrap = document.createElement("div");
  wrap.className = "result-table-wrap";
  const table = document.createElement("table");
  table.className = "result-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of ["gene_id", ...result.contrasts.map((contrast) => contrast.id)]) {
    const th = document.createElement("th");
    th.textContent = column === "gene_id"
      ? "Gene ID"
      : result.contrasts.find((contrast) => contrast.id === column)?.label || column;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const row of result.directionMatrix.slice(0, 100)) {
    const tr = document.createElement("tr");
    const gene = document.createElement("td");
    gene.textContent = row.gene_id;
    tr.append(gene);
    for (const contrast of result.contrasts) {
      const td = document.createElement("td");
      td.textContent = row[contrast.id] || "NA";
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);

  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = `Showing first ${Math.min(100, result.directionMatrix.length).toLocaleString()} of ${result.directionMatrix.length.toLocaleString()} genes. Download the CSV for the full matrix.`;
  details.append(note, wrap);
  container.append(details);
}

function vennSvg(selectedSets, intersections) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 760 360");
  svg.setAttribute("class", "venn-svg");

  const circlePositions = selectedSets.length === 2
    ? [
        { cx: 300, cy: 180, color: "#2f7dbd" },
        { cx: 460, cy: 180, color: "#b73535" }
      ]
    : [
        { cx: 310, cy: 165, color: "#2f7dbd" },
        { cx: 450, cy: 165, color: "#b73535" },
        { cx: 380, cy: 245, color: "#2f8f5b" }
      ];

  selectedSets.forEach((set, index) => {
    const pos = circlePositions[index];
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", pos.cx);
    circle.setAttribute("cy", pos.cy);
    circle.setAttribute("r", "116");
    circle.setAttribute("fill", pos.color);
    circle.setAttribute("opacity", "0.26");
    circle.setAttribute("stroke", pos.color);
    circle.setAttribute("stroke-width", "2");
    svg.append(circle);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", pos.cx);
    label.setAttribute("y", index === 2 ? 340 : 38);
    label.setAttribute("text-anchor", "middle");
    label.textContent = set.label;
    svg.append(label);
  });

  const labels = intersections.slice(0, 8);
  labels.forEach((entry, index) => {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", 24);
    text.setAttribute("y", 42 + index * 28);
    text.textContent = `${entry.key}: ${entry.genes.length}`;
    svg.append(text);
  });

  return svg;
}

function renderOverlap(container, result) {
  const section = document.createElement("section");
  section.className = "overlap-section";
  const title = document.createElement("h3");
  title.textContent = "Overlap";

  const chooser = document.createElement("div");
  chooser.className = "overlap-set-grid";
  const selectedKeys = new Set();
  const availableSets = [];

  for (const contrast of result.contrasts) {
    for (const direction of ["Up", "Down"]) {
      availableSets.push({
        key: `${contrast.id}:${direction}`,
        label: `${contrast.label} ${direction}`,
        contrast,
        direction
      });
    }
  }

  for (const set of availableSets.slice(0, 3)) {
    selectedKeys.add(set.key);
  }

  const output = document.createElement("div");
  output.className = "overlap-output";

  const renderOutput = () => {
    output.replaceChildren();
    const selectedSets = availableSets
      .filter((set) => selectedKeys.has(set.key))
      .map((set) => ({
        ...set,
        genes: buildGeneSet(set.contrast, set.direction)
      }));

    if (selectedSets.length < 2) {
      output.textContent = "Select at least 2 gene sets.";
      return;
    }

    const intersections = computeExclusiveIntersections(selectedSets);

    if (selectedSets.length <= 3) {
      output.append(vennSvg(selectedSets, intersections));
    }

    const table = document.createElement("table");
    table.className = "result-table overlap-table";
    const thead = document.createElement("thead");
    const head = document.createElement("tr");
    for (const label of ["Pattern", "Genes"]) {
      const th = document.createElement("th");
      th.textContent = label;
      head.append(th);
    }
    thead.append(head);
    table.append(thead);
    const tbody = document.createElement("tbody");
    for (const entry of intersections) {
      const tr = document.createElement("tr");
      const pattern = document.createElement("td");
      pattern.textContent = entry.membership
        .map((included, index) => included ? selectedSets[index].label : `not ${selectedSets[index].label}`)
        .join(" | ");
      const genes = document.createElement("td");
      genes.textContent = `${entry.genes.length.toLocaleString()} genes`;
      tr.append(pattern, genes);
      tbody.append(tr);
    }
    table.append(tbody);
    output.append(table);
  };

  for (const set of availableSets) {
    const label = document.createElement("label");
    label.className = "inline-check";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedKeys.has(set.key);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedKeys.add(set.key);
      } else {
        selectedKeys.delete(set.key);
      }
      renderOutput();
    });
    label.append(checkbox, document.createTextNode(` ${set.label}`));
    chooser.append(label);
  }

  section.append(title, chooser, output);
  container.append(section);
  renderOutput();
}

function renderDownloads(container, result, context, parameters, plots, analysisLog, runtimeSummary) {
  container.replaceChildren();

  const bomLabel = document.createElement("label");
  bomLabel.className = "inline-check";
  const bomCheckbox = document.createElement("input");
  bomCheckbox.type = "checkbox";
  bomCheckbox.checked = true;
  bomLabel.append(bomCheckbox, document.createTextNode(" Add UTF-8 BOM for Excel"));

  const grid = document.createElement("div");
  grid.className = "download-grid";
  const prefix = baseName(context);

  function addButton(label, getText, extension, type = "text/csv;charset=utf-8", fileStem = label) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      const filename = `${prefix}_${sanitizeFileName(fileStem)}.${extension}`;
      downloadText(getText(Boolean(bomCheckbox.checked)), filename, type);
    });
    grid.append(button);
  }

  addButton("Selected samples", (bom) => {
    const samples = result.groups.flatMap((group) =>
      group.samples.map((sample) => ({
        ...sample,
        internal_group_id: group.id,
        display_group_label: group.label
      }))
    );
    return objectsToCsv(samples, allResultColumns(samples), { bom });
  }, "csv", "text/csv;charset=utf-8", "selected_samples");

  if (result.globalResult) {
    addButton("Global LRT results", (bom) => rowsToCsv(result.globalResult.rows, bom), "csv", "text/csv;charset=utf-8", "global_results");
  }

  for (const contrast of result.contrasts) {
    addButton(`${contrast.label} all genes`, (bom) => rowsToCsv(contrast.rows, bom), "csv", "text/csv;charset=utf-8", `${contrast.id}_full_results`);
    addButton(`${contrast.label} significant`, (bom) => rowsToCsv(contrast.rows.filter((row) => row.direction === "Up" || row.direction === "Down"), bom), "csv", "text/csv;charset=utf-8", `${contrast.id}_significant_genes`);
    addButton(`${contrast.label} Up`, (bom) => rowsToCsv(contrast.rows.filter((row) => row.direction === "Up"), bom), "csv", "text/csv;charset=utf-8", `${contrast.id}_up_genes`);
    addButton(`${contrast.label} Down`, (bom) => rowsToCsv(contrast.rows.filter((row) => row.direction === "Down"), bom), "csv", "text/csv;charset=utf-8", `${contrast.id}_down_genes`);
  }

  addButton("Contrast summary", (bom) => {
    const rows = result.contrasts.map((contrast) => ({
      contrast_id: contrast.id,
      label: contrast.label,
      numerator_group: contrast.numeratorId,
      denominator_group: contrast.denominatorId,
      up: contrast.rows.filter((row) => row.direction === "Up").length,
      down: contrast.rows.filter((row) => row.direction === "Down").length,
      not_significant: contrast.rows.filter((row) => row.direction === "Not significant").length,
      filtered_or_na: contrast.rows.filter((row) => row.direction === "Filtered / NA").length
    }));
    return objectsToCsv(rows, allResultColumns(rows), { bom });
  }, "csv", "text/csv;charset=utf-8", "contrast_summary");

  addButton("Direction matrix", (bom) => rowsToCsv(result.directionMatrix, bom), "csv", "text/csv;charset=utf-8", "gene_contrast_direction_matrix");
  addButton("Normalized counts", (bom) => result.normalizedCsv && bom && !result.normalizedCsv.startsWith("\uFEFF") ? `\uFEFF${result.normalizedCsv}` : (result.normalizedCsv || "message\r\nNo normalized-count data\r\n"), "csv", "text/csv;charset=utf-8", "normalized_counts");
  addButton("Analysis parameters", () => JSON.stringify({
    appVersion: APP_CONFIG.appVersion,
    dataset: context.dataset?.id || "uploaded",
    engine: result.engine,
    groups: result.groups.map((group) => ({
      id: group.id,
      label: group.label,
      samples: group.samples.map(sampleId)
    })),
    contrasts: result.contrasts.map((contrast) => ({
      id: contrast.id,
      numeratorId: contrast.numeratorId,
      denominatorId: contrast.denominatorId,
      label: contrast.label
    })),
    parameters: {
      ...parameters,
      plots
    },
    runtimeSummary,
    timestamp: new Date().toISOString()
  }, null, 2), "json", "application/json;charset=utf-8", "analysis_parameters");
  addButton("Analysis log", () => analysisLog || "No analysis log was captured.\n", "txt", "text/plain;charset=utf-8", "analysis_log");

  container.append(bomLabel, grid);
}

export function renderMultiGroupResults({
  containers,
  result,
  parameters,
  plots,
  context,
  analysisLogWarnings = [],
  runtimeSummary = {}
}) {
  renderSummaryCards(containers.summaryCards, result);
  containers.resultTable.replaceChildren();
  containers.plotsContainer.replaceChildren();

  const header = document.createElement("div");
  header.className = "multi-result-header";
  const selector = document.createElement("select");
  const tableRoot = document.createElement("div");
  const description = document.createElement("p");
  description.className = "manual-note compact-note";
  const plotRoot = document.createElement("div");

  const views = [];
  if (result.globalResult) {
    views.push({
      key: "global",
      label: "Global LRT",
      type: "global",
      rows: result.globalResult.rows
    });
  }
  for (const contrast of result.contrasts) {
    views.push({
      key: contrast.id,
      label: contrast.label,
      type: "contrast",
      contrast,
      rows: contrast.rows
    });
  }

  for (const view of views) {
    selector.append(option(view.label, view.key));
  }

  header.append(selector, description);
  containers.resultTable.append(header, tableRoot);

  let table = null;
  const renderActive = () => {
    const view = views.find((entry) => entry.key === selector.value) || views[0];
    tableRoot.replaceChildren();
    plotRoot.replaceChildren();
    table = new ResultTable(tableRoot);
    table.setRows(view.rows);

    if (view.type === "global") {
      description.textContent = "Global LRT identifies genes that differ in at least one group. It does not identify which specific groups differ.";
      renderPlots({
        container: plotRoot,
        rows: [],
        plots: {
          ...plots,
          ma: false,
          volcano: false,
          sizeFactor: result.engine === "deseq2",
          normalizedCountBoxplot: result.engine === "deseq2"
        },
        thresholds: parameters,
        plotData: result.plotData,
        sizeFactors: result.sizeFactors,
        normalizedBoxplot: result.normalizedBoxplot,
        onGeneClick: (geneId) => table.focusGene(geneId)
      });
    } else {
      description.textContent = `For ${view.contrast.label}, positive log2 fold change indicates higher expression in ${view.contrast.numeratorLabel} than in ${view.contrast.denominatorLabel}. Benjamini-Hochberg adjustment is performed separately within this comparison.`;
      renderPlots({
        container: plotRoot,
        rows: view.rows,
        plots: {
          ...plots,
          pca: result.engine === "deseq2" && plots.pca,
          sampleCorrelation: result.engine === "deseq2" && plots.sampleCorrelation,
          sampleDistance: result.engine === "deseq2" && plots.sampleDistance,
          sizeFactor: result.engine === "deseq2",
          normalizedCountBoxplot: result.engine === "deseq2"
        },
        thresholds: parameters,
        plotData: result.plotData,
        sizeFactors: result.sizeFactors,
        normalizedBoxplot: result.normalizedBoxplot,
        onGeneClick: (geneId) => table.focusGene(geneId)
      });
    }
  };

  selector.addEventListener("change", renderActive);
  renderActive();
  renderDirectionMatrix(containers.resultTable, result);

  containers.plotsContainer.append(plotRoot);
  renderOverlap(containers.plotsContainer, result);

  const analysisLog = [
    result.analysisLog || "No analysis log was captured.",
    "",
    ...analysisLogWarnings.map((warning) => `Warning: ${warning}`)
  ].join("\n");
  containers.analysisLog.textContent = analysisLog;

  renderDownloads(
    containers.downloadsContainer,
    result,
    context,
    parameters,
    plots,
    analysisLog,
    runtimeSummary
  );
}

function option(label, value = label) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}
