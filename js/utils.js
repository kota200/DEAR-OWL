export function formatError(error) {
  if (error == null) {
    return String(error);
  }

  if (typeof error === "string") {
    return error;
  }

  return error.stack || error.message || String(error);
}

export function escapeHtml(value) {
  const text = value == null ? "" : String(value);
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function detectDelimiter(line) {
  let commas = 0;
  let tabs = 0;
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        index += 1;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      commas += 1;
    } else if (char === "\t") {
      tabs += 1;
    }
  }

  return tabs > commas ? "\t" : ",";
}

export function parseDelimitedRows(text, delimiter = null) {
  const cleanText = text.replace(/^\uFEFF/, "");
  const firstLine = cleanText.split(/\r?\n/, 1)[0] || "";
  const sep = delimiter || detectDelimiter(firstLine);
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < cleanText.length; index += 1) {
    const char = cleanText[index];
    const next = cleanText[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === sep) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (quoted) {
    throw new Error("Unclosed quoted field in delimited text.");
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  return { rows, delimiter: sep };
}

export function rowsToObjects(rows) {
  if (rows.length < 1) {
    return { headers: [], records: [] };
  }

  const headers = rows[0].map((header) => header.trim());
  const records = rows
    .slice(1)
    .filter((row) => row.some((value) => value !== ""))
    .map((row, rowIndex) => {
      if (row.length !== headers.length) {
        throw new Error(`Row ${rowIndex + 2} has ${row.length} columns; expected ${headers.length}.`);
      }

      const record = {};
      headers.forEach((header, columnIndex) => {
        record[header] = row[columnIndex];
      });
      return record;
    });

  return { headers, records };
}

export function parseCsvObjects(text) {
  return rowsToObjects(parseDelimitedRows(text).rows);
}

export function csvEscape(value, { protectFormula = true } = {}) {
  if (value == null || Number.isNaN(value)) {
    return "";
  }

  let text = String(value);

  if (protectFormula && /^[=+\-@]/.test(text)) {
    text = "'" + text;
  }

  if (/[",\r\n\t]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

export function objectsToCsv(rows, columns, { bom = false } = {}) {
  const lines = [
    columns.map((column) => csvEscape(column, { protectFormula: false })).join(",")
  ];

  for (const row of rows) {
    lines.push(
      columns
        .map((column) => csvEscape(row[column]))
        .join(",")
    );
  }

  return (bom ? "\uFEFF" : "") + lines.join("\r\n") + "\r\n";
}

export function sanitizeFileName(value, fallback = "deseq2") {
  const text = String(value || fallback)
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);

  return text || fallback;
}

export function parseNumber(value) {
  if (value == null || value === "" || value === "NA") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function classifyDirection(row, fdrThreshold, log2fcThreshold) {
  const padj = parseNumber(row.padj);
  const log2FoldChange = parseNumber(row.log2FoldChange);

  if (padj == null || log2FoldChange == null) {
    return "Filtered / NA";
  }

  if (padj <= fdrThreshold && log2FoldChange >= log2fcThreshold) {
    return "Up";
  }

  if (padj <= fdrThreshold && log2FoldChange <= -log2fcThreshold) {
    return "Down";
  }

  return "Not significant";
}

export function summarizeValues(values) {
  const filtered = values
    .map(Number)
    .filter((value) => Number.isFinite(value));

  if (filtered.length === 0) {
    return { mean: null, median: null };
  }

  filtered.sort((a, b) => a - b);
  const sum = filtered.reduce((acc, value) => acc + value, 0);
  const middle = Math.floor(filtered.length / 2);
  const median = filtered.length % 2
    ? filtered[middle]
    : (filtered[middle - 1] + filtered[middle]) / 2;

  return {
    mean: sum / filtered.length,
    median
  };
}

export async function gunzipArrayBuffer(buffer) {
  const bytes = new Uint8Array(buffer);

  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return buffer;
  }

  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress gzip files. Use Chrome or Edge, or provide an uncompressed file.");
  }

  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

export async function fetchArrayBufferWithProgress(url, onProgress, options = {}) {
  const response = await fetch(url, options);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);

  if (!response.body || !contentLength) {
    const buffer = await response.arrayBuffer();
    onProgress?.({ loaded: buffer.byteLength, total: buffer.byteLength });
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ loaded, total: contentLength });
  }

  const buffer = new Uint8Array(loaded);
  let offset = 0;

  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return buffer.buffer;
}

export async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  return await response.json();
}

export async function fetchGzipJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  const buffer = await gunzipArrayBuffer(await response.arrayBuffer());
  return JSON.parse(new TextDecoder("utf-8").decode(buffer));
}

export function makeExternalLink(template, geneId) {
  if (!template) {
    return null;
  }

  if (!/^\s*https?:\/\//i.test(template) && !template.startsWith("./") && !template.startsWith("../")) {
    return null;
  }

  return template.replace("{gene}", encodeURIComponent(geneId));
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function unique(values) {
  return [...new Set(values.filter((value) => value != null && value !== ""))];
}

export function countBy(values) {
  const counts = new Map();

  for (const value of values) {
    const key = value || "NA";
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([key, count]) => `${key} (${count})`)
    .join(", ");
}
