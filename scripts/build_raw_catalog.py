#!/usr/bin/env python3
"""Build deseq2/config/datasets.json from folders under deseq2/data/raw.

This keeps the hosted app static while removing hand-edited central JSON from
the normal workflow. Put each dataset in data/raw/<dataset_id>/ and run this
script before uploading the deseq2 directory.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import re
from pathlib import Path
from typing import Iterable


COUNT_PATTERNS = (
    "count.csv",
    "counts.csv",
    "count.tsv",
    "counts.tsv",
    "count.txt",
    "counts.txt",
)
TPM_PATTERNS = (
    "tpm.csv",
    "tpms.csv",
    "tpm.tsv",
    "tpms.tsv",
    "tpm.txt",
    "tpms.txt",
)
ANNOTATION_PATTERNS = (
    "annotation.tsv",
    "annotations.tsv",
    "annotation.csv",
    "annotations.csv",
    "annotation.txt",
    "annotations.txt",
    "annot.tsv",
    "annot.csv",
)
SAMPLE_ID_HEADERS = (
    "SRA",
    "Run",
    "Run accession",
    "run_accession",
    "sample_id",
    "Sample ID",
    "Sample",
    "sample",
    "SRR",
)


def parse_args() -> argparse.Namespace:
    script_dir = Path(__file__).resolve().parent
    app_root = script_dir.parent
    parser = argparse.ArgumentParser(
        description="Generate config/datasets.json from data/raw dataset folders."
    )
    parser.add_argument(
        "--dataset",
        action="append",
        dest="dataset_ids",
        help="Rebuild only this dataset ID and preserve other catalog entries (repeatable).",
    )
    parser.add_argument("--app-root", type=Path, default=app_root, help=argparse.SUPPRESS)
    return parser.parse_args()


def humanize_id(value: str) -> str:
    text = re.sub(r"[_-]+", " ", value).strip()
    return text[:1].upper() + text[1:] if text else value


def infer_names(folder_name: str) -> tuple[str, str, str]:
    if "__" in folder_name:
        species_part, reference_part = folder_name.split("__", 1)
        species = humanize_id(species_part)
        reference = humanize_id(reference_part)
        return f"{species} - {reference}", species, reference

    label = humanize_id(folder_name)
    return label, label, "raw"


def url_for(app_root: Path, file_path: Path) -> str:
    rel = file_path.relative_to(app_root).as_posix()
    return f"./{rel}"


def write_json_atomic(file_path: Path, payload) -> None:
    tmp_file = file_path.with_suffix(file_path.suffix + ".tmp")
    with tmp_file.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    tmp_file.replace(file_path)


def normalize_headers(headers: list[str], fallback_prefix: str) -> list[str]:
    used: dict[str, int] = {}
    normalized = []
    for index, header in enumerate(headers):
        base = str(header or f"{fallback_prefix}_{index + 1}").strip() or f"{fallback_prefix}_{index + 1}"
        count = used.get(base, 0)
        used[base] = count + 1
        normalized.append(base if count == 0 else f"{base}_{count + 1}")
    return normalized


def is_supported_table(file_path: Path) -> bool:
    suffixes = [suffix.lower() for suffix in file_path.suffixes]
    if suffixes and suffixes[-1] == ".gz":
        suffixes = suffixes[:-1]
    return bool(suffixes) and suffixes[-1] in {".csv", ".tsv", ".txt"}


def base_name(file_path: Path) -> str:
    name = file_path.name.lower()
    return name[:-3] if name.endswith(".gz") else name


def prefer_compressed_key(file_path: Path) -> tuple[int, str]:
    return (0 if file_path.name.lower().endswith(".gz") else 1, file_path.name.lower())


def find_file(folder: Path, exact_names: Iterable[str], contains: Iterable[str]) -> Path | None:
    files = [file_path for file_path in folder.iterdir() if file_path.is_file() and is_supported_table(file_path)]

    for name in exact_names:
        matches = [file_path for file_path in files if base_name(file_path) == name]
        if matches:
            return sorted(matches, key=prefer_compressed_key)[0]

    scored: list[tuple[int, int, str, Path]] = []
    for file_path in files:
        name = base_name(file_path)
        if any(token in name for token in contains):
            score = 0
            if name.startswith(tuple(contains)):
                score -= 2
            if "data" in name:
                score -= 1
            compressed_score = 0 if file_path.name.lower().endswith(".gz") else 1
            scored.append((score, compressed_score, name, file_path))

    return sorted(scored)[0][3] if scored else None


def open_text(file_path: Path):
    if file_path.name.lower().endswith(".gz"):
        return gzip.open(file_path, "rt", encoding="utf-8-sig", newline="")
    return file_path.open("r", encoding="utf-8-sig", newline="")


def delimiter_for(file_path: Path, first_line: str) -> str:
    name = base_name(file_path)
    if name.endswith(".tsv") or name.endswith(".txt"):
        return "\t"
    return "\t" if first_line.count("\t") > first_line.count(",") else ","


def read_preview(file_path: Path, limit: int = 30) -> tuple[list[str], list[list[str]], str]:
    with open_text(file_path) as handle:
        first_line = handle.readline()
        if not first_line:
            raise ValueError(f"{file_path} is empty")
        delimiter = delimiter_for(file_path, first_line)
        handle.seek(0)
        reader = csv.reader(handle, delimiter=delimiter)
        header = next(reader)
        rows = []
        for row in reader:
            if any(value != "" for value in row):
                rows.append(row)
            if len(rows) >= limit:
                break
    return header, rows, delimiter


def count_data_rows(file_path: Path, delimiter: str) -> int:
    count = 0
    with open_text(file_path) as handle:
        reader = csv.reader(handle, delimiter=delimiter)
        next(reader, None)
        for row in reader:
            if any(value != "" for value in row):
                count += 1
    return count


def is_integer_token(value: str) -> bool:
    text = str(value).strip()
    if text == "":
        return False
    try:
        number = float(text)
    except ValueError:
        return False
    return number >= 0 and number.is_integer()


def column_is_count_like(rows: list[list[str]], column_index: int) -> bool:
    values = []
    for row in rows:
        if column_index >= len(row):
            return False
        values.append(row[column_index])
    return bool(values) and all(is_integer_token(value) for value in values)


def infer_orientation(header: list[str], rows: list[list[str]]) -> str:
    first = header[0].strip().lower() if header else ""
    if first in {"gene_id", "gene", "gene id", "id"} and all(
        column_is_count_like(rows, index) for index in range(1, len(header))
    ):
        return "genes_as_rows"
    return "samples_as_rows"


def infer_metadata_column_count(header: list[str], rows: list[list[str]]) -> int:
    for index in range(1, len(header)):
        if all(column_is_count_like(rows, column_index) for column_index in range(index, len(header))):
            return index
    raise ValueError(
        "Could not infer metadataColumnCount. Add dataset.json with metadataColumnCount."
    )


def infer_sample_id_column(headers: list[str], rows: list[list[str]]) -> str:
    lower_to_header = {header.strip().lower(): header.strip() for header in headers}
    for name in SAMPLE_ID_HEADERS:
        if name.lower() in lower_to_header:
            return lower_to_header[name.lower()]

    for column_index, header in enumerate(headers):
        values = [
            row[column_index].strip()
            for row in rows
            if column_index < len(row) and row[column_index].strip()
        ]
        if values and len(values) == len(set(values)):
            return header.strip()

    raise ValueError("Could not infer sampleIdColumn. Add dataset.json with sampleIdColumn.")


def extract_sample_row_index(
    file_path: Path,
    delimiter: str,
    metadata_count: int,
    sample_id_column: str,
) -> tuple[list[dict], list[str]]:
    samples: list[dict] = []

    with open_text(file_path) as handle:
        reader = csv.reader(handle, delimiter=delimiter)
        header = next(reader)
        metadata_headers = normalize_headers(header[:metadata_count], "metadata")
        genes = [gene.strip() for gene in header[metadata_count:]]

        raw_sample_id_index = header[:metadata_count].index(sample_id_column)

        for row_number, row in enumerate(reader, start=2):
            if not any(value != "" for value in row):
                continue

            if len(row) < metadata_count:
                raise ValueError(
                    f"{file_path} row {row_number} has {len(row)} columns; "
                    f"expected at least {metadata_count}"
                )

            sample = {
                metadata_headers[index]: row[index]
                for index in range(metadata_count)
            }
            sample_id = row[raw_sample_id_index].strip()
            if not sample_id:
                raise ValueError(f"{file_path} row {row_number} has an empty sample ID")

            sample["sample_id"] = sample_id
            if not sample.get("SRA"):
                sample["SRA"] = sample_id
            samples.append(sample)

    return samples, genes


def extract_gene_row_index(file_path: Path, delimiter: str) -> tuple[list[dict], list[str]]:
    genes: list[str] = []

    with open_text(file_path) as handle:
        reader = csv.reader(handle, delimiter=delimiter)
        header = next(reader)
        sample_names = [sample.strip() for sample in header[1:]]

        for row in reader:
            if any(value != "" for value in row):
                genes.append(row[0].strip())

    samples = [
        {
            "sample_id": sample_name,
            "SRA": sample_name,
        }
        for sample_name in sample_names
    ]
    return samples, genes


def inspect_count_matrix(file_path: Path, app_root: Path, folder: Path) -> dict:
    header, preview_rows, delimiter = read_preview(file_path)
    if not header or not preview_rows:
        raise ValueError(f"{file_path} must contain a header and data rows")

    orientation = infer_orientation(header, preview_rows)
    samples_file = folder / "samples.json"
    genes_file = folder / "genes.json"

    if orientation == "genes_as_rows":
        samples, genes = extract_gene_row_index(file_path, delimiter)
        write_json_atomic(samples_file, {"samples": samples})
        write_json_atomic(genes_file, {"genes": genes})
        return {
            "matrixOrientation": "genes_as_rows",
            "geneCount": len(genes),
            "sampleCount": len(samples),
            "sampleMetadataUrl": url_for(app_root, samples_file),
            "geneListUrl": url_for(app_root, genes_file),
        }

    metadata_count = infer_metadata_column_count(header, preview_rows)
    metadata_headers = header[:metadata_count]
    sample_id_column = infer_sample_id_column(metadata_headers, preview_rows)
    samples, genes = extract_sample_row_index(
        file_path,
        delimiter,
        metadata_count,
        sample_id_column,
    )
    write_json_atomic(samples_file, {"samples": samples})
    write_json_atomic(genes_file, {"genes": genes})

    return {
        "matrixOrientation": "samples_as_rows",
        "metadataColumnCount": metadata_count,
        "sampleIdColumn": sample_id_column,
        "geneCount": len(genes),
        "sampleCount": len(samples),
        "sampleMetadataUrl": url_for(app_root, samples_file),
        "geneListUrl": url_for(app_root, genes_file),
    }


def inspect_annotation(file_path: Path) -> dict:
    header, rows, _delimiter = read_preview(file_path, limit=1)
    if not header:
        return {}

    first_cell = header[0].strip().lower()
    if first_cell in {"gene_id", "gene", "gene id", "id"}:
        return {"annotationHasHeader": True}

    width = max(len(header), len(rows[0]) if rows else 0)
    if width <= 1:
        columns = ["gene_id"]
    elif width == 2:
        columns = ["gene_id", "arabidopsis_homolog"]
    elif width == 3:
        columns = ["gene_id", "arabidopsis_homolog", "rice_homolog"]
    else:
        columns = ["gene_id", "arabidopsis_homolog", "rice_homolog"] + [
            f"homolog_extra_{index}" for index in range(4, width + 1)
        ]

    return {
        "annotationHasHeader": False,
        "annotationColumns": columns,
    }


def load_overrides(folder: Path) -> dict:
    metadata_file = folder / "dataset.json"
    if not metadata_file.exists():
        return {}
    with metadata_file.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def attach_tpm_vector_metadata(app_root: Path, folder: Path, inferred: dict) -> dict:
    vectors_dir = folder / "tpm-vectors"
    manifest_file = vectors_dir / "manifest.json"
    if not manifest_file.exists():
        return {}

    with manifest_file.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    if manifest.get("format") != "float32-gzip-v1":
        raise ValueError(f"Unsupported TPM vector format in {manifest_file}")
    if int(manifest.get("geneCount", -1)) != int(inferred["geneCount"]):
        raise ValueError(
            f"TPM vector gene count mismatch in {manifest_file}: "
            f"{manifest.get('geneCount')} vs {inferred['geneCount']}"
        )

    sample_files = manifest.get("sampleFiles")
    if not isinstance(sample_files, dict):
        raise ValueError(f"TPM vector manifest has no sampleFiles map: {manifest_file}")

    samples_file = folder / "samples.json"
    with samples_file.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    samples = payload.get("samples") if isinstance(payload, dict) else payload
    if not isinstance(samples, list):
        raise ValueError(f"Invalid samples helper file: {samples_file}")

    expected_ids = {str(sample.get("sample_id", "")) for sample in samples}
    vector_ids = {str(sample_id) for sample_id in sample_files}
    if expected_ids != vector_ids:
        missing = sorted(expected_ids - vector_ids)
        extra = sorted(vector_ids - expected_ids)
        raise ValueError(
            f"TPM vector sample mismatch in {manifest_file}; "
            f"missing={missing[:5]}, extra={extra[:5]}"
        )

    for sample in samples:
        sample_id = str(sample["sample_id"])
        relative_file = str(sample_files[sample_id])
        vector_file = vectors_dir / relative_file
        if not vector_file.is_file():
            raise ValueError(f"TPM vector file is missing: {vector_file}")
        sample["tpmFile"] = relative_file

    write_json_atomic(samples_file, {"samples": samples})
    return {
        "tpmBaseUrl": f"{url_for(app_root, vectors_dir)}/",
        "tpmVectorManifestUrl": url_for(app_root, manifest_file),
        "tpmVectorFormat": manifest["format"],
    }


def build_dataset(app_root: Path, folder: Path) -> dict | None:
    overrides = load_overrides(folder)
    if overrides.get("catalogEnabled") is False:
        return None

    count_file = find_file(folder, COUNT_PATTERNS, ("count",))
    if count_file is None:
        return None

    tpm_file = find_file(folder, TPM_PATTERNS, ("tpm",))
    annotation_file = find_file(folder, ANNOTATION_PATTERNS, ("annotation", "annot"))
    inferred = inspect_count_matrix(count_file, app_root, folder)
    tpm_vector_metadata = attach_tpm_vector_metadata(app_root, folder, inferred)
    label, species, reference = infer_names(folder.name)

    dataset = {
        "id": folder.name,
        "label": label,
        "species": species,
        "reference": reference,
        "dataVersion": "raw",
        "description": f"Auto-discovered raw dataset from data/raw/{folder.name}.",
        "format": "direct_matrix",
        "countUrl": url_for(app_root, count_file),
        "gexaGeneUrlTemplate": None,
        "tgifGeneUrlTemplate": None,
        **inferred,
        **tpm_vector_metadata,
    }

    if tpm_file is not None:
        dataset["tpmUrl"] = url_for(app_root, tpm_file)

    if annotation_file is not None:
        dataset["annotationUrl"] = url_for(app_root, annotation_file)
        dataset.update(inspect_annotation(annotation_file))

    dataset.update({key: value for key, value in overrides.items() if key != "catalogEnabled"})
    return dataset


def main() -> int:
    args = parse_args()
    app_root = Path(args.app_root).resolve()
    raw_dir = app_root / "data" / "raw"
    output_file = app_root / "config" / "datasets.json"

    if not raw_dir.exists():
        raise SystemExit(f"Raw data directory does not exist: {raw_dir}")

    folders = [
        folder
        for folder in sorted(raw_dir.iterdir())
        if folder.is_dir() and not folder.name.startswith(".")
    ]
    requested_ids = set(args.dataset_ids or [])
    available_ids = {folder.name for folder in folders}
    unknown_ids = sorted(requested_ids - available_ids)
    if unknown_ids:
        raise SystemExit(f"Unknown raw dataset folder(s): {', '.join(unknown_ids)}")

    rebuilt = []
    for folder in folders:
        if requested_ids and folder.name not in requested_ids:
            continue
        dataset = build_dataset(app_root, folder)
        if dataset is not None:
            rebuilt.append(dataset)

    if requested_ids:
        if not output_file.exists():
            raise SystemExit("Targeted rebuild requires an existing config/datasets.json; run a full rebuild first.")
        with output_file.open("r", encoding="utf-8") as handle:
            existing_payload = json.load(handle)
        rebuilt_by_id = {dataset["id"]: dataset for dataset in rebuilt}
        datasets = [
            rebuilt_by_id.get(dataset.get("id"), dataset)
            for dataset in existing_payload.get("datasets", [])
            if dataset.get("id") not in requested_ids or dataset.get("id") in rebuilt_by_id
        ]
        existing_ids = {dataset.get("id") for dataset in datasets}
        datasets.extend(dataset for dataset in rebuilt if dataset["id"] not in existing_ids)
    else:
        datasets = rebuilt

    payload = {
        "generatedBy": "scripts/build_raw_catalog.py",
        "datasets": datasets,
    }

    output_file.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(output_file, payload)

    print(f"Wrote {len(datasets)} dataset(s) to {output_file}")
    for dataset in rebuilt:
        print(
            f"- {dataset['id']}: {dataset.get('sampleCount', 'NA')} samples, "
            f"{dataset.get('geneCount', 'NA')} genes"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
