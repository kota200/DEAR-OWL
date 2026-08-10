import { APP_CONFIG } from "./config.js?v=20260806e";
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
  computeExclusiveIntersections,
  describeIntersectionMembership
} from "./intersections.js?v=20260806c-directional-venn";

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

function appendWrappedSvgLabel(svg, label, x, y) {
  const words = String(label).trim().split(/\s+/);
  const lines = [];
  let currentLine = "";
  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (candidate.length > 24 && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = candidate;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }

  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("class", "venn-set-label");
  text.setAttribute("text-anchor", "middle");
  lines.forEach((line, index) => {
    const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
    tspan.setAttribute("x", String(x));
    tspan.setAttribute("y", String(y + index * 25));
    tspan.textContent = line;
    text.append(tspan);
  });
  svg.append(text);
}

function vennSvg(selectedSets, intersections) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1200 740");
  svg.setAttribute("class", "venn-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Venn diagram for ${selectedSets.map((set) => set.label).join(", ")}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const layout = selectedSets.length === 2
    ? {
        circles: [
          { cx: 465, cy: 350, radius: 240, color: "#2f7dbd", labelX: 300, labelY: 42 },
          { cx: 735, cy: 350, radius: 240, color: "#b73535", labelX: 900, labelY: 42 }
        ],
        regions: {
          "10": { x: 350, y: 350 },
          "11": { x: 600, y: 350 },
          "01": { x: 850, y: 350 }
        }
      }
    : {
        circles: [
          { cx: 450, cy: 290, radius: 210, color: "#2f7dbd", labelX: 300, labelY: 35 },
          { cx: 750, cy: 290, radius: 210, color: "#b73535", labelX: 900, labelY: 35 },
          { cx: 600, cy: 455, radius: 210, color: "#2f8f5b", labelX: 600, labelY: 690 }
        ],
        regions: {
          "100": { x: 380, y: 245 },
          "010": { x: 820, y: 245 },
          "001": { x: 600, y: 565 },
          "110": { x: 600, y: 175 },
          "101": { x: 480, y: 435 },
          "011": { x: 720, y: 435 },
          "111": { x: 600, y: 335 }
        }
      };

  selectedSets.forEach((set, index) => {
    const pos = layout.circles[index];
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", pos.cx);
    circle.setAttribute("cy", pos.cy);
    circle.setAttribute("r", pos.radius);
    circle.setAttribute("fill", pos.color);
    circle.setAttribute("opacity", "0.26");
    circle.setAttribute("stroke", pos.color);
    circle.setAttribute("stroke-width", "2");
    const circleTitle = document.createElementNS("http://www.w3.org/2000/svg", "title");
    circleTitle.textContent = `${set.label}: ${set.genes.size.toLocaleString()} genes`;
    circle.append(circleTitle);
    svg.append(circle);
    appendWrappedSvgLabel(svg, set.label, pos.labelX, pos.labelY);
  });

  const countByPattern = new Map(
    intersections.map((entry) => [entry.key, entry.genes.length])
  );
  for (const [key, pos] of Object.entries(layout.regions)) {
    const membership = [...key].map((value) => value === "1");
    const count = countByPattern.get(key) || 0;
    const description = describeIntersectionMembership(selectedSets, membership);
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("class", "venn-count");
    text.setAttribute("x", pos.x);
    text.setAttribute("y", pos.y);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "middle");
    text.setAttribute("aria-label", `${description}: ${count.toLocaleString()} genes`);
    text.append(document.createTextNode(count.toLocaleString()));
    const countTitle = document.createElementNS("http://www.w3.org/2000/svg", "title");
    countTitle.textContent = `${description}: ${count.toLocaleString()} genes`;
    text.append(countTitle);
    svg.append(text);
  }

  return svg;
}

const MAX_OVERLAP_SETS = 12;
const MAX_EULER_SETS = 9;
const MAX_UPSET_INTERSECTIONS = 30;
const OVERLAP_COLORS = [
  "#2f7dbd",
  "#b73535",
  "#2f8f5b",
  "#8a5ab5",
  "#c47718",
  "#247f8f",
  "#b64f8f",
  "#66752a",
  "#6b6fc7",
  "#9b623c"
];

function intersectionSize(first, second) {
  const [smaller, larger] = first.size <= second.size
    ? [first, second]
    : [second, first];
  let count = 0;
  for (const geneId of smaller) {
    if (larger.has(geneId)) {
      count += 1;
    }
  }
  return count;
}

function buildEulerLayout(selectedSets) {
  const width = 1200;
  const height = 720;
  const centerX = width / 2;
  const centerY = height / 2;
  const largestSet = Math.max(1, ...selectedSets.map((set) => set.genes.size));
  const ringRadius = selectedSets.length <= 5 ? 220 : 265;
  const nodes = selectedSets.map((set, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / selectedSets.length;
    return {
      x: centerX + Math.cos(angle) * ringRadius,
      y: centerY + Math.sin(angle) * ringRadius,
      radius: 72 + 105 * Math.sqrt(set.genes.size / largestSet),
      set,
      index
    };
  });
  const pairwiseOverlaps = nodes.map(() => Array(nodes.length).fill(0));
  for (let firstIndex = 0; firstIndex < nodes.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < nodes.length; secondIndex += 1) {
      const overlap = intersectionSize(nodes[firstIndex].set.genes, nodes[secondIndex].set.genes);
      pairwiseOverlaps[firstIndex][secondIndex] = overlap;
      pairwiseOverlaps[secondIndex][firstIndex] = overlap;
    }
  }

  for (let iteration = 0; iteration < 360; iteration += 1) {
    const alpha = 0.08 * (1 - iteration / 360) + 0.008;
    for (let firstIndex = 0; firstIndex < nodes.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < nodes.length; secondIndex += 1) {
        const first = nodes[firstIndex];
        const second = nodes[secondIndex];
        const overlap = pairwiseOverlaps[firstIndex][secondIndex];
        const smallerSize = Math.min(first.set.genes.size, second.set.genes.size);
        const overlapCoefficient = smallerSize > 0 ? overlap / smallerSize : 0;
        const radiusSum = first.radius + second.radius;
        const targetDistance = overlap === 0
          ? radiusSum + 34
          : Math.max(
              Math.abs(first.radius - second.radius) * 0.7,
              radiusSum * (0.96 - 0.78 * Math.sqrt(overlapCoefficient))
            );
        let dx = second.x - first.x;
        let dy = second.y - first.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.001) {
          const fallbackAngle = ((firstIndex + 1) * (secondIndex + 2) * 0.73) % (Math.PI * 2);
          dx = Math.cos(fallbackAngle);
          dy = Math.sin(fallbackAngle);
          distance = 1;
        }
        const adjustment = (distance - targetDistance) * alpha * 0.5;
        const unitX = dx / distance;
        const unitY = dy / distance;
        first.x += unitX * adjustment;
        first.y += unitY * adjustment;
        second.x -= unitX * adjustment;
        second.y -= unitY * adjustment;
      }
    }

    for (const node of nodes) {
      node.x += (centerX - node.x) * 0.002;
      node.y += (centerY - node.y) * 0.002;
      node.x = Math.max(node.radius + 24, Math.min(width - node.radius - 24, node.x));
      node.y = Math.max(node.radius + 24, Math.min(height - node.radius - 24, node.y));
    }
  }

  return { width, height, nodes };
}

function eulerSvg(selectedSets) {
  const layout = buildEulerLayout(selectedSets);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  svg.setAttribute("class", "euler-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Euler diagram for ${selectedSets.map((set) => set.label).join(", ")}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  layout.nodes
    .slice()
    .sort((first, second) => second.radius - first.radius)
    .forEach((node) => {
      const color = OVERLAP_COLORS[node.index % OVERLAP_COLORS.length];
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", node.x);
      circle.setAttribute("cy", node.y);
      circle.setAttribute("r", node.radius);
      circle.setAttribute("fill", color);
      circle.setAttribute("fill-opacity", "0.14");
      circle.setAttribute("stroke", color);
      circle.setAttribute("stroke-width", "3");
      const circleTitle = document.createElementNS("http://www.w3.org/2000/svg", "title");
      circleTitle.textContent = `${String.fromCharCode(65 + node.index)}. ${node.set.label}: ${node.set.genes.size.toLocaleString()} genes`;
      circle.append(circleTitle);
      svg.append(circle);
    });

  layout.nodes.forEach((node) => {
    const markerAngle = -Math.PI / 2 + (node.index * Math.PI * 2) / selectedSets.length;
    const markerX = node.x + Math.cos(markerAngle) * node.radius * 0.62;
    const markerY = node.y + Math.sin(markerAngle) * node.radius * 0.62;
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "text");
    marker.setAttribute("class", "euler-set-code");
    marker.setAttribute("x", markerX);
    marker.setAttribute("y", markerY);
    marker.setAttribute("text-anchor", "middle");
    marker.setAttribute("dominant-baseline", "middle");
    marker.textContent = String.fromCharCode(65 + node.index);
    svg.append(marker);
  });

  return svg;
}

function eulerLegend(selectedSets) {
  const list = document.createElement("ol");
  list.className = "euler-legend";
  selectedSets.forEach((set, index) => {
    const item = document.createElement("li");
    const code = document.createElement("span");
    code.className = "euler-legend-code";
    code.style.backgroundColor = OVERLAP_COLORS[index % OVERLAP_COLORS.length];
    code.textContent = String.fromCharCode(65 + index);
    const text = document.createElement("span");
    text.textContent = `${set.label} — ${set.genes.size.toLocaleString()} genes`;
    item.append(code, text);
    list.append(item);
  });
  return list;
}

function upsetSvg(selectedSets, intersections) {
  const shownIntersections = intersections.slice(0, MAX_UPSET_INTERSECTIONS);
  const leftMargin = 390;
  const columnWidth = 44;
  const barTop = 90;
  const barBottom = 360;
  const matrixTop = 430;
  const rowHeight = 38;
  const width = Math.max(1120, leftMargin + shownIntersections.length * columnWidth + 40);
  const height = matrixTop + selectedSets.length * rowHeight + 45;
  const maxCount = Math.max(1, ...shownIntersections.map((entry) => entry.genes.length));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("class", "upset-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `UpSet plot for ${selectedSets.map((set) => set.label).join(", ")}`);

  const axisTitle = document.createElementNS("http://www.w3.org/2000/svg", "text");
  axisTitle.setAttribute("class", "upset-axis-title");
  axisTitle.setAttribute("x", leftMargin - 18);
  axisTitle.setAttribute("y", 28);
  axisTitle.setAttribute("text-anchor", "end");
  axisTitle.textContent = "Exclusive intersection gene count";
  svg.append(axisTitle);

  for (let tickIndex = 0; tickIndex <= 4; tickIndex += 1) {
    const ratio = tickIndex / 4;
    const y = barBottom - ratio * (barBottom - barTop);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "upset-grid-line");
    line.setAttribute("x1", leftMargin);
    line.setAttribute("x2", width - 20);
    line.setAttribute("y1", y);
    line.setAttribute("y2", y);
    svg.append(line);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("class", "upset-axis-label");
    label.setAttribute("x", leftMargin - 14);
    label.setAttribute("y", y + 5);
    label.setAttribute("text-anchor", "end");
    label.textContent = Math.round(maxCount * ratio).toLocaleString();
    svg.append(label);
  }

  selectedSets.forEach((set, setIndex) => {
    const y = matrixTop + setIndex * rowHeight;
    const guide = document.createElementNS("http://www.w3.org/2000/svg", "line");
    guide.setAttribute("class", "upset-row-guide");
    guide.setAttribute("x1", leftMargin);
    guide.setAttribute("x2", width - 20);
    guide.setAttribute("y1", y);
    guide.setAttribute("y2", y);
    svg.append(guide);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("class", "upset-set-label");
    label.setAttribute("x", leftMargin - 14);
    label.setAttribute("y", y + 5);
    label.setAttribute("text-anchor", "end");
    label.textContent = `${String.fromCharCode(65 + setIndex)}. ${set.label}`;
    const labelTitle = document.createElementNS("http://www.w3.org/2000/svg", "title");
    labelTitle.textContent = `${set.label}: ${set.genes.size.toLocaleString()} genes`;
    label.append(labelTitle);
    svg.append(label);
  });

  shownIntersections.forEach((entry, entryIndex) => {
    const x = leftMargin + entryIndex * columnWidth + columnWidth / 2;
    const barHeight = (entry.genes.length / maxCount) * (barBottom - barTop);
    const barY = barBottom - barHeight;
    const description = describeIntersectionMembership(selectedSets, entry.membership);
    const bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bar.setAttribute("class", "upset-bar");
    bar.setAttribute("x", x - 13);
    bar.setAttribute("y", barY);
    bar.setAttribute("width", 26);
    bar.setAttribute("height", Math.max(1, barHeight));
    bar.setAttribute("aria-label", `${description}: ${entry.genes.length.toLocaleString()} genes`);
    const barTitle = document.createElementNS("http://www.w3.org/2000/svg", "title");
    barTitle.textContent = `${description}: ${entry.genes.length.toLocaleString()} genes`;
    bar.append(barTitle);
    svg.append(bar);

    const count = document.createElementNS("http://www.w3.org/2000/svg", "text");
    count.setAttribute("class", "upset-count-label");
    count.setAttribute("x", x + 2);
    count.setAttribute("y", Math.max(48, barY - 7));
    count.setAttribute("transform", `rotate(-55 ${x + 2} ${Math.max(48, barY - 7)})`);
    count.textContent = entry.genes.length.toLocaleString();
    svg.append(count);

    const includedRows = entry.membership
      .map((included, index) => included ? index : -1)
      .filter((index) => index >= 0);
    if (includedRows.length > 1) {
      const connector = document.createElementNS("http://www.w3.org/2000/svg", "line");
      connector.setAttribute("class", "upset-connector");
      connector.setAttribute("x1", x);
      connector.setAttribute("x2", x);
      connector.setAttribute("y1", matrixTop + includedRows[0] * rowHeight);
      connector.setAttribute("y2", matrixTop + includedRows[includedRows.length - 1] * rowHeight);
      svg.append(connector);
    }

    entry.membership.forEach((included, setIndex) => {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("class", included ? "upset-dot is-included" : "upset-dot");
      dot.setAttribute("cx", x);
      dot.setAttribute("cy", matrixTop + setIndex * rowHeight);
      dot.setAttribute("r", included ? 7 : 5);
      svg.append(dot);
    });
  });

  return svg;
}

const SVG_EXPORT_STYLE_PROPERTIES = [
  "color",
  "fill",
  "fill-opacity",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "opacity",
  "paint-order",
  "stroke",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
  "text-anchor"
];

function svgDimensions(svg) {
  const values = String(svg.getAttribute("viewBox") || "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (values.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0) {
    return { x: values[0], y: values[1], width: values[2], height: values[3] };
  }
  return {
    x: 0,
    y: 0,
    width: Number(svg.getAttribute("width")) || 1200,
    height: Number(svg.getAttribute("height")) || 740
  };
}

function inlineSvgComputedStyles(sourceSvg, clonedSvg) {
  const sourceNodes = [sourceSvg, ...sourceSvg.querySelectorAll("*")];
  const clonedNodes = [clonedSvg, ...clonedSvg.querySelectorAll("*")];
  sourceNodes.forEach((sourceNode, index) => {
    const clonedNode = clonedNodes[index];
    if (!clonedNode) {
      return;
    }
    const computed = getComputedStyle(sourceNode);
    for (const property of SVG_EXPORT_STYLE_PROPERTIES) {
      const value = computed.getPropertyValue(property);
      if (value) {
        clonedNode.style.setProperty(property, value);
      }
    }
  });
}

function appendEulerExportLegend(svg, selectedSets, baseHeight, width) {
  const columns = 2;
  const rowHeight = 36;
  const rows = Math.ceil(selectedSets.length / columns);
  const legendHeight = 58 + rows * rowHeight;
  const heading = document.createElementNS("http://www.w3.org/2000/svg", "text");
  heading.setAttribute("x", 24);
  heading.setAttribute("y", baseHeight + 34);
  heading.setAttribute("fill", "#1f2933");
  heading.setAttribute("font-family", "Arial, sans-serif");
  heading.setAttribute("font-size", "18");
  heading.setAttribute("font-weight", "700");
  heading.textContent = "Set legend";
  svg.append(heading);

  selectedSets.forEach((set, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = 24 + column * (width / columns);
    const y = baseHeight + 66 + row * rowHeight;
    const code = String.fromCharCode(65 + index);
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    marker.setAttribute("cx", x + 12);
    marker.setAttribute("cy", y - 5);
    marker.setAttribute("r", 12);
    marker.setAttribute("fill", OVERLAP_COLORS[index % OVERLAP_COLORS.length]);
    svg.append(marker);
    const markerText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    markerText.setAttribute("x", x + 12);
    markerText.setAttribute("y", y);
    markerText.setAttribute("text-anchor", "middle");
    markerText.setAttribute("fill", "#ffffff");
    markerText.setAttribute("font-family", "Arial, sans-serif");
    markerText.setAttribute("font-size", "13");
    markerText.setAttribute("font-weight", "700");
    markerText.textContent = code;
    svg.append(markerText);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", x + 34);
    label.setAttribute("y", y);
    label.setAttribute("fill", "#1f2933");
    label.setAttribute("font-family", "Arial, sans-serif");
    label.setAttribute("font-size", "15");
    label.textContent = `${set.label} — ${set.genes.size.toLocaleString()} genes`;
    svg.append(label);
  });

  return legendHeight;
}

function exportableSvg(sourceSvg, { legendSets = [] } = {}) {
  const clonedSvg = sourceSvg.cloneNode(true);
  inlineSvgComputedStyles(sourceSvg, clonedSvg);
  const dimensions = svgDimensions(sourceSvg);
  const legendHeight = legendSets.length
    ? appendEulerExportLegend(clonedSvg, legendSets, dimensions.height, dimensions.width)
    : 0;
  const exportHeight = dimensions.height + legendHeight;
  clonedSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clonedSvg.setAttribute("viewBox", `${dimensions.x} ${dimensions.y} ${dimensions.width} ${exportHeight}`);
  clonedSvg.setAttribute("width", dimensions.width);
  clonedSvg.setAttribute("height", exportHeight);
  clonedSvg.removeAttribute("class");
  clonedSvg.removeAttribute("style");

  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("x", dimensions.x);
  background.setAttribute("y", dimensions.y);
  background.setAttribute("width", dimensions.width);
  background.setAttribute("height", exportHeight);
  background.setAttribute("fill", "#ffffff");
  clonedSvg.insertBefore(background, clonedSvg.firstChild);

  return {
    svg: clonedSvg,
    width: dimensions.width,
    height: exportHeight
  };
}

function serializeOverlapSvg(sourceSvg, options = {}) {
  const exported = exportableSvg(sourceSvg, options);
  return {
    ...exported,
    text: `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(exported.svg)}`
  };
}

async function downloadOverlapPng(sourceSvg, filename, options = {}) {
  const exported = serializeOverlapSvg(sourceSvg, options);
  const svgUrl = URL.createObjectURL(new Blob([exported.text], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("The overlap SVG could not be converted to PNG."));
      image.src = svgUrl;
    });
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(exported.width * scale);
    canvas.height = Math.round(exported.height * scale);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas rendering is unavailable in this browser.");
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) {
      throw new Error("The overlap PNG could not be created.");
    }
    downloadBlob(blob, filename);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function overlapCsv(selectedSets, intersections) {
  const membershipColumns = selectedSets.map((set, index) =>
    `${String.fromCharCode(65 + index)}. ${set.label}`
  );
  const columns = [
    "rank",
    "membership_pattern",
    "gene_set_combination",
    "gene_count",
    ...membershipColumns
  ];
  const rows = intersections.map((entry, index) => {
    const row = {
      rank: index + 1,
      membership_pattern: `binary_${entry.key}`,
      gene_set_combination: describeIntersectionMembership(selectedSets, entry.membership),
      gene_count: entry.genes.length
    };
    membershipColumns.forEach((column, setIndex) => {
      row[column] = entry.membership[setIndex] ? "Included" : "Excluded";
    });
    return row;
  });
  return objectsToCsv(rows, columns, { bom: true });
}

function overlapFigureHeader({
  title,
  svg,
  fileStem,
  selectedSets,
  intersections,
  legendSets = []
}) {
  const header = document.createElement("div");
  header.className = "overlap-figure-header";
  const heading = document.createElement("h4");
  heading.className = "overlap-figure-title";
  heading.textContent = title;
  const actions = document.createElement("div");
  actions.className = "plot-downloads overlap-downloads";
  const exportOptions = legendSets.length ? { legendSets } : {};

  const downloadSvg = document.createElement("button");
  downloadSvg.type = "button";
  downloadSvg.textContent = "SVG";
  downloadSvg.setAttribute("aria-label", `Download ${title} as SVG`);
  downloadSvg.addEventListener("click", () => {
    const exported = serializeOverlapSvg(svg, exportOptions);
    downloadBlob(
      new Blob([exported.text], { type: "image/svg+xml;charset=utf-8" }),
      `${fileStem}.svg`
    );
  });

  const downloadPng = document.createElement("button");
  downloadPng.type = "button";
  downloadPng.textContent = "PNG";
  downloadPng.setAttribute("aria-label", `Download ${title} as PNG`);
  downloadPng.addEventListener("click", async () => {
    downloadPng.disabled = true;
    try {
      await downloadOverlapPng(svg, `${fileStem}.png`, exportOptions);
    } catch (error) {
      console.error(`Failed to download ${title} as PNG.`, error);
    } finally {
      downloadPng.disabled = false;
    }
  });

  const downloadCsv = document.createElement("button");
  downloadCsv.type = "button";
  downloadCsv.textContent = "CSV";
  downloadCsv.setAttribute("aria-label", `Download ${title} data as CSV`);
  downloadCsv.addEventListener("click", () => {
    downloadText(overlapCsv(selectedSets, intersections), `${fileStem}_data.csv`);
  });

  actions.append(downloadSvg, downloadPng, downloadCsv);
  header.append(heading, actions);
  return header;
}

function renderOverlap(container, result) {
  const section = document.createElement("section");
  section.className = "overlap-section";
  const title = document.createElement("h3");
  title.textContent = "Gene-set overlap visualizations";

  const controls = document.createElement("div");
  controls.className = "venn-controls";

  const directionLabel = document.createElement("label");
  directionLabel.className = "venn-direction-control";
  const directionText = document.createElement("span");
  directionText.textContent = "Direction";
  const directionSelect = document.createElement("select");
  for (const [value, label] of [
    ["Up", "Up-regulated genes"],
    ["Down", "Down-regulated genes"]
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    directionSelect.append(option);
  }
  directionSelect.value = "Up";
  directionLabel.append(directionText, directionSelect);

  const directionNote = document.createElement("p");
  directionNote.className = "muted venn-direction-note";
  directionNote.textContent = "Up means higher expression in the first-named group; Down means lower expression. The selected direction is applied to every comparison.";
  controls.append(directionLabel, directionNote);

  const chooser = document.createElement("div");
  chooser.className = "overlap-set-grid";
  const selectionStatus = document.createElement("p");
  selectionStatus.className = "muted overlap-selection-status";
  const selectedKeys = new Set();
  const availableContrasts = result.contrasts.map((contrast) => ({
    key: contrast.id,
    label: contrast.label,
    contrast
  }));

  for (const contrast of availableContrasts.slice(0, MAX_OVERLAP_SETS)) {
    selectedKeys.add(contrast.key);
  }

  const output = document.createElement("div");
  output.className = "overlap-output";

  const renderOutput = () => {
    output.replaceChildren();
    const direction = directionSelect.value;
    const selectedSets = availableContrasts
      .filter((contrast) => selectedKeys.has(contrast.key))
      .map((contrast) => ({
        ...contrast,
        direction,
        label: `${contrast.label} ${direction}`,
        genes: buildGeneSet(contrast.contrast, direction)
      }));

    if (selectedSets.length < 2) {
      output.textContent = "Select at least 2 comparisons.";
      return;
    }

    const intersections = computeExclusiveIntersections(selectedSets);

    if (selectedSets.length <= 3) {
      const figure = document.createElement("figure");
      figure.className = "overlap-figure venn-figure";
      const diagram = vennSvg(selectedSets, intersections);
      const fileStem = `venn_diagram_${direction.toLowerCase()}_genes`;
      const header = overlapFigureHeader({
        title: "Venn diagram",
        svg: diagram,
        fileStem,
        selectedSets,
        intersections
      });
      const caption = document.createElement("figcaption");
      caption.className = "venn-caption";
      caption.textContent = "Numbers show the gene count in each exclusive Venn region. The complete meaning of every region is listed below.";
      figure.append(header, diagram, caption);
      output.append(figure);
    } else if (selectedSets.length <= MAX_EULER_SETS) {
      const figure = document.createElement("figure");
      figure.className = "overlap-figure euler-figure";
      const diagram = eulerSvg(selectedSets);
      const fileStem = `euler_diagram_${direction.toLowerCase()}_genes`;
      const header = overlapFigureHeader({
        title: "Euler diagram",
        svg: diagram,
        fileStem,
        selectedSets,
        intersections,
        legendSets: selectedSets
      });
      const caption = document.createElement("figcaption");
      caption.className = "venn-caption";
      caption.textContent = "Circle sizes and distances summarize set sizes and pairwise overlap. Geometry is approximate; exact multi-way intersections are shown in the UpSet plot and table.";
      figure.append(header, diagram, eulerLegend(selectedSets), caption);
      output.append(figure);
    } else {
      const warning = document.createElement("p");
      warning.className = "manual-note overlap-diagram-warning";
      warning.textContent = "Venn and Euler diagrams are not displayed for 10 or more comparisons because the overlapping regions become unreadable. Use the UpSet plot below to examine exact intersections.";
      output.append(warning);
    }

    const upsetFigure = document.createElement("figure");
    upsetFigure.className = "overlap-figure upset-figure";
    const upsetDiagram = upsetSvg(selectedSets, intersections);
    const upsetFileStem = `upset_plot_${direction.toLowerCase()}_genes`;
    const upsetHeader = overlapFigureHeader({
      title: "UpSet plot",
      svg: upsetDiagram,
      fileStem: upsetFileStem,
      selectedSets,
      intersections
    });
    const upsetViewport = document.createElement("div");
    upsetViewport.className = "upset-viewport";
    upsetViewport.append(upsetDiagram);
    const upsetCaption = document.createElement("figcaption");
    upsetCaption.className = "venn-caption";
    upsetCaption.textContent = `Showing the ${Math.min(MAX_UPSET_INTERSECTIONS, intersections.length).toLocaleString()} largest non-empty exclusive intersections of ${intersections.length.toLocaleString()}. All exact intersections are listed below.`;
    upsetFigure.append(upsetHeader, upsetViewport, upsetCaption);
    output.append(upsetFigure);

    const tableHeading = document.createElement("h4");
    tableHeading.className = "overlap-figure-title";
    tableHeading.textContent = "Exclusive intersection table";
    output.append(tableHeading);

    const tableWrap = document.createElement("div");
    tableWrap.className = "result-table-wrap overlap-table-wrap";
    const table = document.createElement("table");
    table.className = "result-table overlap-table";
    const thead = document.createElement("thead");
    const head = document.createElement("tr");
    for (const label of ["Gene-set combination", "Gene count"]) {
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
      pattern.textContent = describeIntersectionMembership(selectedSets, entry.membership);
      const genes = document.createElement("td");
      genes.textContent = `${entry.genes.length.toLocaleString()} genes`;
      tr.append(pattern, genes);
      tbody.append(tr);
    }
    table.append(tbody);
    tableWrap.append(table);
    output.append(tableWrap);
  };

  const checkboxes = [];
  const updateSelectionControls = () => {
    const atLimit = selectedKeys.size >= MAX_OVERLAP_SETS;
    for (const { checkbox, key } of checkboxes) {
      checkbox.disabled = atLimit && !selectedKeys.has(key);
    }
    selectionStatus.textContent = `${selectedKeys.size} comparisons selected for overlap views (maximum ${MAX_OVERLAP_SETS}).`;
  };

  directionSelect.addEventListener("change", renderOutput);

  for (const contrast of availableContrasts) {
    const label = document.createElement("label");
    label.className = "inline-check";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedKeys.has(contrast.key);
    checkboxes.push({ checkbox, key: contrast.key });
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        if (selectedKeys.size >= MAX_OVERLAP_SETS) {
          checkbox.checked = false;
          return;
        }
        selectedKeys.add(contrast.key);
      } else {
        selectedKeys.delete(contrast.key);
      }
      updateSelectionControls();
      renderOutput();
    });
    label.append(checkbox, document.createTextNode(` ${contrast.label}`));
    chooser.append(label);
  }

  updateSelectionControls();
  section.append(title, controls, chooser, selectionStatus, output);
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
