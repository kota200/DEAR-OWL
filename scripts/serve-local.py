#!/usr/bin/env python3
"""Serve DEAR-OWL on loopback with the headers required by webR."""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import webbrowser


APP_ROOT = Path(__file__).resolve().parent.parent
LOCAL_HOST = "127.0.0.1"


class DearOwlHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".css": "text/css; charset=utf-8",
        ".csv": "text/csv; charset=utf-8",
        ".data": "application/octet-stream",
        ".gz": "application/gzip",
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".metadata": "application/json; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".so": "application/octet-stream",
        ".tsv": "text/tab-separated-values; charset=utf-8",
        ".wasm": "application/wasm",
    }

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()


class DearOwlServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("port", nargs="?", type=int, default=8766)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    return args


def main() -> int:
    args = parse_args()
    handler = partial(DearOwlHandler, directory=str(APP_ROOT))
    try:
        server = DearOwlServer((LOCAL_HOST, args.port), handler)
    except OSError as error:
        print(f"DEAR-OWL could not listen on port {args.port}: {error}", file=sys.stderr)
        print(f"Try another port: sh start-local.sh {args.port + 1}", file=sys.stderr)
        return 1

    local_url = f"http://{LOCAL_HOST}:{args.port}/?mode=upload"
    print("\nDEAR-OWL is running only on this computer.")
    print(local_url)
    print("Keep this terminal open. Press Ctrl+C to stop.")
    print("Uploaded count matrices are not sent to a remote server.\n")
    if not args.no_browser:
        webbrowser.open(local_url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping DEAR-OWL.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
