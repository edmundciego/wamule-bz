#!/usr/bin/env python3
"""Area-anchored lot label reading: detect area tokens with strict format,
crop a tight strip above each area token for the number, assemble
number+area+S.M. as one unit, match unit centroids to polygons by position.

Area token rules (strict):
  - format: 3-4 digits, dot, 2-3 digits (e.g. 1011.998)
  - plausible range: 100 .. 10000 sqm (rejects fragments like 5.0, 76.0
    and concatenations like 127628.0, 41011998.0)
  - S.M./SM adjacency: an S.M. word within ~2.5 line-heights below the
    number or on the same row (fragments without S.M. nearby are rejected)
Number strip: tight box directly above the area token (same width +/-20%,
height 2.2x token height), single-line digit-only OCR (psm 8), value 1..999.
Units are matched to lots by point-in-polygon of the unit centroid.
Contiguity along streets is reported (gaps/duplicates flagged, never fixed).
"""
from __future__ import annotations

import json
import re
import subprocess
import tempfile
import os
from pathlib import Path

from PIL import Image

AREA_MIN = 200.0
AREA_MAX = 3000.0
UPSCALE = 3
STRIP_HALF_WIDTH_FACTOR = 1.0
IMG_PATH = "out/hopkins-ocr/masterplan_background.webp"
LOTS_PATH = "out/hopkins-ocr/lots.json"
OUT_PATH = "out/hopkins-ocr/area-anchored.json"


def poly_bbox_px(poly_pct, img_w, img_h):
    xs = [p["x"] / 100 * img_w for p in poly_pct]
    ys = [p["y"] / 100 * img_h for p in poly_pct]
    return min(xs), min(ys), max(xs), max(ys)


def point_in_poly(x, y, poly):
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]["x"], poly[i]["y"]
        x2, y2 = poly[(i + 1) % n]["x"], poly[(i + 1) % n]["y"]
        if ((y1 > y) != (y2 > y)) and (x < (x2 - x1) * (y - y1) / (y2 - y1) + x1):
            inside = not inside
    return inside


def tsv_words(png_path, psm="6", whitelist=None):
    cfg = ["--psm", psm]
    if whitelist:
        cfg += ["-c", f"tessedit_char_whitelist={whitelist}"]
    r = subprocess.run(
        ["tesseract", png_path, "stdout"] + cfg + ["tsv"],
        capture_output=True, text=True, timeout=60)
    words = []
    for line in r.stdout.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) < 12:
            continue
        try:
            conf = float(parts[10])
        except ValueError:
            conf = -1.0
        text = parts[11].strip()
        if not text:
            continue
        words.append({
            "text": text,
            "conf": conf,
            "box": [int(parts[6]), int(parts[7]),
                    int(parts[6]) + int(parts[8]),
                    int(parts[7]) + int(parts[9])],
        })
    return words


def is_sm_word(t):
    s = re.sub(r"[^a-zA-Z]", "", t).upper()
    return s in ("SM", "S", "M")


def process_lot(img, lot):
    W, H = img.size
    x0, y0, x1, y1 = poly_bbox_px(lot["polygon_pct"], W, H)
    w, h = x1 - x0, y1 - y0
    pad_x = max(80, 0.15 * w) / 2
    pad_y = max(80, 0.15 * h) / 2
    bx0 = max(0, int(x0 - pad_x))
    by0 = max(0, int(y0 - pad_y))
    bx1 = min(W, int(x1 + pad_x))
    by1 = min(H, int(y1 + pad_y))
    crop = img.crop((bx0, by0, bx1, by1))
    crop = crop.resize((crop.width * UPSCALE, crop.height * UPSCALE), Image.LANCZOS)

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
        crop.save(tf.name, "PNG")
        crop_path = tf.name
    try:
        words = tsv_words(crop_path, psm="6",
                          whitelist="0123456789.SM")
    finally:
        os.unlink(crop_path)

    # Strict area candidates in upscaled crop coords.
    areas = []
    for wd in words:
        t = re.sub(r"\s+", "", wd["text"])
        m = re.fullmatch(r"(\d{3,4})\.(\d{2,3})", t)
        if not m:
            continue
        try:
            val = float(t)
        except ValueError:
            continue
        if not (AREA_MIN <= val <= AREA_MAX):
            continue
        cx = (wd["box"][0] + wd["box"][2]) / 2
        cy = (wd["box"][1] + wd["box"][3]) / 2
        th = wd["box"][3] - wd["box"][1] or 1
        # S.M. adjacency: SM word within 2.5 line-heights below or same row.
        sm_near = False
        for o in words:
            if o is wd or not is_sm_word(o["text"]):
                continue
            ocx = (o["box"][0] + o["box"][2]) / 2
            ocy = (o["box"][1] + o["box"][3]) / 2
            if abs(ocx - cx) <= 3.0 * th and -1.0 * th <= ocy - cy <= 2.5 * th:
                sm_near = True
                break
        areas.append({"word": wd, "value": val, "sm_near": sm_near,
                      "cx": cx, "cy": cy, "h": th})

    # Number words come from the same crop TSV (no strip framing guesses):
    # pure-digit words assigned to the nearest SM-adjacent area token
    # below them (x-overlap + vertical gap window).
    num_words = []
    for wd in words:
        t = re.sub(r"\s+", "", wd["text"])
        if not re.fullmatch(r"\d{1,3}", t):
            continue
        try:
            v = int(t)
        except ValueError:
            continue
        if 1 <= v <= 999:
            num_words.append((wd, t))

    units = []
    for a in areas:
        if not a["sm_near"]:
            continue
        wd = a["word"]
        bw = wd["box"][2] - wd["box"][0]
        ah = a["h"]
        acx = a["cx"]
        atop = wd["box"][1]
        number = None
        best = None
        for nwd, t in num_words:
            gap = atop - nwd["box"][3]
            if not (0.1 * ah <= gap <= 3.0 * ah):
                continue
            ncx = (nwd["box"][0] + nwd["box"][2]) / 2
            if abs(ncx - acx) > 1.5 * bw:
                continue
            score = (abs(ncx - acx) + gap / ah, -nwd["conf"])
            if best is None or score < best[0]:
                best = (score, t)
        if best is not None:
            number = best[1]
        sx0 = max(0, int(acx - STRIP_HALF_WIDTH_FACTOR * bw))
        sx1 = min(crop.width, int(acx + STRIP_HALF_WIDTH_FACTOR * bw))
        sy1 = max(0, int(atop - 0.2 * ah))
        sy0 = max(0, int(atop - 2.4 * ah))
        # Unit centroid in full-image coords.
        ucx_crop = (sx0 + sx1) / 2 / UPSCALE + bx0
        ucy_crop = (sy0 + sy1) / 2 / UPSCALE + by0
        units.append({
            "number": number,
            "area_sqm": a["value"],
            "sm_adjacent": True,
            "area_box_crop": wd["box"],
            "strip_box_crop": [sx0, sy0, sx1, sy1],
            "centroid_full": [round(ucx_crop, 1), round(ucy_crop, 1)],
        })

    return {
        "lot_number": lot["lot_number"],
        "tier_key": lot.get("tier_key"),
        "crop_box": [bx0, by0, bx1, by1],
        "area_candidates": len(areas),
        "area_rejected_no_sm": sum(1 for a in areas if not a["sm_near"]),
        "units": units,
    }


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=[], action="append",
                    help="re-process only these lot numbers (repeatable); "
                         "merges into existing output, others untouched")
    args = ap.parse_args()

    img = Image.open(IMG_PATH)
    lots = json.loads(Path(LOTS_PATH).read_text())
    if args.only:
        wanted = set(args.only)
        lots = [l for l in lots if l["lot_number"] in wanted]
        print(f"targeted re-run: {len(lots)} lots")
        prev_out = json.loads(Path(OUT_PATH).read_text()) if Path(OUT_PATH).exists() else None
        prev_results = {r["lot_number"]: r for r in (prev_out.get("results", []) if prev_out else [])}
        fresh = []
        for i, lot in enumerate(lots):
            if i % 25 == 0:
                print(f"  {i}/{len(lots)}...", flush=True)
            fresh.append(process_lot(img, lot))
        # Merge: replace targeted lots, keep the rest in original order.
        full_lots = json.loads(Path(LOTS_PATH).read_text())
        merged = []
        fresh_by_num = {r["lot_number"]: r for r in fresh}
        kept_old = 0
        for l in full_lots:
            if l["lot_number"] in fresh_by_num:
                merged.append(fresh_by_num[l["lot_number"]])
            elif l["lot_number"] in prev_results:
                merged.append(prev_results[l["lot_number"]])
                kept_old += 1
        print(f"merged: {len(fresh)} re-processed + {kept_old} kept")
        results = merged
        lots = full_lots
    else:
        results = []
        ckpt = Path(OUT_PATH).with_suffix(".ckpt.json")
        start = 0
        if ckpt.exists():
            try:
                prev = json.loads(ckpt.read_text())
                if isinstance(prev, list) and prev and prev[0].get("lot_number") == lots[0]["lot_number"]:
                    results = prev
                    start = len(prev)
                    print(f"resuming from checkpoint {start}/{len(lots)}")
            except Exception:
                pass
        for i in range(start, len(lots)):
            lot = lots[i]
            if i % 50 == 0:
                print(f"  {i}/{len(lots)}...", flush=True)
            results.append(process_lot(img, lot))
            if i % 100 == 0:
                ckpt.write_text(json.dumps(results))

    # Match unit centroids to polygons by position.
    lot_by_num = {l["lot_number"]: l for l in lots}
    matched = {}   # lot_number -> unit
    orphans = []   # units whose centroid falls outside every polygon
    for r in results:
        for u in r["units"]:
            cx, cy = u["centroid_full"]
            # Candidate lots: source lot first, then any containing polygon.
            placed = None
            src = lot_by_num.get(r["lot_number"])
            if src and point_in_poly(
                    cx / img.width * 100, cy / img.height * 100,
                    src["polygon_pct"]):
                placed = r["lot_number"]
            else:
                for lnum, l in lot_by_num.items():
                    if point_in_poly(cx / img.width * 100,
                                     cy / img.height * 100,
                                     l["polygon_pct"]):
                        placed = lnum
                        break
            u["source_crop"] = r["lot_number"]
            u["matched_lot"] = placed
            if placed is None:
                orphans.append(u)
            else:
                matched.setdefault(placed, []).append(u)

    # Per-lot assembly: prefer unit whose source crop == lot (own label).
    assembled = {}
    for lnum in lot_by_num:
        cands = matched.get(lnum, [])
        own = [u for u in cands if u["source_crop"] == lnum]
        pool = own or cands
        if pool:
            # Prefer units with a number; then closest centroid to polygon
            # centroid (stable, no text guessing).
            def key(u):
                poly = lot_by_num[lnum]["polygon_pct"]
                xs = [p["x"] for p in poly]
                ys = [p["y"] for p in poly]
                pcx = sum(xs) / len(xs) / 100 * img.width
                pcy = sum(ys) / len(ys) / 100 * img.height
                d = abs(u["centroid_full"][0] - pcx) + abs(u["centroid_full"][1] - pcy)
                return (0 if u["number"] else 1, d)
            pool.sort(key=key)
            assembled[lnum] = pool[0]

    n_num = sum(1 for u in assembled.values() if u["number"])
    n_area = len(assembled)
    print(f"\nassembled lots: {n_area}/{len(lots)} "
          f"({100*n_area/len(lots):.1f}%), with number: {n_num}")

    # Contiguity: printed numbers should form mostly contiguous runs per
    # tier (street proxy); report gaps/duplicates, never auto-correct.
    nums = sorted({int(u["number"]) for u in assembled.values() if u["number"]})
    from collections import Counter
    cnt = Counter(int(u["number"]) for u in assembled.values() if u["number"])
    dups = {n: c for n, c in cnt.items() if c > 1}
    gaps = []
    if nums:
        full = set(range(min(nums), max(nums) + 1))
        gaps = sorted(full - set(nums))
    print(f"unique printed numbers: {len(nums)} "
          f"(min {min(nums) if nums else '-'}, max {max(nums) if nums else '-'})")
    print(f"duplicates: {len(dups)} values, e.g. {sorted(dups.items())[:10]}")
    print(f"gaps in {min(nums) if nums else '-'}-{max(nums) if nums else '-'}: "
          f"{len(gaps)} missing")

    # Suspect flags (kept, never auto-corrected): single-digit numbers are
    # usually strip fragments; duplicated numbers need labeler confirmation;
    # areas near the range edges may be partial reads.
    dup_set = set(dups)
    n_suspect = 0
    for lnum, u in assembled.items():
        flags = []
        if u["number"] is None:
            flags.append("area-only")
        elif len(u["number"]) == 1:
            flags.append("single-digit")
        if u["number"] is not None and int(u["number"]) in dup_set:
            flags.append("duplicated-number")
        if u["area_sqm"] is not None and (u["area_sqm"] < 400 or u["area_sqm"] > 2500):
            flags.append("area-near-edge")
        u["suspect"] = flags
        n_suspect += bool(flags)
    print(f"suspect units (flagged, kept): {n_suspect}/{len(assembled)}")

    out = {
        "method": "area-anchored",
        "image": Path(IMG_PATH).name,
        "rules": {"area_format": "ddd(d).dd(d)", "area_range_sqm": [AREA_MIN, AREA_MAX],
                  "sm_adjacency": "SM within 2.5 line-heights", "number_range": [1, 999]},
        "lots_total": len(lots),
        "assembled": n_area,
        "with_number": n_num,
        "suspect_units": n_suspect,
        "orphan_units": len(orphans),
        "contiguity": {"unique_numbers": len(nums),
                       "duplicates": {str(k): v for k, v in sorted(dups.items())},
                       "gaps": gaps},
        "results": results,
        "assembled_units": {k: v for k, v in assembled.items()},
    }
    Path(OUT_PATH).write_text(json.dumps(out, indent=1) + "\n")
    ckpt = Path(OUT_PATH).with_suffix(".ckpt.json")
    if ckpt.exists():
        ckpt.unlink()
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
