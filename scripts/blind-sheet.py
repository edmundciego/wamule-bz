#!/usr/bin/env python3
"""Blind labeling sheet: stratified random lots as image crops with NO OCR
text shown, for unbiased human labeling of printed numbers and areas.

    python3 scripts/blind-sheet.py --lots <lots.json> --image <plan>
      --out <sheet-dir> --n 100 --seed 7

Stratification: quotas per tier (largest-remainder, minimum 2 per tier),
then quadrant x aspect-class balance within each tier (seeded shuffle for
ties). Crop = lot bbox + 30% margin (min 160px), native resolution.

Outputs: S001.png..., labels_template.csv (id + EMPTY number/area columns),
mapping.json ({id: lot_number/tier} — SEALED: labeling from crops only),
README.md with instructions. Scoring: scripts/score-labels.py once the
template comes back filled. Nothing here reads OCR output (blind by
construction).
"""
from __future__ import annotations

import argparse
import csv
import json
import random
from pathlib import Path


def centroid(poly):
    xs = [p["x"] for p in poly]
    ys = [p["y"] for p in poly]
    return ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)


def aspect_class(poly):
    xs = [p["x"] for p in poly]
    ys = [p["y"] for p in poly]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    if h <= 0:
        return "square"
    r = w / h
    if r > 1.5:
        return "wide"
    if r < 1 / 1.5:
        return "tall"
    return "square"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lots", required=True)
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=100)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    from PIL import Image
    lots = json.loads(Path(args.lots).read_text())
    img = Image.open(args.image)
    W, H = img.size
    rng = random.Random(args.seed)

    by_tier: dict[str, list[dict]] = {}
    for lot in lots:
        by_tier.setdefault(str(lot.get("tier_key") or "unknown"), []).append(lot)

    # Quotas: minimum 2 per tier present, remainder proportional to tier
    # population (largest remainder), so big tiers dominate the sample.
    quotas: dict[str, int] = {}
    pool = {tier: rows for tier, rows in by_tier.items()}
    remaining = args.n
    for tier, rows in pool.items():
        quotas[tier] = min(len(rows), 2)
        remaining -= quotas[tier]
    if remaining < 0:
        raise SystemExit("sample too small for tier minimums")
    eligible = {tier: len(rows) - quotas[tier] for tier, rows in pool.items() if len(rows) - quotas[tier] > 0}
    total_elig = sum(eligible.values())
    if total_elig > 0:
        fractions = []
        for tier, room in eligible.items():
            exact = remaining * room / total_elig
            add = min(room, int(exact))
            quotas[tier] += add
            remaining -= add
            fractions.append((exact - add, tier))
        fractions.sort(reverse=True)
        i = 0
        while remaining > 0:
            tier = fractions[i % len(fractions)][1]
            if quotas[tier] < len(pool[tier]):
                quotas[tier] += 1
                remaining -= 1
            i += 1
            if i > 100000:
                raise SystemExit("quota loop did not converge")
    assert sum(quotas.values()) == args.n, quotas

    # Within tier: quadrant x aspect balance, seeded shuffle for ties.
    picked = []
    for tier, rows in sorted(by_tier.items()):
        annotated = []
        for lot in rows:
            cx, cy = centroid(lot["polygon_pct"])
            quad = ("W" if cx < 50 else "E") + ("N" if cy < 50 else "S")
            annotated.append((lot, quad, aspect_class(lot["polygon_pct"])))
        rng.shuffle(annotated)
        bins: dict[tuple[str, str], list] = {}
        for lot, quad, aspect in annotated:
            bins.setdefault((quad, aspect), []).append(lot)
        take = quotas[tier]
        keys = sorted(bins)
        k = 0
        chosen = []
        while len(chosen) < take:
            progressed = False
            for key in keys:
                if len(chosen) >= take:
                    break
                if bins[key]:
                    chosen.append(bins[key].pop(0))
                    progressed = True
            k += 1
            if not progressed or k > 10000:
                break
        picked.extend([(tier, lot) for lot in chosen])
    assert len(picked) == args.n, f"picked {len(picked)}, wanted {args.n}"

    out = Path(args.out)
    (out / "crops").mkdir(parents=True, exist_ok=True)
    mapping = {}
    with open(out / "labels_template.csv", "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["id", "printed_number", "printed_area_sqm"])
        for i, (tier, lot) in enumerate(picked, start=1):
            sid = f"S{i:03d}"
            xs = [p["x"] / 100 * W for p in lot["polygon_pct"]]
            ys = [p["y"] / 100 * H for p in lot["polygon_pct"]]
            x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
            pad_x = max(160 - (x1 - x0), 0.3 * (x1 - x0)) / 2
            pad_y = max(160 - (y1 - y0), 0.3 * (y1 - y0)) / 2
            box = (max(0, int(x0 - pad_x)), max(0, int(y0 - pad_y)),
                   min(W, int(x1 + pad_x)), min(H, int(y1 + pad_y)))
            img.crop(box).save(out / "crops" / f"{sid}.png")
            writer.writerow([sid, "", ""])
            mapping[sid] = {"lot_number": lot["lot_number"], "tier_key": tier,
                            "crop_box_px": list(box)}
    (out / "mapping.json").write_text(json.dumps(mapping, indent=1) + "\n")
    (out / "README.md").write_text(
        "# Blind labeling sheet\n\n"
        "Crop filenames are random IDs (S001...); lot numbers are NOT shown.\n"
        "Do NOT open mapping.json until scoring (it breaks the blind).\n\n"
        "For each crop, fill labels_template.csv:\n"
        "- printed_number: the lot number printed inside the crop (exact digits).\n"
        "- printed_area_sqm: the printed area figure in square metres, digits and\n"
        "  decimals only (e.g. 1011.876). Leave blank when no area is printed.\n"
        "Leave a row blank (besides id) when the crop shows no readable number.\n\n"
        "Then run: python3 scripts/score-labels.py --sheet <dir> \\\n"
        "  --labels labels_template.csv --ocr <ocr.json>\n"
    )
    from collections import Counter
    print(f"sheet: {len(picked)} crops -> {out}/crops/")
    print("tier quotas:", {t: sum(1 for tt, _ in picked if tt == t) for t in sorted(by_tier)})


if __name__ == "__main__":
    main()
