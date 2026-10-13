#!/usr/bin/env python3
"""Blind labeling sheet: stratified random lots as image crops with NO OCR
text shown, for unbiased human labeling of printed numbers and areas.

    python3 scripts/blind-sheet.py --lots <lots.json> --image <plan>
      --out <sheet-dir> --n 100 --seed 7

Stratification: quotas per tier (largest-remainder, minimum 2 per tier),
then quadrant x aspect-class balance within each tier (seeded shuffle for
ties). Crop = lot bbox + 30% margin (min 160px), native resolution.

Outputs: sheet-crops/S001.png..., labels_template.csv, label.html generated
from scripts/templates/blind-label.html, and README.md in the served sheet
directory. The lot-number mapping is written separately, outside that
directory, so a static server rooted at --out cannot reveal it during
labeling. Nothing here reads OCR output (blind by construction).
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
import math
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


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def geometry_sha256(lots: list[dict]) -> str:
    geometry = [{
        "lot_number": lot.get("lot_number"),
        "tier_key": lot.get("tier_key"),
        "polygon_pct": lot.get("polygon_pct"),
    } for lot in lots]
    geometry.sort(key=lambda lot: (
        str(lot["lot_number"] or ""),
        json.dumps(lot["polygon_pct"], sort_keys=True, separators=(",", ":"), ensure_ascii=False),
    ))
    payload = json.dumps(geometry, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def round_robin_sample(rows: list[dict], count: int, rng: random.Random) -> list[dict]:
    """Sample across available tiers instead of letting the largest tier dominate."""
    by_tier: dict[str, list[dict]] = {}
    for row in sorted(rows, key=lambda item: str(item["lot_number"])):
        by_tier.setdefault(str(row.get("tier_key") or "unknown"), []).append(row)
    for tier_rows in by_tier.values():
        rng.shuffle(tier_rows)
    selected = []
    tiers = sorted(by_tier)
    while len(selected) < count:
        advanced = False
        for tier in tiers:
            if by_tier[tier] and len(selected) < count:
                selected.append(by_tier[tier].pop())
                advanced = True
        if not advanced:
            raise ValueError(f"benchmark stratum has only {len(selected)} eligible cases; needs {count}")
    return selected


def choose_benchmark_cases(
    lots: list[dict], crop_ocr: dict, area_ocr: dict, seed: int = 7,
) -> tuple[list[tuple[str, dict]], dict[str, int]]:
    """Pick exactly 20 consensus, 20 discordant and 20 challenge polygons.

    Candidate text is read only for sampling and is never copied into either
    artifact served to the blind reviewer.
    """
    rng = random.Random(seed)
    crop_by_id = {row.get("lot_number"): row for row in crop_ocr.get("lots", [])}
    area_by_id = area_ocr.get("assembled_units", {})
    selected_ids: set[str] = set()

    def candidate_rows(predicate):
        return [lot for lot in lots if predicate(
            lot,
            crop_by_id.get(lot["lot_number"], {}),
            area_by_id.get(lot["lot_number"], {}),
        )]

    agree_pool = candidate_rows(lambda lot, crop, _area:
        lot.get("match_status") == "matched" and
        bool(lot.get("printed_lot_number")) and bool(crop.get("number")) and
        str(lot["printed_lot_number"]) == str(crop["number"]))
    disagree_pool = candidate_rows(lambda lot, crop, _area:
        lot.get("match_status") == "matched" and
        bool(lot.get("printed_lot_number")) and bool(crop.get("number")) and
        str(lot["printed_lot_number"]) != str(crop["number"]))

    selected: list[tuple[str, dict]] = []
    for stratum, pool in (("ocr_methods_agree", agree_pool), ("ocr_methods_disagree", disagree_pool)):
        chosen = round_robin_sample(pool, 20, rng)
        selected.extend((stratum, lot) for lot in chosen)
        selected_ids.update(lot["lot_number"] for lot in chosen)

    def available(pool):
        return [lot for lot in pool if lot["lot_number"] not in selected_ids]

    hard_pools = [
        ("duplicate_or_conflicting_page_tokens", candidate_rows(lambda lot, _crop, _area:
            lot.get("match_status") == "duplicate")),
        ("no_number_from_any_path", candidate_rows(lambda lot, crop, area:
            not lot.get("printed_lot_number") and not crop.get("number") and not area.get("number"))),
        ("narrow_or_irregular_geometry", candidate_rows(lambda lot, _crop, _area:
            lot.get("match_status") != "matched" and aspect_class(lot.get("polygon_pct", [])) != "square")),
        ("crop_vs_area_conflict", candidate_rows(lambda lot, crop, area:
            bool(crop.get("number")) and bool(area.get("number")) and
            str(crop["number"]) != str(area["number"]))),
    ]
    hard_counts = {}
    for stratum, pool in hard_pools:
        eligible = available(pool)
        chosen = round_robin_sample(eligible, 5, rng)
        selected.extend((stratum, lot) for lot in chosen)
        selected_ids.update(lot["lot_number"] for lot in chosen)
        hard_counts[stratum] = len(chosen)

    if len(selected) != 60 or len(selected_ids) != 60:
        raise ValueError("benchmark selection did not produce 60 distinct polygons")
    rng.shuffle(selected)
    counts = {
        "ocr_methods_agree": 20,
        "ocr_methods_disagree": 20,
        "difficult_cases": 20,
        **hard_counts,
    }
    return selected, counts


def crop_box_for(poly_pct: list[dict], width: int, height: int) -> tuple[int, int, int, int]:
    if len(poly_pct) < 3:
        raise ValueError("target polygon must have at least 3 vertices")
    points = []
    for point in poly_pct:
        x, y = float(point["x"]), float(point["y"])
        if not math.isfinite(x) or not math.isfinite(y) or not (0 <= x <= 100 and 0 <= y <= 100):
            raise ValueError("polygon coordinates must be finite percentages from 0 to 100")
        points.append((x / 100 * width, y / 100 * height))
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    pad_x = max(160 - (x1 - x0), 0.3 * (x1 - x0)) / 2
    pad_y = max(160 - (y1 - y0), 0.3 * (y1 - y0)) / 2
    return (max(0, int(x0 - pad_x)), max(0, int(y0 - pad_y)),
            min(width, int(x1 + pad_x)), min(height, int(y1 + pad_y)))


def create_target_crop(img, polygon_pct: list[dict], box: tuple[int, int, int, int], path: Path) -> None:
    """Save a lossless source crop and double-stroke only the target boundary."""
    from PIL import ImageDraw
    crop = img.crop(box).convert("RGB")
    points = [(p["x"] / 100 * img.width - box[0], p["y"] / 100 * img.height - box[1])
              for p in polygon_pct]
    closed = points + [points[0]]
    draw = ImageDraw.Draw(crop)
    draw.line(closed, fill="#FFFFFF", width=9, joint="curve")
    draw.line(closed, fill="#D00070", width=4, joint="curve")
    crop.save(path, "PNG", optimize=False)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lots", required=True)
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument(
        "--mapping-out",
        help="private mapping JSON path (default: <out>-mapping.json, outside --out)",
    )
    ap.add_argument("--n", type=int, default=100)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--benchmark", action="store_true",
                    help="build the additive 60-case target-outlined OCR benchmark")
    ap.add_argument("--page-ocr", help="page-wide OCR artifact used by --benchmark")
    ap.add_argument("--crop-ocr", help="per-polygon crop OCR artifact used by --benchmark")
    ap.add_argument("--area-ocr", help="area-anchored OCR artifact used by --benchmark")
    args = ap.parse_args()

    from PIL import Image
    lots = json.loads(Path(args.lots).read_text())
    if not isinstance(lots, list) or not lots:
        raise SystemExit("lots input must be a non-empty array")
    if args.n < 1:
        raise SystemExit("--n must be a positive crop count")
    if args.n > len(lots):
        raise SystemExit(f"--n ({args.n}) cannot exceed available lot count ({len(lots)})")
    img = Image.open(args.image)
    W, H = img.size
    if args.benchmark:
        if args.n != 60:
            raise SystemExit("--benchmark requires --n 60 (20 agreement, 20 disagreement, 20 difficult)")
        missing = [name for name in ("page_ocr", "crop_ocr", "area_ocr") if not getattr(args, name)]
        if missing:
            raise SystemExit("--benchmark requires --page-ocr, --crop-ocr, and --area-ocr")
        generate_benchmark(args, lots, img, W, H)
        return

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

    template_path = Path(__file__).resolve().parent / "templates" / "blind-label.html"
    try:
        page_template = template_path.read_text()
    except OSError as e:
        raise SystemExit(f"could not read reviewer page template {template_path}: {e}")
    if "{{CROP_COUNT}}" not in page_template or "{{REVIEW_KEY}}" not in page_template:
        raise SystemExit(f"reviewer page template is missing required placeholders: {template_path}")

    out = Path(args.out)
    mapping_out = Path(args.mapping_out) if args.mapping_out else out.with_name(f"{out.name}-mapping.json")
    out_resolved = out.resolve()
    mapping_resolved = mapping_out.resolve()
    try:
        mapping_resolved.relative_to(out_resolved)
    except ValueError:
        pass
    else:
        raise SystemExit("mapping output must be outside the served --out directory")

    crops_dir = out / "sheet-crops"
    crops_dir.mkdir(parents=True, exist_ok=True)
    mapping = {}
    review_fingerprint = hashlib.sha256()
    with open(out / "labels_template.csv", "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["id", "printed_number", "printed_area_sqm", "ambiguous", "unreadable"])
        for i, (tier, lot) in enumerate(picked, start=1):
            sid = f"S{i:03d}"
            xs = [p["x"] / 100 * W for p in lot["polygon_pct"]]
            ys = [p["y"] / 100 * H for p in lot["polygon_pct"]]
            x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
            pad_x = max(160 - (x1 - x0), 0.3 * (x1 - x0)) / 2
            pad_y = max(160 - (y1 - y0), 0.3 * (y1 - y0)) / 2
            box = (max(0, int(x0 - pad_x)), max(0, int(y0 - pad_y)),
                   min(W, int(x1 + pad_x)), min(H, int(y1 + pad_y)))
            crop_path = crops_dir / f"{sid}.png"
            img.crop(box).save(crop_path)
            review_fingerprint.update(sid.encode("ascii"))
            review_fingerprint.update(hashlib.sha256(crop_path.read_bytes()).digest())
            writer.writerow([sid, "", "", "", ""])
            mapping[sid] = {"lot_number": lot["lot_number"], "tier_key": tier,
                            "crop_box_px": list(box)}
    mapping_out.parent.mkdir(parents=True, exist_ok=True)
    mapping_out.write_text(json.dumps(mapping, indent=1) + "\n")
    page = page_template
    page = page.replace("{{CROP_COUNT}}", str(args.n))
    page = page.replace("{{REVIEW_KEY}}", review_fingerprint.hexdigest())
    if "{{CROP_COUNT}}" in page or "{{REVIEW_KEY}}" in page:
        raise SystemExit(f"unexpanded template placeholder in {template_path}")
    (out / "label.html").write_text(page)
    (out / "README.md").write_text(
        "# Blind labeling sheet\n\n"
        "Crop filenames are random IDs (S001...); lot numbers are NOT shown.\n"
        "The lot-number mapping is stored separately from this served directory.\n\n"
        "Open label.html through scripts/serve-blind-sheet.py to label crops.\n\n"
        "The CSV records ambiguous and unreadable statuses separately; leave\n"
        "both blank only when that crop has not been reviewed.\n\n"
        "For manual labels_template.csv entry:\n"
        "- printed_number: the lot number printed inside the crop (exact digits).\n"
        "- printed_area_sqm: the printed area figure in square metres, digits and\n"
        "  decimals only (e.g. 1011.876). Leave blank when no area is printed.\n"
        "Leave values blank only when that crop has not been reviewed.\n\n"
        "Then run: python3 scripts/score-labels.py --mapping <private-mapping.json> \\\n"
        "  --lots <lots.json> --labels labels_template.csv --ocr <ocr.json>\n"
    )
    print(f"sheet: {len(picked)} crops -> {crops_dir}/")
    print(f"private mapping: {mapping_out}")
    print("tier quotas:", {t: sum(1 for tt, _ in picked if tt == t) for t in sorted(by_tier)})


def generate_benchmark(args, lots: list[dict], img, width: int, height: int) -> None:
    """Create a fresh, blind, source-bound 60-polygon benchmark pack."""
    out = Path(args.out)
    mapping_out = Path(args.mapping_out) if args.mapping_out else out.with_name(f"{out.name}-mapping.json")
    evidence_out = out.with_name(f"{out.name}-selection-evidence.json")
    if out.exists() or mapping_out.exists() or evidence_out.exists():
        raise SystemExit("benchmark outputs already exist; choose fresh output and mapping paths")
    out_resolved, mapping_resolved = out.resolve(), mapping_out.resolve()
    try:
        mapping_resolved.relative_to(out_resolved)
    except ValueError:
        pass
    else:
        raise SystemExit("mapping output must be outside the served benchmark directory")
    try:
        evidence_out.resolve().relative_to(out_resolved)
    except ValueError:
        pass
    else:
        raise SystemExit("selection evidence must be outside the served benchmark directory")

    source_image = Path(args.image)
    lots_path = Path(args.lots)
    page_ocr_path = Path(args.page_ocr)
    crop_ocr_path = Path(args.crop_ocr)
    area_ocr_path = Path(args.area_ocr)
    page_ocr = json.loads(page_ocr_path.read_text())
    crop_ocr = json.loads(crop_ocr_path.read_text())
    area_ocr = json.loads(area_ocr_path.read_text())

    ids = [lot.get("lot_number") for lot in lots]
    if any(not isinstance(lot_id, str) or not lot_id for lot_id in ids) or len(set(ids)) != len(ids):
        raise SystemExit("lots input must contain unique non-empty detection IDs")
    if any(len(lot.get("polygon_pct", [])) < 3 for lot in lots):
        raise SystemExit("benchmark source contains a detection without drawable polygon geometry")
    page_image = page_ocr.get("image") or {}
    if (page_image.get("width") not in (None, width) or
            page_image.get("height") not in (None, height)):
        raise SystemExit("page OCR image dimensions do not match the crop source image")
    if crop_ocr.get("image") not in (None, source_image.name):
        raise SystemExit("per-polygon OCR source image name does not match --image")
    if area_ocr.get("image") not in (None, source_image.name):
        raise SystemExit("area-anchored OCR source image name does not match --image")

    try:
        selected, strata_counts = choose_benchmark_cases(lots, crop_ocr, area_ocr, args.seed)
    except (KeyError, TypeError, ValueError) as error:
        raise SystemExit(f"could not select the 60-case benchmark: {error}") from error

    source_hash = file_sha256(source_image)
    geometry_hash = geometry_sha256(lots)
    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    benchmark_id = "hopkins-grove-lot-number-benchmark-v1"
    out.mkdir(parents=True, exist_ok=False)
    crops_dir = out / "sheet-crops"
    crops_dir.mkdir()
    review_cases = []
    mapping = {}
    fingerprint = hashlib.sha256()

    for index, (stratum, lot) in enumerate(selected, start=1):
        case_id = f"S{index:03d}"
        polygon = lot["polygon_pct"]
        box = crop_box_for(polygon, width, height)
        crop_path = crops_dir / f"{case_id}.png"
        create_target_crop(img, polygon, box, crop_path)
        crop_hash = file_sha256(crop_path)
        fingerprint.update(case_id.encode("ascii"))
        fingerprint.update(bytes.fromhex(crop_hash))
        case = {
            "id": case_id,
            "detection_id": lot["lot_number"],
            "polygon_pct": polygon,
            "crop_box_px": list(box),
            "crop_file": f"sheet-crops/{case_id}.png",
            "crop_sha256": crop_hash,
        }
        review_cases.append(case)
        # Extra local mapping fields are evidence only; OCR predictions never
        # enter the served pack or the reviewer export.
        mapping[case_id] = {
            "lot_number": lot["lot_number"],
            "tier_key": lot.get("tier_key"),
            "polygon_pct": polygon,
            "crop_box_px": list(box),
            "crop_file": case["crop_file"],
            "crop_sha256": crop_hash,
            "selection_stratum": stratum,
            "source_image_sha256": source_hash,
        }

    manifest = {
        "schema_version": 1,
        "artifact_type": "wamule-lot-number-benchmark",
        "benchmark_id": benchmark_id,
        "generated_at_utc": timestamp,
        "selection_seed": args.seed,
        "selection_contract": "20 OCR-path agreements, 20 OCR-path disagreements, 20 difficult cases; stratified across available tiers",
        "source_image": {
            "name": source_image.name,
            "sha256": source_hash,
            "width": width,
            "height": height,
            "coordinate_space": "pixel coordinates from polygon_pct × native width/height",
        },
        "lot_geometry_sha256": geometry_hash,
        "review_key": fingerprint.hexdigest(),
        "cases": review_cases,
    }
    manifest_bytes = (json.dumps(manifest, indent=1, ensure_ascii=False) + "\n").encode("utf-8")
    manifest_path = out / "benchmark-manifest.json"
    manifest_path.write_bytes(manifest_bytes)
    manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()

    template_path = Path(__file__).resolve().parent / "templates" / "lot-number-benchmark.html"
    try:
        page_template = template_path.read_text()
    except OSError as error:
        raise SystemExit(f"could not read benchmark reviewer template {template_path}: {error}") from error
    page = page_template.replace("{{BENCHMARK_ID}}", benchmark_id)
    page = page.replace("{{CASE_COUNT}}", str(len(review_cases)))
    page = page.replace("{{MANIFEST_SHA256}}", manifest_hash)
    if "{{" in page:
        raise SystemExit(f"unexpanded reviewer-template placeholder in {template_path}")
    (out / "label.html").write_text(page, encoding="utf-8")

    with (out / "labels_template.csv").open("w", newline="", encoding="utf-8") as target:
        writer = csv.writer(target)
        writer.writerow(["id", "printed_number", "printed_area_sqm", "ambiguous", "unreadable", "skipped", "reviewer", "reviewed_at"])
        writer.writerows([[case["id"], "", "", "", "", "", "", ""] for case in review_cases])

    mapping_out.parent.mkdir(parents=True, exist_ok=True)
    mapping_out.write_text(json.dumps(mapping, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    selection_evidence = {
        "schema_version": 1,
        "artifact_type": "wamule-lot-number-benchmark-selection-evidence",
        "benchmark_id": benchmark_id,
        "generated_at_utc": timestamp,
        "selection_seed": args.seed,
        "strata_counts": strata_counts,
        "inputs": {
            "lots": {"name": lots_path.name, "sha256": file_sha256(lots_path)},
            "source_image": {"name": source_image.name, "sha256": source_hash},
            "page_ocr": {"name": page_ocr_path.name, "sha256": file_sha256(page_ocr_path)},
            "crop_ocr": {"name": crop_ocr_path.name, "sha256": file_sha256(crop_ocr_path)},
            "area_ocr": {"name": area_ocr_path.name, "sha256": file_sha256(area_ocr_path)},
        },
        "lot_geometry_sha256": geometry_hash,
        "mapping_sha256": file_sha256(mapping_out),
        "review_manifest_sha256": manifest_hash,
        "generator_sha256": file_sha256(Path(__file__).resolve()),
        "case_selection": [
            {"id": case_id, "detection_id": info["lot_number"], "stratum": info["selection_stratum"]}
            for case_id, info in mapping.items()
        ],
    }
    evidence_out.write_text(json.dumps(selection_evidence, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    (out / "README.md").write_text(
        "# Hopkins Grove lot-number benchmark v1\n\n"
        "This local-only review pack contains 60 source-aligned crops. The exact target lot boundary is outlined in white and magenta. Read only the number printed inside that outline; neighboring numbers are context. OCR/AI predictions are not included or served.\n\n"
        "The page autosaves progress in this browser. Use **Export review JSON** and **Export scorer CSV** periodically and before closing. A skipped case is not complete; use **Review skipped** to return to it.\n\n"
        "The generated `benchmark-manifest.json` records source image SHA-256, full-image dimensions, polygon vertices, native crop box, and each crop SHA-256. `../" + mapping_out.name + "` and `../" + evidence_out.name + "` are private local provenance files and are deliberately outside the served directory.\n\n"
        "The scorer CSV uses `score-labels.py` columns. After downloading it, score page-wide predictions with the matching source/polygons and a fresh OCR artifact:\n\n"
        "```sh\npython3 scripts/score-labels.py --mapping " + mapping_out.as_posix() +
        " --lots " + lots_path.as_posix() + " --labels <downloaded-labels.csv> --ocr " + page_ocr_path.as_posix() + "\n```\n\n"
        "That scorer measures full-image token reading/position, not the separate crop-OCR extraction path; crop-specific scoring remains a follow-up.\n",
        encoding="utf-8",
    )
    print(f"benchmark: {len(review_cases)} source-aligned outlined crops -> {crops_dir}/")
    print(f"review page: {out / 'label.html'}")
    print(f"review manifest: {manifest_path} (sha256 {manifest_hash})")
    print(f"private mapping: {mapping_out}")
    print(f"private selection evidence: {evidence_out}")
    print(f"strata: {strata_counts}")


if __name__ == "__main__":
    main()
