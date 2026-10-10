#!/usr/bin/env python3
"""OCR stages S1-S3 for tenant builds: read printed lot numbers and areas
from the plan raster at native resolution, match them to polygons by
position, and validate polygon areas against a measured scale reference.

    python3 scripts/ocr-match.py --dir <build-dir> --tiers <tiers.json>
      [--labels labels.json] [--engines tesseract|rapidocr|both]
      [--road-band X0,X1 --road-width-ft 60]
      [--number-pattern '\\d{2,3}' --number-min 1 --number-max 999]
      [--confidence-floor 0.5] [--token-threshold 0.95 --char-threshold 0.98]
      [--area-tolerance 0.08] [--stage ocr|match|validate|all]

Reads build/lots.json (polygon_pct, 0-100 space) + masterplan_background.webp.
Writes build/ocr.json, patches lots.json (printed_lot_number,
printed_area_sqm, match_status, area_status, area_ratio), extends
build/ingest-report.json (ocr/matching/area/paint_out_gate), and writes
build/ocr-qa.html (SVG overlay of boxes + match status).

S1 OCR: Tesseract 5 TSV (psm 6) and/or RapidOCR, word->line grouping,
two token classes with constrained decoding (LOT number, AREA figure).
Upscale rule: estimate median digit-box height at native res; upscale only
if < ~20px (factor 24/median, capped 3x) and re-run.
S2 matching gates: exactly one number token centroid inside the polygon,
tenant pattern/range, confidence floor; the same number claimed by 2+ lots
flags ALL claimants (duplicates flag BOTH, never first-claim); multiple
distinct numbers inside one polygon also flags it. Unmatched lots keep
needs_review. Area figure: the area token in the same polygon (exactly one).
S3 area validation: scale derived from a stated reference (road width in ft
divided by its MEASURED px width in the raster — never from match medians);
polygon px-area -> sqft -> sqm; |ratio-1| <= tolerance else redraw queue.

Comparison mode (--labels + both engines): evaluates each engine on the
labeled sample (token + character accuracy, overall/per-class/per-tier) and
gates on the thresholds (exit 3 below). Without labels: single engine
(tesseract default), no accuracy gate.

Exit codes: 0 ok; 2 usage/missing input/engines; 3 below accuracy threshold.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Exact by definition (international foot): 1 ft = 0.3048 m.
FT_TO_M = 0.3048
ACRES_PER_SQFT = 1.0 / 43560.0
DIGIT_TARGET_PX = 20.0
UPSCALE_CAP = 3.0


def fail(msg: str) -> "NoReturn":
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(2)


def have_tesseract() -> bool:
    return shutil.which("tesseract") is not None


def have_rapidocr() -> bool:
    try:
        import rapidocr_onnxruntime  # noqa: F401
        return True
    except Exception:
        return False


# ---------------------------------------------------------------- S1: OCR

def tesseract_tsv(image: Path) -> list[dict]:
    try:
        proc = subprocess.run(
            ["tesseract", str(image), "stdout", "--psm", "6", "tsv"],
            capture_output=True, timeout=600,
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"tesseract timed out on {image}") from e
    if proc.returncode != 0:
        raise RuntimeError(f"tesseract failed: {proc.stderr.decode('utf8', 'replace').strip()[:300]}")
    # Manual parse (not csv.DictReader): misread glyphs can embed literal
    # tabs/newlines that would shift DictReader columns and fabricate tokens.
    # TSV has 12 columns; the text field is everything after the 11th tab.
    rows = []
    for line in proc.stdout.decode("utf8", "replace").splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) < 12:
            continue
        level, _, _, _, _, _, left, top, width, height, conf = parts[:11]
        text = "\t".join(parts[11:]).replace("\t", " ").replace("\n", " ")
        rows.append({"level": level, "left": left, "top": top, "width": width,
                     "height": height, "conf": conf, "text": text})
    words = []
    for r in rows:
        try:
            if int(r["level"]) != 5:
                continue
        except (KeyError, ValueError):
            continue
        text = (r.get("text") or "").strip()
        if not text:
            continue
        try:
            conf = int(float(r.get("conf", "-1")))
        except ValueError:
            conf = -1
        words.append({
            "text": text,
            "box": [int(r["left"]), int(r["top"]), int(r["left"]) + int(r["width"]), int(r["top"]) + int(r["height"])],
            "conf": conf / 100.0,
            "line_key": ("tess", r.get("left"), r.get("top")),
        })
    return words


def rapidocr_lines(image: Path) -> list[dict]:
    try:
        from rapidocr_onnxruntime import RapidOCR
        from PIL import Image
        ocr = RapidOCR()
        out, _ = ocr(str(image))
    except Exception as e:
        raise RuntimeError(f"rapidocr failed: {str(e)[:300]}") from e
    words = []
    img = Image.open(image)
    _w, _h = img.size
    for quad, text, score in (out or []):
        text = (text or "").strip()
        if not text:
            continue
        xs = [p[0] for p in quad]
        ys = [p[1] for p in quad]
        # True text angle from the quad's top edge (axis-aligned bboxes lose
        # it); normalized to [-90, 90). Tesseract boxes stay axis-aligned.
        dx = quad[1][0] - quad[0][0]
        dy = quad[1][1] - quad[0][1]
        angle = math.degrees(math.atan2(dy, dx))
        while angle <= -90:
            angle += 180
        while angle > 90:
            angle -= 180
        # RapidOCR emits line-level boxes already; keep each as one word so
        # the shared line-grouper below is a no-op for it.
        words.append({
            "text": text,
            "box": [min(xs), min(ys), max(xs), max(ys)],
            "conf": float(score),
            "line_key": ("rapid", text),
            "angle_deg": round(angle, 1),
        })
    return words


def digit_height_median(words: list[dict]) -> float | None:
    heights = [w["box"][3] - w["box"][1] for w in words if re.search(r"\d", w["text"]) and w["conf"] >= 0]
    if not heights:
        return None
    heights.sort()
    mid = len(heights) // 2
    return float(heights[mid] if len(heights) % 2 else (heights[mid - 1] + heights[mid]) / 2)


def assemble_areas(lines: list[dict]) -> list[dict]:
    """Merge a bare-decimal line with an S.M. unit line directly below it
    (plat convention: figure over unit; periods often unread). Returns new
    line list; merged lines keep min conf and union boxes."""
    used: set[int] = set()
    out = []
    for i, line in enumerate(lines):
        if i in used:
            continue
        text = line["text"].strip()
        if not re.fullmatch(r"\d+\.\d+[.,;:']?", text):
            out.append(line)
            continue
        # Unit line directly below: contains S[.]M[.]? possibly with cruft.
        best = None
        for j, other in enumerate(lines):
            if j == i or j in used:
                continue
            otext = other["text"].strip().upper()
            for q in ("‘", "’", "“", "”", "'", '"'):
                otext = otext.replace(q, "")
            if not re.search(r"\bS\.?\s*M\.?\b", otext):
                continue
            ox0, _, ox1, _ = other["box"]
            x0, _, x1, _ = line["box"]
            overlap = max(0, min(x1, ox1) - max(x0, ox0))
            if overlap < 0.5 * min(x1 - x0, ox1 - ox0):
                continue
            gap = other["box"][1] - line["box"][3]
            h = line["box"][3] - line["box"][1]
            if 0 <= gap <= 1.5 * h:
                best = j
                break
        if best is not None:
            other = lines[best]
            used.add(i)
            used.add(best)
            x0 = min(line["box"][0], other["box"][0])
            y0 = min(line["box"][1], other["box"][1])
            x1 = max(line["box"][2], other["box"][2])
            y1 = max(line["box"][3], other["box"][3])
            out.append({"text": f"{text} S.M.", "box": [x0, y0, x1, y1],
                        "conf": min(line["conf"], other["conf"])})
            continue
        out.append(line)
    return out


def box_iou(a: list[float], b: list[float]) -> float:
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    if inter <= 0:
        return 0.0
    aa = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    bb = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = aa + bb - inter
    return inter / union if union > 0 else 0.0


def ensemble_agree(tess_tokens: list[dict], rapid_tokens: list[dict]) -> dict:
    """Two-engine agreement: accept a tesseract token only when a rapidocr
    token carries the same normalized key with overlapping box (IoU > 0.12).
    Returns agreed tokens + rate stats. Rotation tokens are NOT part of the
    agreement (tesseract-only enhancement); they ride along separately and
    are reported as such."""
    used: set[int] = set()
    agreed = []
    for t in tess_tokens:
        if t["kind"] not in ("number", "area"):
            continue
        key = token_key(t["kind"], t["text"])
        best, best_iou = None, 0.0
        for i, r in enumerate(rapid_tokens):
            if i in used or r["kind"] != t["kind"]:
                continue
            if token_key(r["kind"], r["text"]) != key:
                continue
            iou = box_iou(t["box"], r["box"])
            if iou > best_iou:
                best, best_iou = i, iou
        if best is not None and best_iou > 0.12:
            used.add(best)
            agreed.append(t)
    union = len([t for t in tess_tokens if t["kind"] in ("number", "area")]) + \
        len([r for i, r in enumerate(rapid_tokens) if i not in used and r["kind"] in ("number", "area")])
    return {"tokens": agreed,
            "agree_rate": round(len(agreed) / union, 4) if union else None,
            "agreed": len(agreed), "union": union}


def group_lines(words: list[dict]) -> list[dict]:
    """Cluster word boxes into text lines: vertical overlap for rows, then
    split on wide horizontal gaps so adjacent lots never merge. Pure
    punctuation tokens (grid-line artifacts like ||) are dropped first —
    neither token class needs them."""
    words = [w for w in words if re.search(r"[A-Za-z0-9]", w["text"])]
    remaining = sorted(words, key=lambda w: (w["box"][1] + w["box"][3]) / 2)
    rows: list[list[dict]] = []
    for word in remaining:
        placed = False
        cy = (word["box"][1] + word["box"][3]) / 2
        h = word["box"][3] - word["box"][1]
        for row in rows:
            lcy = sum((w["box"][1] + w["box"][3]) / 2 for w in row) / len(row)
            lh = max(w["box"][3] - w["box"][1] for w in row)
            if abs(cy - lcy) < 0.5 * min(h, lh):
                row.append(word)
                placed = True
                break
        if not placed:
            rows.append([word])
    out = []
    for row in rows:
        row.sort(key=lambda w: w["box"][0])
        # Split where the gap dwarfs the type size (inter-lot / road gaps).
        chunks: list[list[dict]] = [[]]
        prev = None
        for word in row:
            if prev is not None:
                gap = word["box"][0] - prev["box"][2]
                ref_h = min(word["box"][3] - word["box"][1], prev["box"][3] - prev["box"][1])
                if gap > max(15.0, 1.5 * ref_h):
                    chunks.append([])
            chunks[-1].append(word)
            prev = word
        for line in chunks:
            if not line:
                continue
            x0 = min(w["box"][0] for w in line)
            y0 = min(w["box"][1] for w in line)
            x1 = max(w["box"][2] for w in line)
            y1 = max(w["box"][3] for w in line)
            # Mean (not min): one shaky word must not sink a line the
            # constrained patterns already accept — the regex is the gate.
            out.append({
                "text": " ".join(w["text"] for w in line),
                "box": [x0, y0, x1, y1],
                "conf": sum(w["conf"] for w in line) / len(line),
            })
    return out


BORDER_ARTIFACTS = "()[]{}|\\/"


def strip_border_artifacts(text: str) -> str:
    """Strip welded lot-border punctuation ("]", ")", "|", "/").
    Alphanumeric lookalikes (l, I, 1) are deliberately NOT stripped: real
    numbers start and end with 1s constantly ("10" must survive)."""
    return re.sub(f"^[{re.escape(BORDER_ARTIFACTS)}]+|[{re.escape(BORDER_ARTIFACTS)}]+$", "", text)


def classify_line(text: str, number_pattern: str) -> tuple[str, str | float | None]:
    norm = re.sub(r"\s+", " ", text.strip().upper())
    norm = norm.strip("\"'‘’“”")
    if re.fullmatch(number_pattern, norm):
        return ("number", norm)
    stripped = strip_border_artifacts(norm)
    if stripped != norm and re.fullmatch(number_pattern, stripped):
        return ("number", stripped)
    m = re.fullmatch(r"(\d+\.\d+)[,;:]?\s*S\.?M\.?", norm)
    if m:
        return ("area", float(m.group(1)))
    return ("other", None)


def rotation_retry_lots(image: Path, lots_px: list[dict], number_pattern: str) -> list[dict]:
    """Orientation retry for tall-narrow lots (vertical plat text): crop the
    lot interior, try both 90° transposes via psm 6. Returns per-lot,
    per-orientation reads; the caller keeps only the winning orientation
    (most pattern matches, then confidence), because the wrong rotation
    reads upside-down digits as other numbers (91 -> 16)."""
    from PIL import Image
    img = Image.open(image)
    out = []
    skipped = 0
    for lot in lots_px:
        xs = [p[0] for p in lot["poly"]]
        ys = [p[1] for p in lot["poly"]]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        w, h = x1 - x0, y1 - y0
        if not (h > 1.8 * w and w >= 30):
            continue
        try:
            for angle in (Image.ROTATE_90, Image.ROTATE_270):
                tmp = image.with_suffix(".rot-tmp.png")
                # White margin: Tesseract drops text touching the image edge.
                turned = crop_for(image, img, (x0, y0, x1, y1), angle)
                turned.save(tmp)
                try:
                    lined = []
                    for line in group_lines(tesseract_tsv(tmp)):
                        kind, value = classify_line(line["text"], number_pattern)
                        if kind in ("number", "area"):
                            lined.append({
                                "text": line["text"],
                                "kind": kind,
                                "value": value,
                                "box": [x0 + 0.1 * w, y0 + 0.1 * h, x1 - 0.1 * w, y1 - 0.1 * h],
                                "conf": line["conf"],
                                "rotation_lot": lot["lot_number"],
                            })
                finally:
                    tmp.unlink(missing_ok=True)
                if lined:
                    out.append({"lot": lot["lot_number"], "orientation": angle, "tokens": lined})
        except Exception as e:
            skipped += 1
            print(f"[ocr-match] rotation retry skipped lot {lot['lot_number']}: {str(e)[:120]}")
    if skipped:
        print(f"[ocr-match] rotation retry skipped {skipped} lots (see above; base reads stand)")
    return out


def crop_for(image: Path, img, bbox: tuple[float, float, float, float], angle) -> "Image.Image":
    """Crop lot interior with margin, transpose, white margin."""
    from PIL import Image
    x0, y0, x1, y1 = bbox
    w, h = x1 - x0, y1 - y0
    crop = img.crop((int(x0 + 0.1 * w), int(y0 + 0.1 * h), int(x1 - 0.1 * w), int(y1 - 0.1 * h)))
    turned = crop.transpose(angle)
    sheet = Image.new("RGB", (turned.width + 48, turned.height + 48), (255, 255, 255))
    sheet.paste(turned, (24, 24))
    return sheet


def run_engine(engine: str, image: Path) -> tuple[list[dict], dict]:
    """Run once at native res; upscale only if median digit height < ~20px."""
    from PIL import Image
    if engine == "tesseract":
        words = tesseract_tsv(image)
    elif engine == "rapidocr":
        words = rapidocr_lines(image)
    else:
        fail(f"unknown engine: {engine}")
    median = digit_height_median(words)
    info: dict = {"engine": engine, "digit_height_median": median, "upscaled": {"applied": False, "factor": 1.0}}
    if median is not None and median < DIGIT_TARGET_PX:
        factor = min(DIGIT_TARGET_PX / median, UPSCALE_CAP)
        if factor > 1.05:
            img = Image.open(image)
            big = img.resize((round(img.width * factor), round(img.height * factor)), Image.LANCZOS)
            tmp = image.with_suffix(f".upscaled-{engine}.png")
            big.save(tmp)
            words = tesseract_tsv(tmp) if engine == "tesseract" else rapidocr_lines(tmp)
            for w in words:
                x0, y0, x1, y1 = w["box"]
                w["box"] = [x0 / factor, y0 / factor, x1 / factor, y1 / factor]
            tmp.unlink(missing_ok=True)
            info["upscaled"] = {"applied": True, "factor": round(factor, 2)}
            info["digit_height_median"] = digit_height_median(words)
    return words, info


def ocr_image(engine: str, image: Path, number_pattern: str) -> dict:
    from PIL import Image
    w, h = Image.open(image).size
    words, info = run_engine(engine, image)
    tokens = []
    for i, line in enumerate(assemble_areas(group_lines(words))):
        kind, value = classify_line(line["text"], number_pattern)
        tokens.append({
            "id": f"{engine}-{i}",
            "text": line["text"],
            "kind": kind,
            "value": value,
            "box": [round(v, 1) for v in line["box"]],
            "conf": round(line["conf"], 3),
        })
    return {
        "engine": engine,
        "image": {"width": w, "height": h},
        "digit_height_median": info["digit_height_median"],
        "upscaled": info["upscaled"],
        "tokens": tokens,
    }


# ------------------------------------------------------- comparison mode

def levenshtein(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[-1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def normalize_token_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().upper())


def area_value(text: str) -> float | None:
    m = re.fullmatch(r"(\d+\.\d+)\s*S\.?M\.?", normalize_token_text(text))
    return float(m.group(1)) if m else None


def token_key(kind: str, text: str):
    """Equality key: numbers exact after border-artifact stripping; areas by
    parsed value (whitespace between the figure and S.M. carries nothing)."""
    if kind == "area":
        value = area_value(text)
        return ("area", value) if value is not None else ("area-text", normalize_token_text(text).replace(" ", ""))
    return ("number", strip_border_artifacts(text.strip().upper()))


def evaluate_engine(ocr: dict, labels: dict, lot_tier: dict[str, str]) -> dict:
    """Match engine tokens to ground-truth tokens (same text, center inside
    gt box +6px, one use each). Token accuracy = exact matches / total.
    Char accuracy = 1 - lev/total_chars (unmatched gt counts fully wrong)."""
    gt = labels["tokens"]
    used: set[int] = set()
    matched = 0
    lev_total = 0
    char_total = 0
    per_class: dict[str, dict[str, int | float]] = {}
    per_tier: dict[str, dict[str, int | float]] = {}
    for g in gt:
        want = token_key(g["kind"], g["text"])
        char_total += len(g["text"])
        gx = (g["bbox"][0] + g["bbox"][2]) / 2
        gy = (g["bbox"][1] + g["bbox"][3]) / 2
        hit = None
        for i, t in enumerate(ocr["tokens"]):
            if i in used:
                continue
            if token_key(t["kind"], t["text"]) != want:
                continue
            cx = (t["box"][0] + t["box"][2]) / 2
            cy = (t["box"][1] + t["box"][3]) / 2
            if g["bbox"][0] - 6 <= cx <= g["bbox"][2] + 6 and g["bbox"][1] - 6 <= cy <= g["bbox"][3] + 6:
                hit = i
                break
        cls = per_class.setdefault(g["kind"], {"total": 0, "matched": 0, "lev": 0, "chars": 0})
        cls["total"] += 1
        cls["chars"] += len(g["text"])
        tier = per_tier.setdefault(lot_tier.get(g.get("lot", ""), "unknown"), {"total": 0, "matched": 0, "lev": 0,
                                                                               "chars": 0})
        tier["total"] += 1
        tier["chars"] += len(g["text"])
        if hit is None:
            lev_total += len(g["text"])
            cls["lev"] += len(g["text"])
            tier["lev"] += len(g["text"])
            continue
        used.add(hit)
        matched += 1
        cls["matched"] += 1
        tier["matched"] += 1
        # Residual distance on whitespace-normalized text (spacing variants
        # of the same area figure are not character errors).
        lev = levenshtein(normalize_token_text(ocr["tokens"][hit]["text"]).replace(" ", ""),
                           normalize_token_text(g["text"]).replace(" ", ""))
        lev_total += lev
        cls["lev"] += lev
        tier["lev"] += lev
    for bucket in list(per_class.values()) + list(per_tier.values()):
        bucket["token_accuracy"] = round(bucket["matched"] / bucket["total"], 4) if bucket["total"] else None
        bucket["char_accuracy"] = round(1 - bucket["lev"] / bucket["chars"], 4) if bucket["chars"] else None
    return {
        "tokens_total": len(gt),
        "tokens_matched": matched,
        "token_accuracy": round(matched / len(gt), 4) if gt else None,
        "char_accuracy": round(1 - lev_total / char_total, 4) if char_total else None,
        "per_class": per_class,
        "per_tier": per_tier,
        "gx": gx if gt else None,
        "gy": gy if gt else None,
    }


# ---------------------------------------------------------------- S2/S3

def point_in_poly(x: float, y: float, poly: list[list[float]]) -> bool:
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1:
            inside = not inside
    return inside


def poly_area_px(poly: list[list[float]]) -> float:
    return abs(sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(poly, poly[1:] + poly[:1])) / 2)


def measure_road_px(image: Path, band: tuple[float, ...], axis: str = "x") -> float:
    """Measure a road's width between its boundary lines (solid or dashed).
    Column/row darkness profiles concentrate mass at the boundary lines even
    when dashes break them; the two strongest well-separated clusters bound
    the road. Thresholds are relative, so white roads on white paper work.
    band = (a0, a1) along the measurement axis, optionally + window (w0, w1)
    along the road; axis 'x' measures a vertical road, 'y' a horizontal one.
    Returns px width."""
    from PIL import Image
    img = Image.open(image).convert("L")
    w, h = img.size
    px = img.load()
    if len(band) == 4:
        a0, a1, w0, w1 = (int(v) for v in band)
    else:
        a0, a1 = (int(v) for v in band[:2])
        w0, w1 = (0, w) if axis == "y" else (0, h)
    if axis == "y":
        a0, a1 = max(0, a0), min(h, a1)
        w0, w1 = max(0, w0), min(w, w1)
        lines = range(a0, a1)
        across = lambda v: range(w0, w1, 4)
        at = lambda v, u: px[u, v]
    else:
        a0, a1 = max(0, a0), min(w, a1)
        w0, w1 = max(0, w0), min(h, w1)
        lines = range(a0, a1)
        across = lambda v: range(w0, w1, 4)
        at = lambda v, u: px[v, u]
    # Longest continuous dark run per line: boundary lines run far, while
    # text/dashes/grid ticks break into short runs. Median-immune.
    runs = []
    for v in lines:
        best = cur = 0
        for u in across(v):
            if at(v, u) < 100:
                cur += 1
                best = max(best, cur)
            else:
                cur = 0
        runs.append(best * 4)
    # Boundary columns/rows: dark pixels spread across ALL window octants
    # (solid or dashed lines run the whole way; text clusters in 1-2).
    noct = 8
    cover = []
    span = (w1 - w0) if axis == "x" else (w1 - w0)
    for v in lines:
        hits = [0] * noct
        seq = list(across(v))
        for u in seq:
            if at(v, u) < 100:
                hits[min(noct - 1, (u - (w0 if axis == "x" else w0)) * noct // max(1, span))] += 1
        cover.append(sum(1 for c in hits if c > 1))
    # Lines covering most octants are boundary lines (dashed: 4-6 of 8).
    strong = [i for i, c in enumerate(cover) if c >= noct - 2]
    if len(strong) < 2:
        strong = [i for i, c in enumerate(cover) if c >= noct - 3]
    clusters = []
    cur = None
    for i in strong:
        if cur is None or i > cur[1] + 3:
            if cur is not None:
                clusters.append(cur)
            cur = [i, i]
        else:
            cur[1] = i
    if cur is not None:
        clusters.append(cur)
    if len(clusters) < 2:
        fail("could not find two road boundary lines in band "
             f"(axis={axis}, clusters={len(clusters)})")
    width = clusters[-1][1] - clusters[0][0]
    if width <= 0:
        fail("road band measurement non-positive")
    return float(width)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="build dir (lots.json + background image)")
    ap.add_argument("--image", default="masterplan_background.webp", help="background filename in --dir")
    ap.add_argument("--tiers", default=None)
    ap.add_argument("--labels", default=None, help="labels.json ground truth -> comparison mode")
    ap.add_argument("--engines", default="both", choices=["tesseract", "rapidocr", "both"])
    ap.add_argument("--engine", default="tesseract", choices=["tesseract", "rapidocr"],
                    help="production engine when --labels is absent")
    ap.add_argument("--road-band", default=[], action="append",
                    help="road band X0,X1 (vertical) or X0,X1,Y0,Y1, for scale measurement (repeatable)")
    ap.add_argument("--road-axis", default=[], action="append", choices=["x", "y"],
                    help="measurement axis per --road-band (default x); repeatable, same order")
    ap.add_argument("--road-width-ft", default=[], action="append", type=float,
                    help="stated width in ft for each --road-band, same order")
    ap.add_argument("--open-space-bbox", default=None, help="open-space rect in px X0,Y0,X1,Y1 to measure")
    ap.add_argument("--open-space-acres", default=None, type=float, help="printed open-space acres to cross-check")
    ap.add_argument("--open-space-mode", default="bbox", choices=["bbox", "mask", "hatch"],
                    help="bbox: rect area (clean regions); mask: count --open-space-color pixels; "
                         "hatch: brick-pattern green/white variance (plat open-space hatching)")
    ap.add_argument("--open-space-color", default=None,
                    help="mask-mode fill R,G,B[,tol] (e.g. green hatch)")
    ap.add_argument("--number-pattern", default=r"\d{2,3}")
    ap.add_argument("--number-min", type=int, default=1)
    ap.add_argument("--number-max", type=int, default=999)
    ap.add_argument("--confidence-floor", type=float, default=0.5)
    ap.add_argument("--token-threshold", type=float, default=0.95)
    ap.add_argument("--char-threshold", type=float, default=0.98)
    ap.add_argument("--area-tolerance", type=float, default=0.08)
    ap.add_argument("--ensemble", action="store_true",
                    help="two-engine agreement mode: match only tokens both engines agree on "
                         "(rotation retry skipped); anything else stays needs_review")
    ap.add_argument("--stage", default="all", choices=["ocr", "match", "validate", "all"])
    args = ap.parse_args()

    build = Path(args.dir)
    lots_path = build / "lots.json"
    image_path = build / args.image
    if not lots_path.exists():
        fail(f"lots.json not found in {build}")
    if not image_path.exists():
        fail(f"{args.image} not found in {build}")
    lots = json.loads(lots_path.read_text())
    from PIL import Image
    img_w, img_h = Image.open(image_path).size

    def to_px(poly_pct):
        return [[p["x"] / 100 * img_w, p["y"] / 100 * img_h] for p in poly_pct]

    # ---------------------------------------------------------- S1: OCR
    ocr_by_engine: dict[str, dict] = {}
    if args.stage in ("ocr", "all"):
        want = ["tesseract", "rapidocr"] if args.engines == "both" else [args.engines]
        if "tesseract" in want and not have_tesseract():
            fail("tesseract binary not found")
        if "rapidocr" in want and not have_rapidocr():
            fail("rapidocr_onnxruntime not importable (pip install rapidocr_onnxruntime)")
        for engine in want:
            print(f"[ocr-match] S1 OCR via {engine} ...", flush=True)
            try:
                ocr_by_engine[engine] = ocr_image(engine, image_path, args.number_pattern)
            except RuntimeError as e:
                fail(str(e))
            kinds: dict[str, int] = {}
            for t in ocr_by_engine[engine]["tokens"]:
                kinds[t["kind"]] = kinds.get(t["kind"], 0) + 1
            print(f"[ocr-match] {engine}: {len(ocr_by_engine[engine]['tokens'])} lines {kinds}, "
                  f"digit_h={ocr_by_engine[engine]['digit_height_median']}, "
                  f"upscaled={ocr_by_engine[engine]['upscaled']}")
        (build / "ocr.json").write_text(json.dumps(
            {"engines": ocr_by_engine, "image": {"width": img_w, "height": img_h}}, indent=1) + "\n")

    labels = json.loads(Path(args.labels).read_text()) if args.labels else None
    lots_px = [{"lot_number": lot.get("lot_number", ""), "poly": to_px(lot["polygon_pct"])} for lot in lots]

    # Orientation retry (production tesseract path): tall-narrow lots get a
    # crop-rotate re-read; base number/area tokens inside recovered lots are
    # superseded (their fragments). RapidOCR stays base-config for a fair
    # engine comparison; production numbers are reported separately.
    production = None
    ensemble_info: dict | None = None
    if args.ensemble and args.stage in ("ocr", "all"):
        if "tesseract" not in ocr_by_engine or "rapidocr" not in ocr_by_engine:
            fail("--ensemble needs both engines (pass --engines both)")
        result = ensemble_agree(ocr_by_engine["tesseract"]["tokens"], ocr_by_engine["rapidocr"]["tokens"])
        ensemble_info = {"agree_rate": result["agree_rate"], "agreed": result["agreed"], "union": result["union"]}
        print(f"[ocr-match] ensemble agreement: {result['agreed']}/{result['union']} "
              f"(rate {result['agree_rate']}); rotation retry skipped in ensemble mode")
        ocr = {"engine": "ensemble", "tokens": result["tokens"],
               "digit_height_median": ocr_by_engine["tesseract"]["digit_height_median"],
               "upscaled": ocr_by_engine["tesseract"]["upscaled"],
               "rotation_recovered_lots": []}
        ocr_by_engine["ensemble"] = ocr
        production = dict(ocr)
    if production is None and "tesseract" in ocr_by_engine and args.stage in ("ocr", "all"):
        rotation_groups = rotation_retry_lots(image_path, lots_px, args.number_pattern)
        rotation_tokens = []
        for group in rotation_groups:
            rotation_tokens.extend(group["tokens"])
        for i, t in enumerate(rotation_tokens):
            t["id"] = f"tesseract-rot{i}"
        # Supersede base fragments only where rotation actually read something
        # trustworthy (best rotation conf >= floor): vertical text cannot read
        # horizontally, but a weak rotation read must not erase good base ones
        # (small text can beat rotation). Unrecovered lots keep base tokens.
        recovered = set()
        for lot in lots_px:
            best = max(
                (t["conf"] for t in rotation_tokens if t["rotation_lot"] == lot["lot_number"]),
                default=0.0,
            )
            if best >= args.confidence_floor:
                recovered.add(lot["lot_number"])
        merged = []
        for t in ocr_by_engine["tesseract"]["tokens"]:
            if t["kind"] in ("number", "area"):
                cx = (t["box"][0] + t["box"][2]) / 2
                cy = (t["box"][1] + t["box"][3]) / 2
                if any(lot["lot_number"] in recovered and point_in_poly(cx, cy, lot["poly"]) for lot in lots_px):
                    continue
            merged.append(t)
        merged.extend(rotation_tokens)
        base = dict(ocr_by_engine["tesseract"])
        production = dict(base, tokens=merged, rotation_recovered_lots=sorted(recovered),
                          rotation_count=len(rotation_tokens))
        print(f"[ocr-match] rotation retry: {len(rotation_tokens)} tokens, recovered lots {sorted(recovered)}")

    # --------------------------------------- comparison + threshold gate
    comparison = None
    if labels and args.stage in ("ocr", "all"):
        lot_tier = {lot.get("lot_number", ""): lot.get("tier_key", "unknown") for lot in lots}
        results = {}
        # Raw engines only (ensemble is evaluated separately below).
        for engine in [e for e in ocr_by_engine if e in ("tesseract", "rapidocr")]:
            results[engine] = evaluate_engine(ocr_by_engine[engine], labels, lot_tier)
            r = results[engine]
            print(f"[ocr-match] {engine}: token_acc={r['token_accuracy']} char_acc={r['char_accuracy']} "
                  f"({r['tokens_matched']}/{r['tokens_total']})")
            for cls, b in r["per_class"].items():
                print(f"           class {cls}: token={b['token_accuracy']} char={b['char_accuracy']} n={b['total']}")
            for tier, b in r["per_tier"].items():
                print(f"           tier {tier}: token={b['token_accuracy']} char={b['char_accuracy']} n={b['total']}")
        ranked = sorted(results.items(), key=lambda kv: (kv[1]["token_accuracy"] or -1, kv[1]["char_accuracy"] or -1), reverse=True)
        winner, wres = ranked[0]
        comparison = {"results": results, "winner": winner,
                      "thresholds": {"token": args.token_threshold, "char": args.char_threshold}}
        if ensemble_info is not None:
            # Error rate among agreed tokens (labels required).
            agreed_eval = evaluate_engine(
                {"tokens": ocr_by_engine["ensemble"]["tokens"]},
                labels, lot_tier)
            comparison["ensemble"] = {
                "agree_rate": ensemble_info["agree_rate"],
                "agreed": ensemble_info["agreed"], "union": ensemble_info["union"],
                "token_accuracy": agreed_eval["token_accuracy"],
                "char_accuracy": agreed_eval["char_accuracy"],
                "tokens_matched": agreed_eval["tokens_matched"], "tokens_total": agreed_eval["tokens_total"],
                "error_rate": round(1 - (agreed_eval["token_accuracy"] or 0), 4),
            }
            print(f"[ocr-match] ensemble agreed: token_acc={agreed_eval['token_accuracy']} "
                  f"char_acc={agreed_eval['char_accuracy']} ({agreed_eval['tokens_matched']}/{agreed_eval['tokens_total']}) "
                  f"-> error rate {comparison['ensemble']['error_rate']}")
        # Gate applies to the PRODUCTION configuration; the tables above stay
        # fair comparisons.
        if production is not None:
            prod_eval = evaluate_engine(
                {"tokens": production["tokens"]},
                labels, {lot.get("lot_number", ""): lot.get("tier_key", "unknown") for lot in lots})
            comparison["production"] = {"engine": production.get("engine", "tesseract+rotation"), **prod_eval}
            gated = (prod_eval["token_accuracy"] or 0) >= args.token_threshold and \
                (prod_eval["char_accuracy"] or 0) >= args.char_threshold
            print(f"[ocr-match] production {production.get('engine')}: token_acc={prod_eval['token_accuracy']} "
                  f"char_acc={prod_eval['char_accuracy']} ({prod_eval['tokens_matched']}/{prod_eval['tokens_total']})")
        else:
            gated = (wres["token_accuracy"] or 0) >= args.token_threshold and \
                (wres["char_accuracy"] or 0) >= args.char_threshold
        comparison["pass"] = bool(gated)
        print(f"[ocr-match] gate token>={args.token_threshold}, char>={args.char_threshold}: {'PASS' if gated else 'FAIL — stopping'}")
        if not gated:
            (build / "ocr-comparison.json").write_text(json.dumps(comparison, indent=1) + "\n")
            print("error: production OCR below agreed accuracy threshold — not proceeding", file=sys.stderr)
            sys.exit(3)
        (build / "ocr-comparison.json").write_text(json.dumps(comparison, indent=1) + "\n")

    # Working OCR: ensemble/production when built, else requested engine.
    if production is not None:
        ocr = {"engine": production.get("engine", "tesseract+rotation"), "tokens": production["tokens"],
               "digit_height_median": (ocr_by_engine.get("tesseract") or {}).get("digit_height_median"),
               "upscaled": (ocr_by_engine.get("tesseract") or {}).get("upscaled"),
               "rotation_recovered_lots": production.get("rotation_recovered_lots", [])}
        ocr_by_engine[ocr["engine"]] = ocr
        (build / "ocr.json").write_text(json.dumps(
            {"engines": ocr_by_engine, "production": ocr["engine"],
             "image": {"width": img_w, "height": img_h}}, indent=1) + "\n")
    elif args.stage in ("match", "validate"):
        stored = json.loads((build / "ocr.json").read_text())
        if "production" in stored and stored["production"] in stored.get("engines", {}):
            ocr = stored["engines"][stored["production"]]
        else:
            pref = args.engine
            ocr = stored["engines"].get(pref) or next(iter(stored["engines"].values()))
    else:
        ocr = ocr_by_engine.get(args.engine) or next(iter(ocr_by_engine.values()))
        (build / "ocr.json").write_text(json.dumps(
            {"engines": ocr_by_engine, "image": {"width": img_w, "height": img_h}}, indent=1) + "\n")
    if args.stage == "ocr":
        print("[ocr-match] stage ocr done")
        return

    # ---------------------------------------------------------- S2: match
    def valid_number(text: str) -> str | None:
        cleaned = strip_border_artifacts(text.strip().upper())
        if not re.fullmatch(args.number_pattern, cleaned):
            return None
        try:
            value = int(cleaned)
        except ValueError:
            return None
        # Return the cleaned STRING (not int): "07" must stay "07".
        return cleaned if args.number_min <= value <= args.number_max else None

    assignments: dict[str, list[dict]] = {}  # lot_number -> inside number tokens
    token_use: dict[str, list[str]] = {}     # token id -> lot_numbers containing it
    for lot in lots:
        poly = to_px(lot["polygon_pct"])
        inside = []
        for t in ocr["tokens"]:
            if t["kind"] != "number" or t["conf"] < args.confidence_floor:
                continue
            cx = (t["box"][0] + t["box"][2]) / 2
            cy = (t["box"][1] + t["box"][3]) / 2
            if not point_in_poly(cx, cy, poly):
                continue
            if valid_number(t["text"]) is None:
                continue
            t = dict(t, norm_value=str(valid_number(t["text"])))
            inside.append(t)
            token_use.setdefault(t["id"], []).append(lot["lot_number"])
        assignments[lot["lot_number"]] = inside

    # Cross-lot duplicates: same number value claimed by 2+ lots -> flag ALL.
    # Rotation-derived tokens are excluded: their boxes are lot-interior
    # approximations, so an upside-down confusion ("99" read as "66") must
    # not drag the innocent neighbor into a duplicate. Rotation disagreements
    # already surface as multi-token duplicates inside their own lot.
    value_claims: dict[str, list[str]] = {}
    for lot_number, toks in assignments.items():
        for t in toks:
            if t["id"].startswith("tesseract-rot"):
                continue
            value_claims.setdefault(t["norm_value"], []).append(lot_number)
    dup_values = {v: ls for v, ls in value_claims.items() if len(set(ls)) > 1}

    lot_match: dict[str, dict] = {}
    duplicate_records: list[dict] = []
    for lot in lots:
        lot_number = lot["lot_number"]
        toks = assignments[lot_number]
        if len(toks) >= 2 and len({t["norm_value"] for t in toks}) > 1:
            lot_match[lot_number] = {"status": "duplicate", "reason": "multiple distinct numbers inside polygon",
                                     "tokens": [t["id"] for t in toks]}
            duplicate_records.append({"lot": lot_number, "kind": "multi-token", "tokens": [t["id"] for t in toks]})
        elif len(toks) == 0:
            lot_match[lot_number] = {"status": "unmatched", "reason": "no number token inside polygon"}
        else:
            best = max(toks, key=lambda t: t["conf"])
            value = best["norm_value"]
            if value in dup_values:
                lot_match[lot_number] = {"status": "duplicate", "reason": f"value claimed by {sorted(set(dup_values[value]))}",
                                         "tokens": [t["id"] for t in toks]}
                duplicate_records.append({"lot": lot_number, "kind": "cross-lot", "value": value,
                                          "lots": sorted(set(dup_values[value]))})
            else:
                lot_match[lot_number] = {"status": "candidate", "token": best["id"], "value": value}

    # Areas: the area token in the same polygon (exactly one).
    for lot in lots:
        lot_number = lot["lot_number"]
        if lot_match[lot_number]["status"] != "candidate":
            continue
        poly = to_px(lot["polygon_pct"])
        areas = []
        for t in ocr["tokens"]:
            if t["kind"] != "area" or t["conf"] < args.confidence_floor:
                continue
            cx = (t["box"][0] + t["box"][2]) / 2
            cy = (t["box"][1] + t["box"][3]) / 2
            if point_in_poly(cx, cy, poly):
                areas.append(t)
        if len(areas) == 1:
            lot_match[lot_number]["area_sqm"] = areas[0]["value"]
            lot_match[lot_number]["area_token"] = areas[0]["id"]
        else:
            lot_match[lot_number]["area_sqm"] = None
            lot_match[lot_number]["area_note"] = f"{len(areas)} area tokens in polygon"
    if args.stage == "match":
        print("[ocr-match] stage match done (validate separately with --stage validate)")
        # Patch lots.json with match fields now (area stage did not run).
        patch_lots(lots, lot_match, area_results={}, area_ran=False)
        lots_path.write_text(json.dumps(lots, indent=1) + "\n")
        return

    # ---------------------------------------------------------- S3: areas
    # Scale comes ONLY from stated references (repeatable --road-band +
    # --road-width-ft pairs), never from match medians. The median ratio is
    # reported as a cross-check of the calibration, never fed back into it.
    if not args.road_band:
        fail("--road-band X0,X1 (px) is required: scale must come from a stated reference, never match medians")
    if len(args.road_band) != len(args.road_width_ft) or not args.road_band:
        fail("each --road-band needs a matching --road-width-ft (same order, repeatable flags)")
    measurements = []
    try:
        bands = []
        for index, spec in enumerate(args.road_band):
            parts = [float(v) for v in spec.split(",")]
            if len(parts) not in (2, 4):
                fail("--road-band must look like X0,X1 or X0,X1,Y0,Y1 in px")
            axis = args.road_axis[index] if index < len(args.road_axis) else "x"
            bands.append((parts, axis))
    except ValueError:
        fail("--road-band must look like X0,X1 or X0,X1,Y0,Y1 in px")
    for (parts, axis), width_ft in zip(bands, args.road_width_ft + [None] * len(bands)):
        if width_ft is None:
            fail("each --road-band needs a matching --road-width-ft (same order)")
        measured = measure_road_px(image_path, tuple(parts), axis)
        measurements.append({"stated_ft": width_ft, "measured_px": round(measured, 1),
                             "axis": axis, "ft_per_px": round(width_ft / measured, 4)})
        print(f"[ocr-match] S3 reference: road {width_ft}ft ({axis}) = {measured:.1f}px", flush=True)
    ft_per_px = max(measurements, key=lambda m: m["measured_px"])["ft_per_px"]
    primary = max(measurements, key=lambda m: m["measured_px"])
    print(f"[ocr-match] S3 scale: widest reference {primary['stated_ft']}ft -> {ft_per_px:.4f} ft/px "
          f"(linear error doubles in area: 1% scale ~= 2% area)")
    spread = max(m["ft_per_px"] for m in measurements) - min(m["ft_per_px"] for m in measurements)
    if spread / ft_per_px > 0.10:
        print(f"[ocr-match] WARNING: references disagree by {spread / ft_per_px:.1%} (>10%) — check stated widths")
    area_results: dict[str, dict] = {}
    ratios = []
    for lot in lots:
        lot_number = lot["lot_number"]
        m = lot_match[lot_number]
        if m["status"] != "candidate" or not m.get("area_sqm"):
            area_results[lot_number] = {"status": "missing"}
            continue
        poly = to_px(lot["polygon_pct"])
        # Exact: 1 ft = 0.3048 m, so sqm = px_area * (ft_per_px * 0.3048)^2.
        computed_sqm = poly_area_px(poly) * (ft_per_px * FT_TO_M) ** 2
        ratio = computed_sqm / m["area_sqm"] if m["area_sqm"] else None
        if ratio is None:
            area_results[lot_number] = {"status": "missing"}
            continue
        ratios.append((ratio, lot_number))
        ok = abs(ratio - 1.0) <= args.area_tolerance
        area_results[lot_number] = {"status": "ok" if ok else "outlier", "ratio": round(ratio, 4),
                                    "computed_sqm": round(computed_sqm, 2), "printed_sqm": m["area_sqm"]}
    ratios.sort()
    median_ratio = ratios[len(ratios) // 2][0] if ratios else None
    outliers = [lot for lot, r in area_results.items() if r["status"] == "outlier"]
    print(f"[ocr-match] S3 area: {sum(1 for r in area_results.values() if r['status']=='ok')}/{len(area_results)} ok, "
          f"median_ratio={median_ratio}, outliers={len(outliers)}")

    # ---------------------------------------------------------- outputs
    patch_lots(lots, lot_match, area_results)
    lots_path.write_text(json.dumps(lots, indent=1) + "\n")

    per_tier: dict[str, dict] = {}
    for lot in lots:
        tier = lot.get("tier_key", "unknown")
        b = per_tier.setdefault(tier, {"lots": 0, "matched": 0, "area_ok": 0, "ratios": []})
        b["lots"] += 1
        if lot.get("match_status") == "matched":
            b["matched"] += 1
        if area_results.get(lot["lot_number"], {}).get("status") == "ok":
            b["area_ok"] += 1
            b["ratios"].append(area_results[lot["lot_number"]]["ratio"])
    for b in per_tier.values():
        b["match_rate"] = round(b["matched"] / b["lots"], 4) if b["lots"] else None
        b["area_pass_rate"] = round(b["area_ok"] / b["lots"], 4) if b["lots"] else None
        ratios = sorted(b.pop("ratios"))
        # Within-tier spread of computed/printed ratios (median + stdev).
        if ratios:
            median = ratios[len(ratios) // 2]
            mean = sum(ratios) / len(ratios)
            var = sum((x - mean) ** 2 for x in ratios) / len(ratios)
            b["ratio_median"] = round(median, 4)
            b["ratio_stdev"] = round(var ** 0.5, 4)
            b["ratio_min"] = round(ratios[0], 4)
            b["ratio_max"] = round(ratios[-1], 4)
        else:
            b["ratio_median"] = b["ratio_stdev"] = b["ratio_min"] = b["ratio_max"] = None
    matched_n = sum(1 for lot in lots if lot.get("match_status") == "matched")
    ok_n = sum(1 for r in area_results.values() if r["status"] == "ok")
    out_n = sum(1 for r in area_results.values() if r["status"] == "outlier")
    total_n = len(lots)
    match_rate = matched_n / total_n if total_n else None
    # Pass rate over lots that printed an area (missing areas are reported,
    # not failed — narrow flag lots carry numbers only).
    area_rate = ok_n / (ok_n + out_n) if (ok_n + out_n) else None
    reserve_pending = []
    for lot in lots:
        poly = lot.get("polygon_pct") or []
        # Irregular footprints (not simple quads) and area outliers always
        # need human eyes before any paint-out, regardless of tier.
        if len(poly) != 4 or area_results.get(lot["lot_number"], {}).get("status") == "outlier":
            reserve_pending.append(lot["lot_number"])
    reserve_pending = sorted(set(reserve_pending))
    gate = {
        "matched_ok": (match_rate or 0) >= 0.95,
        "area_ok": (area_rate or 0) >= 0.90,
        "manual_review_done": False,
        "manual_review_pending": reserve_pending,
        "pass": False,
    }
    gate["pass"] = bool(gate["matched_ok"] and gate["area_ok"] and gate["manual_review_done"])
    report_path = build / "ingest-report.json"
    report = json.loads(report_path.read_text()) if report_path.exists() else {}
    report["ocr"] = {
        "engine": ocr.get("engine"), "engines_compared": sorted(ocr_by_engine.keys()) if ocr_by_engine else [],
        "comparison": comparison,
        "digit_height_median": ocr.get("digit_height_median"), "upscaled": ocr.get("upscaled"),
        "environment": engine_environment(),
    }
    report["matching"] = {
        "match_rate": round(match_rate, 4) if match_rate is not None else None,
        "matched": matched_n, "total": total_n,
        "per_tier": per_tier,
        "duplicates": duplicate_records,
        "duplicate_count": len(duplicate_records),
    }
    if comparison and comparison.get("ensemble"):
        report["ensemble"] = comparison["ensemble"]
    report["area_validation"] = {
        "scale": {"references": measurements, "ft_per_px": round(ft_per_px, 4),
                  "method": "stated road widths divided by measured px widths; widest reference wins; "
                            "median ratio is a cross-check only, never fed back into the scale"},
        "pass_rate": round(area_rate, 4) if area_rate is not None else None,
        "median_ratio": round(median_ratio, 4) if median_ratio is not None else None,
        "tolerance": args.area_tolerance,
        "outliers_redraw_queue": outliers,
    }
    report["open_space"] = check_open_space(image_path, ft_per_px, args)
    report["paint_out_gate"] = gate
    report_path.write_text(json.dumps(report, indent=1) + "\n")
    write_qa(build, lots, ocr, lot_match, area_results, report, img_w, img_h, image_path)
    print(f"[ocr-match] paint-out gate: matched_ok={gate['matched_ok']} area_ok={gate['area_ok']} "
          f"human_review_pending={len(reserve_pending)} -> {'PASS' if gate['pass'] else 'HOLD (no paint-out)'}")


def check_open_space(image_path: Path, ft_per_px: float, args) -> dict | None:
    """Cross-check a printed open-space acreage: measure the operator-given
    region via the calibrated scale and report signed bias. Two modes:
    bbox (axis-aligned rect area — clean synthetic regions) and mask (count
    --open-space-color pixels inside the bbox — e.g. green hatch on plats).
    The bias is reported only — scale is never adjusted from this check."""
    if args.open_space_bbox is None or args.open_space_acres is None:
        return None
    try:
        x0, y0, x1, y1 = (float(v) for v in args.open_space_bbox.split(","))
    except ValueError:
        fail("--open-space-bbox must look like X0,Y0,X1,Y1 in px")
    mode = args.open_space_mode
    if mode == "mask":
        if not args.open_space_color:
            fail("--open-space-color R,G,B[,tol] is required in mask mode")
        try:
            comps = [float(v) for v in args.open_space_color.split(",")]
            if len(comps) not in (3, 4):
                raise ValueError
        except ValueError:
            fail("--open-space-color must look like R,G,B[,tol]")
        tol = comps[3] if len(comps) == 4 else 60.0
        from PIL import Image
        img = Image.open(image_path).convert("RGB")
        w, h = img.size
        px = img.load()
        x0i, y0i = max(0, int(x0)), max(0, int(y0))
        x1i, y1i = min(w, int(x1)), min(h, int(y1))
        step = max(1, (x1i - x0i) * (y1i - y0i) // 400000 + 1)
        hit = total = 0
        for y in range(y0i, y1i, step):
            for x in range(x0i, x1i, step):
                total += 1
                r, g, b = px[x, y]
                if abs(r - comps[0]) + abs(g - comps[1]) + abs(b - comps[2]) <= tol * 3:
                    hit += 1
        px_area = hit / total * (x1i - x0i) * (y1i - y0i) if total else 0.0
    elif mode == "hatch":
        from PIL import Image

        def is_hatch(px, x, y, w, h):
            greens = whites = 0
            for dy in range(-6, 7, 3):
                for dx in range(-6, 7, 3):
                    xx, yy = x + dx, y + dy
                    if not (0 <= xx < w and 0 <= yy < h):
                        continue
                    r, g, b = px[xx, yy]
                    if g > 150 and g - r > 40 and g - b > 40:
                        greens += 1
                    elif r > 200 and g > 200 and b > 200:
                        whites += 1
            return greens >= 3 and whites >= 3

        img = Image.open(image_path).convert("RGB")
        w, h = img.size
        px = img.load()
        x0i, y0i = max(0, int(x0)), max(0, int(y0))
        x1i, y1i = min(w, int(x1)), min(h, int(y1))
        step = max(4, (x1i - x0i) * (y1i - y0i) // 300000 + 1)
        hit = total = 0
        for y in range(y0i, y1i, step):
            for x in range(x0i, x1i, step):
                total += 1
                if is_hatch(px, x, y, w, h):
                    hit += 1
        px_area = hit / total * (x1i - x0i) * (y1i - y0i) if total else 0.0
    else:
        px_area = abs(x1 - x0) * abs(y1 - y0)
    measured_acres = px_area * ft_per_px * ft_per_px * ACRES_PER_SQFT
    bias = (measured_acres - args.open_space_acres) / args.open_space_acres if args.open_space_acres else None
    return {"mode": mode, "stated_acres": args.open_space_acres,
            "measured_acres": round(measured_acres, 3),
            "bias": round(bias, 4) if bias is not None else None,
            "note": "bias reported only; scale is never corrected from this check"}


def engine_environment() -> dict:
    """Pinned engine versions + run parameters for the report."""
    import importlib.metadata
    env: dict = {"parameters": {
        "upscale_rule": f"median digit-box height < {DIGIT_TARGET_PX}px -> factor 24/median capped {UPSCALE_CAP}x",
        "confidence_floor_default": 0.5, "area_tolerance_default": 0.08,
        "thresholds_default": {"token": 0.95, "char": 0.98},
    }}
    try:
        proc = subprocess.run(["tesseract", "--version"], capture_output=True, text=True, timeout=60)
        env["tesseract"] = proc.stdout.splitlines()[0].strip() if proc.returncode == 0 else "missing"
    except Exception:
        env["tesseract"] = "missing"
    for pkg in ("rapidocr_onnxruntime", "onnxruntime", "opencv-python", "Pillow", "numpy"):
        try:
            env[pkg] = importlib.metadata.version(pkg)
        except Exception:
            env[pkg] = "missing"
    return env


def patch_lots(lots: list[dict], lot_match: dict, area_results: dict, area_ran: bool = True) -> None:
    for lot in lots:
        m = lot_match.get(lot["lot_number"], {"status": "unmatched"})
        status = m["status"]
        lot["printed_lot_number"] = m.get("value") if status == "candidate" else None
        lot["printed_area_sqm"] = m.get("area_sqm")
        lot["match_status"] = "matched" if status == "candidate" else status
        area = area_results.get(lot["lot_number"], {})
        lot["area_status"] = area.get("status", "missing" if area_ran else "not-run")
        if "ratio" in area:
            lot["area_ratio"] = area["ratio"]
        lot["needs_review"] = bool(lot.get("needs_review")) or lot["match_status"] != "matched" or \
            (area_ran and lot.get("area_status") != "ok")


def write_qa(build: Path, lots: list[dict], ocr: dict, lot_match: dict,
             area_results: dict, report: dict, img_w: int, img_h: int, image_path: Path) -> None:
    import base64
    data = base64.b64encode(image_path.read_bytes()).decode()
    color = {"matched": "#16a34a", "unmatched": "#d97706", "duplicate": "#dc2626"}
    parts = [f"<h1>OCR QA — {ocr.get('engine')} (match {report['matching']['match_rate']}, "
             f"area {report['area_validation']['pass_rate']}, gate {'PASS' if report['paint_out_gate']['pass'] else 'HOLD'})</h1>"]
    parts.append(f"<p>{len(ocr['tokens'])} tokens · {len(lots)} lots · "
                 f"duplicates {report['matching']['duplicate_count']} · "
                 f"redraw queue {len(report['area_validation']['outliers_redraw_queue'])}</p>")
    parts.append(f'<div style="position:relative;width:{min(img_w, 1400)}px">'
                 f'<img src="data:image/webp;base64,{data}" style="width:100%">'
                 f'<svg viewBox="0 0 {img_w} {img_h}" style="position:absolute;inset:0;width:100%;height:100%">')
    by_lot = {lot["lot_number"]: lot for lot in lots}
    for lot in lots:
        poly = lot["polygon_pct"]
        pts = " ".join(f"{p['x'] / 100 * img_w},{p['y'] / 100 * img_h}" for p in poly)
        st = lot.get("match_status", "unmatched")
        parts.append(f'<polygon points="{pts}" fill="none" stroke="{color.get(st, "#888")}" stroke-width="3">'
                     f"<title>Lot {lot['lot_number']}: {st}</title></polygon>")
        _ = by_lot
    for t in ocr["tokens"]:
        x0, y0, x1, y1 = t["box"]
        c = {"number": "#2563eb", "area": "#7c3aed", "other": "#9ca3af"}.get(t["kind"], "#9ca3af")
        parts.append(f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" fill="none" '
                     f'stroke="{c}" stroke-width="2"><title>{t["text"]} ({t["kind"]}, {t["conf"]})</title></rect>')
    parts.append("</svg></div>")
    (build / "ocr-qa.html").write_text(
        "<!doctype html><html><body style=\"font-family:sans-serif\">" + "".join(parts) + "</body></html>")
    print("[ocr-match] QA viewer -> build/ocr-qa.html")


if __name__ == "__main__":
    main()
