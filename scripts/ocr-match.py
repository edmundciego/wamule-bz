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
import csv
import io
import json
import math
import re
import shutil
import subprocess
import sys
from pathlib import Path

SQFT_PER_SQM = 10.7639
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
    proc = subprocess.run(
        ["tesseract", str(image), "stdout", "--psm", "6", "tsv"],
        capture_output=True, text=True, timeout=600,
    )
    if proc.returncode != 0:
        fail(f"tesseract failed: {proc.stderr.strip()[:300]}")
    rows = list(csv.DictReader(io.StringIO(proc.stdout), delimiter="\t"))
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
            "line_key": (r.get("block_num"), r.get("par_num"), r.get("line_num")),
        })
    return words


def rapidocr_lines(image: Path) -> list[dict]:
    from rapidocr_onnxruntime import RapidOCR
    from PIL import Image
    ocr = RapidOCR()
    out, _ = ocr(str(image))
    words = []
    img = Image.open(image)
    _w, _h = img.size
    for quad, text, score in (out or []):
        text = (text or "").strip()
        if not text:
            continue
        xs = [p[0] for p in quad]
        ys = [p[1] for p in quad]
        # RapidOCR emits line-level boxes already; keep each as one word so
        # the shared line-grouper below is a no-op for it.
        words.append({
            "text": text,
            "box": [min(xs), min(ys), max(xs), max(ys)],
            "conf": float(score),
            "line_key": ("rapid", text),
        })
    return words


def digit_height_median(words: list[dict]) -> float | None:
    heights = [w["box"][3] - w["box"][1] for w in words if re.search(r"\d", w["text"]) and w["conf"] >= 0]
    if not heights:
        return None
    heights.sort()
    mid = len(heights) // 2
    return float(heights[mid] if len(heights) % 2 else (heights[mid - 1] + heights[mid]) / 2)


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
    if re.fullmatch(number_pattern, norm):
        return ("number", norm)
    stripped = strip_border_artifacts(norm)
    if stripped != norm and re.fullmatch(number_pattern, stripped):
        return ("number", stripped)
    m = re.fullmatch(r"(\d+\.\d+)\s*S\.?M\.?", norm)
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
    for lot in lots_px:
        xs = [p[0] for p in lot["poly"]]
        ys = [p[1] for p in lot["poly"]]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        w, h = x1 - x0, y1 - y0
        if not (h > 1.8 * w and w >= 30):
            continue
        ix0, iy0 = x0 + 0.1 * w, y0 + 0.1 * h
        ix1, iy1 = x1 - 0.1 * w, y1 - 0.1 * h
        crop = img.crop((int(ix0), int(iy0), int(ix1), int(iy1)))
        for angle in (Image.ROTATE_90, Image.ROTATE_270):
            tmp = image.with_suffix(".rot-tmp.png")
            # White margin: Tesseract drops text touching the image edge.
            turned = crop.transpose(angle)
            sheet = Image.new("RGB", (turned.width + 48, turned.height + 48), (255, 255, 255))
            sheet.paste(turned, (24, 24))
            sheet.save(tmp)
            lined = []
            for line in group_lines(tesseract_tsv(tmp)):
                kind, value = classify_line(line["text"], number_pattern)
                if kind in ("number", "area"):
                    lined.append({
                        "text": line["text"],
                        "kind": kind,
                        "value": value,
                        "box": [ix0, iy0, ix1, iy1],
                        "conf": line["conf"],
                        "rotation_lot": lot["lot_number"],
                    })
            tmp.unlink(missing_ok=True)
            if lined:
                out.append({"lot": lot["lot_number"], "orientation": angle, "tokens": lined})
    return out


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
    for i, line in enumerate(group_lines(words)):
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


def measure_road_px(image: Path, band: tuple[float, float]) -> float:
    """Measure a vertical road band's width from column luminance: the road
    fill is a darker plateau than the paper; the widest sub-threshold run
    inside the band is the width. Thresholds are relative (paper median),
    not absolute, so webp softening can't erase the step."""
    from PIL import Image
    import statistics
    img = Image.open(image).convert("L")
    w, h = img.size
    px = img.load()
    x0, x1 = max(0, int(band[0])), min(w, int(band[1]))
    y0, y1 = int(h * 0.1), int(h * 0.9)
    means = []
    for x in range(x0, x1):
        s = 0
        n = 0
        for y in range(y0, y1, 4):
            s += px[x, y]
            n += 1
        means.append(s / n)
    paper = sorted(means)[min(len(means) - 1, int(len(means) * 0.9))]
    dark = [m < paper - 4 for m in means]
    best: tuple[int, int] | None = None
    cur = None
    for i, is_dark in enumerate(dark + [False]):
        if is_dark and cur is None:
            cur = i
        elif not is_dark and cur is not None:
            if best is None or i - cur > best[1] - best[0]:
                best = (cur, i)
            cur = None
    if best is None or best[1] - best[0] < 20:
        fail("could not measure road band (no wide darker run found)")
    return float(best[1] - best[0])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="build dir (lots.json + masterplan_background.webp)")
    ap.add_argument("--tiers", default=None)
    ap.add_argument("--labels", default=None, help="labels.json ground truth -> comparison mode")
    ap.add_argument("--engines", default="both", choices=["tesseract", "rapidocr", "both"])
    ap.add_argument("--engine", default="tesseract", choices=["tesseract", "rapidocr"],
                    help="production engine when --labels is absent")
    ap.add_argument("--road-band", default=None, help="vertical road band in px, X0,X1, for scale measurement")
    ap.add_argument("--road-width-ft", type=float, default=60.0)
    ap.add_argument("--number-pattern", default=r"\d{2,3}")
    ap.add_argument("--number-min", type=int, default=1)
    ap.add_argument("--number-max", type=int, default=999)
    ap.add_argument("--confidence-floor", type=float, default=0.5)
    ap.add_argument("--token-threshold", type=float, default=0.95)
    ap.add_argument("--char-threshold", type=float, default=0.98)
    ap.add_argument("--area-tolerance", type=float, default=0.08)
    ap.add_argument("--stage", default="all", choices=["ocr", "match", "validate", "all"])
    args = ap.parse_args()

    build = Path(args.dir)
    lots_path = build / "lots.json"
    image_path = build / "masterplan_background.webp"
    if not lots_path.exists():
        fail(f"lots.json not found in {build}")
    if not image_path.exists():
        fail(f"masterplan_background.webp not found in {build}")
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
            ocr_by_engine[engine] = ocr_image(engine, image_path, args.number_pattern)
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
    if "tesseract" in ocr_by_engine and args.stage in ("ocr", "all"):
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
        for engine, ocr in ocr_by_engine.items():
            results[engine] = evaluate_engine(ocr, labels, lot_tier)
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
        # Gate applies to the PRODUCTION configuration (tesseract + rotation
        # retry when present); the base table above stays a fair comparison.
        if production is not None:
            prod_eval = evaluate_engine(
                {"tokens": production["tokens"]},
                labels, {lot.get("lot_number", ""): lot.get("tier_key", "unknown") for lot in lots})
            comparison["production"] = {"engine": "tesseract+rotation", **prod_eval}
            gated = (prod_eval["token_accuracy"] or 0) >= args.token_threshold and \
                (prod_eval["char_accuracy"] or 0) >= args.char_threshold
            print(f"[ocr-match] production tesseract+rotation: token_acc={prod_eval['token_accuracy']} "
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

    # Working OCR: production (tesseract+rotation) when built, else requested.
    if production is not None:
        ocr = {"engine": "tesseract+rotation", "tokens": production["tokens"],
               "digit_height_median": ocr_by_engine["tesseract"]["digit_height_median"],
               "upscaled": ocr_by_engine["tesseract"]["upscaled"],
               "rotation_recovered_lots": production["rotation_recovered_lots"]}
        ocr_by_engine["tesseract+rotation"] = ocr
        (build / "ocr.json").write_text(json.dumps(
            {"engines": ocr_by_engine, "production": "tesseract+rotation",
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
    if not args.road_band:
        fail("--road-band X0,X1 (px) is required: scale must come from a stated reference, never match medians")
    try:
        bx0, bx1 = (float(v) for v in args.road_band.split(","))
    except ValueError:
        fail("--road-band must look like X0,X1 in px")
    road_px = measure_road_px(image_path, (bx0, bx1))
    ft_per_px = args.road_width_ft / road_px
    print(f"[ocr-match] S3 scale: road {args.road_width_ft}ft = {road_px:.1f}px -> {ft_per_px:.4f} ft/px")
    area_results: dict[str, dict] = {}
    ratios = []
    for lot in lots:
        lot_number = lot["lot_number"]
        m = lot_match[lot_number]
        if m["status"] != "candidate" or not m.get("area_sqm"):
            area_results[lot_number] = {"status": "missing"}
            continue
        poly = to_px(lot["polygon_pct"])
        computed_sqm = poly_area_px(poly) * ft_per_px * ft_per_px / SQFT_PER_SQM
        ratio = computed_sqm / m["area_sqm"] if m["area_sqm"] else None
        if ratio is None:
            area_results[lot_number] = {"status": "missing"}
            continue
        ratios.append(ratio)
        ok = abs(ratio - 1.0) <= args.area_tolerance
        area_results[lot_number] = {"status": "ok" if ok else "outlier", "ratio": round(ratio, 4),
                                    "computed_sqm": round(computed_sqm, 2), "printed_sqm": m["area_sqm"]}
    ratios.sort()
    median_ratio = ratios[len(ratios) // 2] if ratios else None
    outliers = [lot for lot, r in area_results.items() if r["status"] == "outlier"]
    print(f"[ocr-match] S3 area: {sum(1 for r in area_results.values() if r['status']=='ok')}/{len(area_results)} ok, "
          f"median_ratio={median_ratio}, outliers={len(outliers)}")

    # ---------------------------------------------------------- outputs
    patch_lots(lots, lot_match, area_results)
    lots_path.write_text(json.dumps(lots, indent=1) + "\n")

    per_tier: dict[str, dict] = {}
    for lot in lots:
        tier = lot.get("tier_key", "unknown")
        b = per_tier.setdefault(tier, {"lots": 0, "matched": 0, "area_ok": 0})
        b["lots"] += 1
        if lot.get("match_status") == "matched":
            b["matched"] += 1
        if area_results.get(lot["lot_number"], {}).get("status") == "ok":
            b["area_ok"] += 1
    for b in per_tier.values():
        b["match_rate"] = round(b["matched"] / b["lots"], 4) if b["lots"] else None
        b["area_pass_rate"] = round(b["area_ok"] / b["lots"], 4) if b["lots"] else None
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
    }
    report["matching"] = {
        "match_rate": round(match_rate, 4) if match_rate is not None else None,
        "matched": matched_n, "total": total_n,
        "per_tier": per_tier,
        "duplicates": duplicate_records,
        "duplicate_count": len(duplicate_records),
    }
    report["area_validation"] = {
        "scale": {"reference": f"road {args.road_width_ft}ft", "measured_px": round(road_px, 1),
                  "ft_per_px": round(ft_per_px, 4)},
        "pass_rate": round(area_rate, 4) if area_rate is not None else None,
        "median_ratio": round(median_ratio, 4) if median_ratio is not None else None,
        "tolerance": args.area_tolerance,
        "outliers_redraw_queue": outliers,
    }
    report["paint_out_gate"] = gate
    report_path.write_text(json.dumps(report, indent=1) + "\n")
    write_qa(build, lots, ocr, lot_match, area_results, report, img_w, img_h, image_path)
    print(f"[ocr-match] paint-out gate: matched_ok={gate['matched_ok']} area_ok={gate['area_ok']} "
          f"human_review_pending={len(reserve_pending)} -> {'PASS' if gate['pass'] else 'HOLD (no paint-out)'}")


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
