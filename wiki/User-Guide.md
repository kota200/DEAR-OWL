# User Guide

## 1. Open DEAR-OWL

Use the hosted application for GExA datasets, or start the local application
for a count matrix on your computer. See [Local Use and Privacy](Local-Use-and-Privacy.md)
for Windows, macOS, and Linux instructions.

## 2. Select data

Choose one input mode in Step 1.

### GExA dataset

Select a dataset from the catalog. DEAR-OWL downloads only that dataset's
compressed count file; it does not load every species at startup. The Data
loading progress bar covers transfer and metadata scanning.

The compressed response is cached in the browser. Only sample metadata and
gene order are initially retained in memory. After sample groups are selected,
the cached file is scanned and only the selected sample count rows are
materialized.

### Upload count matrix

Select a CSV, TSV, TXT, or gzip-compressed matrix. The first column must contain
gene IDs and the remaining columns must contain raw integer counts for samples.
The file is parsed locally in the browser and is not sent to the application
server.

DESeq2 requires raw counts. Do not upload TPM, FPKM, CPM, or log-transformed
values as the statistical input.

## 3. Wait for analysis preparation

Data loading and Analysis preparation are separate operations. Analysis
preparation stores and verifies the webR/DESeq2 files, initializes the browser R
runtime, and loads the required R packages. The run buttons remain disabled
until it reaches 100%.

When the status reports that analysis is locked to local files, the prepared
runtime will be reused and the DEG calculation will not contact the server.

## 4. Select an analysis design

### Two-group comparison

Assign control and treatment samples. A sample cannot belong to both groups.
At least two samples per group are required; three or more biological
replicates are recommended.

### Multi-group comparison

Create at least three groups and assign samples to them. DESeq2 can report all
configured pairwise contrasts and can optionally run a global likelihood-ratio
test. The fast Z-test reports pairwise screening results but has no global test.

For either design:

- Prefer samples from the same BioProject.
- Match tissue, stage, cultivar, genotype, and experimental conditions.
- Confirm biological replicates rather than treating technical runs as
  independent biological samples.
- Review BioProject, BioSample, SRA, and publication metadata before analysis.

## 5. Set analysis parameters

A reasonable first DESeq2 run uses:

- **Analysis engine:** DESeq2 (standard)
- **FDR threshold:** 0.05
- **Absolute log2 fold-change threshold:** 1
- **Low-expression pre-filtering:** enabled
- **Size-factor estimation:** `ratio`, or `poscounts` for a sparse matrix when
  ratio estimation fails

Low-expression pre-filtering is shared by DESeq2 and the pairwise Z-test. When
enabled, a gene is tested only if the sum of its raw counts across all selected
samples reaches the configured minimum total count. Turning it off disables
that threshold and tests all input genes.

DESeq2 is the standard analysis engine. Pairwise Z-test is intended for fast
screening and should not be presented as equivalent statistical inference.

Cook's cutoff and independent filtering affect DESeq2 results. Parameters
marked DESeq2 only do not affect the fast Z-test.

## 6. Select plots and run

MA and volcano plots are useful for most analyses. PCA, sample correlation, and
sample distance views help inspect sample-level structure but can require more
time and memory for large selections.

The Analysis activity list reports the current browser and R stage. Do not
close the tab or local launcher while a run is active.

## 7. Interpret and download results

Interpret adjusted p-value, log2 fold change, expression level, annotation, and
study design together.

Important two-group columns include:

- `direction`: Up or Down in treatment relative to control.
- `baseMean`: average DESeq2-normalized count.
- `log2FoldChange`: estimated treatment-versus-control change.
- `pvalue`: unadjusted test p-value.
- `padj`: multiple-testing-adjusted p-value used for DEG selection.
- control/treatment TPM summaries: expression context only, not the DESeq2
  statistical input.

In multi-group pairwise results, direction is relative to the numerator group
versus the denominator group. Global LRT rows do not have an Up/Down direction.

Download the result tables and analysis metadata needed to record the dataset,
sample grouping, parameters, engine, and runtime versions. Do not interpret a
DEG list without reviewing the experimental design.
