# DEG on Web

DEG on Web is a static browser application for two-group differential gene
expression analysis of plant RNA-seq count data.

The app can analyze GExA-style public datasets or user-uploaded raw count
matrices. It runs in the browser with webR and DESeq2, so no server-side
analysis API is required.

## Features

- Select public GExA-style RNA-seq datasets from a static catalog.
- Upload a raw count matrix in CSV, TSV, TXT, or gzip format.
- Select control and treatment samples from metadata tables.
- Run DESeq2 in the browser through webR.
- Use an optional high-speed JavaScript screening engine.
- Generate result tables, normalized counts, MA plots, volcano plots, PCA plots,
  and heatmaps.
- Add TPM and homolog annotation columns when configured source files are
  available.
- Download result tables, significant gene lists, plots, and analysis summaries.

## Repository Contents

```text
.
├── index.html              # Main DEG on Web application
├── help.html               # User help page
├── config/                 # Dataset catalog
├── css/                    # Application styles
├── js/                     # Application logic and analysis runners
├── library/                # Browser-side R and DESeq2 library image
├── scripts/                # Dataset and runtime preparation scripts
├── tests/                  # Local validation scripts and fixtures
├── webr/                   # webR runtime files
└── wiki/                   # Project wiki pages in Markdown
```

## Quick Start

Serve the repository root with cross-origin isolation headers. The helper server
used during development is:

```powershell
node .\tests\serve-cross-origin-isolated.mjs 8766 ..
```

Then open:

```text
http://127.0.0.1:8766/DEG-on-Web/
```

If the folder is deployed as `/deseq2/`, open:

```text
https://example.org/deseq2/
```

## Input Data

DESeq2 requires raw integer read counts. TPM values can be shown as expression
context, but they are not used for statistical testing.

The default GExA-style matrix orientation is sample rows:

```text
BioProject,SRA,BioSample,treatment,tissue,stage,cultivar,code,temperature,attributes,gene0001,gene0002
PRJ...,SRR...,SAMN...,control,leaf,...,...,...,...,...,10,20
PRJ...,SRR...,SAMN...,treated,leaf,...,...,...,...,...,40,25
```

The app also supports gene-row count matrices:

```text
gene_id,sample_A,sample_B
gene0001,10,40
gene0002,20,25
```

## Dataset Catalog

Datasets are configured in `config/datasets.json`. Each entry defines metadata
and source file names for counts, gene lengths, TPM fallback data, and optional
annotation.

The production configuration currently expects external count and annotation
files under:

```javascript
externalDataBaseUrl: "/RNADB/Download/files/"
```

Update `js/config.js` if the public data files are hosted at a different path.

## Recommended Analysis Practice

As a rule, DEG analysis should compare samples within the same BioProject.
When sample metadata are unclear, inspect the BioProject, BioSample, and SRA
records. If possible, trace the BioProject accession to the original publication
and confirm treatment, genotype, tissue, developmental stage, replicate
structure, and batch information before analysis.

## Validation

Run JavaScript syntax checks and unit tests with Node.js:

```powershell
Get-ChildItem -LiteralPath .\js -Filter *.js | ForEach-Object { node --check $_.FullName }
node .\tests\unit-tests.mjs
node .\tests\validate-runner-r.mjs
```

The test suite covers delimiter handling, count validation, DEG classification,
normalized-count generation, CSV escaping, URL generation, and direct raw dataset
loading.

## Deployment

Deploy all files in this repository to a static web directory. The `.htaccess`
file is required on Apache-compatible hosting because it sets COOP and COEP
headers for cross-origin isolation.

The webR runtime and DESeq2 library image are included in this repository:

```javascript
baseUrl: "./webr/",
libraryDataUrl: "./library/library.data.gz",
libraryMetadataUrl: "./library/library.js.metadata",
workerLibraryDataUrl: "./library/library-uncompressed.data"
```

## Wiki

Project wiki pages are stored in the `wiki/` directory:

- `wiki/Home.md`
- `wiki/User-Guide.md`
- `wiki/Dataset-Catalog.md`
- `wiki/Deployment.md`
- `wiki/Development.md`

These files can also be copied into the GitHub Wiki if the repository wiki
feature is enabled.

## License

No project-level license has been selected yet. Choose a license with the
project supervisor before public reuse is allowed. Bundled third-party
components, including webR, R packages, and DESeq2, retain their own licenses.

## Acknowledgments

DEG on Web uses webR and Bioconductor DESeq2. Public expression datasets are
intended to be used with appropriate citation of their original BioProject,
BioSample, SRA records, and source publications.
