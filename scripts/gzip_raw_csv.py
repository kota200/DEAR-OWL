#!/usr/bin/env python3
"""Gzip raw CSV files under deseq2/data/raw without deleting the originals."""

from __future__ import annotations

import argparse
import gzip
import shutil
from pathlib import Path


def parse_args() -> argparse.Namespace:
    script_dir = Path(__file__).resolve().parent
    app_root = script_dir.parent
    parser = argparse.ArgumentParser(
        description="Create .csv.gz files next to CSV files under data/raw."
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="recreate .csv.gz files even when they are newer than the source CSV",
    )
    return parser.parse_args(namespace=argparse.Namespace(app_root=app_root))


def format_bytes(value: int) -> str:
    units = ("B", "KB", "MB", "GB")
    number = float(value)
    index = 0
    while number >= 1024 and index < len(units) - 1:
        number /= 1024
        index += 1
    return f"{number:.1f} {units[index]}" if index else f"{int(number)} {units[index]}"


def gzip_file(source: Path, force: bool) -> tuple[str, int, int]:
    target = source.with_name(source.name + ".gz")

    if target.exists() and not force and target.stat().st_mtime >= source.stat().st_mtime:
        return "skipped", source.stat().st_size, target.stat().st_size

    tmp = target.with_name(target.name + ".tmp")
    if tmp.exists():
        tmp.unlink()

    with source.open("rb") as input_handle:
        with gzip.GzipFile(filename="", mode="wb", fileobj=tmp.open("wb"), compresslevel=6, mtime=0) as output_handle:
            shutil.copyfileobj(input_handle, output_handle, length=1024 * 1024)

    tmp.replace(target)
    return "written", source.stat().st_size, target.stat().st_size


def main() -> int:
    args = parse_args()
    raw_dir = Path(args.app_root).resolve() / "data" / "raw"

    if not raw_dir.exists():
        raise SystemExit(f"Raw data directory does not exist: {raw_dir}")

    csv_files = sorted(
        file_path
        for file_path in raw_dir.rglob("*.csv")
        if file_path.is_file() and not file_path.name.lower().endswith(".csv.gz")
    )

    if not csv_files:
        print("No CSV files found.")
        return 0

    total_source = 0
    total_gzip = 0
    written = 0

    for index, source in enumerate(csv_files, start=1):
        rel = source.relative_to(raw_dir).as_posix()
        print(f"[{index}/{len(csv_files)}] {rel}")
        status, source_size, gzip_size = gzip_file(source, args.force)
        total_source += source_size
        total_gzip += gzip_size
        if status == "written":
            written += 1
        ratio = gzip_size / source_size if source_size else 0
        print(f"  {status}: {format_bytes(source_size)} -> {format_bytes(gzip_size)} ({ratio:.1%})")

    print(
        f"Done. {written} file(s) written. "
        f"Total: {format_bytes(total_source)} -> {format_bytes(total_gzip)}."
    )
    print("Original CSV files were kept.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
