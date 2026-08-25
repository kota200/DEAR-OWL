# DEAR-OWL

<p align="center">
  <img src="./dear-owl.png" alt="DEAR-OWL owl mark" width="220">
</p>

**DEAR-OWL (Differential Expression Analysis Resource on the Web, Lite)** is a
browser-based application for differential gene expression analysis of plant
RNA-seq count data. It can be used in two ways:

- as the hosted GExA-connected web application; or
- as a locally runnable application for a count matrix on the user's computer.

In both modes, the statistical computation runs inside the browser through
webR. An uploaded count matrix is parsed locally and is never uploaded to an
application server. After the input files and analysis runtime are ready,
DEAR-OWL locks analysis requests to browser-local files so the DEG calculation
does not communicate with the server.

## The three promises of DEAR-OWL

1. **Your uploaded data is not sent to the server.** A user-supplied count
   matrix is read and parsed inside the browser.
2. **Analysis runs without communication after preparation.** When data and the
   analysis environment are ready, a network lock restricts the DEG run to
   cached or local files.
3. **DEAR-OWL runs locally.** The same application can be launched on Windows,
   macOS, and Linux for private analysis of a count matrix on that computer.

GExA mode necessarily communicates before analysis to obtain the dataset
selected by the user. It does not load the entire catalog, and the subsequent
DEG calculation is still performed under the network lock.

## Use DEAR-OWL

### Hosted application

Open [DEAR-OWL](https://webpark2116.sakura.ne.jp/deseq2/) to use a published
GExA dataset or upload a count matrix.

### Local application

Download or clone the complete repository, including `webr/` and `library/`,
then use the launcher for your operating system:

- **Windows:** double-click `start-local.cmd`. No Python or Node.js installation
  is required.
- **macOS or Linux:** open a terminal in the repository directory and run
  `sh start-local.sh`. The launcher uses Python 3 when available and otherwise
  uses Node.js.
- **macOS Finder:** run `chmod +x start-local.command` once, then double-click
  `start-local.command`.

The launcher opens `http://127.0.0.1:8766/?mode=upload`. Keep its window or
terminal open while using DEAR-OWL; press Ctrl+C or close the window to stop it.
The server binds only to the loopback address, so it is available only on the
same computer.

Do not open `index.html` directly with a `file://` URL. Modern browsers do not
allow the JavaScript modules, module workers, WebAssembly, and Service Worker
used by webR to operate correctly from `file://`. The local launcher supplies
these browser requirements without publishing the app or the count matrix to a
remote server.

Local launch is intended for **Upload count matrix** analysis. GExA datasets
remain outside this repository under `/RNADB/Download/files/`, so use the
hosted application when those server datasets are needed.

## Data and network behavior

| Input mode | Data acquisition | Data retained in memory | DEG analysis |
|---|---|---|---|
| Uploaded count matrix | The browser reads the user-selected file directly. It is not uploaded. | The current count matrix and selected samples. | Runs in the browser with network access locked to cached/local files. |
| GExA dataset | The hosted app fetches only the dataset selected in Step 1 from `/RNADB/Download/files/`. | Sample metadata and gene order first; selected sample count vectors are materialized later. | Runs in the browser with network access locked after preparation. |

DEAR-OWL does **not** download every GExA dataset at startup. A catalog in
`config/datasets.json` supplies lightweight dataset metadata. When a user
chooses one entry, the app streams that dataset's compressed count matrix and
stores the compressed response in browser Cache Storage. Because the current
GExA format places all samples in one `.csv.gz`, the selected dataset file must
be transferred once; the decompressed full matrix is not retained as a large
JavaScript string. After group selection, the cached file is streamed again
and only the chosen sample rows are converted to count vectors.

The interface reports this as two separate stages:

1. **Data loading** — transfer and metadata scan for the selected input.
2. **Analysis preparation** — cache verification and webR/DESeq2 startup.

The run buttons are enabled only when preparation is complete. The ready webR
runtime is reused for analysis instead of being initialized a second time.
Only the latest selected GExA dataset is retained in the dedicated data cache.

"No communication during analysis" refers to the DEG calculation after these
preparation stages. A hosted GExA dataset must first be downloaded, and a
browser with an empty cache must first load the bundled webR/DESeq2 assets.

## Supported analyses

- Two-group control-versus-treatment comparison.
- One-factor multi-group comparison with three or more groups.
- DESeq2 standard analysis in webR.
- Pairwise Z-test for fast screening.
- Optional global likelihood-ratio test for multi-group DESeq2 analysis.
- MA and volcano plots, with optional PCA, correlation, and distance plots.
- Downloadable result tables and analysis metadata.

DESeq2 requires raw, non-negative integer counts. TPM values may be added for
expression context, but they are not used for statistical testing.

## Uploaded count matrix format

The app accepts CSV, TSV, TXT, and gzip-compressed files with genes as rows:

```text
gene_id,control_1,control_2,treatment_1,treatment_2
gene0001,10,12,40,38
gene0002,20,18,25,29
```

Requirements:

- The first row is a header.
- The first column contains unique, non-empty gene IDs.
- Every remaining column represents one sample and has a unique name.
- Counts are non-negative integers within the R integer range.
- At least two sample columns are required.

## GExA data deployment

GExA matrices are deliberately not stored in this repository. The shared data
location is configured in `js/config.js`:

```javascript
externalDataBaseUrl: "/RNADB/Download/files/"
```

`config/datasets.json` is the catalog of file names and dataset metadata.
Count, TPM fallback, gene-length, and annotation files stay in the server's
separate RNADB directory. There is no application `data/` directory.

For the current sample-row GExA format, metadata columns precede gene columns:

```text
BioProject,SRA,BioSample,treatment,tissue,stage,cultivar,code,temperature,attributes,gene0001,gene0002
PRJ...,SRR...,SAMN...,control,leaf,...,...,...,...,...,10,20
PRJ...,SRR...,SAMN...,treated,leaf,...,...,...,...,...,40,25
```

See [Dataset Catalog](wiki/Dataset-Catalog.md) before adding or changing a
dataset.

## Browser storage and privacy

- Uploaded matrices remain in browser memory and are not sent to a remote
  application server.
- Runtime and selected GExA files are stored in browser Cache Storage so they
  can be reused during analysis.
- DEAR-OWL requests persistent browser storage when supported. If it is denied,
  the cache remains usable but the browser may evict it later.
- If a required asset is missing or storage quota is exhausted, analysis stays
  disabled instead of silently reverting to network access.
- Clearing site data removes the cached runtime and GExA dataset.

Current Chrome or Edge is recommended. Large datasets can require substantial
memory and preparation time; closing unrelated tabs and selecting only needed
samples can help on memory-limited systems.

## Repository layout

```text
.
|-- index.html                 Main application
|-- help.html                  In-app manual
|-- start-local.cmd            Windows local launcher
|-- start-local.sh             macOS/Linux local launcher
|-- start-local.command        Optional macOS Finder launcher
|-- sw.js                      Offline/cache and analysis network lock
|-- config/datasets.json       GExA dataset catalog
|-- css/                       Styles
|-- js/                        UI, data loading, storage, and analysis code
|-- scripts/                   Loopback-only local servers
|-- tests/                     Automated and browser checks
|-- webr/                      Bundled webR runtime
|-- library/                   Bundled DESeq2 R library image
`-- wiki/                      Detailed documentation
```

## Documentation

- [Wiki home](wiki/Home.md)
- [User guide](wiki/User-Guide.md)
- [Local use and privacy](wiki/Local-Use-and-Privacy.md)
- [Dataset catalog](wiki/Dataset-Catalog.md)
- [Deployment](wiki/Deployment.md)
- [Development and validation](wiki/Development.md)

## Deployment summary

Deploy the complete repository to the web directory. On Apache-compatible
hosting, include the hidden `.htaccess` file; it supplies the COOP/COEP/CORP
headers used by webR. Keep `webr/`, `library/`, and `sw.js` in the deployment.
The external GExA files remain separately under `/RNADB/Download/files/`.

See [Deployment](wiki/Deployment.md) for the complete checklist.

## Validation

With Node.js available:

```sh
node tests/unit-tests.mjs
node tests/offline-service-worker-tests.mjs
node tests/validate-staged-r.mjs
node tests/validate-runner-r.mjs
```

`validate-runner-r.mjs` uses a local R installation when available. See
[Development and validation](wiki/Development.md) for syntax checks, browser
checks, and the release checklist.

## Citation
DEAR-OWL: a fully browser-based hybrid resource for instant or precise differential gene expression analysis

Kota Kambara, Sintho Wahyuning Ardie, Daisuke Tsugama

bioRxiv 2026.07.28.741369; doi: https://doi.org/10.64898/2026.07.28.741369
