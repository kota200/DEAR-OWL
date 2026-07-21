import {
  downloadBlob,
  objectsToCsv,
  sanitizeFileName
} from "./utils.js";
import {
  RESULT_COLUMN_LABELS,
  RESULT_COLUMNS
} from "./config.js";

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "")
    .replace("T", "_")
    .slice(0, 15);
}

function baseName(context) {
  const dataset = context.dataset?.species || context.dataset?.id || "uploaded";
  const reference = context.dataset?.reference || "matrix";
  const control = context.controlSamples.map((sample) => sample.sample_id).slice(0, 3).join("_");
  const treatment = context.treatmentSamples.map((sample) => sample.sample_id).slice(0, 3).join("_");
  return sanitizeFileName(`${dataset}_${reference}_${control}_vs_${treatment}_${timestamp()}`);
}

function downloadText(text, filename, type) {
  downloadBlob(new Blob([text], { type }), filename);
}

function resultColumns(rows) {
  const columns = [...RESULT_COLUMNS];

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key.startsWith("TPM:") && !columns.includes(key)) {
        columns.push(key);
      }
    }
  }

  return columns.filter((column) =>
    rows.some((row) => Object.prototype.hasOwnProperty.call(row, column))
  );
}

function resultCsv(rows, bom) {
  if (!rows.length) {
    return objectsToCsv([{ message: "No rows" }], ["message"], { bom });
  }

  const columns = resultColumns(rows);
  const displayColumns = columns.map((column) => RESULT_COLUMN_LABELS[column] || column);
  const displayRows = rows.map((row) => Object.fromEntries(
    columns.map((column, index) => [displayColumns[index], row[column]])
  ));
  return objectsToCsv(displayRows, displayColumns, { bom });
}

function rawCsv(text, bom) {
  const body = text || "message\r\nNo normalized-count data\r\n";
  return bom && !body.startsWith("\uFEFF") ? `\uFEFF${body}` : body;
}

export function renderDownloads({
  container,
  rows,
  normalizedCsv,
  context,
  parameters,
  summary,
  analysisLog,
  runtimeSummary
}) {
  container.replaceChildren();

  const bomLabel = document.createElement("label");
  bomLabel.className = "inline-check";
  const bomCheckbox = document.createElement("input");
  bomCheckbox.type = "checkbox";
  bomCheckbox.checked = true;
  bomLabel.append(bomCheckbox, document.createTextNode(" Add UTF-8 BOM for Excel"));

  const grid = document.createElement("div");
  grid.className = "download-grid";

  function addButton(label, getText, extension, type = "text/csv;charset=utf-8") {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      const name = `${baseName(context)}_${sanitizeFileName(label.toLowerCase())}.${extension}`;
      downloadText(getText(Boolean(bomCheckbox.checked)), name, type);
    });
    grid.append(button);
  }

  addButton("All genes", (bom) => resultCsv(rows, bom), "csv");
  addButton("Upregulated genes", (bom) => resultCsv(rows.filter((row) => row.direction === "Up"), bom), "csv");
  addButton("Downregulated genes", (bom) => resultCsv(rows.filter((row) => row.direction === "Down"), bom), "csv");
  addButton("Significant genes", (bom) => resultCsv(rows.filter((row) => row.direction === "Up" || row.direction === "Down"), bom), "csv");
  addButton("Normalized counts", (bom) => rawCsv(normalizedCsv, bom), "csv");
  addButton("Selected samples", (bom) => {
    const samples = [
      ...context.controlSamples.map((sample) => ({ ...sample, group: "control" })),
      ...context.treatmentSamples.map((sample) => ({ ...sample, group: "treatment" }))
    ];
    const columns = samples.length ? Object.keys(samples[0]) : ["sample_id", "group"];
    return objectsToCsv(samples, columns, { bom });
  }, "csv");

  addButton("Analysis parameters", () => JSON.stringify({
    appVersion: context.appVersion,
    webrVersion: runtimeSummary.webrVersion,
    rVersion: summary.rVersion || runtimeSummary.rVersion,
    deseq2Version: summary.deseq2Version || runtimeSummary.deseq2Version,
    dataset: context.dataset?.id || "uploaded",
    controlSamples: context.controlSamples.map((sample) => sample.sample_id),
    treatmentSamples: context.treatmentSamples.map((sample) => sample.sample_id),
    parameters,
    timestamp: new Date().toISOString()
  }, null, 2), "json", "application/json;charset=utf-8");

  addButton("Analysis summary", () => Object.entries(summary)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n") + "\n", "txt", "text/plain;charset=utf-8");

  addButton("Analysis log", () => analysisLog || "No analysis log was captured.\n", "txt", "text/plain;charset=utf-8");

  container.append(bomLabel, grid);
}
