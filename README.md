DEAR-OWL (Differential Expression Analysis Resource on the Web, Lite) is a browser-based application for differential gene expression analysis of plant RNA-seq count data. This repository contains the source code and supporting files for the application.

## External CSV Data Source

The app reads published CSV/TSV matrices directly from Grass Expression Atals (GExA).
`deseq2/js/config.js` sets the shared base path:

```javascript
externalDataBaseUrl: "/RNADB/Download/files/"
```

Browsers cannot list arbitrary server directories, so `config/datasets.json`
still acts as the static catalog. The catalog now stores the dataset metadata
and the count, TPM, gene-length, and annotation file names; it does not point to
`samples.json`, `genes.json`, or generated sample-vector files.

Expected file names are:

```text
Foxtail_millet_count_data.csv.gz
Foxtail_millet_gene_length.tsv
Foxtail_millet_annotation.tsv
```

The catalog uses gzip-compressed count and TPM CSV files by default. If a
configured `.csv.gz` count file is not found, the app automatically
tries the same URL without `.gz` so an uncompressed `.csv` can be used as a
fallback. The app also accepts `.tsv`, `.tsv.gz`, and `.txt` if a catalog entry
uses those file names. The default orientation is the GExA-style sample-row
matrix:

```text
BioProject,SRA,BioSample,treatment,tissue,stage,cultivar,code,temperature,attributes,gene0001,gene0002
PRJ...,SRR...,SAMN...,control,leaf,...,...,...,...,...,10,20
PRJ...,SRR...,SAMN...,treated,leaf,...,...,...,...,...,40,25
```

Rules:

- First row is the header.
- The first `metadataColumnCount` columns are sample metadata.
- Columns after that are gene IDs.
- Each following row is one sample.
- `sampleIdColumn` identifies the sample ID column, usually `SRA`.
- Count values must be non-negative integers.
- `geneLengthFile` is preferred for TPM enrichment. When it is present and
  valid, TPM is calculated from the selected count vectors as
  `count / Length / sum(count / Length) * 1,000,000`.
- If the gene-length file is missing or invalid, the app falls back to reading
  TPM from the TPM CSV after DESeq2 finishes.
- A fallback TPM CSV must use the same sample IDs and exact same gene order as
  count data.
- Annotation is optional and is loaded only after DESeq2 finishes.
- Headerless annotation tables use `gene_id`, `arabidopsis_homolog`, and
  `rice_homolog` as columns 1-3. No separate `annotation` result column is
  created.

The app also accepts `matrixOrientation: "genes_as_rows"` for simpler
gene-row matrices, but the RNADB catalog is expected to use sample-row files:

```text
gene_id,sample_A,sample_B
gene0001,10,40
gene0002,20,25
```

## Add or update a dataset

Upload the dataset files to the external data directory configured by `externalDataBaseUrl`, and then add a dataset entry to `config/datasets.json`.

The following example registers the Pearl millet Tift dataset:

```json
{
  "id": "pearl_millet__tift",
  "label": "Pearl millet - Tift",
  "species": "Pearl millet",
  "reference": "Tift",
  "dataVersion": "raw",
  "description": "GExA raw count data with gene lengths and annotation.",
  "format": "direct_matrix",
  "countFile": "Pearl_millet_count_data_cv_Tift.csv.gz",
  "geneLengthFile": "Pearl_millet_gene_length_cv_Tift.tsv",
  "annotationFile": "Pearl_millet_annotation_cv_Tift.tsv",
  "matrixOrientation": "samples_as_rows",
  "metadataColumnCount": 10,
  "sampleIdColumn": "SRA",
  "geneCount": 36510,
  "sampleCount": 987,
  "annotationHasHeader": false,
  "annotationColumns": [
    "gene_id",
    "arabidopsis_homolog",
    "rice_homolog"
  ],
  "referenceDisplay": "Tift (Ramu et al. 2023)",
  "gexaGeneUrlTemplate": "https://webpark2116.sakura.ne.jp/RNADB/PM/PM.html?gene={gene}",
  "tgifGeneUrlTemplate": "https://webpark2116.sakura.ne.jp/rlgpr/result.php?geneid={gene}"
}
```

### Dataset entry fields

| Key | Requirement | Description |
|---|---|---|
| `id` | Required | Unique identifier used internally by DEAR-OWL. |
| `label` | Required | Dataset name displayed in the dataset selector. |
| `species` | Recommended | Species name displayed in the dataset information and output files. |
| `reference` | Recommended | Short reference-genome or cultivar identifier. |
| `dataVersion` | Optional | Dataset version or data type, such as `raw`. |
| `description` | Optional | Short description of the dataset. |
| `format` | Required | Input format. Use `direct_matrix` for the matrices described here. |
| `countFile` | Required | Raw integer count matrix used for differential expression analysis. |
| `geneLengthFile` | Recommended | Gene-length table used to calculate TPM directly from raw counts. |
| `tpmFile` | Optional | Precomputed TPM matrix used only as a fallback if TPM calculation from gene lengths fails. |
| `annotationFile` | Optional | Gene annotation table used to add homolog information to the results. |
| `matrixOrientation` | Optional | Matrix layout. The default is `samples_as_rows`. |
| `metadataColumnCount` | Optional | Number of metadata columns before the gene columns. The default is `10`. |
| `sampleIdColumn` | Recommended | Metadata column containing unique sample IDs, usually `SRA`. |
| `geneCount` | Optional | Expected number of genes, used for dataset information. |
| `sampleCount` | Optional | Expected number of samples, used for dataset information and loading progress. |
| `annotationHasHeader` | Conditional | Set to `false` when the annotation file has no header row. The default is `true`. |
| `annotationColumns` | Conditional | Column names and order for a headerless annotation file. |
| `referenceDisplay` | Optional | Full reference-genome text displayed in the app. If omitted, `reference` is used. |
| `gexaGeneUrlTemplate` | Optional | URL template for linking gene IDs to a GExA gene page. Use `{gene}` as the placeholder. |
| `tgifGeneUrlTemplate` | Optional | URL template for linking gene IDs to another gene-information resource. Use `{gene}` as the placeholder. |

### Required and optional files

Only `countFile` is required for differential expression analysis.

- `countFile` is required and must contain raw, non-negative integer counts.
- `geneLengthFile` is optional but recommended. When it is available, DEAR-OWL calculates TPM directly from the raw counts and gene lengths.
- `tpmFile` is optional and is normally unnecessary. It is used only as a fallback when TPM cannot be calculated from gene lengths.
- `annotationFile` is optional and adds homolog information to the result table.

The count matrix must contain one sample per row. The first `metadataColumnCount` columns are sample metadata, including the column specified by `sampleIdColumn`. All remaining columns are gene IDs.

The gene-length table must have a header and include `Geneid` and `Length` columns. Gene lengths must be positive numbers and must be available for every gene in the count matrix.

If `annotationHasHeader` is `false`, the annotation file must follow the column order specified by `annotationColumns`.

File names are case-sensitive and must exactly match the files deployed on the server.

## Deployment

Upload the `deseq2` directory:

```text
public_html/
  deseq2/
    .htaccess
    index.html
    css/
    js/
    config/
    webr/
    library/
```

`deseq2/js/config.js` currently points to local runtime assets:

```javascript
baseUrl: "./webr/",
libraryDataUrl: "./library/library.data.gz",
libraryMetadataUrl: "./library/library.js.metadata",
workerLibraryDataUrl: "./library/library-uncompressed.data"
```

So `/deseq2/` is self-contained for webR and DESeq2. Count, gene-length, TPM
fallback, and annotation tables are loaded separately from
`/RNADB/Download/files/`.

The leading dot in `.htaccess` is required. Make sure the upload tool includes
hidden files. This file sets the COOP and COEP response headers needed for
cross-origin isolation and the SharedArrayBuffer webR channel. After deployment,
the browser console should report `window.crossOriginIsolated === true`.

Upload both `library/library-uncompressed.data` and
`library/library-uncompressed.js.metadata`. The worker deliberately uses this
uncompressed pair because some hosts return `.gz` files with
`Content-Encoding: gzip` or `x-gzip`. Browsers decode that response before webR
sees it, and webR 0.6.0 otherwise attempts a second gzip decode.

## Validation

Run the local checks with the bundled Node used by Codex:

```powershell
python .\deseq2\scripts\prepare_worker_library.py
$node='C:\Users\0314k\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
Get-ChildItem -LiteralPath .\deseq2\js -Filter *.js | ForEach-Object { & $node --check $_.FullName }
& $node .\deseq2\tests\unit-tests.mjs
& $node .\deseq2\tests\validate-runner-r.mjs
& $node .\deseq2\tests\serve-cross-origin-isolated.mjs 8766
```

The unit test covers delimiter handling, count validation helpers, DEG
classification, normalized-count generation, CSV escaping, URL generation,
and both helper-backed and CSV-only direct raw dataset loading.
The runner test asks the local R parser to validate the exact single-call R
program used by both regular and compact large analyses.
