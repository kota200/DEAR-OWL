# User Guide

## 1. Select Data

Choose a GExA dataset or upload a raw count matrix.

DESeq2 requires raw integer counts. TPM values are useful for expression
context, but they are not used for statistical testing.

## 2. Select Samples

Select control and treatment samples.

Recommended practice:

- Compare samples within the same BioProject.
- Match tissue, stage, cultivar, and genotype when possible.
- Use at least two samples per group.
- Use three or more biological replicates when possible.
- Do not place the same sample in both groups.

If sample metadata are unclear, inspect the BioProject, BioSample, and SRA
records. If possible, trace the BioProject accession to the original
publication.

## 3. Set Analysis Parameters

Recommended first run:

- Analysis engine: `R / DESeq2 (standard)`
- FDR threshold: `0.05`
- Absolute log2 fold change threshold: `1`
- Low-expression pre-filtering: enabled
- Size-factor estimation: `poscounts` for sparse public datasets

Use the JavaScript screening engine only for rapid exploration.

## 4. Select Plots

MA and volcano plots are useful for most analyses. PCA and heatmaps help check
sample-level structure, but they may be slower for large datasets.

## 5. Interpret Results

Use adjusted p-value, log2 fold change, expression level, annotation, and study
design together.

Important columns:

- `direction`: Up or Down relative to treatment versus control.
- `baseMean`: average normalized count.
- `log2FoldChange`: estimated expression change.
- `pvalue`: raw test p-value.
- `padj`: adjusted p-value for DEG selection.
- `TPM`: expression context only.

Do not interpret DEG lists without checking sample design.
