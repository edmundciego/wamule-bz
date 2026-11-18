#!/usr/bin/env python3
"""Score OCR output against filled blind labels (owner-labeled, unbiased).

    python3 scripts/score-labels.py --mapping <private-mapping.json> --labels filled.csv
      --ocr <ocr.json> [--out scores.json]

Joins filled.csv rows to lots via the sheet mapping, then scores each engine
dict found in ocr.json (tesseract, rapidocr, ensemble, production) with the
same token/char accuracy definitions as ocr-match comparison mode:
per-lot positional matching (token centroid inside the labeled lot polygon),
exact normalized text for numbers, parsed-value equality for areas. Character
accuracy uses edit distance after same-kind positional alignment; a missed token
counts as a deletion rather than turning its entire string into errors.

Writes scores.json (default: alongside --labels as scores.json), including
ambiguous, unreadable, skipped, and blank coverage. No hosted writes; local only.
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


def fail(message: str) -> "NoReturn":
    print(f"error: {message}", file=sys.stderr)
    sys.exit(2)


def read_flag(value: str | None, column: str, row_number: int) -> bool:
    normalized = (value or "").strip().lower()
    if normalized in {"", "0", "false", "no", "n"}:
        return False
    if normalized in {"1", "true", "yes", "y"}:
        return True
    fail(f"labels CSV row {row_number}: {column} must be blank/0 or 1/true")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mapping", required=True, help="private mapping JSON produced by blind-sheet.py")
    ap.add_argument("--lots", required=True, help="lots.json with polygon_pct for positional matching")
    ap.add_argument("--labels", required=True,
                    help="review CSV (id,printed_number,printed_area_sqm; optional ambiguous/unreadable/skipped flags)")
    ap.add_argument("--ocr", required=True, help="ocr.json with engines dict")
    ap.add_argument("--image", default=None,
                    help="source image (default: image name next to --lots)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    ocr_match = load_ocr_match()
    evaluate_engine = ocr_match.evaluate_engine
    mapping_path = Path(args.mapping)
    lots_path = Path(args.lots)
    labels_path = Path(args.labels)
    ocr_path = Path(args.ocr)

    mapping = json.loads(mapping_path.read_text())
    lots_list = json.loads(lots_path.read_text())
    if not isinstance(mapping, dict) or not mapping:
        fail("blind mapping must be a non-empty object")
    if not isinstance(lots_list, list):
        fail("lots input must be a JSON array")
    lots = {}
    for lot in lots_list:
        number = lot.get("lot_number") if isinstance(lot, dict) else None
        if not isinstance(number, str) or not number:
            fail("lots input contains a row without a valid lot_number")
        if number in lots:
            fail(f"lots input contains duplicate lot_number {number!r}")
        lots[number] = lot
    for sid, info in mapping.items():
        lot_number = info.get("lot_number") if isinstance(info, dict) else None
        if not isinstance(lot_number, str) or lot_number not in lots:
            fail(f"blind mapping {sid!r} does not resolve to a lot in lots.json")
    ocr = json.loads(ocr_path.read_text())
    engines = ocr.get("engines", {})

    image_meta = ocr.get("image") if isinstance(ocr.get("image"), dict) else {}
    image_name = image_meta.get("name")
    if not isinstance(image_name, str) or Path(image_name).name != image_name:
        fail("OCR output has no safe source image name; regenerate it with ocr-match.py --stage ocr")
    image_path = Path(args.image) if args.image else lots_path.parent / image_name
    if not image_path.is_file():
        fail(f"source image not found: {image_path}")
    expected_image_hash = image_meta.get("sha256")
    expected_geometry_hash = ocr.get("lot_geometry_sha256")
    if not isinstance(expected_image_hash, str) or not isinstance(expected_geometry_hash, str):
        fail("OCR output lacks input fingerprints; regenerate it with ocr-match.py --engines both --stage ocr")
    try:
        image_fingerprint = ocr_match.fingerprint_file(image_path)
        geometry_hash = ocr_match.fingerprint_lot_geometry(lots_list)
    except (OSError, RuntimeError) as e:
        fail(f"could not fingerprint score inputs: {e}")
    if image_fingerprint["sha256"] != expected_image_hash:
        fail("OCR source-image fingerprint does not match; regenerate predictions before scoring")
    if geometry_hash != expected_geometry_hash:
        fail("OCR lot-geometry fingerprint does not match; regenerate predictions before scoring")
    image_width = image_meta.get("width")
    image_height = image_meta.get("height")
    if not isinstance(image_width, int) or image_width <= 0 or not isinstance(image_height, int) or image_height <= 0:
        fail("OCR output has invalid source image dimensions; regenerate predictions before scoring")
    try:
        scorer_path = Path(__file__).resolve()
        matcher_path = scorer_path.with_name("ocr-match.py")
        file_fingerprints = {
            "ocr_output": ocr_match.fingerprint_file(ocr_path),
            "labels_csv": ocr_match.fingerprint_file(labels_path),
            "blind_mapping": ocr_match.fingerprint_file(mapping_path),
            "score_labels_code": ocr_match.fingerprint_file(scorer_path),
            "ocr_match_code": ocr_match.fingerprint_file(matcher_path),
        }
    except (OSError, RuntimeError) as e:
        fail(f"could not fingerprint score evidence: {e}")

    required_columns = {"id", "printed_number", "printed_area_sqm"}
    filled = {}
    seen_ids = set()
    ambiguous_count = 0
    unreadable_count = 0
    skipped_count = 0
    blank_unmarked_count = 0
    with labels_path.open(newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames or not required_columns.issubset(reader.fieldnames):
            fail("labels CSV must include id, printed_number, and printed_area_sqm columns")
        unreadable_column_present = "unreadable" in reader.fieldnames
        skipped_column_present = "skipped" in reader.fieldnames
        for row_number, row in enumerate(reader, start=2):
            if None in row:
                fail(f"labels CSV row {row_number}: unexpected extra column values")
            sid = (row.get("id") or "").strip()
            if not sid:
                fail(f"labels CSV row {row_number}: id is required")
            if sid not in mapping:
                fail(f"labels CSV row {row_number}: unknown crop id {sid!r}")
            if sid in seen_ids:
                fail(f"labels CSV row {row_number}: duplicate crop id {sid!r}")
            seen_ids.add(sid)
            ambiguous = read_flag(row.get("ambiguous"), "ambiguous", row_number)
            unreadable = read_flag(row.get("unreadable"), "unreadable", row_number)
            skipped = read_flag(row.get("skipped"), "skipped", row_number)
            if sum((ambiguous, unreadable, skipped)) > 1:
                fail(f"labels CSV row {row_number}: ambiguous, unreadable, and skipped statuses are mutually exclusive")
            entry = {
                "number": (row.get("printed_number") or "").strip(),
                "area": (row.get("printed_area_sqm") or "").strip(),
            }
            if entry["number"] and not entry["number"].isdigit():
                fail(f"labels CSV row {row_number}: printed_number must contain digits only")
            if entry["area"]:
                try:
                    parsed_area = float(entry["area"])
                except ValueError:
                    fail(f"labels CSV row {row_number}: printed_area_sqm must be numeric")
                if not entry["area"].replace(".", "", 1).isdigit() or parsed_area <= 0:
                    fail(f"labels CSV row {row_number}: printed_area_sqm must be a positive decimal")
            if unreadable:
                if entry["number"] or entry["area"]:
                    fail(f"labels CSV row {row_number}: unreadable crop cannot include printed values")
                unreadable_count += 1
                continue
            if skipped:
                if entry["number"] or entry["area"]:
                    fail(f"labels CSV row {row_number}: skipped crop cannot include printed values")
                skipped_count += 1
                continue
            if ambiguous:
                if entry["number"] or entry["area"]:
                    fail(f"labels CSV row {row_number}: ambiguous crop cannot include printed values")
                ambiguous_count += 1
                continue
            if entry["number"] or entry["area"]:
                filled[sid] = entry
            else:
                blank_unmarked_count += 1
    missing_ids = set(mapping) - seen_ids
    if not filled:
        fail("no labeled rows found")

    # Ground-truth tokens carry both a pixel bbox (cheap rejection) and the
    # actual pixel polygon (final containment test).
    gt_tokens = []
    lot_tier = {}
    img_w = image_width
    img_h = image_height
    for sid, entry in filled.items():
        info = mapping[sid]
        lot_number = info["lot_number"]
        lot = lots.get(lot_number)
        if lot is None:
            continue
        polygon = lot["polygon_pct"]
        xs = [p["x"] / 100 * img_w for p in polygon]
        ys = [p["y"] / 100 * img_h for p in polygon]
        bbox = [min(xs), min(ys), max(xs), max(ys)]
        polygon_px = [[p["x"] / 100 * img_w, p["y"] / 100 * img_h] for p in polygon]
        lot_tier[lot_number] = str(lot.get("tier_key") or "unknown")
        if entry["number"]:
            gt_tokens.append({"lot": lot_number, "kind": "number", "text": entry["number"],
                              "bbox": bbox, "polygon": polygon_px})
        if entry["area"]:
            try:
                gt_tokens.append({"lot": lot_number, "kind": "area",
                                  "text": f"{float(entry['area']):.3f} S.M.",
                                  "bbox": bbox, "polygon": polygon_px})
            except ValueError:
                print(f"warning: {sid} area not numeric: {entry['area']!r}", file=sys.stderr)
    gt = {"tokens": gt_tokens}

    # Positional matching uses actual polygon containment, not only its bbox.
    results = {}
    engines = ocr.get("engines", {})
    for name, eng in engines.items():
        results[name] = evaluate_engine(eng, gt, lot_tier)
        print(f"[score] {name}: token={results[name]['token_accuracy']} "
              f"char={results[name]['char_accuracy']} "
              f"({results[name]['tokens_matched']}/{results[name]['tokens_total']})")

    out = {
        "schema_version": 2,
        "labeled_lots": len(filled),
        "method": {
            "token_accuracy": "exact normalized token-key matches / ground-truth tokens",
            "character_accuracy": "1 - normalized Levenshtein edits / normalized ground-truth characters",
            "spatial_alignment": "same-kind prediction center inside ground-truth polygon when present; bbox is only a rejection bound",
            "missing_prediction": "counts as deletion of the normalized ground-truth token",
        },
        "provenance": {
            "source_image": {"name": image_path.name, **image_fingerprint},
            "lot_geometry_sha256": geometry_hash,
            "ocr_output": {"name": ocr_path.name, **file_fingerprints["ocr_output"]},
            "labels_csv": {"name": labels_path.name, **file_fingerprints["labels_csv"]},
            "blind_mapping": {"name": mapping_path.name, **file_fingerprints["blind_mapping"]},
            "score_labels_code": {"name": scorer_path.name, **file_fingerprints["score_labels_code"]},
            "ocr_match_code": {"name": matcher_path.name, **file_fingerprints["ocr_match_code"]},
            "ocr_schema_version": ocr.get("schema_version"),
            "engine_environment": ocr.get("environment"),
        },
        "label_summary": {
            "expected_crops": len(mapping),
            "rows_received": len(seen_ids),
            "missing_rows": len(missing_ids),
            "scored_crops": len(filled),
            "ambiguous_excluded": ambiguous_count,
            "unreadable_excluded": unreadable_count,
            "unreadable_status_column_present": unreadable_column_present,
            "skipped_excluded": skipped_count,
            "skipped_status_column_present": skipped_column_present,
            "blank_unmarked": blank_unmarked_count,
            "review_coverage_complete": not missing_ids and blank_unmarked_count == 0 and skipped_count == 0,
        },
        "engines": results,
    }
    out_path = Path(args.out) if args.out else labels_path.parent / "scores.json"
    out_path.write_text(json.dumps(out, indent=1) + "\n")
    print(f"[score] wrote {out_path}")


if __name__ == "__main__":
    main()
