#!/usr/bin/env python3
"""Score OCR output against filled blind labels (owner-labeled, unbiased).

    python3 scripts/score-labels.py --sheet <sheet-dir> --labels filled.csv
      --ocr <ocr.json> [--out scores.json]

Joins filled.csv rows to lots via the sheet mapping, then scores each engine
dict found in ocr.json (tesseract, rapidocr, ensemble, production) with the
same token/char accuracy definitions as ocr-match comparison mode:
per-lot positional matching (token centroid inside the labeled lot polygon),
exact normalized text for numbers, parsed-value equality for areas.

Writes scores.json (default: alongside --labels as scores.json). No writes
to hosted systems; pure local computation.
"""
from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def load_ocr_match():
    spec = importlib.util.spec_from_file_location(
        "ocr_match", Path(__file__).resolve().parent / "ocr-match.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", required=True, help="sheet dir (mapping.json + lots geometry source hint)")
    ap.add_argument("--lots", required=True, help="lots.json with polygon_pct for positional matching")
    ap.add_argument("--labels", required=True, help="filled labels_template.csv (id,printed_number,printed_area_sqm)")
    ap.add_argument("--ocr", required=True, help="ocr.json with engines dict")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    evaluate_engine = load_ocr_match().evaluate_engine

    mapping = json.loads(Path(args.sheet, "mapping.json").read_text())
    lots = {lot["lot_number"]: lot for lot in json.loads(Path(args.lots).read_text())}
    ocr = json.loads(Path(args.ocr).read_text())
    engines = ocr.get("engines", {})

    filled = {}
    with open(args.labels, newline="") as f:
        for row in csv.DictReader(f):
            sid = (row.get("id") or "").strip()
            if sid and sid in mapping:
                filled[sid] = {
                    "number": (row.get("printed_number") or "").strip(),
                    "area": (row.get("printed_area_sqm") or "").strip(),
                }
    if not filled:
        print("error: no labeled rows found", file=sys.stderr)
        sys.exit(2)

    # Ground-truth tokens in evaluate_engine format (bbox = labeled polygon
    # bbox: positional matching then reduces to inside-polygon containment).
    gt_tokens = []
    lot_tier = {}
    img_w = ocr.get("image", {}).get("width") or 100
    img_h = ocr.get("image", {}).get("height") or 100
    for sid, entry in filled.items():
        info = mapping[sid]
        lot_number = info["lot_number"]
        lot = lots.get(lot_number)
        if lot is None:
            continue
        poly = lot["polygon_pct"]
        xs = [p["x"] / 100 * img_w for p in poly]
        ys = [p["y"] / 100 * img_h for p in poly]
        bbox = [min(xs), min(ys), max(xs), max(ys)]
        lot_tier[lot_number] = str(lot.get("tier_key") or "unknown")
        if entry["number"]:
            gt_tokens.append({"lot": lot_number, "kind": "number", "text": entry["number"], "bbox": bbox})
        if entry["area"]:
            try:
                gt_tokens.append({"lot": lot_number, "kind": "area",
                                  "text": f"{float(entry['area']):.3f} S.M.", "bbox": bbox})
            except ValueError:
                print(f"warning: {sid} area not numeric: {entry['area']!r}", file=sys.stderr)
    gt = {"tokens": gt_tokens}

    # Positional matching happens inside evaluate_engine (engine token
    # center inside the labeled lot's bbox + text equality).
    results = {}
    engines = ocr.get("engines", {})
    for name, eng in engines.items():
        results[name] = evaluate_engine(eng, gt, lot_tier)
        print(f"[score] {name}: token={results[name]['token_accuracy']} "
              f"char={results[name]['char_accuracy']} "
              f"({results[name]['tokens_matched']}/{results[name]['tokens_total']})")

    out = {"labeled_lots": len(filled), "engines": results}
    out_path = Path(args.out) if args.out else Path(args.labels).parent / "scores.json"
    out_path.write_text(json.dumps(out, indent=1) + "\n")
    print(f"[score] wrote {out_path}")


if __name__ == "__main__":
    main()
