#!/usr/bin/env python3
"""M1 PDF source audit (bounded reads only).

Verifies the stated source hypotheses for the Hopkins sales plat WITHOUT
decoding or dumping raster bytes:
  - pdfinfo            -> pages, page size, creator, producer (structure only)
  - pdfimages -list    -> embedded image count + dimensions (no extraction;
                          NEVER `pdfimages -j`, which dumps 17 x 78MB PPMs)
  - pdftotext to stdout -> selectable-text character count (text layer only)
  - bounded streaming pass -> size, %PDF magic, and SHA-256 fingerprint

Usage:
  python3 scripts/pdf-source-audit.py --pdf "2026 Hopkins Map.pdf" \
    --out docs/implementation/source-audit.json
Exit 0 with a JSON report {checks:[{hypothesis, observed, verdict}]}.
Verdicts: confirmed | refuted | unverified (tool missing or parse failed).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HASH_CHUNK_BYTES = 1024 * 1024
COMMAND_TIMEOUT_SECONDS = 300
VERSION_TIMEOUT_SECONDS = 10


def inspect_source(pdf: Path) -> dict[str, object]:
    """Read identity and checksum in one bounded-memory pass."""
    before = pdf.stat()
    digest = hashlib.sha256()
    magic = bytearray()
    total = 0
    with pdf.open("rb") as source:
        while True:
            chunk = source.read(HASH_CHUNK_BYTES)
            if not chunk:
                break
            if len(magic) < 8:
                magic.extend(chunk[: 8 - len(magic)])
            digest.update(chunk)
            total += len(chunk)
    after = pdf.stat()
    if (
        total != before.st_size or after.st_size != total or
        before.st_mtime_ns != after.st_mtime_ns or
        before.st_ctime_ns != after.st_ctime_ns or
        before.st_ino != after.st_ino or before.st_dev != after.st_dev
    ):
        raise RuntimeError(f"source changed while hashing: {pdf}")
    return {"bytes": total, "magic": bytes(magic), "sha256": digest.hexdigest()}


def run(cmd: list[str], timeout: int = COMMAND_TIMEOUT_SECONDS) -> str | None:
    if shutil.which(cmd[0]) is None:
        return None
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout


def command_version(command: str) -> str | None:
    if shutil.which(command) is None:
        return None
    try:
        proc = subprocess.run(
            [command, "-v"], capture_output=True, text=True,
            timeout=VERSION_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    output = f"{proc.stdout}\n{proc.stderr}"
    return next((line.strip() for line in output.splitlines() if line.strip()), None)


def write_report(path: Path, report: dict) -> None:
    """Atomically replace the report so a low-disk failure preserves prior evidence."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        report_mode = path.stat().st_mode & 0o777
    except FileNotFoundError:
        report_mode = 0o644
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=f".{path.name}.", suffix=".tmp", delete=False,
        ) as output:
            temporary_path = Path(output.name)
            json.dump(report, output, indent=1)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary_path, report_mode)
        os.replace(temporary_path, path)
    except OSError as error:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except OSError:
                pass
        raise OSError(f"could not write report {path}; previous report preserved: {error}") from error


def inspect_pdfium_geometry(pdf: Path) -> dict[str, object]:
    """Record page orientation and the first embedded image transform without decoding it."""
    try:
        import pypdfium2 as pdfium
    except ImportError:
        return {"status": "unverified", "reason": "pypdfium2 is not installed"}

    document = None
    try:
        document = pdfium.PdfDocument(str(pdf))
        if len(document) == 0:
            return {"status": "unverified", "reason": "PDF has no pages"}
        page = document[0]
        width, height = page.get_size()
        rotation = int(page.get_rotation())
        displayed_width, displayed_height = (height, width) if rotation % 180 else (width, height)
        page_objects = list(page.get_objects())
        object_types: dict[str, int] = {}
        for obj in page_objects:
            name = type(obj).__name__
            object_types[name] = object_types.get(name, 0) + 1
        images = [obj for obj in page_objects if isinstance(obj, pdfium.PdfImage)]
        evidence: dict[str, object] = {
            "status": "verified",
            "pypdfium2_version": first_version("pypdfium2"),
            "page_count": len(document),
            "page_size_pt": [round(float(width), 6), round(float(height), 6)],
            "page_rotation_degrees": rotation,
            "page_orientation": "landscape" if displayed_width >= displayed_height else "portrait",
            "page_object_types": object_types,
            "non_image_object_count": len(page_objects) - len(images),
            "embedded_image_count": len(images),
        }
        if images:
            image = images[0]
            matrix = image.get_matrix()
            transform = [round(float(getattr(matrix, axis)), 6) for axis in ("a", "b", "c", "d", "e", "f")]
            covers_page = (
                abs(transform[0] - width) < 0.01 and abs(transform[1]) < 0.01 and
                abs(transform[2]) < 0.01 and abs(transform[3] - height) < 0.01 and
                abs(transform[4]) < 0.01 and abs(transform[5]) < 0.01
            )
            evidence.update({
                "detector_image_index": 0,
                "first_image_size_px": [int(value) for value in image.get_size()],
                "first_image_matrix_pt": transform,
                "first_image_covers_page_at_origin": covers_page,
            })
        return evidence
    except Exception as error:
        return {"status": "unverified", "reason": f"pypdfium2 inspection failed: {error}"}
    finally:
        if document is not None:
            document.close()


def first_version(package: str) -> str | None:
    try:
        from importlib.metadata import version
        return version(package)
    except Exception:
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--out", default="docs/implementation/source-audit.json")
    args = ap.parse_args()

    pdf = Path(args.pdf)
    if not pdf.exists():
        print(f"error: {pdf} not found", file=sys.stderr)
        sys.exit(2)

    checks: list[dict] = []
    identity = inspect_source(pdf)
    size = int(identity["bytes"])
    magic = identity["magic"]
    checks.append({
        "hypothesis": "PDF magic header %PDF-1.x in first 8 bytes",
        "observed": magic.decode("latin1", "replace"),
        "verdict": "confirmed" if magic.startswith(b"%PDF-") else "refuted",
    })
    checks.append({
        "hypothesis": "file size ~1.4GB single plat export",
        "observed": f"{size} bytes",
        "verdict": "confirmed" if size > 10**9 else "refuted",
    })

    info = run(["pdfinfo", str(pdf)])
    if info is None:
        for h in ["1 page", "547.2 x 460.8 pt", "Civil 3D 2024 creator",
                  "Photoshop producer"]:
            checks.append({"hypothesis": h, "observed": "pdfinfo missing/failed", "verdict": "unverified"})
    else:
        def field(name: str) -> str | None:
            m = re.search(rf"^{name}:\s*(.+)$", info, re.M)
            return m.group(1).strip() if m else None

        pages = field("Pages")
        checks.append({"hypothesis": "exactly 1 page", "observed": f"Pages: {pages}",
                       "verdict": "confirmed" if pages == "1" else "refuted"})
        size_line = field("Page size")
        checks.append({"hypothesis": "page size 547.2 x 460.8 pts", "observed": f"Page size: {size_line}",
                       "verdict": "confirmed" if (size_line or "").startswith("547.2 x 460.8") else "refuted"})
        creator = field("Creator") or ""
        checks.append({"hypothesis": "Creator is Civil 3D 2024",
                       "observed": f"Creator: {creator}",
                       "verdict": "confirmed" if "Civil 3D 2024" in creator else "refuted"})
        producer = field("Producer") or ""
        checks.append({"hypothesis": "Producer is Photoshop",
                       "observed": f"Producer: {producer}",
                       "verdict": "confirmed" if "Photoshop" in producer else "refuted"})

    listing = run(["pdfimages", "-list", str(pdf)])
    if listing is None:
        checks.append({"hypothesis": "17 embedded 5700x4800 rasters",
                       "observed": "pdfimages missing/failed", "verdict": "unverified"})
    else:
        rows = [ln for ln in listing.splitlines()[2:] if ln.strip()]
        dims = set()
        for r in rows:
            parts = r.split()
            try:
                dims.add((int(parts[3]), int(parts[4])))
            except (IndexError, ValueError):
                pass
        checks.append({
            "hypothesis": "17 embedded 5700x4800 rasters",
            "observed": f"{len(rows)} images, dimensions={sorted(dims)}",
            "verdict": "confirmed" if len(rows) == 17 and dims == {(5700, 4800)} else "refuted",
        })

    text = run(["pdftotext", str(pdf), "-"])
    if text is None:
        checks.append({"hypothesis": "no selectable text", "observed": "pdftotext missing/failed", "verdict": "unverified"})
    else:
        n = len(text.strip())
        checks.append({"hypothesis": "no selectable text", "observed": f"{n} text chars extracted",
                       "verdict": "confirmed" if n == 0 else "refuted"})

    report = {"pdf": str(pdf), "bytes": size,
              "sha256": identity["sha256"],
              "checksum_method": f"SHA-256 streamed in {HASH_CHUNK_BYTES // 1024} KiB chunks",
              "tool_versions": {
                  "python": sys.version.split()[0],
                  "pdfinfo": command_version("pdfinfo"),
                  "pdfimages": command_version("pdfimages"),
                  "pdftotext": command_version("pdftotext"),
                  "pypdfium2": first_version("pypdfium2"),
              },
              "processing_limits": {
                  "sha256_chunk_bytes": HASH_CHUNK_BYTES,
                  "external_command_timeout_seconds": COMMAND_TIMEOUT_SECONDS,
                  "raster_decode": False,
              },
              "pdfium_geometry": inspect_pdfium_geometry(pdf),
              "checks": checks,
              "method": "pdfinfo + pdfimages -list + pdftotext + pypdfium2 page-object geometry/type inventory (no raster decode, no PPM dump)"}
    try:
        write_report(Path(args.out), report)
    except OSError as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(2)
    for c in checks:
        print(f"[{c['verdict']:>10}] {c['hypothesis']}  ({c['observed']})")
    print(f"wrote {args.out}")
    if any(c["verdict"] == "refuted" for c in checks):
        sys.exit(3)


if __name__ == "__main__":
    main()
