# Dataset Catalog

Datasets are configured in `config/datasets.json`.

Each dataset entry can define:

- dataset ID and label
- species and reference genome display name
- count matrix file
- gene-length file
- TPM fallback file
- annotation file
- matrix orientation
- metadata column count
- sample ID column
- external gene page URL templates

## Count Matrix Format

The default public dataset format uses sample rows:

```text
BioProject,SRA,BioSample,treatment,tissue,stage,cultivar,code,temperature,attributes,gene0001,gene0002
PRJ...,SRR...,SAMN...,control,leaf,...,...,...,...,...,10,20
PRJ...,SRR...,SAMN...,treated,leaf,...,...,...,...,...,40,25
```

Rules:

- The first row is the header.
- Metadata columns come first.
- Gene count columns follow metadata columns.
- Count values must be non-negative integers.
- Sample IDs should be unique.
- Gene IDs should be unique.

## Annotation

Annotation is optional. Headerless annotation tables can use:

```text
gene_id,arabidopsis_homolog,rice_homolog
```

## TPM

If a valid gene-length file is available, TPM is calculated from selected count
vectors. If not, the app can use the configured TPM fallback file.
