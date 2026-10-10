#!/usr/bin/env python3
"""Lot-crop primary OCR pass: crop each polygon with padding, upscale 3x Lanczos,
OCR as one block with whitelist digits . S M, assemble number+area+S.M. as one unit.

Outputs: out/hopkins-ocr/lot-ocr.json with per-lot results.
"""
from __future__ import annotations
import json
import subprocess
import tempfile
import os
from pathlib import Path
from PIL import Image

def poly_bbox_px(poly_pct, img_w, img_h):
    xs = [p["x"] / 100 * img_w for p in poly_pct]
    ys = [p["y"] / 100 * img_h for p in poly_pct]
    return min(xs), min(ys), max(xs), max(ys)

def crop_and_ocr_lot(img, lot, lot_idx, total):
    x0, y0, x1, y1 = poly_bbox_px(lot["polygon_pct"], img.width, img.height)
    # 15% padding, min 80px
    w, h = x1 - x0, y1 - y0
    pad_x = max(80, 0.15 * w) / 2
    pad_y = max(80, 0.15 * h) / 2
    bx0 = max(0, int(x0 - pad_x))
    by0 = max(0, int(y0 - pad_y))
    bx1 = min(img.width, int(x1 + pad_x))
    by1 = min(img.height, int(y1 + pad_y))
    
    crop = img.crop((bx0, by0, bx1, by1))
    
    # Upscale 3x Lanczos
    crop = crop.resize((crop.width * 3, crop.height * 3), Image.LANCZOS)
    
    # Save to temp file
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tf:
        crop.save(tf.name, 'PNG')
        tf_path = tf.name
    
    try:
        # Tesseract with whitelist, single block (psm 6)
        result = subprocess.run([
            'tesseract', tf_path, 'stdout',
            '--psm', '6',
            '-c', 'tessedit_char_whitelist=0123456789.SM',
            '-c', 'preserve_interword_spaces=1'
        ], capture_output=True, text=True, timeout=30)
        text = result.stdout.strip()
    finally:
        os.unlink(tf_path)
    
    # Parse: look for number (digits) and area (digits.digits S.M.)
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    
    number = None
    area = None
    area_raw = None
    
    import re
    # First, find all candidate area values near S.M./SM
    # Pattern: number (with decimal) followed by S.M. or SM
    all_text = ' '.join(lines)
    area_candidates = []
    for m in re.finditer(r'(\d+(?:\.\d+)?)\s*[Ss]\.?\s*[Mm]\.?', all_text):
        try:
            val = float(m.group(1))
            area_candidates.append((val, m.group(0), m.start()))
        except ValueError:
            pass
    
    # Pick the largest area candidate (typical lot areas are 1000+ sqm)
    if area_candidates:
        area_candidates.sort(key=lambda x: -x[0])
        area, area_raw, _ = area_candidates[0]
    
    # Number: find all 2-4 digit numbers that are NOT part of a decimal
    # Use negative lookbehind/lookahead to avoid matching parts of decimals
    number_candidates = []
    for m in re.finditer(r'(?<![\d.])\b(\d{2,4})\b(?![\d.])', all_text):
        val = m.group(1)
        try:
            ival = int(val)
            # Exclude if it matches the integer part of area
            if area is not None and ival == int(area):
                continue
            # Exclude obvious area-like values (1000+)
            if ival >= 1000:
                continue
            number_candidates.append((ival, m.start()))
        except ValueError:
            pass
    
    # Pick the number candidate that appears earliest (top of crop)
    if number_candidates:
        number_candidates.sort(key=lambda x: x[1])
        number = str(number_candidates[0][0])
    
    # Fallback: if no number found but we have area candidates with small values
    if number is None and area_candidates:
        # Check if any area candidate is a plausible lot number (2-4 digits, <1000)
        for val, raw, pos in area_candidates:
            if val < 1000 and val >= 10:
                number = str(int(val))
                break
    
    # Digit height estimate
    digit_h = crop.height / max(1, len(lines)) if lines else 0
    
    return {
        "lot_number": lot["lot_number"],
        "tier_key": lot.get("tier_key"),
        "crop_box": [bx0, by0, bx1, by1],
        "crop_size": [crop.width, crop.height],
        "raw_text": text,
        "lines": lines,
        "number": number,
        "area_sqm": area,
        "area_raw": area_raw,
        "digit_height_px": digit_h,
        "readable": bool(number or area)
    }

def main():
    img = Image.open('out/hopkins-ocr/masterplan_background.webp')
    lots = json.load(open('out/hopkins-ocr/lots.json'))
    
    results = []
    for i, lot in enumerate(lots):
        if i % 50 == 0:
            print(f'  {i}/{len(lots)}...')
        r = crop_and_ocr_lot(img, lot, i, len(lots))
        results.append(r)
    
    # Summary
    numbers = sum(1 for r in results if r["number"])
    areas = sum(1 for r in results if r["area_sqm"] is not None)
    readable = sum(1 for r in results if r["readable"])
    digit_heights = [r["digit_height_px"] for r in results if r["digit_height_px"] > 0]
    
    print(f'\n=== SUMMARY ===')
    print(f'Total lots: {len(results)}')
    print(f'Number read: {numbers} ({100*numbers/len(results):.1f}%)')
    print(f'Area read: {areas} ({100*areas/len(results):.1f}%)')
    print(f'Any readable: {readable} ({100*readable/len(results):.1f}%)')
    if digit_heights:
        print(f'Median digit height: {sorted(digit_heights)[len(digit_heights)//2]:.1f}px')
    
    out = {
        "image": "masterplan_background.webp",
        "total_lots": len(results),
        "summary": {
            "number_read": numbers,
            "area_read": areas,
            "any_readable": readable,
            "median_digit_height_px": sorted(digit_heights)[len(digit_heights)//2] if digit_heights else 0
        },
        "lots": results
    }
    
    Path('out/hopkins-ocr/lot-ocr.json').write_text(json.dumps(out, indent=1) + '\n')
    print('Wrote out/hopkins-ocr/lot-ocr.json')

if __name__ == '__main__':
    main()