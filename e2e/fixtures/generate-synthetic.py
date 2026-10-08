#!/usr/bin/env python3
"""Generate the committed synthetic e2e map fixture (no customer data).

Writes e2e/fixtures/synthetic/: lots.json, tiers.json,
masterplan_background.webp — the exact filenames PublicLotMap.loadDemo
expects. Deterministic; rerun anytime:
    python3 e2e/fixtures/generate-synthetic.py

Layout (map space: x 0-100, y 0-84.2, i.e. 1200x1010 @1.188 aspect):
  - 54 standard grid lots (two blocks split by cross roads)
  - 4 tiny lots (1.4x1.4: labels gated off until 4x by the fs*zoom rule)
  - 1 huge lot (35x20: label size capped at MAX_LABEL_PX)
  - 1 irregular reserve polygon (7 vertices, capped label)
Total: 60 lots, all Available, clearly-fake S-### numbering.
"""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent / "synthetic"
IMG_W, IMG_H = 1200, 1010  # aspect 1.1881 -> viewBox height 84.18

TIERS = {
    "standard": {"label": "Standard", "price": 20000, "legend": "#4ade80"},
    "premium": {"label": "Premium", "price": 30000, "legend": "#60a5fa"},
    "estate": {"label": "Estate", "price": 45000, "legend": "#fbbf24"},
    "reserve": {"label": "Reserve", "price": 60000, "legend": "#2dd4bf"},
}


def rect(x: float, y: float, w: float, h: float) -> list[dict[str, float]]:
    return [
        {"x": x, "y": y},
        {"x": x + w, "y": y},
        {"x": x + w, "y": y + h},
        {"x": x, "y": y + h},
    ]


def grid(x0: float, y0: float, cols: int, rows: int, w: float, h: float, gx: float, gy: float):
    for r in range(rows):
        for c in range(cols):
            yield rect(x0 + c * (w + gx), y0 + r * (h + gy), w, h)


def build_lots() -> list[dict]:
    polys: list[tuple[list[dict[str, float]], str]] = []
    # NW block: 6x5 standard/premium rows (x 4-46, y 4-38).
    for i, p in enumerate(grid(4, 4, 6, 5, 6.3, 6.2, 0.7, 0.7)):
        polys.append((p, "premium" if (i // 6) % 2 else "standard"))
    # NE block: 6x4 premium/estate rows (x 54-96, y 4-38).
    for i, p in enumerate(grid(54, 4, 6, 4, 6.3, 7.9, 0.7, 0.75)):
        polys.append((p, "estate" if (i // 6) % 2 else "premium"))
    # Tiny row (labels appear only at 4x).
    for p in grid(4, 48, 4, 1, 1.4, 1.4, 0.6, 0.6):
        polys.append((p, "standard"))
    # Huge lot (label capped on screen).
    polys.append((rect(60, 48, 35, 20), "estate"))
    # Irregular reserve (7 vertices).
    polys.append((
        [
            {"x": 4, "y": 64}, {"x": 20, "y": 62}, {"x": 34, "y": 66},
            {"x": 36, "y": 76}, {"x": 24, "y": 82}, {"x": 10, "y": 80}, {"x": 3, "y": 72},
        ],
        "reserve",
    ))
    assert len(polys) == 60, f"expected 60 lots, got {len(polys)}"
    # Fixed statuses exercise the waitlist (Reserved) and no-inquiry (Sold)
    # UI paths. Everything else stays Available.
    STATUS = {"S-054": "Sold", "S-059": "Reserved", "S-060": "Reserved"}
    lots = []
    for n, (poly, tier) in enumerate(polys, start=1):
        lot_number = f"S-{n:03d}"
        lots.append({
            "lot_number": lot_number,
            "tier_key": tier,
            "price": TIERS[tier]["price"],
            "status": STATUS.get(lot_number, "Available"),
            "polygon_pct": [{k: round(v, 3) for k, v in pt.items()} for pt in poly],
        })
    return lots


def build_background() -> None:
    img = Image.new("RGB", (IMG_W, IMG_H), "#e7eee3")
    d = ImageDraw.Draw(img)
    for gx in range(0, IMG_W + 1, 60):
        d.line([(gx, 0), (gx, IMG_H)], fill="#d3dccf")
    for gy in range(0, IMG_H + 1, 60):
        d.line([(0, gy), (IMG_W, gy)], fill="#d3dccf")
    # Cross roads matching the lot blocks: vertical x 48-52%, horizontal y 40-44/84.2.
    d.rectangle([IMG_W * 0.48, 0, IMG_W * 0.52, IMG_H], fill="#f5f2e8")
    y0, y1 = IMG_H * 40 / 84.2, IMG_H * 44 / 84.2
    d.rectangle([0, y0, IMG_W, y1], fill="#f5f2e8")
    d.text((10, IMG_H - 24), "SYNTHETIC E2E FIXTURE - NOT A REAL PLAT", fill="#8a938a")
    img.save(OUT / "masterplan_background.webp", "WEBP", quality=80)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    lots = build_lots()
    (OUT / "lots.json").write_text(json.dumps(lots, indent=1) + "\n")
    (OUT / "tiers.json").write_text(json.dumps({"tiers": TIERS}, indent=1) + "\n")
    build_background()
    tiny = sum(1 for lot in lots if len(lot["polygon_pct"]) == 4 and lot["polygon_pct"][2]["x"] - lot["polygon_pct"][0]["x"] < 2)
    print(f"wrote {len(lots)} lots ({tiny} tiny) + tiers + background -> {OUT}")


if __name__ == "__main__":
    main()
