#!/usr/bin/env python3
"""Serve only the selected map-review page and its explicit assets on loopback."""
from __future__ import annotations

import argparse
import re
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


def allowed_relative_path(request_target: str, mode: str = "labels") -> str | None:
    """Return an allowlisted path relative to the sheet root, else None."""
    try:
        path = unquote(urlsplit(request_target).path, errors="strict")
    except (UnicodeDecodeError, ValueError):
        return None
    if mode == "labels":
        if path == "/label.html":
            return "label.html"
        match = re.fullmatch(r"/sheet-crops/S(\d{3})\.png", path)
        if match and 1 <= int(match.group(1)) <= 100:
            return f"sheet-crops/S{match.group(1)}.png"
        return None
    if mode == "roads":
        return {
            "/measure-roads.html": "measure-roads.html",
            "/masterplan_background.webp": "masterplan_background.webp",
        }.get(path)
    if mode == "benchmark":
        if path in {"/label.html", "/benchmark-manifest.json"}:
            return path.lstrip("/")
        match = re.fullmatch(r"/sheet-crops/(S\d{3})\.png", path)
        if match and 1 <= int(match.group(1)[1:]) <= 60:
            return f"sheet-crops/{match.group(1)}.png"
    return None


def safe_regular_file(root: Path, relative_path: str) -> bool:
    candidate = root / relative_path
    try:
        resolved = candidate.resolve(strict=True)
    except OSError:
        return False
    # Refuse symlinks (including a symlinked sheet-crops directory) and any
    # path that resolves outside or elsewhere inside the private directory.
    return resolved == candidate and candidate.is_file()


class BlindSheetHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str, mode: str, **kwargs):
        self.sheet_root = Path(directory).resolve(strict=True)
        self.mode = mode
        super().__init__(*args, directory=str(self.sheet_root), **kwargs)

    def _check_request(self) -> str | None:
        relative_path = allowed_relative_path(self.path, self.mode)
        if relative_path is None or not safe_regular_file(self.sheet_root, relative_path):
            self.send_error(404, "Not found")
            return None
        return relative_path

    def do_GET(self) -> None:
        try:
            path = unquote(urlsplit(self.path).path, errors="strict")
        except (UnicodeDecodeError, ValueError):
            self.send_error(404, "Not found")
            return
        if path == "/":
            self.send_response(302)
            landing = "/measure-roads.html" if self.mode == "roads" else "/label.html"
            self.send_header("Location", landing)
            self.end_headers()
            return
        if self._check_request() is None:
            return
        super().do_GET()

    def do_HEAD(self) -> None:
        if self._check_request() is None:
            return
        super().do_HEAD()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, help="private review directory containing label.html and sheet-crops/")
    parser.add_argument("--mode", choices=("labels", "roads", "benchmark"), default="labels")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    root = Path(args.directory).resolve(strict=True)
    if not root.is_dir():
        parser.error("review directory must exist")
    if args.mode == "labels":
        valid_assets = (root / "label.html").is_file() and (root / "sheet-crops").is_dir()
    elif args.mode == "roads":
        valid_assets = (root / "measure-roads.html").is_file() and (root / "masterplan_background.webp").is_file()
    else:
        valid_assets = (
            (root / "label.html").is_file()
            and (root / "benchmark-manifest.json").is_file()
            and (root / "sheet-crops").is_dir()
        )
    if not valid_assets:
        parser.error(f"directory is missing required assets for --mode {args.mode}")

    handler = partial(BlindSheetHandler, directory=str(root), mode=args.mode)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"blind review server: http://127.0.0.1:{server.server_address[1]}/", flush=True)
    allowed = (
        "/label.html and /sheet-crops/S001.png through S100.png"
        if args.mode == "labels"
        else "/measure-roads.html and /masterplan_background.webp"
        if args.mode == "roads"
        else "/label.html, /benchmark-manifest.json, and /sheet-crops/S001.png through S060.png"
    )
    print(f"mode: {args.mode}; allowed: {allowed} only", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
