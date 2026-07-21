#!/usr/bin/env python3
"""Convert sample-row TPM tables to independently fetchable Float32 vectors."""

from __future__ import annotations

import argparse
from array import array
import csv
import gzip
import json
import math
from pathlib import Path
import shutil
import sys
import time

from build_raw_catalog import (
    SAMPLE_ID_HEADERS,
    TPM_PATTERNS,
    delimiter_for,
    find_file,
    open_text,
)


VECTOR_FORMAT = "float32-gzip-v1"


def parse_args() -> argparse.Namespace:
    script_dir = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(
        description="Build per-sample gzip Float32 TPM vectors for raw datasets."
    )
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument(
        "--dataset",
        action="append",
        dest="dataset_ids",
        help="Raw dataset folder ID to convert (repeatable).",
    )
    selection.add_argument(
        "--all",
        action="store_true",
        help="Convert every raw dataset with a TPM table; keep existing vectors.",
    )
    parser.add_argument(
        "--compression-level",
        type=int,
        choices=range(1, 10),
        default=6,
        metavar="1-9",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Replace an existing tpm-vectors directory.",
    )
    parser.add_argument(
        "--app-root",
        type=Path,
        default=script_dir.parent,
        help=argparse.SUPPRESS,
    )
    return parser.parse_args()


def load_json_list(file_path: Path, key: str) -> list:
    with file_path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    values = payload.get(key) if isinstance(payload, dict) else payload
    if not isinstance(values, list) or not values:
        raise ValueError(f"{file_path} does not contain a non-empty {key} list")
    return values


def find_sample_id_index(metadata_headers: list[str]) -> int:
    by_lower = {header.strip().lower(): index for index, header in enumerate(metadata_headers)}
    for candidate in SAMPLE_ID_HEADERS:
        if candidate.lower() in by_lower:
            return by_lower[candidate.lower()]
    raise ValueError("Could not identify the TPM sample ID column")


def parse_tpm_vector(tokens: list[str]) -> array:
    vector = array("f")
    for token in tokens:
        text = str(token).strip()
        if text == "" or text.upper() == "NA":
            vector.append(math.nan)
            continue
        try:
            value = float(text)
            vector.append(value if math.isfinite(value) and value >= 0 else math.nan)
        except (ValueError, OverflowError):
            vector.append(math.nan)

    if sys.byteorder != "little":
        vector.byteswap()
    return vector


def write_gzip_vector(file_path: Path, vector: array, compression_level: int) -> None:
    with file_path.open("wb") as raw_handle:
        with gzip.GzipFile(
            filename="",
            mode="wb",
            fileobj=raw_handle,
            compresslevel=compression_level,
            mtime=0,
        ) as gzip_handle:
            gzip_handle.write(vector.tobytes())


def build_dataset_vectors(folder: Path, compression_level: int, force: bool) -> dict:
    samples_file = folder / "samples.json"
    genes_file = folder / "genes.json"
    if not samples_file.is_file() or not genes_file.is_file():
        raise ValueError(
            f"Run build_raw_catalog.py first; helper files are missing in {folder}"
        )

    tpm_file = find_file(folder, TPM_PATTERNS, ("tpm",))
    if tpm_file is None:
        raise ValueError(f"No TPM table was found in {folder}")

    samples = load_json_list(samples_file, "samples")
    genes = [str(gene).strip() for gene in load_json_list(genes_file, "genes")]
    expected_ids = [str(sample.get("sample_id", "")).strip() for sample in samples]
    if any(not sample_id for sample_id in expected_ids):
        raise ValueError(f"A sample in {samples_file} has no sample_id")
    if len(expected_ids) != len(set(expected_ids)):
        raise ValueError(f"Duplicate sample IDs in {samples_file}")
    expected_id_set = set(expected_ids)

    output_dir = folder / "tpm-vectors"
    staging_dir = folder / ".tpm-vectors.tmp"
    if staging_dir.exists():
        raise ValueError(f"Remove interrupted staging directory before retrying: {staging_dir}")
    if output_dir.exists():
        if not force:
            raise ValueError(f"Output already exists (use --force to replace it): {output_dir}")

    started = time.monotonic()
    staging_dir.mkdir()
    sample_files: dict[str, str] = {}
    try:
        with open_text(tpm_file) as handle:
            first_line = handle.readline()
            if not first_line:
                raise ValueError(f"TPM table is empty: {tpm_file}")
            delimiter = delimiter_for(tpm_file, first_line)
            handle.seek(0)
            reader = csv.reader(handle, delimiter=delimiter)
            header = [cell.strip() for cell in next(reader)]
            metadata_count = len(header) - len(genes)
            if metadata_count < 1 or header[metadata_count:] != genes:
                raise ValueError(
                    f"TPM gene order does not exactly match {genes_file}"
                )
            sample_id_index = find_sample_id_index(header[:metadata_count])

            for row_number, row in enumerate(reader, start=2):
                if not any(cell != "" for cell in row):
                    continue
                if len(row) != len(header):
                    raise ValueError(
                        f"{tpm_file} row {row_number} has {len(row)} columns; expected {len(header)}"
                    )
                sample_id = row[sample_id_index].strip()
                if sample_id not in expected_id_set:
                    raise ValueError(f"Unexpected TPM sample ID at row {row_number}: {sample_id}")
                if sample_id in sample_files:
                    raise ValueError(f"Duplicate TPM sample ID: {sample_id}")

                file_name = f"{len(sample_files):06d}.bin.gz"
                vector = parse_tpm_vector(row[metadata_count:])
                write_gzip_vector(staging_dir / file_name, vector, compression_level)
                sample_files[sample_id] = file_name

                if len(sample_files) % 100 == 0:
                    elapsed = time.monotonic() - started
                    print(f"  {folder.name}: {len(sample_files)}/{len(expected_ids)} samples ({elapsed:.0f}s)")

        missing_ids = sorted(expected_id_set - set(sample_files))
        if missing_ids:
            raise ValueError(f"TPM table is missing sample IDs: {missing_ids[:10]}")

        manifest = {
            "format": VECTOR_FORMAT,
            "source": tpm_file.name,
            "geneCount": len(genes),
            "sampleCount": len(sample_files),
            "sampleFiles": sample_files,
        }
        with (staging_dir / "manifest.json").open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        if output_dir.exists():
            shutil.rmtree(output_dir)
        staging_dir.replace(output_dir)
    except Exception:
        if staging_dir.exists():
            shutil.rmtree(staging_dir)
        raise

    total_bytes = sum(file_path.stat().st_size for file_path in output_dir.glob("*.bin.gz"))
    elapsed = time.monotonic() - started
    return {
        "dataset": folder.name,
        "samples": len(sample_files),
        "genes": len(genes),
        "bytes": total_bytes,
        "elapsed": elapsed,
    }


def main() -> int:
    args = parse_args()
    raw_dir = Path(args.app_root).resolve() / "data" / "raw"
    if args.all:
        dataset_ids = [
            folder.name
            for folder in sorted(raw_dir.iterdir())
            if folder.is_dir() and find_file(folder, TPM_PATTERNS, ("tpm",)) is not None
        ]
    else:
        dataset_ids = args.dataset_ids

    converted = 0
    for dataset_id in dataset_ids:
        folder = raw_dir / dataset_id
        if not folder.is_dir():
            raise SystemExit(f"Raw dataset folder does not exist: {folder}")
        if args.all and (folder / "tpm-vectors").exists() and not args.force:
            print(f"Kept existing {dataset_id}/tpm-vectors")
            continue
        result = build_dataset_vectors(folder, args.compression_level, args.force)
        converted += 1
        print(
            f"Built {result['dataset']}: {result['samples']} samples x {result['genes']} genes, "
            f"{result['bytes'] / 1024 / 1024:.1f} MB in {result['elapsed']:.1f}s"
        )
    print(f"Converted {converted} dataset(s). Run build_raw_catalog.py before deployment.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
