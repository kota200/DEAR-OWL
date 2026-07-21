import {
  csvEscape,
  downloadBlob,
  objectsToCsv,
  parseNumber
} from "./utils.js";

const COLORS = {
  Up: "#b73535",
  Down: "#2869b1",
  "Not significant": "#7a7f87",
  "Filtered / NA": "#b8bdc5",
  control: "#2869b1",
  treatment: "#b73535"
};

function number(value) {
  const parsed = parseNumber(value);
  return parsed == null ? null : parsed;
}

function svgEl(name, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
  return element;
}

function extent(values) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;

  for (const value of values) {
    if (!Number.isFinite(value)) {
      continue;
    }

    min = Math.min(min, value);
    max = Math.max(max, value);
    count += 1;
  }

  if (count === 0) {
    return [0, 1];
  }

  if (min === max) {
    return [min - 1, max + 1];
  }
  return [min, max];
}

function scale([domainMin, domainMax], [rangeMin, rangeMax]) {
  return (value) => rangeMin + ((value - domainMin) / (domainMax - domainMin)) * (rangeMax - rangeMin);
}

function formatTick(value) {
  if (!Number.isFinite(value)) {
    return "";
  }
  if (value === 0) {
    return "0";
  }

  const abs = Math.abs(value);
  if (abs >= 10000 || abs < 0.001) {
    return value.toExponential(1);
  }
  if (abs < 1) {
    return String(Number(value.toPrecision(2)));
  }
  return String(Number(value.toPrecision(3)));
}

function linearTicks([min, max], count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [];
  }
  if (min === max) {
    return [min];
  }

  const step = (max - min) / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, index) => min + step * index);
}

function addAxis(svg, chart, {
  xLabel,
  yLabel,
  xDomain = null,
  yDomain = null,
  xScale = null,
  yScale = null,
  xTicks = null,
  yTicks = null
}) {
  const grid = svgEl("g", { class: "plot-grid-lines" });
  const axis = svgEl("g", { class: "plot-axis" });

  const resolvedXTicks = xTicks || (xScale && xDomain ? linearTicks(xDomain) : []);
  const resolvedYTicks = yTicks || (yScale && yDomain ? linearTicks(yDomain) : []);

  for (const tick of resolvedXTicks) {
    const x = xScale(tick);
    axis.append(svgEl("line", {
      x1: x,
      y1: chart.bottom,
      x2: x,
      y2: chart.bottom + 6,
      stroke: "#475569",
      "stroke-width": 1
    }));
    grid.append(svgEl("line", {
      x1: x,
      y1: chart.top,
      x2: x,
      y2: chart.bottom,
      class: "plot-grid-line",
      stroke: "#e5e7eb",
      "stroke-width": 1
    }));
    const tickText = svgEl("text", {
      x,
      y: chart.bottom + 22,
      "text-anchor": "middle",
      fill: "#334155",
      "font-size": 13
    });
    tickText.textContent = formatTick(tick);
    axis.append(tickText);
  }

  for (const tick of resolvedYTicks) {
    const y = yScale(tick);
    axis.append(svgEl("line", {
      x1: chart.left - 6,
      y1: y,
      x2: chart.left,
      y2: y,
      stroke: "#475569",
      "stroke-width": 1
    }));
    grid.append(svgEl("line", {
      x1: chart.left,
      y1: y,
      x2: chart.right,
      y2: y,
      class: "plot-grid-line",
      stroke: "#e5e7eb",
      "stroke-width": 1
    }));
    const tickText = svgEl("text", {
      x: chart.left - 10,
      y: y + 4,
      "text-anchor": "end",
      fill: "#334155",
      "font-size": 13
    });
    tickText.textContent = formatTick(tick);
    axis.append(tickText);
  }

  axis.append(svgEl("line", {
    x1: chart.left,
    y1: chart.bottom,
    x2: chart.right,
    y2: chart.bottom,
    stroke: "#475569",
    "stroke-width": 1.2
  }));
  axis.append(svgEl("line", {
    x1: chart.left,
    y1: chart.top,
    x2: chart.left,
    y2: chart.bottom,
    stroke: "#475569",
    "stroke-width": 1.2
  }));

  const xText = svgEl("text", {
    x: (chart.left + chart.right) / 2,
    y: chart.height - 18,
    "text-anchor": "middle",
    fill: "#334155",
    "font-size": 15,
    "font-weight": 700
  });
  xText.textContent = xLabel;
  axis.append(xText);

  const yText = svgEl("text", {
    x: 20,
    y: (chart.top + chart.bottom) / 2,
    transform: `rotate(-90 20 ${(chart.top + chart.bottom) / 2})`,
    "text-anchor": "middle",
    fill: "#334155",
    "font-size": 15,
    "font-weight": 700
  });
  yText.textContent = yLabel;
  axis.append(yText);
  svg.append(grid);
  svg.append(axis);
}

function addLegend(svg, chart, labels) {
  const group = svgEl("g", { class: "plot-legend" });
  let x = chart.left;
  const y = 48;

  for (const label of labels) {
    group.append(svgEl("circle", {
      cx: x + 6,
      cy: y - 4,
      r: 5,
      fill: COLORS[label] || "#555"
    }));
    const text = svgEl("text", {
      x: x + 16,
      y
    });
    text.textContent = label;
    group.append(text);
    x += Math.max(120, label.length * 8 + 38);
  }

  svg.append(group);
}

function scatterSvg({
  rows,
  title,
  xLabel,
  yLabel,
  xValue,
  yValue,
  thresholds = [],
  onGeneClick
}) {
  const width = 900;
  const height = 560;
  const chart = {
    width,
    height,
    left: 92,
    right: width - 28,
    top: 76,
    bottom: height - 80
  };
  const points = rows
    .map((row) => ({
      row,
      x: xValue(row),
      y: yValue(row),
      direction: row.direction || row.group || "Not significant"
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

  const [xMin, xMax] = extent(points.map((point) => point.x));
  const [yMin, yMax] = extent(points.map((point) => point.y));
  const sx = scale([xMin, xMax], [chart.left, chart.right]);
  const sy = scale([yMin, yMax], [chart.bottom, chart.top]);
  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": title
  });

  const titleText = svgEl("text", {
    x: chart.left,
    y: 24,
    class: "plot-title-svg"
  });
  titleText.textContent = title;
  svg.append(titleText);

  addAxis(svg, chart, {
    xLabel,
    yLabel,
    xDomain: [xMin, xMax],
    yDomain: [yMin, yMax],
    xScale: sx,
    yScale: sy
  });
  addLegend(svg, chart, ["Up", "Down", "Not significant", "Filtered / NA"].filter((label) =>
    points.some((point) => point.direction === label)
  ));

  for (const line of thresholds) {
    if (line.x != null && line.x >= xMin && line.x <= xMax) {
      svg.append(svgEl("line", {
        x1: sx(line.x),
        y1: chart.top,
        x2: sx(line.x),
        y2: chart.bottom,
        class: "threshold-line"
      }));
    }
    if (line.y != null && line.y >= yMin && line.y <= yMax) {
      svg.append(svgEl("line", {
        x1: chart.left,
        y1: sy(line.y),
        x2: chart.right,
        y2: sy(line.y),
        class: "threshold-line"
      }));
    }
  }

  const pointGroup = svgEl("g", { class: "plot-points" });
  for (const point of points) {
    const homologText = [
      point.row.arabidopsis_homolog,
      point.row.rice_homolog
    ].filter(Boolean).join("\n");
    const circle = svgEl("circle", {
      cx: sx(point.x),
      cy: sy(point.y),
      r: 3.2,
      fill: COLORS[point.direction] || "#666",
      tabindex: 0
    });
    const tooltip = svgEl("title");
    tooltip.textContent = `${point.row.gene_id || point.row.sample || ""}\n${xLabel}: ${point.x}\n${yLabel}: ${point.y}${homologText ? `\n${homologText}` : ""}`;
    circle.append(tooltip);
    circle.addEventListener("click", () => {
      if (point.row.gene_id) {
        onGeneClick?.(point.row.gene_id);
      }
    });
    pointGroup.append(circle);
  }
  svg.append(pointGroup);

  return {
    svg,
    data: points.map((point) => ({
      id: point.row.gene_id || point.row.sample,
      x: point.x,
      y: point.y,
      direction: point.direction,
      arabidopsis_homolog: point.row.arabidopsis_homolog || "",
      rice_homolog: point.row.rice_homolog || ""
    }))
  };
}

function matrixSvg(rows, title, valuePrefix = "") {
  const samples = rows.map((row) => row.sample);
  const size = Math.max(420, Math.min(860, samples.length * 24 + 160));
  const margin = 120;
  const cellSize = Math.max(8, Math.min(28, (size - margin - 30) / Math.max(samples.length, 1)));
  const width = margin + cellSize * samples.length + 30;
  const height = margin + cellSize * samples.length + 52;
  const values = [];

  for (const row of rows) {
    for (const sample of samples) {
      const value = number(row[sample]);
      if (value != null) {
        values.push(value);
      }
    }
  }

  const [min, max] = extent(values);
  const color = (value) => {
    const t = max === min ? 0.5 : (value - min) / (max - min);
    const r = Math.round(245 - t * 180);
    const g = Math.round(247 - t * 95);
    const b = Math.round(250 - t * 55);
    return `rgb(${r},${g},${b})`;
  };

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": title
  });

  const titleText = svgEl("text", {
    x: 18,
    y: 24,
    class: "plot-title-svg"
  });
  titleText.textContent = title;
  svg.append(titleText);

  samples.forEach((sample, index) => {
    const xText = svgEl("text", {
      x: margin + index * cellSize + cellSize / 2,
      y: margin - 8,
      transform: `rotate(-45 ${margin + index * cellSize + cellSize / 2} ${margin - 8})`,
      "text-anchor": "end",
      class: "heatmap-label"
    });
    xText.textContent = sample;
    svg.append(xText);

    const yText = svgEl("text", {
      x: margin - 8,
      y: margin + index * cellSize + cellSize * 0.7,
      "text-anchor": "end",
      class: "heatmap-label"
    });
    yText.textContent = sample;
    svg.append(yText);
  });

  rows.forEach((row, rowIndex) => {
    samples.forEach((sample, columnIndex) => {
      const value = number(row[sample]);
      const rect = svgEl("rect", {
        x: margin + columnIndex * cellSize,
        y: margin + rowIndex * cellSize,
        width: cellSize,
        height: cellSize,
        fill: value == null ? "#f1f3f5" : color(value),
        stroke: "#fff",
        "stroke-width": 1
      });
      const tooltip = svgEl("title");
      tooltip.textContent = `${row.sample} x ${sample}: ${valuePrefix}${value ?? "NA"}`;
      rect.append(tooltip);
      svg.append(rect);
    });
  });

  return { svg, data: rows };
}

function boxplotSvg(normalizedBoxplot) {
  const summaries = (normalizedBoxplot || [])
    .map((row) => ({
      sample: row.sample,
      group: row.group,
      min: number(row.min),
      q1: number(row.q1),
      median: number(row.median),
      q3: number(row.q3),
      max: number(row.max)
    }))
    .filter((summary) =>
      summary.sample &&
      summary.min != null &&
      summary.q1 != null &&
      summary.median != null &&
      summary.q3 != null &&
      summary.max != null
    );

  const width = Math.max(760, summaries.length * 64 + 120);
  const height = 560;
  const chart = {
    width,
    height,
    left: 92,
    right: width - 28,
    top: 44,
    bottom: height - 112
  };
  const [yMin, yMax] = extent(summaries.flatMap((summary) => [summary.min, summary.max]));
  const sy = scale([yMin, yMax], [chart.bottom, chart.top]);
  const step = summaries.length ? (chart.right - chart.left) / summaries.length : 1;
  const boxWidth = Math.min(34, step * 0.5);
  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": "DESeq2-normalized count boxplot"
  });

  const titleText = svgEl("text", {
    x: chart.left,
    y: 24,
    class: "plot-title-svg"
  });
  titleText.textContent = "DESeq2-normalized count boxplot";
  svg.append(titleText);
  addAxis(svg, chart, {
    xLabel: "sample",
    yLabel: "log10(normalized count + 1)",
    yDomain: [yMin, yMax],
    yScale: sy
  });

  summaries.forEach((summary, index) => {
    const x = chart.left + step * index + step / 2;
    svg.append(svgEl("line", {
      x1: x,
      y1: sy(summary.min),
      x2: x,
      y2: sy(summary.max),
      stroke: "#475569"
    }));
    svg.append(svgEl("rect", {
      x: x - boxWidth / 2,
      y: sy(summary.q3),
      width: boxWidth,
      height: Math.max(1, sy(summary.q1) - sy(summary.q3)),
      fill: "#dcecff",
      stroke: "#2869b1"
    }));
    svg.append(svgEl("line", {
      x1: x - boxWidth / 2,
      y1: sy(summary.median),
      x2: x + boxWidth / 2,
      y2: sy(summary.median),
      stroke: "#b73535",
      "stroke-width": 2
    }));

    const label = svgEl("text", {
      x,
      y: chart.bottom + 16,
      transform: `rotate(45 ${x} ${chart.bottom + 16})`,
      class: "heatmap-label"
    });
    label.textContent = summary.sample;
    svg.append(label);
  });

  return { svg, data: summaries };
}

function card(title, rendered, dataRows) {
  const section = document.createElement("section");
  section.className = "plot-card";

  const header = document.createElement("div");
  header.className = "plot-card-header";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  const actions = document.createElement("div");
  actions.className = "plot-downloads";

  const downloadSvg = document.createElement("button");
  downloadSvg.type = "button";
  downloadSvg.textContent = "SVG";
  downloadSvg.addEventListener("click", () => {
    const svgText = new XMLSerializer().serializeToString(rendered);
    downloadBlob(new Blob([svgText], { type: "image/svg+xml" }), `${title.replace(/\s+/g, "_").toLowerCase()}.svg`);
  });

  const downloadPng = document.createElement("button");
  downloadPng.type = "button";
  downloadPng.textContent = "PNG";
  downloadPng.addEventListener("click", async () => {
    const svgText = new XMLSerializer().serializeToString(rendered);
    const image = new Image();
    const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width || 900;
      canvas.height = image.height || 520;
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) {
          downloadBlob(blob, `${title.replace(/\s+/g, "_").toLowerCase()}.png`);
        }
        URL.revokeObjectURL(url);
      });
    };
    image.src = url;
  });

  const downloadData = document.createElement("button");
  downloadData.type = "button";
  downloadData.textContent = "CSV";
  downloadData.addEventListener("click", () => {
    const columns = dataRows.length ? Object.keys(dataRows[0]) : ["message"];
    const csv = dataRows.length
      ? objectsToCsv(dataRows, columns)
      : `message\r\n${csvEscape("No plot data")}\r\n`;
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${title.replace(/\s+/g, "_").toLowerCase()}_data.csv`);
  });

  actions.append(downloadSvg, downloadPng, downloadData);
  header.append(h3, actions);
  section.append(header, rendered);
  return section;
}

function messageCard(title, message) {
  const section = document.createElement("section");
  section.className = "plot-card plot-message";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  const p = document.createElement("p");
  p.textContent = message;
  section.append(h3, p);
  return section;
}

export function renderPlots({
  container,
  rows,
  plots,
  thresholds,
  plotData,
  sizeFactors,
  normalizedBoxplot,
  onGeneClick
}) {
  container.replaceChildren();

  if (plots.ma) {
    const rendered = scatterSvg({
      rows,
      title: "MA plot",
      xLabel: "log10(baseMean + 1)",
      yLabel: "log2 fold change",
      xValue: (row) => {
        const baseMean = number(row.baseMean);
        return baseMean == null ? null : Math.log10(baseMean + 1);
      },
      yValue: (row) => number(row.log2FoldChange),
      thresholds: [
        { y: thresholds.log2FoldChangeThreshold },
        { y: -thresholds.log2FoldChangeThreshold }
      ],
      onGeneClick
    });
    container.append(card("MA plot", rendered.svg, rendered.data));
  }

  if (plots.volcano) {
    let minPositive = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      const padj = number(row.padj);
      if (padj != null && padj > 0) {
        minPositive = Math.min(minPositive, padj);
      }
    }
    if (!Number.isFinite(minPositive)) {
      minPositive = 1e-300;
    }
    const rendered = scatterSvg({
      rows,
      title: "Volcano plot",
      xLabel: "log2 fold change",
      yLabel: "-log10(adjusted p-value)",
      xValue: (row) => number(row.log2FoldChange),
      yValue: (row) => {
        const padj = number(row.padj);
        if (padj == null) {
          return null;
        }
        return -Math.log10(Math.max(padj, minPositive));
      },
      thresholds: [
        { x: thresholds.log2FoldChangeThreshold },
        { x: -thresholds.log2FoldChangeThreshold },
        { y: -Math.log10(thresholds.fdrThreshold) }
      ],
      onGeneClick
    });
    container.append(card("Volcano plot", rendered.svg, rendered.data));
  }

  if (plots.pca) {
    if (plotData.pca?.length) {
      const rendered = scatterSvg({
        rows: plotData.pca,
        title: `PCA plot (PC1 ${Number(plotData.pca[0].PC1_percent).toFixed(1)}%, PC2 ${Number(plotData.pca[0].PC2_percent).toFixed(1)}%)`,
        xLabel: "PC1",
        yLabel: "PC2",
        xValue: (row) => number(row.PC1),
        yValue: (row) => number(row.PC2)
      });
      container.append(card("PCA plot", rendered.svg, rendered.data));
    } else {
      container.append(messageCard("PCA plot", "PCA was selected, but no PCA data was produced. Check the analysis log."));
    }
  }

  if (plots.sampleCorrelation) {
    if (plotData.sampleCorrelation?.length) {
      const rendered = matrixSvg(plotData.sampleCorrelation, "Sample correlation heatmap");
      container.append(card("Sample correlation heatmap", rendered.svg, rendered.data));
    } else {
      container.append(messageCard("Sample correlation heatmap", "No correlation matrix was produced. Check the analysis log."));
    }
  }

  if (plots.sampleDistance) {
    if (plotData.sampleDistance?.length) {
      const rendered = matrixSvg(plotData.sampleDistance, "Sample distance heatmap");
      container.append(card("Sample distance heatmap", rendered.svg, rendered.data));
    } else {
      container.append(messageCard("Sample distance heatmap", "No distance matrix was produced. Check the analysis log."));
    }
  }

  if (plots.dispersion) {
    if (plotData.dispersion?.length) {
      const rendered = scatterSvg({
        rows: plotData.dispersion,
        title: "Dispersion plot",
        xLabel: "log10(mean + 1)",
        yLabel: "dispersion",
        xValue: (row) => {
          const mean = number(row.mean);
          return mean == null ? null : Math.log10(mean + 1);
        },
        yValue: (row) => number(row.dispersion)
      });
      container.append(card("Dispersion plot", rendered.svg, rendered.data));
    } else {
      container.append(messageCard("Dispersion plot", "No dispersion data was produced. Check the analysis log."));
    }
  }

  if (plots.sizeFactor && sizeFactors?.length) {
    const rendered = scatterSvg({
      rows: sizeFactors.map((row, index) => ({
        ...row,
        sample: row.sample,
        group: row.group,
        direction: row.group,
        index
      })),
      title: "Size-factor plot",
      xLabel: "sample index",
      yLabel: "size factor",
      xValue: (row) => row.index + 1,
      yValue: (row) => number(row.size_factor)
    });
    container.append(card("Size-factor plot", rendered.svg, rendered.data));
  }

  if (plots.normalizedCountBoxplot) {
    if (normalizedBoxplot?.length) {
      const rendered = boxplotSvg(normalizedBoxplot);
      container.append(card("DESeq2-normalized count boxplot", rendered.svg, rendered.data));
    } else {
      container.append(messageCard("DESeq2-normalized count boxplot", "No DESeq2-normalized count data was available."));
    }
  }
}
