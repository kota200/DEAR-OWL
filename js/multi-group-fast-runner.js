import { runPairwiseZTest } from "./fast-ztest.js?v=20260810-shared-prefilter";
import { buildDirectionMatrix } from "./intersections.js";

export function runMultiGroupFastAnalysis({
  geneNames,
  vectorsMap,
  groups,
  contrasts,
  parameters,
  inputGeneCount = geneNames.length
}) {
  const startedAt = performance.now();
  const byGroupId = new Map(groups.map((group) => [group.id, group]));
  const contrastResults = [];

  for (const contrast of contrasts) {
    const numerator = byGroupId.get(contrast.numeratorId);
    const denominator = byGroupId.get(contrast.denominatorId);

    if (!numerator || !denominator) {
      throw new Error(`Contrast ${contrast.label} refers to a missing group.`);
    }

    const result = runPairwiseZTest({
      geneNames,
      vectorsMap,
      numeratorSamples: numerator.samples,
      denominatorSamples: denominator.samples,
      parameters,
      inputGeneCount
    });

    contrastResults.push({
      ...contrast,
      rows: result.resultRows,
      summary: {
        ...result.summary,
        numerator_samples: numerator.samples.length,
        denominator_samples: denominator.samples.length
      }
    });
  }

  return {
    mode: "multi_group",
    engine: "javascript",
    groups,
    contrasts: contrastResults,
    globalResult: null,
    directionMatrix: buildDirectionMatrix(contrastResults),
    groupSummaries: groups.map((group) => ({
      id: group.id,
      label: group.label,
      samples: group.samples.length
    })),
    normalizedCsv: "",
    normalizedBoxplot: null,
    plotData: {},
    sizeFactors: null,
    runtimeSummary: { channelType: "Native JavaScript Z-test" },
    summary: {
      input_genes: inputGeneCount,
      contrast_count: contrastResults.length,
      execution_time_seconds: (performance.now() - startedAt) / 1000
    },
    analysisLog: [
      "[JS FAST ENGINE REPORT]",
      "Ultrafast pairwise Z-test completed.",
      `Contrasts: ${contrastResults.length}`,
      parameters.preFiltering
        ? `Pre-filtering: minimum total count ${parameters.minimumCount} applied.`
        : "Pre-filtering: disabled; all input genes tested.",
      "Benjamini-Hochberg FDR adjustment is applied separately within each pairwise comparison.",
      "No global/omnibus test is performed by the ultrafast engine."
    ].join("\n")
  };
}
