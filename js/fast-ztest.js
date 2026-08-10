import { classifyDirection } from "./utils.js";

function sampleId(sample) {
  return sample.sample_id || sample.SRA || sample.sample || sample.id;
}

export function errorFunction(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return sign * y;
}

export function calculateLibrarySizes(sampleIds, vectorsMap) {
  const librarySizes = {};

  for (const id of sampleIds) {
    const vector = vectorsMap.get(id) || [];
    let sum = 0;
    for (let index = 0; index < vector.length; index += 1) {
      sum += vector[index];
    }
    librarySizes[id] = sum;
  }

  return librarySizes;
}

function adjustPValuesBenjaminiHochberg(rows) {
  const validTests = rows.filter((row) => row.direction !== "Filtered / NA");
  const totalTests = validTests.length;

  if (totalTests === 0) {
    return totalTests;
  }

  const sortedList = validTests.map((row) => ({ row }));
  sortedList.sort((a, b) => a.row.pvalue - b.row.pvalue);

  let minFdr = 1.0;
  for (let index = totalTests - 1; index >= 0; index -= 1) {
    const rank = index + 1;
    const fdrValue = (sortedList[index].row.pvalue * totalTests) / rank;
    minFdr = Math.min(minFdr, fdrValue);
    sortedList[index].row.padj = Math.max(sortedList[index].row.pvalue, minFdr);
  }

  return totalTests;
}

export function runPairwiseZTest({
  geneNames,
  vectorsMap,
  numeratorSamples,
  denominatorSamples,
  parameters,
  inputGeneCount = geneNames.length
}) {
  const allSamples = [...denominatorSamples, ...numeratorSamples];
  const sampleIds = allSamples.map(sampleId);

  if (geneNames.length === 0 || sampleIds.length === 0) {
    throw new Error("No data matrix records allocated inside browser context.");
  }

  const numSamples = sampleIds.length;
  const librarySizes = calculateLibrarySizes(sampleIds, vectorsMap);
  const totalLibSum = Object.values(librarySizes).reduce((a, b) => a + b, 0);
  const avgLibSize = totalLibSum / numSamples || 1;
  const priorCount = 2.0;
  const results = [];
  let genesAfterPrefiltering = 0;

  for (let geneIndex = 0; geneIndex < geneNames.length; geneIndex += 1) {
    const gene = geneNames[geneIndex];
    let geneTotalCount = 0;

    for (const id of sampleIds) {
      geneTotalCount += vectorsMap.get(id)?.[geneIndex] || 0;
    }

    if (geneTotalCount < parameters.minimumCount) {
      results.push({
        gene_id: gene,
        baseMean: geneTotalCount / numSamples,
        log2FoldChange: NaN,
        lfcSE: NaN,
        stat: NaN,
        pvalue: NaN,
        padj: NaN,
        direction: "Filtered / NA",
        significant: "no",
        prefilter_pass: false
      });
      continue;
    }

    genesAfterPrefiltering += 1;

    const log2CpmMap = {};
    for (const id of sampleIds) {
      const count = vectorsMap.get(id)?.[geneIndex] || 0;
      const librarySize = librarySizes[id] || 1;
      const adjustedPrior = priorCount * (librarySize / avgLibSize);
      log2CpmMap[id] = Math.log2(
        ((count + adjustedPrior) / (librarySize + 2 * adjustedPrior)) * 1000000
      );
    }

    const calcStats = (samples) => {
      const values = samples.map((sample) => log2CpmMap[sampleId(sample)] || 0);
      const n = values.length;
      const mean = values.reduce((a, b) => a + b, 0) / n;
      let variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
      if (Number.isNaN(variance) || variance < 0.01) {
        variance = 0.01;
      }
      return { mean, var: variance, n };
    };

    const denominator = calcStats(denominatorSamples);
    const numerator = calcStats(numeratorSamples);
    const log2FoldChange = numerator.mean - denominator.mean;
    const bottomValue = (denominator.var / denominator.n) + (numerator.var / numerator.n);
    const safeBottom = Number.isNaN(bottomValue) || bottomValue < 1e-5 ? 1e-5 : bottomValue;
    const zStat = log2FoldChange / Math.sqrt(safeBottom);
    let rawP = 1 - errorFunction(Math.abs(zStat) / Math.sqrt(2));
    if (Number.isNaN(rawP)) {
      rawP = 1.0;
    }

    results.push({
      gene_id: gene,
      baseMean: geneTotalCount / numSamples,
      log2FoldChange,
      lfcSE: Math.sqrt(safeBottom),
      stat: zStat,
      pvalue: rawP,
      padj: rawP,
      direction: "NS",
      significant: "no",
      prefilter_pass: true
    });
  }

  const totalTests = adjustPValuesBenjaminiHochberg(results);

  for (const row of results) {
    const direction = classifyDirection(
      row,
      parameters.fdrThreshold,
      parameters.log2FoldChangeThreshold
    );
    row.direction = direction;
    row.significant = direction === "Up" || direction === "Down" ? "yes" : "no";
  }

  return {
    resultRows: results,
    summary: {
      input_genes: inputGeneCount,
      genes_after_prefiltering: genesAfterPrefiltering,
      tested_genes: totalTests
    }
  };
}
