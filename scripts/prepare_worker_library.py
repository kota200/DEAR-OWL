#!/usr/bin/env python3
"""Create the uncompressed webR library image used by SharedArrayBuffer workers."""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
from pathlib import Path


def parse_args() -> argparse.Namespace:
    app_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(
        description=(
            "Create library-uncompressed.data and matching metadata so webR does "
            "not double-decompress server-decoded .gz responses."
        )
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace existing generated files after validating the source image",
    )
    return parser.parse_args(namespace=argparse.Namespace(app_root=app_root))


def main() -> int:
    args = parse_args()
    library_dir = Path(args.app_root).resolve() / "library"
    source_data = library_dir / "library.data.gz"
    source_metadata = library_dir / "library.js.metadata"
    target_data = library_dir / "library-uncompressed.data"
    target_metadata = library_dir / "library-uncompressed.js.metadata"

    if not source_data.is_file() or not source_metadata.is_file():
        raise SystemExit("The compressed library image or metadata file is missing.")

    metadata = json.loads(source_metadata.read_text(encoding="utf-8"))
    expected_size = int(metadata.get("remote_package_size", 0))
    generated_metadata = {**metadata, "gzip": False}

    if target_data.exists() or target_metadata.exists():
        if not args.force:
            current_metadata = None
            if target_metadata.is_file():
                current_metadata = json.loads(target_metadata.read_text(encoding="utf-8"))
            if (
                target_data.is_file()
                and target_data.stat().st_size == expected_size
                and current_metadata == generated_metadata
            ):
                print("Worker library image is already up to date.")
                return 0
            raise SystemExit("Generated worker library files already exist; use --force to replace them.")

    data_tmp = target_data.with_suffix(target_data.suffix + ".tmp")
    metadata_tmp = target_metadata.with_suffix(target_metadata.suffix + ".tmp")
    for tmp in (data_tmp, metadata_tmp):
        if tmp.exists():
            tmp.unlink()

    try:
        with gzip.open(source_data, "rb") as input_handle, data_tmp.open("wb") as output_handle:
            shutil.copyfileobj(input_handle, output_handle, length=1024 * 1024)

        actual_size = data_tmp.stat().st_size
        if expected_size and actual_size != expected_size:
            raise RuntimeError(
                f"Uncompressed image size mismatch: expected {expected_size}, got {actual_size}."
            )

        metadata_tmp.write_text(
            json.dumps(generated_metadata, ensure_ascii=True, separators=(",", ":")),
            encoding="utf-8",
        )

        if args.force:
            target_data.unlink(missing_ok=True)
            target_metadata.unlink(missing_ok=True)
        data_tmp.replace(target_data)
        metadata_tmp.replace(target_metadata)
    finally:
        data_tmp.unlink(missing_ok=True)
        metadata_tmp.unlink(missing_ok=True)

    print(f"Created {target_data.name}: {target_data.stat().st_size} bytes")
    print(f"Created {target_metadata.name} with gzip=false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
