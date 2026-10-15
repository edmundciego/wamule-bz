#!/usr/bin/env python3
"""Create local-only, source-bound color-component polygon proposals.

No canonical lot data is written. All outputs are separate review artifacts.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from shapely.geometry import Point, Polygon, box
from shapely.ops import unary_union

PIPELINE_VERSION = "0.1.2"
OUTPUT_NAMES = ("proposal.json", "comparison.png", "overlay.png", "report.md", "manifest.json")
COLORS = ((0, 232, 190), (72, 220, 255), (255, 220, 74), (255, 142, 120),
          (190, 165, 255), (120, 238, 130), (255, 170, 220), (185, 230, 255))


def fingerprint_file(path: Path) -> dict[str, Any]:
    before = path.stat()
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    after = path.stat()
    if (size != before.st_size or after.st_size != size or
            before.st_mtime_ns != after.st_mtime_ns or before.st_ino != after.st_ino):
        raise RuntimeError(f"Input changed while fingerprinting: {path}")
    return {"bytes": size, "sha256": digest.hexdigest()}


def canonical_sha(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def load_detections(path: Path | None) -> list[dict[str, Any]]:
    if path is None:
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    rows = raw.get("lots", []) if isinstance(raw, dict) else raw
    if not isinstance(rows, list):
        raise ValueError("Detection input must be a list or an object containing a lots list.")
    return [row for row in rows if isinstance(row, dict)]


def find_detection(rows: list[dict[str, Any]], detection_id: str) -> dict[str, Any]:
    matches = [row for row in rows
               if str(row.get("lot_number", row.get("id", ""))) == detection_id
               or str(row.get("id", "")) == detection_id]
    if len(matches) != 1:
        raise ValueError(f"Expected one detection matching {detection_id!r}; found {len(matches)}.")
    polygon = matches[0].get("polygon_pct")
    if not isinstance(polygon, list) or len(polygon) < 3:
        raise ValueError(f"Detection {detection_id} has no drawable polygon.")
    return matches[0]


def polygon_from_pct(points: list[dict[str, Any]], width: int, height: int) -> Polygon:
    return Polygon([(float(point["x"]) * width / 100.0, float(point["y"]) * height / 100.0)
                    for point in points])


def px_points_to_pct(points: list[tuple[float, float]], width: int, height: int) -> list[dict[str, float]]:
    # Inverse of mapPolygonToRasterPixels in src/lib/mapGeometry.ts.
    return [{"x": round(x * 100.0 / width, 8), "y": round(y * 100.0 / height, 8)} for x, y in points]


def parse_hue_ranges(value: str) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    for part in value.split(","):
        start, separator, end = part.strip().partition("-")
        if not separator:
            raise ValueError(f"Invalid hue range {part!r}; use comma-separated low-high pairs.")
        low, high = int(start), int(end)
        if low < 0 or high > 179 or low > high:
            raise ValueError(f"OpenCV hue range must satisfy 0 <= low <= high <= 179: {part}")
        ranges.append((low, high))
    if not ranges:
        raise ValueError("Provide at least one hue range.")
    return ranges


def read_region(value: str, width: int, height: int) -> tuple[int, int, int, int]:
    try:
        x0, y0, x1, y1 = (int(part.strip()) for part in value.split(","))
    except (ValueError, TypeError) as exc:
        raise ValueError("Region must be four integer source pixels: x0,y0,x1,y1.") from exc
    if x0 < 0 or y0 < 0 or x1 > width or y1 > height or x1 <= x0 or y1 <= y0:
        raise ValueError(f"Region must fit the {width}x{height} source image and have positive area.")
    return x0, y0, x1, y1


def get_tesseract_version(executable: str | None) -> str | None:
    if not executable:
        return None
    try:
        result = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=10)
        return result.stdout.splitlines()[0].strip() if result.stdout else "version unavailable"
    except (OSError, subprocess.TimeoutExpired):
        return "version unavailable"


def ocr_variant(
    gray: np.ndarray,
    origin: tuple[int, int],
    scale: int,
    method: str,
    polygon: Polygon,
    tesseract: str,
) -> dict[str, Any]:
    enlarged = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    ok, encoded = cv2.imencode(".png", enlarged)
    if not ok:
        return {"method": method, "psm": 6, "raw_text": "", "tokens": [],
                "error": "Could not encode OCR crop."}
    try:
        result = subprocess.run(
            [tesseract, "stdin", "stdout", "--psm", "6", "tsv",
             "-c", "tessedit_char_whitelist=0123456789."],
            input=encoded.tobytes(), capture_output=True, timeout=45,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"method": method, "psm": 6, "raw_text": "", "tokens": [], "error": str(exc)}
    if result.returncode:
        return {"method": method, "psm": 6, "raw_text": "", "tokens": [],
                "error": result.stderr.decode("utf-8", "replace")[:300]}

    rows = list(csv.DictReader(io.StringIO(result.stdout.decode("utf-8", "replace")), delimiter="\t"))
    word_rows = [row for row in rows if row.get("level") == "5" and row.get("text", "").strip()]
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    parsed: list[dict[str, Any]] = []
    for row in word_rows:
        try:
            left, top = float(row["left"]), float(row["top"])
            width, height = float(row["width"]), float(row["height"])
            confidence = float(row.get("conf", "-1"))
        except (ValueError, KeyError):
            continue
        text = row["text"].strip()
        center_x = origin[0] + (left + width / 2) / scale
        center_y = origin[1] + (top + height / 2) / scale
        token = {
            "text": text,
            "source_bbox_px": [round(origin[0] + left / scale, 2),
                               round(origin[1] + top / scale, 2),
                               round(width / scale, 2), round(height / scale, 2)],
            "source_center_px": [round(center_x, 2), round(center_y, 2)],
            "inside_candidate": bool(polygon.buffer(1.0).covers(Point(center_x, center_y))),
            "tesseract_confidence": round(confidence, 2),
        }
        parsed.append(token)
        key = (row.get("block_num", ""), row.get("par_num", ""), row.get("line_num", ""))
        groups.setdefault(key, []).append(token)

    number_tokens: list[dict[str, Any]] = []
    for group in groups.values():
        # Suppress 2-3 digit fragments on OCR lines that contain a decimal area
        # or a longer integer area reading.
        area_line = any("." in token["text"] or
                        (token["text"].isdigit() and len(token["text"]) >= 4)
                        for token in group)
        if area_line:
            continue
        for token in group:
            if (re.fullmatch(r"\d{2,3}", token["text"]) and token["inside_candidate"]
                    and token["tesseract_confidence"] >= 30):
                number_tokens.append(token)

    raw_text = "\n".join(row["text"].strip() for row in word_rows if row.get("text", "").strip())
    return {"method": method, "psm": 6, "raw_text": raw_text,
            "tokens": parsed, "number_tokens_inside_candidate": number_tokens}


def extract_number_evidence(
    source: np.ndarray,
    polygon: Polygon,
    approx_local: np.ndarray,
    component_bbox: tuple[int, int, int, int],
    tesseract: str | None,
    ocr_scale: int,
) -> dict[str, Any]:
    if not tesseract:
        return {"provider": None, "model_version": None, "raw_text": [], "candidates": [],
                "proposed_printed_number": None, "flags": ["tesseract_unavailable"]}
    source_height, source_width = source.shape[:2]
    x, y, width, height = component_bbox
    x0, y0 = max(0, x - 48), max(0, y - 48)
    x1, y1 = min(source_width, x + width + 48), min(source_height, y + height + 48)
    plain = cv2.cvtColor(source[y0:y1, x0:x1], cv2.COLOR_BGR2HSV)[:, :, 2]
    local_value = cv2.cvtColor(source[y:y + height, x:x + width], cv2.COLOR_BGR2HSV)[:, :, 2].copy()
    silhouette = np.zeros((height, width), dtype=np.uint8)
    cv2.fillPoly(silhouette, [approx_local], 255)
    local_value[silhouette == 0] = 255

    variants = [
        ocr_variant(plain, (x0, y0), max(ocr_scale, 4), "local-value-channel", polygon, tesseract),
        ocr_variant(local_value, (x, y), max(ocr_scale, 5), "component-masked-value-channel", polygon, tesseract),
    ]
    evidence: dict[str, dict[str, Any]] = {}
    for variant in variants:
        for token in variant.get("number_tokens_inside_candidate", []):
            number = token["text"]
            entry = evidence.setdefault(number, {"printed_number_candidate": number, "observations": []})
            entry["observations"].append({
                "method": variant["method"],
                "psm": variant["psm"],
                "source_center_px": token["source_center_px"],
                "tesseract_confidence": token["tesseract_confidence"],
            })
    candidates = [evidence[value] for value in sorted(evidence, key=lambda number: (int(number), number))]
    proposed = candidates[0]["printed_number_candidate"] if len(candidates) == 1 else None
    flags = ["unreviewed_ocr_suggestion"]
    if not candidates:
        flags.append("no_number_read")
    elif len(candidates) > 1:
        flags.append("conflicting_ocr_candidates")
    return {
        "provider": "tesseract",
        "model_version": get_tesseract_version(tesseract),
        "raw_text": variants,
        "candidates": candidates,
        "proposed_printed_number": proposed,
        "flags": flags,
        "confidence_note": "Tesseract confidence is an engine score, not calibrated extraction accuracy.",
    }


def geometry_validation(
    children: list[dict[str, Any]],
    parent: Polygon,
    detections: list[dict[str, Any]],
    parent_id: str | None,
    gray: np.ndarray,
) -> dict[str, Any]:
    shapes = [child["_shape"] for child in children]
    valid_shapes = [shape for shape in shapes
                    if shape is not None and not shape.is_empty and shape.is_valid]
    child_union = unary_union(valid_shapes) if valid_shapes else Polygon()
    pairwise_overlaps: list[dict[str, Any]] = []
    for first in range(len(valid_shapes)):
        for second in range(first + 1, len(valid_shapes)):
            area = valid_shapes[first].intersection(valid_shapes[second]).area
            if area > 0.25:
                pairwise_overlaps.append({"child_indices": [first + 1, second + 1],
                                          "overlap_px2": round(area, 2)})

    parent_area = parent.area
    intersection_area = child_union.intersection(parent).area if not child_union.is_empty else 0.0
    gap_area = parent.difference(child_union).area if not child_union.is_empty else parent_area
    outside_area = child_union.difference(parent).area if not child_union.is_empty else 0.0

    image_height, image_width = gray.shape[:2]
    ink = (gray < 85).astype(np.uint8)
    distance = cv2.distanceTransform(np.where(ink > 0, 0, 255).astype(np.uint8), cv2.DIST_L2, 3)
    alignment: list[float] = []
    for child in children:
        xs = [point[0] for point in child["polygon_px"]]
        ys = [point[1] for point in child["polygon_px"]]
        x0, y0 = max(0, math.floor(min(xs)) - 3), max(0, math.floor(min(ys)) - 3)
        x1, y1 = min(image_width, math.ceil(max(xs)) + 4), min(image_height, math.ceil(max(ys)) + 4)
        edge = np.zeros((y1 - y0, x1 - x0), dtype=np.uint8)
        local = np.array([[[round(x - x0), round(y - y0)] for x, y in child["polygon_px"]]],
                         dtype=np.int32)
        cv2.polylines(edge, local, True, 255, 1, lineType=cv2.LINE_8)
        samples = distance[y0:y1, x0:x1][edge > 0]
        alignment.append(float(np.mean(samples <= 4.0)) if samples.size else 0.0)
    for index, child in enumerate(children):
        child["_alignment_within_4px"] = round(alignment[index] * 100, 2)

    detection_conflicts: list[dict[str, Any]] = []
    for child_index, shape in enumerate(shapes):
        if shape is None or shape.is_empty or not shape.is_valid:
            continue
        for row in detections:
            detection_id = str(row.get("lot_number", row.get("id", "")))
            if not detection_id or detection_id == parent_id:
                continue
            points = row.get("polygon_pct")
            if not isinstance(points, list) or len(points) < 3:
                continue
            other = Polygon([(float(point["x"]) * image_width / 100.0,
                              float(point["y"]) * image_height / 100.0) for point in points])
            if not other.is_valid or other.is_empty:
                continue
            overlap_area = shape.intersection(other).area
            if overlap_area > max(4.0, shape.area * 0.001):
                detection_conflicts.append({
                    "child_index": child_index + 1,
                    "detection_id": detection_id,
                    "intersection_px2": round(overlap_area, 2),
                    "candidate_area_fraction": round(overlap_area / shape.area, 6) if shape.area else None,
                })

    duplicates: dict[str, list[int]] = {}
    for index, child in enumerate(children, 1):
        number = child.get("number_evidence", {}).get("proposed_printed_number")
        if number:
            duplicates.setdefault(number, []).append(index)
    duplicate_assignments = [{"printed_number_candidate": value, "child_indices": indices}
                             for value, indices in sorted(duplicates.items()) if len(indices) > 1]
    invalid = [index + 1 for index, shape in enumerate(shapes)
               if shape is None or shape.is_empty or not shape.is_valid or shape.area <= 0]

    summary = {
        "all_child_shapes_valid": not invalid,
        "invalid_child_indices": invalid,
        "pairwise_child_overlaps": pairwise_overlaps,
        "existing_detection_overlaps": detection_conflicts,
        "duplicate_number_candidates": duplicate_assignments,
        "parent_area_px2": round(parent_area, 2),
        "child_union_area_px2": round(child_union.area, 2),
        "parent_coverage_percent": round(intersection_area / parent_area * 100, 3) if parent_area else 0.0,
        "unassigned_parent_area_percent": round(gap_area / parent_area * 100, 3) if parent_area else None,
        "outside_parent_area_percent": round(outside_area / parent_area * 100, 3) if parent_area else None,
        "child_boundary_alignment_within_4px_percent": [child["_alignment_within_4px"] for child in children],
        "boundary_alignment_method": "fraction of simplified child-boundary raster samples within 4 source pixels of dark source pixels; heuristic, not survey accuracy",
        "review_flags": [],
    }
    if len(children) < 2:
        summary["review_flags"].append("fewer_than_two_components")
    if invalid:
        summary["review_flags"].append("invalid_or_self_intersecting_geometry")
    if pairwise_overlaps:
        summary["review_flags"].append("child_overlaps")
    if detection_conflicts:
        summary["review_flags"].append("overlap_with_other_detection")
    if duplicate_assignments:
        summary["review_flags"].append("duplicate_ocr_number_candidates")
    if (summary["unassigned_parent_area_percent"] or 0) > 1:
        summary["review_flags"].append("parent_area_gap_requires_human_review")
    if (summary["outside_parent_area_percent"] or 0) > 0.1:
        summary["review_flags"].append("candidate_geometry_outside_parent")
    return summary


def draw_outputs(
    image: Image.Image,
    crop_box: tuple[int, int, int, int],
    parent_points: list[tuple[float, float]],
    children: list[dict[str, Any]],
) -> tuple[bytes, bytes]:
    scale = 2
    x0, y0, _, _ = crop_box
    base = image.crop(crop_box).convert("RGB")
    base = base.resize((base.width * scale, base.height * scale), Image.Resampling.LANCZOS)
    panel_width, panel_height = base.size
    header_height, gap = 52, 18
    font = ImageFont.load_default()
    comparison = Image.new("RGB", (panel_width * 2 + gap, panel_height + header_height), (248, 249, 247))
    draw = ImageDraw.Draw(comparison)
    draw.text((12, 16), "Original detection", fill=(32, 40, 38), font=font)
    draw.text((panel_width + gap + 12, 16), f"CV proposals: {len(children)} draft components",
              fill=(32, 40, 38), font=font)
    comparison.paste(base, (0, header_height))
    comparison.paste(base, (panel_width + gap, header_height))

    def comparison_points(points: list[tuple[float, float]], offset_x: int) -> list[tuple[int, int]]:
        return [(round(offset_x + (x - x0) * scale), round(header_height + (y - y0) * scale))
                for x, y in points]

    left_parent = comparison_points(parent_points, 0)
    draw.line(left_parent + [left_parent[0]], fill=(255, 0, 190), width=5, joint="curve")
    right_parent = comparison_points(parent_points, panel_width + gap)
    draw.line(right_parent + [right_parent[0]], fill=(255, 0, 190), width=3, joint="curve")
    for index, child in enumerate(children):
        color = COLORS[index % len(COLORS)]
        points = comparison_points(child["polygon_px"], panel_width + gap)
        draw.line(points + [points[0]], fill=color, width=5, joint="curve")
        label_point = Point(child["bbox_px"][0] + 7, child["bbox_px"][1] + 7)
        label = f"C{index + 1} · {child.get('proposed_printed_number') or 'number ?'}"
        lx = round(panel_width + gap + (label_point.x - x0) * scale)
        ly = round(header_height + (label_point.y - y0) * scale)
        bounds = draw.textbbox((lx, ly), label, font=font)
        draw.rectangle((bounds[0] - 4, bounds[1] - 3, bounds[2] + 4, bounds[3] + 3), fill=(15, 28, 26))
        draw.text((lx, ly), label, fill=(255, 255, 255), font=font)

    overlay = image.crop(crop_box).convert("RGB").resize((panel_width, panel_height), Image.Resampling.LANCZOS)
    overdraw = ImageDraw.Draw(overlay)

    def overlay_points(points: list[tuple[float, float]]) -> list[tuple[int, int]]:
        return [(round((x - x0) * scale), round((y - y0) * scale)) for x, y in points]

    out_parent = overlay_points(parent_points)
    overdraw.line(out_parent + [out_parent[0]], fill=(255, 0, 190), width=5, joint="curve")
    for index, child in enumerate(children):
        points = overlay_points(child["polygon_px"])
        overdraw.line(points + [points[0]], fill=COLORS[index % len(COLORS)], width=5, joint="curve")
        label_point = Point(child["bbox_px"][0] + 7, child["bbox_px"][1] + 7)
        label = f"C{index + 1} · {child.get('proposed_printed_number') or '?'}"
        xy = (round((label_point.x - x0) * scale), round((label_point.y - y0) * scale))
        bounds = overdraw.textbbox(xy, label, font=font)
        overdraw.rectangle((bounds[0] - 4, bounds[1] - 3, bounds[2] + 4, bounds[3] + 3), fill=(15, 28, 26))
        overdraw.text(xy, label, fill=(255, 255, 255), font=font)

    comparison_buffer, overlay_buffer = io.BytesIO(), io.BytesIO()
    comparison.save(comparison_buffer, format="PNG", optimize=False)
    overlay.save(overlay_buffer, format="PNG", optimize=False)
    return comparison_buffer.getvalue(), overlay_buffer.getvalue()


def clean_child(child: dict[str, Any]) -> dict[str, Any]:
    result = {key: value for key, value in child.items()
              if not key.startswith("_")}
    result["review"] = {"status": "draft", "printed_number": "", "reviewer": "", "reviewed_at": None}
    return result


def make_report(proposal: dict[str, Any]) -> str:
    validation = proposal["validation"]
    children = proposal["children"]
    pdf_note = ("The optional source PDF was fingerprinted read-only." if proposal.get("source_pdf")
                else "No source PDF was opened or fingerprinted in this run; processing used the source-bound raster only.")
    lines = [
        "# Plat digitizer proposal report", "",
        f"- Detection: {proposal['detection_source']['selected_parent_detection_id'] or 'explicit source region'}",
        f"- Proposal fingerprint: {proposal['proposal_fingerprint']}",
        f"- Source raster: {proposal['source_image']['width']}x{proposal['source_image']['height']} pixels; SHA-256 {proposal['source_image']['sha256']}",
        f"- Existing detections compared: {proposal['detection_source']['detection_count']}",
        f"- Connected components proposed: {len(children)}",
        f"- Printed-number suggestions: {sum(bool(child['proposed_printed_number']) for child in children)}; all remain unreviewed",
        "", "## Visual evidence", "",
        "See comparison.png for original detection versus proposed child outlines and overlay.png for the combined source-aligned view. Coordinates are derived from source pixels, then converted to Wamule image-relative percentages.",
        "", "## Geometry checks", "",
        f"- Valid child shapes: {validation['all_child_shapes_valid']}",
        f"- Pairwise child overlaps: {len(validation['pairwise_child_overlaps'])}",
        f"- Overlaps with other detections: {len(validation['existing_detection_overlaps'])}",
        f"- Parent area covered: {validation['parent_coverage_percent']:.3f}%",
        f"- Parent area unassigned: {validation['unassigned_parent_area_percent']:.3f}%",
        f"- Child boundary samples within 4 px of dark source ink: {validation['child_boundary_alignment_within_4px_percent']}% (heuristic only)",
        f"- Review flags: {', '.join(validation['review_flags']) or 'none detected by these checks'}",
        "", "## Child candidates", "",
        "| Draft ID | OCR number candidate | OCR candidates | Geometry | Review flags |",
        "|---|---:|---|---|---|",
    ]
    for child in children:
        candidates = ", ".join(item["printed_number_candidate"] for item in child["number_evidence"]["candidates"]) or "none"
        flags = ", ".join(child["review_flags"]) or "none"
        lines.append(
            f"| {child['draft_id']} | {child['proposed_printed_number'] or '—'} | {candidates} | "
            f"{child['segmentation']['simplified_vertex_count']} vertices, "
            f"{child['segmentation']['component_pixel_count']} fill pixels | {flags} |"
        )
    lines.extend([
        "", "## Accuracy and uncertainty", "",
        "This is a computer-vision/OCR proposal, not an accuracy benchmark. The independent 60-case blind benchmark was not read, changed, or used as ground truth. Tesseract confidence is an uncalibrated engine score. No candidate number or boundary is approved. Gaps, component boundaries, duplicate candidates, and neighboring detection overlaps require source review. No AI provider was called and no proprietary image was uploaded.",
        "", "## Data safety", "",
        f"The source raster and existing detection JSON were read only. {pdf_note} The original detection, benchmark evidence, canonical parcel identities, prices, availability, buyer map, and hosted data were not modified. All child IDs are local draft references.", "",
    ])
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, required=True, help="Original or source-bound full-page raster.")
    parser.add_argument("--source-pdf", type=Path, help="Optional original source PDF to fingerprint; never modified.")
    parser.add_argument("--detections", type=Path, help="Existing lots.json used for a parent and/or overlap checks.")
    parser.add_argument("--parent-id", help="Existing detection ID to segment, for example L-683.")
    parser.add_argument("--region-px", help="Optional native raster rectangle x0,y0,x1,y1.")
    parser.add_argument("--ocr-results", type=Path, help="Optional existing local OCR JSON, read-only.")
    parser.add_argument("--output-dir", type=Path, required=True, help="Local proposal directory; differing files are never overwritten.")
    parser.add_argument("--hue-ranges", default="0-12,170-179", help="OpenCV HSV hue ranges; default isolates red fills.")
    parser.add_argument("--min-saturation", type=int, default=90)
    parser.add_argument("--min-value", type=int, default=80)
    parser.add_argument("--min-component-area", type=int, default=300, help="Minimum connected fill pixels.")
    parser.add_argument("--simplify-px", type=float, default=2.0, help="Contour simplification tolerance in source pixels.")
    parser.add_argument("--ocr-scale", type=int, default=4)
    parser.add_argument("--no-ocr", action="store_true", help="Skip local Tesseract without changing geometry extraction.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if not 0 <= args.min_saturation <= 255 or not 0 <= args.min_value <= 255:
            raise ValueError("Saturation and value thresholds must be from 0 through 255.")
        if args.min_component_area <= 0 or args.simplify_px <= 0 or args.ocr_scale <= 0:
            raise ValueError("Component area, simplification tolerance, and OCR scale must be positive.")
        hue_ranges = parse_hue_ranges(args.hue_ranges)
        if args.parent_id and not args.detections:
            raise ValueError("Pass --detections when selecting a --parent-id.")
        if not args.parent_id and not args.region_px:
            raise ValueError("Select an existing --parent-id or provide an explicit --region-px rectangle.")
        for name in ("image", "source_pdf", "detections", "ocr_results"):
            path = getattr(args, name)
            if path is not None and not path.is_file():
                raise ValueError(f"Input not found: {path}")
        source = cv2.imread(str(args.image), cv2.IMREAD_COLOR)
        if source is None:
            raise ValueError(f"OpenCV could not read raster: {args.image}")
        height, width = source.shape[:2]
        detections = load_detections(args.detections)
        parent_row = find_detection(detections, args.parent_id) if args.parent_id else None
        if parent_row:
            parent_id = str(parent_row.get("lot_number", parent_row.get("id")))
            parent = polygon_from_pct(parent_row["polygon_pct"], width, height)
            parent_pct = parent_row["polygon_pct"]
            if not parent.is_valid or parent.area <= 0:
                raise ValueError("Selected detection geometry is invalid; no segmentation was run.")
            parent_points = [(float(point["x"]) * width / 100.0,
                              float(point["y"]) * height / 100.0) for point in parent_pct]
        else:
            parent_id = None
            parent_pct = None
            parent_points = []
            parent = Polygon()

        selected_region = read_region(args.region_px, width, height) if args.region_px else None
        if selected_region:
            region_shape = box(*selected_region)
            if parent_id:
                parent = parent.intersection(region_shape)
                if parent.geom_type != "Polygon" or parent.is_empty or not parent.is_valid:
                    raise ValueError("The selected source region does not leave one valid parent polygon.")
                parent_points = [(float(x), float(y)) for x, y in list(parent.exterior.coords)[:-1]]
            else:
                parent = region_shape
                parent_points = [(selected_region[0], selected_region[1]),
                                 (selected_region[2], selected_region[1]),
                                 (selected_region[2], selected_region[3]),
                                 (selected_region[0], selected_region[3])]
                parent_pct = px_points_to_pct(parent_points, width, height)
        elif not parent_id:
            raise ValueError("A source region is required when no parent detection is selected.")

        min_x, min_y, max_x, max_y = parent.bounds
        parent_bbox = (max(0, math.floor(min_x)), max(0, math.floor(min_y)),
                       min(width, math.ceil(max_x)), min(height, math.ceil(max_y)))
        rx0, ry0, rx1, ry1 = parent_bbox
        roi = np.zeros((ry1 - ry0, rx1 - rx0), dtype=np.uint8)
        local_parent = np.array([[(round(x - rx0), round(y - ry0)) for x, y in parent_points]], dtype=np.int32)
        cv2.fillPoly(roi, local_parent, 255)
        local_image = source[ry0:ry1, rx0:rx1]
        hsv = cv2.cvtColor(local_image, cv2.COLOR_BGR2HSV)
        color_mask = np.zeros(roi.shape, dtype=np.uint8)
        for hue_min, hue_max in hue_ranges:
            current = cv2.inRange(
                hsv,
                np.array([hue_min, args.min_saturation, args.min_value], dtype=np.uint8),
                np.array([hue_max, 255, 255], dtype=np.uint8),
            )
            color_mask = cv2.bitwise_or(color_mask, current)
        color_mask = cv2.bitwise_and(color_mask, roi)
        _, labels, stats, _ = cv2.connectedComponentsWithStats(color_mask, connectivity=8)
        components = [(component_id, stat) for component_id, stat in enumerate(stats[1:], 1)
                      if int(stat[cv2.CC_STAT_AREA]) >= args.min_component_area]
        components.sort(key=lambda item: (int(item[1][cv2.CC_STAT_TOP]), int(item[1][cv2.CC_STAT_LEFT])))
        if not components:
            raise ValueError("No filled-color components met the area threshold. Do not force a parcel count; review/trace the source manually.")

        tesseract = None if args.no_ocr else shutil.which("tesseract")
        children: list[dict[str, Any]] = []
        for component_id, stat in components:
            x, y, component_width, component_height, pixel_count = (int(value) for value in stat[:5])
            component_mask = np.where(
                labels[y:y + component_height, x:x + component_width] == component_id, 255, 0
            ).astype(np.uint8)
            contours, _ = cv2.findContours(component_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                continue
            contour = max(contours, key=cv2.contourArea)
            approximate = cv2.approxPolyDP(contour, args.simplify_px, True)
            local_vertices = approximate.reshape(-1, 2)
            points_px = [(float(px + rx0 + x), float(py + ry0 + y)) for px, py in local_vertices]
            shape = Polygon(points_px) if len(points_px) >= 3 else None
            bbox_px = [x + rx0, y + ry0, x + rx0 + component_width, y + ry0 + component_height]
            number_evidence = extract_number_evidence(
                source, shape if shape is not None else Polygon(), approximate,
                (x + rx0, y + ry0, component_width, component_height), tesseract, args.ocr_scale,
            )
            children.append({
                "parent_detection_id": parent_id,
                "polygon_pct": px_points_to_pct(points_px, width, height),
                "polygon_px": [[round(px, 3), round(py, 3)] for px, py in points_px],
                "bbox_px": bbox_px,
                "segmentation": {
                    "algorithm": "opencv-hsv-connected-component-contour",
                    "component_pixel_count": pixel_count,
                    "contour_area_px2": round(float(cv2.contourArea(contour)), 2),
                    "simplified_vertex_count": len(points_px),
                    "simplify_tolerance_px": args.simplify_px,
                },
                "number_evidence": number_evidence,
                "proposed_printed_number": number_evidence["proposed_printed_number"],
                "review_status": "unreviewed",
                "review_flags": list(number_evidence["flags"]),
                "_shape": shape,
            })

        fingerprints = {
            "source_image": {"name": args.image.name, **fingerprint_file(args.image)},
            "source_pdf": {"name": args.source_pdf.name, **fingerprint_file(args.source_pdf)} if args.source_pdf else None,
            "detection_file": {"name": args.detections.name, **fingerprint_file(args.detections)} if args.detections else None,
            "ocr_file": {"name": args.ocr_results.name, **fingerprint_file(args.ocr_results)} if args.ocr_results else None,
        }
        parent_geometry_sha = canonical_sha({"parent_detection_id": parent_id, "polygon_pct": parent_pct})
        settings = {
            "pipeline_version": PIPELINE_VERSION,
            "source": fingerprints,
            "parent_detection_id": parent_id,
            "parent_geometry_sha256": parent_geometry_sha,
            "region_px": selected_region,
            "hue_ranges": hue_ranges,
            "min_saturation": args.min_saturation,
            "min_value": args.min_value,
            "min_component_area": args.min_component_area,
            "simplify_px": args.simplify_px,
            "ocr_scale": args.ocr_scale,
            "ocr_provider": "tesseract" if tesseract else None,
            "opencv_version": cv2.__version__,
            "tesseract_version": get_tesseract_version(tesseract),
        }
        proposal_fingerprint = canonical_sha(settings)

        existing_parent_ocr = None
        if args.ocr_results and parent_id:
            ocr_data = json.loads(args.ocr_results.read_text(encoding="utf-8"))
            ocr_rows = ocr_data.get("lots", []) if isinstance(ocr_data, dict) else []
            existing_parent_ocr = next(({
                "candidate_number": row.get("number"),
                "raw_text": row.get("raw_text"),
                "crop_box_px": row.get("crop_box"),
                "association_note": "Legacy parent crop may contain labels from multiple physical parcels; this is not a child-number assignment.",
            } for row in ocr_rows if str(row.get("lot_number")) == parent_id), None)

        for index, child in enumerate(children, 1):
            child["draft_id"] = f"DRAFT-{parent_id or 'REGION'}-CV{proposal_fingerprint[:8]}-{index:02d}"
        validation = geometry_validation(
            children, parent, detections, parent_id, cv2.cvtColor(source, cv2.COLOR_BGR2GRAY),
        )
        duplicates: dict[str, list[int]] = {}
        for index, child in enumerate(children, 1):
            value = child["proposed_printed_number"]
            if value:
                duplicates.setdefault(value, []).append(index)
        for indices in duplicates.values():
            if len(indices) > 1:
                for index in indices:
                    children[index - 1]["review_flags"].append("duplicate_ocr_number_candidate")

        source_fingerprint = fingerprints["source_image"]
        proposal = {
            "schema_version": 1,
            "artifact_type": "wamule-plat-digitizer-proposal",
            "pipeline_version": PIPELINE_VERSION,
            "proposal_fingerprint": proposal_fingerprint,
            "source_image": {
                **source_fingerprint,
                "width": width,
                "height": height,
                "coordinate_system": "image-relative percentage 0-100; inverse of mapPolygonToRasterPixels",
            },
            "source_pdf": fingerprints["source_pdf"],
            "detection_source": {
                **(fingerprints["detection_file"] or {}),
                "detection_count": len(detections),
                "selected_parent_detection_id": parent_id,
                "selected_parent_polygon_pct": parent_pct,
                "selected_parent_geometry_sha256": parent_geometry_sha,
            },
            "existing_parent_ocr_candidate": existing_parent_ocr,
            "selection": {
                "region_px": list(selected_region) if selected_region else None,
                "parent_bbox_px": list(parent_bbox),
                "source_crop_bbox_px": [max(0, rx0 - 64), max(0, ry0 - 64),
                                        min(width, rx1 + 64), min(height, ry1 + 64)],
            },
            "processing": {
                "geometry_provider": "opencv",
                "geometry_method": "HSV threshold within selected parent followed by connected-component contours; no model-generated coordinates",
                "hue_ranges": [list(pair) for pair in hue_ranges],
                "minimum_saturation": args.min_saturation,
                "minimum_value": args.min_value,
                "minimum_component_area_px": args.min_component_area,
                "simplification_tolerance_px": args.simplify_px,
                "opencv_version": cv2.__version__,
                "ocr_provider": "tesseract" if tesseract else None,
                "ocr_model_version": get_tesseract_version(tesseract),
                "external_ai_upload_performed": False,
            },
            "validation": validation,
            "children": [clean_child(child) for child in children],
            "review": {
                "status": "unreviewed",
                "reviewer": None,
                "reviewed_at": None,
                "required_actions": ["accept", "edit", "reject"],
                "editor_integration": "pending_proposal_import",
                "canonical_identity_assigned": False,
            },
            "safety": {
                "original_detection_modified": False,
                "canonical_parcel_data_modified": False,
                "buyer_map_modified": False,
                "benchmark_modified": False,
                "price_or_availability_assigned": False,
            },
        }
        for index, child in enumerate(proposal["children"]):
            child["boundary_ink_alignment_within_4px_percent"] = validation["child_boundary_alignment_within_4px_percent"][index]

        image = Image.open(args.image).convert("RGB")
        image_crop_box = tuple(proposal["selection"]["source_crop_bbox_px"])
        comparison_bytes, overlay_bytes = draw_outputs(image, image_crop_box, parent_points, children)
        report = make_report(proposal)
        outputs = {
            "proposal.json": (json.dumps(proposal, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8"),
            "comparison.png": comparison_bytes,
            "overlay.png": overlay_bytes,
            "report.md": report.encode("utf-8"),
        }
        output_dir = args.output_dir
        output_dir.mkdir(parents=True, exist_ok=True)
        for name, content in outputs.items():
            target = output_dir / name
            if target.exists() and target.read_bytes() != content:
                raise FileExistsError(f"Refusing to overwrite differing output {target}; preserve it and choose another directory.")
        manifest = {
            "schema_version": 1,
            "proposal_fingerprint": proposal_fingerprint,
            "outputs": {name: hashlib.sha256(content).hexdigest() for name, content in sorted(outputs.items())},
        }
        manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
        manifest_path = output_dir / "manifest.json"
        if manifest_path.exists() and manifest_path.read_bytes() != manifest_bytes:
            raise FileExistsError(f"Refusing to overwrite differing output {manifest_path}; preserve it and choose another directory.")
        for name, content in (*outputs.items(), ("manifest.json", manifest_bytes)):
            target = output_dir / name
            if not target.exists():
                target.write_bytes(content)
        print(f"Proposal {proposal_fingerprint[:12]}: {len(children)} draft components; "
              f"{sum(bool(child['proposed_printed_number']) for child in children)} OCR number candidates.")
        print(f"Parent coverage {validation['parent_coverage_percent']:.3f}%; "
              f"unassigned parent area {validation['unassigned_parent_area_percent']:.3f}%.")
        print(f"Local artifacts: {output_dir}")
        print("No canonical data or original detection was changed.")
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"plat-digitizer: {exc}", file=sys.stderr)
        return 2


def make_report(proposal: dict[str, Any]) -> str:
    validation = proposal["validation"]
    children = proposal["children"]
    pdf_note = ("The optional source PDF was fingerprinted read-only." if proposal.get("source_pdf")
                else "No source PDF was opened or fingerprinted in this run; processing used the source-bound raster only.")
    lines = [
        "# Plat digitizer proposal report", "",
        f"- Detection: {proposal['detection_source']['selected_parent_detection_id'] or 'explicit source region'}",
        f"- Proposal fingerprint: {proposal['proposal_fingerprint']}",
        f"- Source raster: {proposal['source_image']['width']}x{proposal['source_image']['height']} pixels; SHA-256 {proposal['source_image']['sha256']}",
        f"- Existing detections compared: {proposal['detection_source']['detection_count']}",
        f"- Connected components proposed: {len(children)}",
        f"- Printed-number suggestions: {sum(bool(child['proposed_printed_number']) for child in children)}; all remain unreviewed",
        "", "## Visual evidence", "",
        "See comparison.png for original detection versus proposed child outlines and overlay.png for the combined source-aligned view. Coordinates are derived from source pixels, then converted to Wamule image-relative percentages.",
        "", "## Geometry checks", "",
        f"- Valid child shapes: {validation['all_child_shapes_valid']}",
        f"- Pairwise child overlaps: {len(validation['pairwise_child_overlaps'])}",
        f"- Overlaps with other detections: {len(validation['existing_detection_overlaps'])}",
        f"- Parent area covered: {validation['parent_coverage_percent']:.3f}%",
        f"- Parent area unassigned: {validation['unassigned_parent_area_percent']:.3f}%",
        f"- Child boundary samples within 4 px of dark source ink: {validation['child_boundary_alignment_within_4px_percent']}% (heuristic only)",
        f"- Review flags: {', '.join(validation['review_flags']) or 'none detected by these checks'}",
        "", "## Child candidates", "",
        "| Draft ID | OCR number candidate | OCR candidates | Geometry | Review flags |",
        "|---|---:|---|---|---|",
    ]
    for child in children:
        candidates = ", ".join(item["printed_number_candidate"] for item in child["number_evidence"]["candidates"]) or "none"
        flags = ", ".join(child["review_flags"]) or "none"
        lines.append(
            f"| {child['draft_id']} | {child['proposed_printed_number'] or '—'} | {candidates} | "
            f"{child['segmentation']['simplified_vertex_count']} vertices, "
            f"{child['segmentation']['component_pixel_count']} fill pixels | {flags} |"
        )
    lines.extend([
        "", "## Accuracy and uncertainty", "",
        "This is a computer-vision/OCR proposal, not an accuracy benchmark. The independent 60-case blind benchmark was not read, changed, or used as ground truth. Tesseract confidence is an uncalibrated engine score. No candidate number or boundary is approved. Gaps, component boundaries, duplicate candidates, and neighboring detection overlaps require source review. No AI provider was called and no proprietary image was uploaded.",
        "", "## Data safety", "",
        f"The source raster and existing detection JSON were read only. {pdf_note} The original detection, benchmark evidence, canonical parcel identities, prices, availability, buyer map, and hosted data were not modified. All child IDs are local draft references.", "",
    ])
    return "\n".join(lines)


if __name__ == "__main__":
    raise SystemExit(main())
