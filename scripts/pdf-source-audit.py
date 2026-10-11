#!/usr/bin/env python3
"""M1 PDF source audit (bounded reads only).

Verifies the stated source hypotheses for the Hopkins sales plat WITHOUT
decoding or dumping raster bytes:
  - pdfinfo            -> pages, page size, creator, producer (structure only)
  - pdfimages -list    -> embedded image count + dimensions (no extraction;
                          NEVER `pdfimages -j`, which dumps 17 x 78MB PPMs)
  - pdftotext to stdout -> selectable-text character count (text layer only)
  - os.stat + 8-byte header read -> size + %PDF magic

Usage:
  python3 scripts/pdf-source-audit.py --pdf "2026 Hopkins Map.pdf" \
    --out docs/implementation/source-audit.json
Exit 0 with a JSON report {checks:[{hypothesis, observed, verdict}]}.
Verdicts: confirmed | refuted | unverified (tool missing or parse failed).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str], timeout: int = 300) -> str | None:
    if shutil.which(cmd[0]) is None:
        return None
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout


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
    size = pdf.stat().st_size
    with open(pdf, "rb") as f:
        magic = f.read(8)
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

    report = {"pdf": str(pdf), "bytes": size, "checks": checks,
              "method": "pdfinfo + pdfimages -list + pdftotext (structure/text layers only; no raster decode, no PPM dump)"}
    Path(args.out).write_text(json.dumps(report, indent=1) + "\n")
    for c in checks:
        print(f"[{c['verdict']:>10}] {c['hypothesis']}  ({c['observed']})")
    print(f"wrote {args.out}")
    if any(c["verdict"] == "refuted" for c in checks):
        sys.exit(3)


if __name__ == "__main__":
    main()
