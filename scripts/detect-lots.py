#!/usr/bin/env python3
"""Raster lot detector for Wamule interactive maps (Step 1: extraction + detection).

Pipeline stage 1 of the per-tenant interactive lot map workflow:
    source plat PDF/image -> lots.json + ingest-report.json

Method (calibrated on the Hopkins Grove PoC, 861 lots):
  * Extracts the FIRST embedded raster from a PDF via pypdfium2
    (streaming single-image extract -- never `pdfimages -f 1 -l 1 -j`,
    which dumps all 17 x 78MB PPMs and fills the disk).
  * Downscales to a bounded work resolution for memory safety.
  * Classifies each pixel by nearest tier FILL anchor (RGB euclidean)
    within that tier's tolerance. Fill anchors -- not legend swatches --
    because legend swatches render lighter/desaturated vs map fills
    (anti-aliasing + JPEG artifacts).
  * Connected components per tier (scipy.ndimage.label, 8-connectivity),
    minimum-area filter kills noise fragments (this is what brought
    Hopkins 1592 -> 861).
  * Polygon per component = convex hull of its pixels (lots are
    near-rectangular; concave L-lots get hull + needs_review flag),
    simplified with RDP, normalized to 0-100 % (matches
    `public.parcels.map_polygon` + `useParcelMap.sanitizePolygon`).
  * Confidence / needs_review from solidity + extent + area heuristics.
  * Validation gates fail closed (non-zero exit) on count / geometry /
    tier / price violations.

Outputs in --out-dir:
  lots.json           [{lot_number,tier_key,price,polygon_pct,confidence,
                       needs_review,source}]
  ingest-report.json  {counts per tier, low-confidence %, dims, gates}

Stage 2 (orchestrator `scripts/build-interactive-map.mjs`, next step)
adds: background.webp conversion, aspect-drift gate vs active map,
QA poc.html, and publish dry-run/apply.

Deps (all already on the agent box): Pillow, numpy, scipy, pypdfium2
(only for PDF input). No opencv required.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile
from collections import Counter


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.strip().lstrip("#")
    if len(h) != 6:
        raise ValueError(f"bad hex color: {h!r}")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def load_tiers(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    tiers = raw.get("tiers", raw)  # accept {tiers:{...}} or bare {...}
    if not isinstance(tiers, dict) or not tiers:
        raise ValueError(f"no tiers found in {path}")
    out: dict[str, dict] = {}
    for key, t in tiers.items():
        if not isinstance(t, dict):
            raise ValueError(f"tier {key!r} must be an object")
        for field in ("label", "price", "fill"):
            if field not in t:
                raise ValueError(f"tier {key!r} missing {field!r}")
        out[key] = {
            "label": str(t["label"]),
            "price": float(t["price"]),
            "legend": str(t.get("legend", t["fill"])),
            "fill": str(t["fill"]),
            "tolerance": float(t.get("tolerance", 60)),
            "rgb": hex_to_rgb(str(t["fill"])),
        }
        if out[key]["price"] <= 0:
            raise ValueError(f"tier {key!r} price must be > 0")
        if out[key]["tolerance"] <= 0:
            raise ValueError(f"tier {key!r} tolerance must be > 0")
    return out


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Detect lot polygons from a plat raster.")
    p.add_argument("--source", required=True, help="Plat PDF or image (png/jpg/webp).")
    p.add_argument("--tiers", required=True, help="Tier catalogue JSON (map-input/*.tiers.json).")
    p.add_argument("--out-dir", required=True, help="Output dir for lots.json + ingest-report.json.")
    p.add_argument("--tenant", default="", help="Tenant slug (recorded in report only).")
    p.add_argument("--pdf-image-index", type=int, default=0,
                   help="Which embedded PDF image to extract (default 0 = first).")
    p.add_argument("--work-width", type=int, default=2000,
                   help="Detection width in px; aspect preserved (default 2000).")
    p.add_argument("--min-area", type=float, default=60.0,
                   help="Min component area in PoC units (1000x842 space, default 60).")
    p.add_argument("--expected-min", type=int, default=700, help="Min plausible lot count.")
    p.add_argument("--expected-max", type=int, default=1000, help="Max plausible lot count.")
    p.add_argument("--max-blob-frac", type=float, default=0.05,
                   help="Skip components covering more than this image fraction (background).")
    p.add_argument("--max-points", type=int, default=32, help="Max polygon vertices after RDP.")
    p.add_argument("--rdp-eps", type=float, default=2.0, help="RDP epsilon in work px.")
    p.add_argument("--review-solidity", type=float, default=0.9,
                   help="Solidity below this flags needs_review.")
    p.add_argument("--line-white", type=float, default=215.0,
                   help="Pixels with min(R,G,B) above this are grid/paper lines,"
                   " forced unclassified to split adjacent lots (default 215).")
    p.add_argument("--erode-px", type=int, default=0,
                   help="Legacy erode-split iterations (superseded by peak-split;"
                   " kept for compat, default 0 = off).")
    p.add_argument("--peak-win", type=int, default=7,
                   help="Maximum-filter window for lot-core peaks (default 7).")
    p.add_argument("--peak-min-dist", type=float, default=4.0,
                   help="Min distance-transform depth for a lot-core peak"
                   " (default 4.0px; reserved for future peak strategies).")
    p.add_argument("--bridge-px", type=int, default=1,
                   help="Dilation iterations bridging text-split fragments"
                   " before merge (default 1; grid gaps are ~3x wider and"
                   " survive).")
    p.add_argument("--seed-sort", action="store_true",
                   help="Sort lots top-to-bottom,left-to-right before numbering (default on).")
    p.add_argument("--no-seed-sort", dest="seed_sort", action="store_false")
    p.set_defaults(seed_sort=True)
    return p.parse_args(argv)


# ---------------------------------------------------------------------------
# Source loading: PDF single-image extract (streaming) or plain image file.
# ---------------------------------------------------------------------------

def load_source_image(source: str, image_index: int, work_width: int):
    """Return (PIL RGB image at work size, meta dict). Memory/disk safe.

    PDFs: extracts ONLY image `image_index` via pypdfium2 page-object API
    into a temp PNG, then opens it. Never shells to `pdfimages` page-range
    extraction (that dumps every image on the page -- 17 x 78MB for
    Hopkins -- and fills the disk).
    """
    from PIL import Image

    meta: dict = {"source": source, "work_width": work_width}
    tmp_path: str | None = None

    lower = source.lower()
    if lower.endswith(".pdf"):
        try:
            import pypdfium2 as pdfium
        except ImportError as e:  # pragma: no cover
            raise SystemExit("PDF input needs pypdfium2: pip install pypdfium2") from e
        pdf = pdfium.PdfDocument(source)
        try:
            if len(pdf) < 1:
                raise SystemExit(f"PDF has no pages: {source}")
            page = pdf[0]
            objs = [o for o in page.get_objects() if isinstance(o, pdfium.PdfImage)]
            meta["pdf_pages"] = len(pdf)
            meta["pdf_images_on_page1"] = len(objs)
            if not objs:
                raise SystemExit(f"no embedded images on page 1 of {source}")
            if image_index < 0 or image_index >= len(objs):
                raise SystemExit(
                    f"--pdf-image-index {image_index} out of range "
                    f"(0..{len(objs) - 1}) for {source}"
                )
            meta["pdf_image_index"] = image_index
            tmp = tempfile.NamedTemporaryFile(prefix="lotdetect_", suffix=".png", delete=False)
            tmp.close()
            tmp_path = tmp.name
            # extract() appends its own extension; pass prefix then resolve.
            prefix = tmp_path + ".img"
            objs[image_index].extract(prefix)
            import glob

            cands = sorted(glob.glob(prefix + ".*"))
            if not cands:
                raise SystemExit("pypdfium2 extract produced no file")
            tmp_path = cands[0]
            meta["pdf_extract_file"] = os.path.basename(tmp_path)
            img = Image.open(tmp_path).convert("RGB")
            meta["native_size"] = list(img.size)
        finally:
            pdf.close()
    else:
        img = Image.open(source).convert("RGB")
        meta["native_size"] = list(img.size)

    try:
        w, h = img.size
        if w <= 0 or h <= 0:
            raise SystemExit(f"empty image: {source}")
        scale = work_width / float(w) if w > work_width else 1.0
        meta["work_scale"] = scale
        if scale < 1.0:
            img = img.resize((work_width, max(1, round(h * scale))), Image.LANCZOS)
        meta["work_size"] = list(img.size)
        return img, meta
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Classification: nearest tier fill anchor within tolerance.
# ---------------------------------------------------------------------------

def classify_pixels(img, tiers: dict, line_white: float = 215.0):
    """Return (labels HxW int16 tier idx or -1, order list of tier keys).

    Vectorized RGB euclidean distance to each tier fill anchor on a
    float32 buffer. Peak memory ~= H*W*(3 + n_tiers) floats -- at
    2000px wide (~1685px tall) x 7 tiers ~= 130MB, acceptable; the
    native 5700x4800 raster is NEVER classified directly.

    Grid/paper separator pass: pixels with min(R,G,B) > line_white are
    forced unclassified (-1). At work resolution the white grid lines
    between adjacent lots blur into the fills and would otherwise fuse
    whole blocks into one component; masking them restores separation
    (PoC equivalent of morphological opening before labeling).
    """
    import numpy as np

    arr = np.asarray(img).astype(np.float32)  # H,W,3
    keys = list(tiers.keys())
    h, w = arr.shape[:2]
    best = np.full((h, w), np.inf, dtype=np.float32)
    labels = np.full((h, w), -1, dtype=np.int16)
    for i, key in enumerate(keys):
        rgb = np.array(tiers[key]["rgb"], dtype=np.float32)
        tol = float(tiers[key]["tolerance"])
        d = np.sqrt(((arr - rgb) ** 2).sum(axis=2))
        take = (d <= tol) & (d < best)
        labels[take] = i
        best = np.minimum(best, np.where(d <= tol, d, best))
    if line_white and line_white > 0:
        whitest = arr.min(axis=2)
        labels[whitest > float(line_white)] = -1
    return labels, keys

# ---------------------------------------------------------------------------
# Geometry: hull + RDP (no opencv).
# ---------------------------------------------------------------------------

def _cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def convex_hull(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Monotone chain. Points as (x, y). CCW hull without dup endpoint."""
    pts = sorted(set(points))
    if len(pts) <= 1:
        return pts
    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and _cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and _cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _perp_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    denom = math.hypot(dx, dy)
    if denom == 0:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    return abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / denom


def rdp(points: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
    """Ramer-Douglas-Peucker polyline simplification (open ring)."""
    if len(points) < 3 or eps <= 0:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        s, e = stack.pop()
        dmax, idx = 0.0, -1
        for i in range(s + 1, e):
            d = _perp_dist(points[i], points[s], points[e])
            if d > dmax:
                dmax, idx = d, i
        if dmax > eps and idx > 0:
            keep[idx] = True
            stack.append((s, idx))
            stack.append((idx, e))
    return [p for p, k in zip(points, keep) if k]


def polygon_area(pts: list[tuple[float, float]]) -> float:
    a = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


# ---------------------------------------------------------------------------
# Detection: components per tier -> lot records.
# ---------------------------------------------------------------------------

def detect_lots(labels, tier_keys: list[str], args) -> tuple[list[dict], dict]:
    """Peak-split components per tier; returns (raw_lots, stats).

    Text strokes punch holes in pale fills, so raw connected components
    are lot FRAGMENTS. Splitting must therefore happen per-FRAGMENT via
    distance-transform local maxima (one marker per lot core), not via
    erosion (which multiplies markers on ragged text edges: erode2 gave
    51 markers on a 28-lot patch). Assignment is by nearest marker
    (Voronoi) clipped to the tier mask -- a poor man's watershed using
    only scipy, no skimage. Fragments whose core was eaten by text get
    no marker and attach to the neighbour whose core they touch,
    which re-joins text-split halves instead of counting them twice.
    """
    import numpy as np
    from scipy import ndimage

    h, w = labels.shape
    # PoC space 1000x842; scale areas so --min-area matches PoC calibration.
    poc_scale = (1000.0 * 842.0) / float(w * h)
    max_blob_px = float(args.max_blob_frac) * w * h
    peak_win = int(getattr(args, "peak_win", 7))
    peak_min_dist = float(getattr(args, "peak_min_dist", 4.0))

    raw: list[dict] = []
    per_tier_blobs: dict[str, int] = {k: 0 for k in tier_keys}
    struct = np.ones((3, 3), dtype=bool)  # 8-connectivity like PoC morphology
    for idx, key in enumerate(tier_keys):
        mask = labels == idx
        if not bool(mask.any()):
            continue
        # Markers: local maxima of the distance transform = lot cores.
        # peak_win suppresses multi-peaks per lot; peak_min_dist drops
        # shallow sliver/text-edge maxima. NOTE: markers are used to
        # MERGE text-split fragments (union-find below), never to split:
        # a marker claims only the single connected fragment that
        # contains it, so ragged text edges can never multiply lots.
        dt = ndimage.distance_transform_edt(mask)
        peaks = ndimage.maximum_filter(dt, size=peak_win)
        seeds = (dt == peaks) & (dt >= peak_min_dist) & mask
        slab, n_mark = ndimage.label(seeds, structure=struct)
        if n_mark == 0:
            continue
        # Fragment merge packs text-split halves back into whole lots:
        # dilate the tier mask by ~1/2 text-stroke width, label the
        # BRIDGED mask (text gaps close, grid gaps survive: dark text
        # half-width ~1.4px vs white grid half-width ~4.1px, so
        # iterations=1 bridges text but not grid), then merge fragments
        # that fall in the same bridged component. Unmerged fragments
        # stay separate -- min-area gate + needs_review handle them.
        lab, n = ndimage.label(mask, structure=struct)
        if n == 0:
            continue
        bridge_iter = int(getattr(args, "bridge_px", 1))
        parent = list(range(n + 1))
        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a
        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra
        if bridge_iter > 0:
            bridged = ndimage.binary_dilation(mask, iterations=bridge_iter)
            blab, bn = ndimage.label(bridged, structure=struct)
            for b in range(1, bn + 1):
                frags = set(np.unique(lab[blab == b]).tolist()) - {0}
                # Only merge small groups: cap prevents runaway fusion
                # across any accidental grid bridge.
                frags = [int(f) for f in frags]
                if 1 < len(frags) <= 6:
                    for f in frags[1:]:
                        union(frags[0], f)
        merged = np.zeros_like(lab)
        remap: dict[int, int] = {}
        for comp_id in range(1, n + 1):
            root = find(comp_id)
            if root not in remap:
                remap[root] = len(remap) + 1
            merged[lab == comp_id] = remap[root]
        lab, n = merged, len(remap)
        sizes = ndimage.sum(mask, lab, range(1, n + 1))
        for comp_id in range(1, n + 1):
            area_px = float(sizes[comp_id - 1])
            if area_px > max_blob_px:
                continue  # background wash / legend panel, not a lot
            area_poc = area_px * poc_scale
            if area_poc < args.min_area:
                continue  # noise fragment gate (1592 -> 861)
            ys, xs = np.nonzero(lab == comp_id)
            if len(xs) < 4:
                continue
            x0, x1 = float(xs.min()), float(xs.max())
            y0, y1 = float(ys.min()), float(ys.max())
            bw, bh = max(1.0, x1 - x0 + 1.0), max(1.0, y1 - y0 + 1.0)
            extent = area_px / (bw * bh)
            stride = max(1, len(xs) // 4000)
            hull = convex_hull(list(zip(xs[::stride].tolist(), ys[::stride].tolist())))
            if len(hull) < 3:
                continue
            hull_area = polygon_area([(float(x), float(y)) for x, y in hull])
            solidity = (area_px / hull_area) if hull_area > 0 else 0.0
            simp = rdp([(float(x), float(y)) for x, y in hull], args.rdp_eps)
            if len(simp) > args.max_points:
                simp = simp[: args.max_points]
            if len(simp) < 3:
                continue
            if polygon_area(simp) <= 0:
                continue
            raw.append({
                "tier_key": key,
                "poly_work": simp,
                "cx": float(xs.mean()),
                "cy": float(ys.mean()),
                "area_px": area_px,
                "area_poc": area_poc,
                "solidity": float(min(1.0, solidity)),
                "extent": float(extent),
            })
            per_tier_blobs[key] += 1
    stats = {"per_tier_blobs": per_tier_blobs, "poc_scale": poc_scale,
             "work_size": [w, h]}
    return raw, stats



def build_records(raw: list[dict], tiers: dict,
                  w: int, h: int, args, seed_sort: bool = True) -> list[dict]:
    """Sort, number L-001.., normalize to 0-100%, score confidence."""
    items = list(raw)
    if seed_sort:
        # Reading order: top-to-bottom bands, then left-to-right.
        items.sort(key=lambda r: (round(r["cy"] / max(1.0, h) * 40.0), r["cx"]))
    lots: list[dict] = []
    for i, r in enumerate(items, start=1):
        poly_pct = [
            {"x": round(min(100.0, max(0.0, x / w * 100.0)), 2),
             "y": round(min(100.0, max(0.0, y / h * 100.0)), 2)}
            for x, y in r["poly_work"]
        ]
        solidity = r["solidity"]
        extent = r["extent"]
        # Confidence: rectangular lots score high; concave/sliver low.
        conf = 0.55 * min(1.0, solidity / 0.95) + 0.30 * min(1.0, extent / 0.8)
        conf += 0.15 if r["area_poc"] >= 70.0 else 0.15 * (r["area_poc"] / 70.0)
        conf = round(min(1.0, max(0.0, conf)), 3)
        needs_review = bool(
            solidity < args.review_solidity or extent < 0.45 or r["area_poc"] < 60.0
        )
        lots.append({
            "lot_number": f"L-{i:03d}",
            "tier_key": r["tier_key"],
            "price": int(tiers[r["tier_key"]]["price"]),
            "polygon_pct": poly_pct,
            "confidence": conf,
            "needs_review": needs_review,
            "source": "raster-auto",
        })
    return lots


# ---------------------------------------------------------------------------
# Validation gates (fail closed).
# ---------------------------------------------------------------------------

def run_gates(lots: list[dict], tier_keys: list[str], tiers: dict,
              args) -> tuple[list[str], list[str], dict]:
    """Return (errors, warnings, gate_report). Errors -> exit 2."""
    errors: list[str] = []
    warnings: list[str] = []
    n = len(lots)
    if n < args.expected_min or n > args.expected_max:
        errors.append(
            f"lot count {n} outside expected [{args.expected_min},{args.expected_max}]"
        )
    counts = Counter(l["tier_key"] for l in lots)
    for key in tier_keys:
        if counts.get(key, 0) == 0:
            warnings.append(f"tier {key!r} detected 0 lots")
    bad_geom = 0
    small_poly = 0
    for lot in lots:
        pts = lot.get("polygon_pct", [])
        if not isinstance(pts, list) or len(pts) < 3 or len(pts) > 200:
            bad_geom += 1
            continue
        ok = all(
            isinstance(p, dict) and isinstance(p.get("x"), (int, float))
            and isinstance(p.get("y"), (int, float))
            and 0.0 <= p["x"] <= 100.0 and 0.0 <= p["y"] <= 100.0
            and math.isfinite(p["x"]) and math.isfinite(p["y"])
            for p in pts
        )
        if not ok:
            bad_geom += 1
            continue
        area = polygon_area([(p["x"], p["y"]) for p in pts])
        if area < 0.005:  # degenerate sliver in pct space
            small_poly += 1
    if bad_geom:
        errors.append(f"{bad_geom} lots with invalid polygon_pct (need 3..200 pts in 0..100)")
    if small_poly:
        warnings.append(f"{small_poly} lots with degenerate area (<0.005 pct^2)")
    price_bad = [l["lot_number"] for l in lots
                 if l.get("tier_key") in tiers
                 and l.get("price") != int(tiers[l["tier_key"]]["price"])]
    if price_bad:
        errors.append(f"{len(price_bad)} lots with price != tier catalogue (e.g. {price_bad[:3]})")
    unknown_tier = sorted({str(l.get("tier_key")) for l in lots} - set(tier_keys))
    if unknown_tier:
        errors.append(f"{len(unknown_tier)} unknown tier_key(s): {unknown_tier[:5]}")
    bad_schema = 0
    for lot in lots:
        conf = lot.get("confidence")
        if not isinstance(conf, (int, float)) or not math.isfinite(conf) or not 0.0 <= conf <= 1.0:
            bad_schema += 1
            continue
        if not isinstance(lot.get("needs_review"), bool):
            bad_schema += 1
            continue
        lot_number = lot.get("lot_number")
        if not isinstance(lot_number, str) or not lot_number:
            bad_schema += 1
            continue
        if lot.get("source") != "raster-auto":
            bad_schema += 1
    if bad_schema:
        errors.append(f"{bad_schema} lots with invalid confidence/needs_review/lot_number/source schema")
    low = sum(1 for l in lots if l.get("needs_review"))
    low_frac = (low / n) if n else 0.0
    if low_frac > 0.75:
        warnings.append(f"needs_review fraction high: {low_frac:.0%} ({low}/{n})")
    report = {
        "lot_count": n,
        "per_tier": dict(counts),
        "needs_review": low,
        "needs_review_frac": round(low_frac, 4),
        "bad_geometry": bad_geom,
        "degenerate_area": small_poly,
        "expected_range": [args.expected_min, args.expected_max],
    }
    return errors, warnings, report


# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not os.path.exists(args.source):
        print(f"error: source not found: {args.source}", file=sys.stderr)
        return 2
    if not os.path.exists(args.tiers):
        print(f"error: tiers file not found: {args.tiers}", file=sys.stderr)
        return 2
    os.makedirs(args.out_dir, exist_ok=True)

    tiers = load_tiers(args.tiers)
    img, meta = load_source_image(args.source, args.pdf_image_index, args.work_width)
    w, h = img.size
    labels, tier_keys = classify_pixels(img, tiers, line_white=args.line_white)
    raw, det_stats = detect_lots(labels, tier_keys, args)
    lots = build_records(raw, tiers, w, h, args, seed_sort=args.seed_sort)
    errors, warnings, gate_report = run_gates(lots, tier_keys, tiers, args)

    lots_path = os.path.join(args.out_dir, "lots.json")
    with open(lots_path, "w", encoding="utf-8") as f:
        json.dump(lots, f)
    report = {
        "tenant": args.tenant,
        "source_meta": meta,
        "tiers_file": os.path.basename(args.tiers),
        "tier_catalogue": {k: {"label": v["label"], "price": v["price"],
                               "fill": v["fill"], "tolerance": v["tolerance"]}
                           for k, v in tiers.items()},
        "params": {"work_width": args.work_width, "min_area": args.min_area,
                   "max_blob_frac": args.max_blob_frac, "rdp_eps": args.rdp_eps,
                   "max_points": args.max_points,
                   "review_solidity": args.review_solidity,
                   "line_white": args.line_white, "erode_px": args.erode_px,
                   "pdf_image_index": args.pdf_image_index},
        "detection": det_stats,
        "gates": gate_report,
        "warnings": warnings,
        "errors": errors,
        "outputs": {"lots_json": "lots.json"},
    }
    report_path = os.path.join(args.out_dir, "ingest-report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    n = len(lots)
    low = gate_report["needs_review"]
    print(f"detected {n} lots ({low} needs_review) -> {lots_path}")
    print(f"tiers: {dict(gate_report['per_tier'])}")
    for wrn in warnings:
        print(f"warning: {wrn}", file=sys.stderr)
    if errors:
        for err in errors:
            print(f"error: {err}", file=sys.stderr)
        print(f"report: {report_path} (GATES FAILED)", file=sys.stderr)
        return 2
    print(f"report: {report_path} (gates passed)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

