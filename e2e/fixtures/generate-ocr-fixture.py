#!/usr/bin/env python3
"""Deterministic synthetic LABELED plan fixture for OCR stages S1-S3.

Renders lots with printed numbers + "<area> S.M." areas (small and rotated
variants, a reserve with curved text), plus the pipeline-format lots.json /
tiers.json and exact ground-truth labels.json. No customer data anywhere.

    python3 e2e/fixtures/generate-ocr-fixture.py [--small-text] [--out e2e/fixtures/ocr-synthetic]

Declared scale (also printed on the plan): roads are 60 ft wide.
FT_PER_PX = 0.5 (road band drawn at exactly 120 px). Printed areas are the
TRUE geometry-derived values, so S3 area validation is self-consistent.

Layout (2400x2000): 100 numbered lots (3 grid blocks of 30 + 10 narrow with
rotated numbers, 25 per tier) + 1 unnumbered reserve with curved text.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

IMG_W, IMG_H = 2400, 2000
FT_PER_PX = 0.5
ROAD_FT = 60
ROAD_PX = int(ROAD_FT / FT_PER_PX)  # 120
PAPER = (244, 241, 232)
ROAD_FILL = (233, 228, 214)
ROAD_EDGE = (120, 115, 100)
INK = (25, 25, 25)

TIERS = [
    ("standard", "Standard", 20000, "#4ade80"),
    ("premium", "Premium", 30000, "#60a5fa"),
    ("estate", "Estate", 45000, "#fbbf24"),
    ("reserve", "Reserve", 60000, "#2dd4bf"),
]

FONT_CANDIDATES = [
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
]

CONDENSED_CANDIDATES = [
    "/System/Library/Fonts/Avenir Next Condensed.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf",
]


def load_font(size: int, condensed: bool = False) -> ImageFont.FreeTypeFont:
    for path in (CONDENSED_CANDIDATES if condensed else []) + FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    print("warning: no TTF found, bitmap fallback (OCR scores will suffer)", file=sys.stderr)
    return ImageFont.load_default()


def poly_area_px(poly) -> float:
    return abs(sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(poly, poly[1:] + poly[:1])) / 2)


def draw_centered(base: Image.Image, center, text: str, font, angle: float = 0.0):
    """Draw text centered at `center` (optionally rotated); return the tight
    ink bbox (alpha getbbox — never the scratch-canvas size)."""
    if angle == 0.0:
        d = ImageDraw.Draw(base)
        box = d.textbbox((0, 0), text, font=font, anchor="mm")
        w, h = box[2] - box[0], box[3] - box[1]
        tmp = Image.new("RGBA", (w + 8, h + 8), (0, 0, 0, 0))
        ImageDraw.Draw(tmp).text((4, 4), text, font=font, fill=INK + (255,))
        ink = tmp.getbbox() or (0, 0, tmp.width, tmp.height)
        piece = tmp.crop(ink)
        x0 = int(center[0] - piece.width / 2)
        y0 = int(center[1] - piece.height / 2)
        base.paste(piece, (x0, y0), piece)
        return [x0, y0, x0 + piece.width, y0 + piece.height]
    tmp_size = 600
    tmp = Image.new("RGBA", (tmp_size, tmp_size), (0, 0, 0, 0))
    ImageDraw.Draw(tmp).text((tmp_size // 2, tmp_size // 2), text, font=font, anchor="mm", fill=INK + (255,))
    rot = tmp.rotate(angle, expand=True, resample=Image.BICUBIC)
    ink = rot.getbbox()
    if ink is None:
        return [center[0], center[1], center[0], center[1]]
    piece = rot.crop(ink)
    x0 = int(center[0] - piece.width / 2)
    y0 = int(center[1] - piece.height / 2)
    base.paste(piece, (x0, y0), piece)
    return [x0, y0, x0 + piece.width, y0 + piece.height]


def draw_curved(base: Image.Image, text: str, font, center, radius: float, span_deg: float, flip: bool = False):
    """Arc text, letter by letter; returns the union bbox (no lot link)."""
    boxes = []
    n = len(text)
    for i, ch in enumerate(text):
        t = (i / max(n - 1, 1) - 0.5) * math.radians(span_deg)
        x = center[0] + radius * math.sin(t)
        y = center[1] - radius * math.cos(t) * (1 if not flip else -1)
        boxes.append(draw_centered(base, (x, y), ch, font, angle=math.degrees(t) * (1 if not flip else -1)))
    xs = [b[0] for b in boxes] + [b[2] for b in boxes]
    ys = [b[1] for b in boxes] + [b[3] for b in boxes]
    return [min(xs), min(ys), max(xs), max(ys)]


def grid(x0, y0, cols, rows, w, h, gx, gy):
    cells = []
    for r in range(rows):
        for c in range(cols):
            x, y = x0 + c * (w + gx), y0 + r * (h + gy)
            # Clamp to the image (real detectors clip at edges too).
            cells.append([clip(x, y) for x, y in [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]])
    return cells


def clip(x, y):
    return (min(max(x, 0), IMG_W), min(max(y, 0), IMG_H))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--small-text", action="store_true", help="render all lot text at 45% size (exercises the upscale path)")
    ap.add_argument("--tough", action="store_true",
                    help="stress variant: condensed type, +-30deg tilted lots, border-touching digits, "
                         "JPEG compression, plus an open-space band (needs --image masterplan_background.jpg)")
    ap.add_argument("--out", default="e2e/fixtures/ocr-synthetic")
    args = ap.parse_args()

    H = IMG_H + (140 if args.tough else 0)
    scale = 0.45 if args.small_text else 1.0
    num_size = max(8, int(36 * scale))
    area_size = max(8, int(24 * scale))
    num_font = load_font(num_size, condensed=args.tough)
    area_font = load_font(area_size, condensed=args.tough)
    small_font = load_font(max(8, int(20 * scale)), condensed=args.tough)

    img = Image.new("RGB", (IMG_W, H), PAPER)
    d = ImageDraw.Draw(img)
    # Roads (the scale reference): vertical x 1140-1260, horizontal y 940-1060.
    d.rectangle([1140, 0, 1260, H], fill=ROAD_FILL)
    d.rectangle([0, 940, IMG_W, 1060], fill=ROAD_FILL)
    for x in (1140, 1260):
        d.line([(x, 0), (x, IMG_H)], fill=ROAD_EDGE, width=3)
    for y in (940, 1060):
        d.line([(0, y), (IMG_W, y)], fill=ROAD_EDGE, width=3)
    draw_centered(img, (1200, 500), "60 FT ROAD", small_font, angle=90)
    draw_centered(img, (600, 1000), "60 FT ROAD", small_font, angle=0)
    draw_centered(img, (200, 1960), "SYNTHETIC PLAN - NOT REAL", small_font)
    draw_centered(img, (2200, 1960), "ROADS 60 FT WIDE", small_font)

    blocks = [
        grid(60, 60, 6, 5, 160, 152, 10, 10),
        grid(1320, 60, 6, 5, 160, 152, 10, 10),
        grid(60, 1120, 6, 5, 160, 152, 10, 10),
        # Narrow flag lots (tall aspect triggers the vertical-text retry).
        grid(1320, 1120, 2, 5, 80, 170, 10, 10),
    ]
    reserve = [(1650, 1130), (2050, 1120), (2330, 1180), (2340, 1500), (2200, 1930), (1800, 1940), (1640, 1600)]
    narrow_start = 90  # first 90 lots are unrotated; last 10 rotated

    lots, tokens, lot_records = [], [], []
    n = 0
    for block in blocks:
        for poly in block:
            n += 1
            tier = TIERS[(n - 1) % 4]
            number = f"{n:02d}" if n < 100 else "100"
            area_sqm = round(poly_area_px(poly) * FT_PER_PX * FT_PER_PX / 10.7639, 2)
            area_text = f"{area_sqm:.2f} S.M."
            xs = [p[0] for p in poly]
            ys = [p[1] for p in poly]
            d.polygon(poly, outline=(40, 40, 40))
            rotated = n > narrow_start
            tilted = args.tough and not rotated and n % 8 == 0
            touching = args.tough and not rotated and n % 12 == 5
            cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
            if rotated:
                # Narrow flag lots carry the number only (a 170px column
                # cannot hold both rotated lines); areas stay covered on the
                # other lots.
                num_box = draw_centered(img, (cx, cy - 14 * scale), number, num_font, angle=90)
                tokens.append({"lot": number, "kind": "number", "text": number, "bbox": [round(v, 1) for v in num_box]})
            else:
                num_angle = (30 if (n // 8) % 2 == 0 else -30) if tilted else 0
                num_cx = cx
                if touching:
                    # Digits crossing the lot border (border welds onto glyphs).
                    probe = ImageDraw.Draw(img).textbbox((0, 0), number, font=num_font)
                    num_cx = min(xs) + (probe[2] - probe[0]) / 2 - 6
                num_box = draw_centered(img, (num_cx, cy - 14 * scale), number, num_font, angle=num_angle)
                tokens.append({"lot": number, "kind": "number", "text": number, "bbox": [round(v, 1) for v in num_box]})
                area_box = draw_centered(img, (cx, cy + 20 * scale), area_text, area_font, angle=num_angle)
                tokens.append({"lot": number, "kind": "area", "text": area_text, "bbox": [round(v, 1) for v in area_box]})
            lot_records.append({"lot_number": number, "tier_key": tier[0], "price": tier[2],
                                "polygon_pct": [{"x": round(x / IMG_W * 100, 3), "y": round(y / H * 100, 3)} for x, y in poly],
                                "confidence": 1.0, "needs_review": False, "source": "synthetic"})
    assert n == 100, f"expected 100 lots, got {n}"

    d.polygon(reserve, outline=(40, 40, 40))
    res_box = draw_curved(img, "CREEKSIDE RESERVE", load_font(max(10, int(30 * scale)), condensed=args.tough),
                          center=(1990, 1680), radius=420, span_deg=38)
    decoys = [{"kind": "reserve-text", "text": "CREEKSIDE RESERVE", "bbox": [round(v, 1) for v in res_box]}]

    open_space = None
    if args.tough:
        # Open-space band below the lots: axis-aligned rect + printed acres
        # (true value from geometry, so the check is self-consistent).
        ox0, oy0, ox1, oy1 = 500, 2010, 1900, 2130
        d.rectangle([ox0, oy0, ox1, oy1], outline=(40, 40, 40))
        acres_true = (ox1 - ox0) * (oy1 - oy0) * FT_PER_PX * FT_PER_PX / 43560
        acres_text = f"{acres_true:.2f} ACRES"
        os_box = draw_centered(img, ((ox0 + ox1) / 2, (oy0 + oy1) / 2), acres_text,
                               load_font(max(10, int(28 * scale)), condensed=True))
        open_space = {"bbox_px": [ox0, oy0, ox1, oy1], "printed_acres": round(acres_true, 2),
                      "label": acres_text, "label_bbox": [round(v, 1) for v in os_box]}

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    if args.tough:
        img.save(out / "masterplan_background.jpg", "JPEG", quality=70)
    else:
        img.save(out / "masterplan_background.webp", "WEBP", quality=85)
    tiers = {"tiers": {k: {"label": lab, "price": p, "legend": c} for k, lab, p, c in TIERS}}
    (out / "tiers.json").write_text(json.dumps(tiers, indent=1) + "\n")
    (out / "lots.json").write_text(json.dumps(lot_records, indent=1) + "\n")
    (out / "labels.json").write_text(json.dumps({
        "scale_ft_per_px": FT_PER_PX, "road_width_ft": ROAD_FT,
        "image": {"width": IMG_W, "height": H},
        "tokens": tokens, "decoys": decoys,
        "reserve": {"text": "CREEKSIDE RESERVE"},
        "open_space": open_space,
    }, indent=1) + "\n")
    print(f"wrote 100 lots + {len(tokens)} tokens -> {out} (small-text={args.small_text}, tough={args.tough})")


if __name__ == "__main__":
    main()
