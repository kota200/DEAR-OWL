# DEG on Web raw-dataset variant

This directory is a second static web app that keeps the original app folder
untouched. It includes its own webR and DESeq2 library image, so it can run
without the original `deseq` folder being deployed.

## External CSV Data Source

The app reads published GExA-style CSV/TSV matrices directly from the RNADB
download directory instead of shipping copied matrices under `deseq2/data`.
`deseq2/js/config.js` sets the shared base path:

```javascript
externalDataBaseUrl: "/RNADB/Download/files/"
```

When `deseq2` is deployed at `https://webpark2116.sakura.ne.jp/deseq2/`, that
absolute URL points to server files under `~/www/RNADB/Download/files`.

Browsers cannot list arbitrary server directories, so `config/datasets.json`
still acts as the static catalog. The catalog now stores the dataset metadata
and the count, TPM, gene-length, and annotation file names; it does not point to
`samples.json`, `genes.json`, or generated sample-vector files.

Expected file names are:

```text
Foxtail_millet_count_data.csv.gz
Foxtail_millet_TPM_data.csv.gz
Foxtail_millet_gene_length.tsv
Foxtail_millet_annotation.tsv
Pearl_millet_count_data_cv_Tift.csv.gz
Pearl_millet_TPM_data_cv_Tift.csv.gz
Pearl_millet_gene_length_cv_Tift.tsv
Pearl_millet_annotation_cv_Tift.tsv
```

The catalog uses gzip-compressed count and TPM CSV files by default. If a
configured `.csv.gz` count or TPM file is not found, the app automatically
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

## Add Or Update A Dataset

Add the source CSV/TSV files to `~/www/RNADB/Download/files`, then add one
entry to `deseq2/config/datasets.json`. The count file is required; TPM and
annotation files are optional fallback/enrichment files. `geneLengthFile` is
recommended so TPM can be calculated without reading the large TPM matrix.

```json
{
  "id": "pearl_millet__tift",
  "label": "Pearl millet - Tift",
  "species": "Pearl millet",
  "reference": "Tift",
  "dataVersion": "raw",
  "description": "GExA raw count, TPM, and annotation data.",
  "format": "direct_matrix",
  "countFile": "Pearl_millet_count_data_cv_Tift.csv.gz",
  "tpmFile": "Pearl_millet_TPM_data_cv_Tift.csv.gz",
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

Use `referenceDisplay` to control the Reference genome text shown in Step 1;
new species can define it without changing the app JavaScript.

Use `null` for URL templates unless the real gene-page URL pattern has been
confirmed. Gene IDs are passed through `encodeURIComponent()` before links are
created.

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

## Performance note

Raw CSV mode is easier to maintain because the deployed app no longer carries
duplicated matrix files or generated helper JSON. Selecting a dataset streams
the count CSV header and sample metadata columns to build the sample table
without retaining count values. When analysis starts, sample-row count matrices
are streamed again and only the selected rows are materialized in JavaScript.
After DESeq2 finishes, TPM is calculated from the selected count rows and the
small `geneLengthFile` table. The TPM CSV is streamed only if the gene-length
table is unavailable or invalid.

This CSV-only path uses less persistent browser memory than loading whole
matrices into JavaScript strings, but it is slower than a generated
sample-vector layout because the browser may still need to scan the count CSV
to find selected rows.

The only fitting-time gene filter is the visible low-expression rule configured
in the UI. All input genes remain in the result table; genes excluded from model
fitting are marked `prefilter_pass = FALSE`.

Large analyses can use the PostMessage webR channel in compatibility mode.
Binary matrix transfer keeps the working set smaller for this channel, while
avoiding repeated webR 0.6.0 `SharedArrayBuffer` worker exceptions seen in some
browsers. COOP/COEP headers remain useful for normal auto-selected
SharedArrayBuffer runs but are not required by the compatibility path.

With the SharedArrayBuffer channel, an uncompressed R library image is mounted
from its same-origin URL by `webr::mount()` inside the R worker. This avoids
both server-dependent double gzip decoding and sending the 29 MB expanded
package image through the JavaScript/webR communication bridge. The existing
JavaScript `WORKERFS` mounting is used by the PostMessage compatibility channel;
it checks the gzip magic bytes before decompressing, so it also accepts a
response that the server already decoded.

For large PostMessage compatibility runs, JavaScript executes nine R stages:
matrix loading, DESeqDataSet creation, size-factor estimation, dispersion
estimation, Wald or LRT model fitting, result generation, optional plots, and finalization.
Each full stage is written to webR's temporary filesystem. JavaScript submits a
short `evalRVoid()` wrapper that parses the stage file, while the stage status
returns through another temporary file. The wrapper records `WRAPPER_STARTED`
and `STAGE_PARSED` before executing a stage. The matrix loader adds markers for
state lookup, stage logging, gene-ID loading, binary-count loading, and matrix
construction, so a worker-side failure can be located without relying on an R
exception message. Staged logs intentionally omit formatted wall-clock
timestamps because webR 0.6.0 can fail in WebAssembly string conversion while
formatting browser time values. Large R source strings and R return objects do
not cross the JavaScript/webR bridge.
The activity list records total and per-stage elapsed time, so the current
DESeq2 operation remains visible throughout the run.
Large runs skip R-side normalized
count CSV generation because the same all-gene outputs are restored once in
JavaScript after the model succeeds.
This avoids holding the full DESeq2 calculation inside webR 0.6.0's
`evalRBoolean()` request wrapper, which can return an empty `WebRWorkerError`
before the script starts. The R model is released when the job finishes, and
all-gene normalized counts are generated in JavaScript.

For these large runs, selected sample vectors are converted directly to a
validated Int32 matrix without first building the full 30,123-gene count CSV.
The low-expression filter and selected 3,000/5,000/8,000-gene cap are applied
in JavaScript before webR starts. Counts are transferred as a little-endian
Int32 binary file and read with `readBin()`; gene IDs are transferred as UTF-8
lines and read with `readLines()`. Only the six sample names and groups remain
as short R literals. Large runs therefore avoid both R's CSV parser and a large
parsed R expression. All-gene normalized counts and result-table restoration
are performed in JavaScript after the DESeq2 model succeeds.

## Size-factor note

The default size-factor estimation is DESeq2's standard `ratio` method. It
needs at least one gene with positive counts in every selected sample. Sparse
atlas data can violate that condition, especially as more samples are selected.
If size-factor estimation fails, try `poscounts`.

## Cook's cutoff note

The default Cook's cutoff setting is `TRUE`. Cook's-distance handling can add
substantial work in webR/WebAssembly and may slow large analyses. On slower or
memory-limited systems, users should consider setting it to `FALSE`.
