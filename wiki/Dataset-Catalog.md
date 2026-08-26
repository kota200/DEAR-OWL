# Dataset Catalog

Published GExA datasets are registered in `config/datasets.json`. The catalog
contains metadata and external file names; the large data files are not stored
in this repository.

The shared server location is configured in `js/config.js`:

```javascript
externalDataBaseUrl: "/RNADB/Download/files/"
```

In the current deployment, those URLs map to files maintained separately under
the RNADB download directory. Do not create an application `data/` directory or
copy GExA matrices into the DEAR-OWL repository.

## Loading model

The browser cannot list an arbitrary server directory, so the JSON catalog is
loaded first. It is small and supplies the dataset dropdown.

When the app is online, the catalog is requested from the server before using
the cached fallback. After this catalog behavior has been deployed once,
routine dataset additions and metadata changes require updating only the
external data files and `config/datasets.json`; they do not require an app or
Service Worker version change.

When a dataset is selected:

1. Only the selected dataset's compressed count matrix is requested.
2. The response is streamed and retained in browser Cache Storage.
3. The full decompressed matrix is not retained as a JavaScript string; only
   gene order and sample metadata remain in memory.
4. After the user assigns sample groups, the cached response is streamed again
   and only selected sample rows are materialized as count vectors.
5. Repeating the same selection reuses those vectors. Changing the selection
   drops vectors that are no longer needed.

Because the source is one monolithic sample-row `.csv.gz`, the complete
compressed file for the selected dataset must be fetched once. DEAR-OWL does
not fetch every catalog dataset and does not keep multiple selected dataset
matrices in its dedicated cache.

## Catalog entry

A dataset entry can contain:

| Key | Requirement | Description |
|---|---|---|
| `id` | Required | Unique internal identifier. |
| `label` | Required | Text displayed in the dataset selector. |
| `species` | Recommended | Species displayed in dataset information and outputs. |
| `referenceDisplay` | Recommended | Full reference-genome text displayed in Step 1. |
| `format` | Required | Use `direct_matrix` for the external matrices described here. |
| `countFile` | Required | Raw, non-negative integer count matrix. |
| `tpmFile` | Optional | Precomputed TPM fallback matrix. |
| `geneLengthFile` | Recommended | Gene lengths used to calculate TPM from selected counts. |
| `annotationFile` | Optional | Gene annotation/homolog table. |
| `matrixOrientation` | Optional | `samples_as_rows` for current GExA files; `genes_as_rows` is also supported. |
| `metadataColumnCount` | Conditional | Number of metadata columns before gene columns for sample-row matrices. |
| `sampleIdColumn` | Recommended | Unique sample identifier column, normally `SRA`. |
| `geneCount` | Optional | Expected gene count for dataset information/progress. |
| `sampleCount` | Optional | Expected sample count for dataset information/progress. |
| `annotationHasHeader` | Conditional | Set to `false` for a headerless annotation table. |
| `annotationColumns` | Conditional | Column order assigned to a headerless annotation table. |
| `gexaGeneUrlTemplate` | Optional | GExA gene-page URL with `{gene}` placeholder. |
| `tgifGeneUrlTemplate` | Optional | TGIF-DB URL with `{gene}` placeholder. |

Example:

```json
{
  "id": "pearl_millet__tift",
  "label": "Pearl millet - Tift",
  "species": "Pearl millet",
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
  "referenceDisplay": "Tift (Ramu et al. 2023)"
}
```

File names are case-sensitive and must exactly match the external server files.

## Sample-row count format

The current GExA format has one sample per row:

```text
BioProject,SRA,BioSample,treatment,tissue,stage,cultivar,code,temperature,attributes,gene0001,gene0002
PRJ...,SRR...,SAMN...,control,leaf,...,...,...,...,...,10,20
PRJ...,SRR...,SAMN...,treated,leaf,...,...,...,...,...,40,25
```

Rules:

- The first row is the header.
- The first `metadataColumnCount` columns contain sample metadata.
- All following columns are unique gene IDs.
- Every following row represents one sample.
- `sampleIdColumn` must contain unique sample IDs.
- Count values must be non-negative integers.

The loader can also accept `genes_as_rows` matrices when a catalog entry
explicitly configures that orientation.

## Gene length, TPM, and annotation

A gene-length table is preferred because DEAR-OWL can calculate TPM from the
selected counts without loading a large TPM matrix:

```text
TPM = count / Length / sum(count / Length) * 1,000,000
```

The table must have `Geneid` and `Length` columns, with a positive length for
each count-matrix gene. If it is missing or invalid, the configured `tpmFile`
can be used as a fallback.

Annotation is optional. A headerless annotation table may use:

```text
gene_id,arabidopsis_homolog,rice_homolog
```

Set `annotationHasHeader` and `annotationColumns` to match the actual file.

## Add or update a dataset

1. Place the external data files in the server's RNADB download directory.
2. Add or update one entry in `config/datasets.json`.
3. Verify exact file-name case, counts, orientation, metadata column count, and
   sample ID column.
4. Load the hosted app with a fresh cache and confirm the dropdown metadata.
5. Test data loading, group selection, preparation, and both an analysis and a
   repeated analysis from the cached dataset.
