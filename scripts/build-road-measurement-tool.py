#!/usr/bin/env python3
"""Create a source-bound, local road-width measurement page.

Example:
  python3 scripts/build-road-measurement-tool.py \
    --image out/hopkins-ocr/masterplan_background.webp \
    --out out/hopkins-ocr/measure-roads.html

The output is created exclusively and never overwrites an existing review
artifact. Serve it only with scripts/serve-blind-sheet.py --mode roads.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import NoReturn

HASH_CHUNK_BYTES = 1024 * 1024
REQUIRED_PLACEHOLDERS = (
    "{{IMAGE_URL}}",
    "{{IMAGE_WIDTH}}",
    "{{IMAGE_HEIGHT}}",
    "{{CANVAS_WIDTH}}",
    "{{CANVAS_HEIGHT}}",
    "{{IMAGE_SHA256}}",
)


def fail(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(2)


def fingerprint_file(path: Path) -> tuple[str, int]:
    before = path.stat()
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as source:
        while True:
            chunk = source.read(HASH_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
    after = path.stat()
    if (
        total != before.st_size
        or after.st_size != total
        or before.st_mtime_ns != after.st_mtime_ns
        or before.st_ctime_ns != after.st_ctime_ns
        or before.st_ino != after.st_ino
        or before.st_dev != after.st_dev
    ):
        raise RuntimeError(f"source image changed while fingerprinting: {path}")
    return digest.hexdigest(), total


def build_page(image_path: Path, template_path: Path) -> str:
    from PIL import Image

    if image_path.is_symlink() or not image_path.is_file():
        raise ValueError("source image must be a regular, non-symlink file")
    with Image.open(image_path) as image:
        image_width, image_height = image.size
    if image_width <= 0 or image_height <= 0:
        raise ValueError("source image dimensions must be positive")
    digest, _ = fingerprint_file(image_path)
    template = template_path.read_text(encoding="utf-8")
    if any(placeholder not in template for placeholder in REQUIRED_PLACEHOLDERS):
        raise ValueError(f"road measurement template is missing a required placeholder: {template_path}")

    canvas_width = min(1400, image_width)
    canvas_height = round(canvas_width * image_height / image_width)
    values = {
        "{{IMAGE_URL}}": json.dumps(image_path.name),
        "{{IMAGE_WIDTH}}": str(image_width),
        "{{IMAGE_HEIGHT}}": str(image_height),
        "{{CANVAS_WIDTH}}": str(canvas_width),
        "{{CANVAS_HEIGHT}}": str(canvas_height),
        "{{IMAGE_SHA256}}": json.dumps(digest),
    }
    page = template
    for placeholder, value in values.items():
        page = page.replace(placeholder, value)
    if re.search(r"\{\{[A-Z_]+\}\}", page):
        raise ValueError(f"unexpanded placeholder in road measurement template: {template_path}")
    return page


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="exact source image shown during road clicks")
    parser.add_argument("--out", required=True, help="new HTML path in the same directory as --image")
    args = parser.parse_args()

    image_path = Path(args.image).resolve(strict=True)
    output_path = Path(args.out).absolute()
    if image_path.parent != output_path.parent.resolve():
        fail("--image and --out must be in the same directory so the allowlisted server can serve the source")
    template_path = Path(__file__).resolve().parent / "templates" / "measure-roads.html"
    try:
        page = build_page(image_path, template_path)
    except (OSError, RuntimeError, ValueError) as exc:
        fail(str(exc))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        fd, temp_name = tempfile.mkstemp(prefix=f".{output_path.name}.", suffix=".tmp", dir=output_path.parent)
        temp_path = Path(temp_name)
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            target.write(page)
            target.flush()
            os.fsync(target.fileno())
        os.link(temp_path, output_path)
    except FileExistsError:
        fail(f"refusing to overwrite existing review artifact: {output_path}")
    except OSError as exc:
        fail(f"could not write road measurement page: {exc}")
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)

    print(f"road measurement page: {output_path}")
    print(f"source image: {image_path.name}; dimensions: {build_dimensions(image_path)}")


def build_dimensions(image_path: Path) -> str:
    from PIL import Image

    with Image.open(image_path) as image:
        return f"{image.width}x{image.height}"


if __name__ == "__main__":
    main()
