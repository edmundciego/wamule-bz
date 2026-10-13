#!/usr/bin/env python3
"""Validate and fingerprint owner-reviewed road-width click evidence.

This creates a candidate calibration record, never an accepted/public scale.
The 60 ft group is the fit reference; 40 ft measurements are held-out checks.
Both transverse click orientations must be represented for both widths.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import re
import statistics
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import NoReturn

from PIL import Image, __version__ as PILLOW_VERSION

MIN_PER_WIDTH_AXIS = 3
RELATIVE_TOLERANCE = 0.10
DUPLICATE_ENDPOINT_TOLERANCE_PX = 2.0
HASH_CHUNK_BYTES = 1024 * 1024


def fail(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(2)


def fingerprint_file(path: Path) -> dict[str, int | str]:
    before = path.stat()
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as source:
        while True:
            chunk = source.read(HASH_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
    after = path.stat()
    if (
        total != before.st_size or after.st_size != total or
        before.st_mtime_ns != after.st_mtime_ns or
        before.st_ctime_ns != after.st_ctime_ns or
        before.st_ino != after.st_ino or before.st_dev != after.st_dev
    ):
        raise RuntimeError(f"input changed while fingerprinting: {path}")
    return {"bytes": total, "sha256": digest.hexdigest()}


def utc_timestamp(value: str | None) -> str:
    if value is None:
        return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("--recorded-at must be an ISO-8601 timestamp with timezone") from exc
    if parsed.tzinfo is None:
        raise ValueError("--recorded-at must include a timezone")
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_measurements(raw: dict, image_width: int, image_height: int) -> list[dict]:
    roads = raw.get("roads")
    if not isinstance(roads, list) or not roads:
        raise ValueError("measurements JSON must contain a non-empty roads array")
    parsed = []
    for index, road in enumerate(roads, start=1):
        if not isinstance(road, dict):
            raise ValueError(f"road #{index} must be an object")
        stated = road.get("stated")
        if stated not in (40, 60):
            raise ValueError(f"road #{index} must state 40 or 60 ft")
        points = [road.get("p1"), road.get("p2")]
        if not all(isinstance(point, dict) for point in points):
            raise ValueError(f"road #{index} needs p1 and p2 endpoints")
        coordinates = []
        for point in points:
            x, y = point.get("x"), point.get("y")
            if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                raise ValueError(f"road #{index} endpoints must have numeric x/y coordinates")
            if not math.isfinite(x) or not math.isfinite(y):
                raise ValueError(f"road #{index} endpoints must be finite")
            if not (0 <= x <= image_width and 0 <= y <= image_height):
                raise ValueError(f"road #{index} endpoint is outside the source image")
            coordinates.append((float(x), float(y)))
        (x1, y1), (x2, y2) = coordinates
        dx, dy = x2 - x1, y2 - y1
        measured = math.hypot(dx, dy)
        recorded = road.get("width")
        if measured <= 0 or not isinstance(recorded, (int, float)) or not math.isfinite(recorded):
            raise ValueError(f"road #{index} width must be a positive finite number")
        if not math.isclose(measured, float(recorded), rel_tol=0.001, abs_tol=0.25):
            raise ValueError(f"road #{index} width does not match its endpoints")
        parsed.append({
            "index": index,
            "stated_width_ft": int(stated),
            "measured_width_px": measured,
            "ft_per_px": int(stated) / measured,
            "measurement_axis": "x" if abs(dx) >= abs(dy) else "y",
            "p1": {"x": x1, "y": y1},
            "p2": {"x": x2, "y": y2},
        })
        for previous in parsed[:-1]:
            if previous["stated_width_ft"] != int(stated):
                continue
            same_order = (
                math.hypot(previous["p1"]["x"] - x1, previous["p1"]["y"] - y1) <= DUPLICATE_ENDPOINT_TOLERANCE_PX
                and math.hypot(previous["p2"]["x"] - x2, previous["p2"]["y"] - y2) <= DUPLICATE_ENDPOINT_TOLERANCE_PX
            )
            reverse_order = (
                math.hypot(previous["p1"]["x"] - x2, previous["p1"]["y"] - y2) <= DUPLICATE_ENDPOINT_TOLERANCE_PX
                and math.hypot(previous["p2"]["x"] - x1, previous["p2"]["y"] - y1) <= DUPLICATE_ENDPOINT_TOLERANCE_PX
            )
            if same_order or reverse_order:
                raise ValueError(f"road #{index} duplicates road #{previous['index']} within the endpoint tolerance")
    return parsed


def build_record(args) -> dict:
    measurement_path = Path(args.measurements)
    image_path = Path(args.image)
    measurements_bytes = measurement_path.read_bytes()
    raw = json.loads(measurements_bytes)
    if not isinstance(raw, dict):
        raise ValueError("measurements JSON root must be an object")

    image_size = raw.get("imageSize")
    if (
        not isinstance(image_size, list) or len(image_size) != 2 or
        not all(isinstance(value, int) and value > 0 for value in image_size)
    ):
        raise ValueError("measurements JSON must include imageSize [width,height]")
    display_scale = raw.get("scale")
    if (not isinstance(display_scale, (int, float)) or isinstance(display_scale, bool) or
            not math.isfinite(display_scale) or display_scale <= 0):
        raise ValueError("measurements JSON must include a positive finite display scale")
    with Image.open(image_path) as image:
        actual_image_size = list(image.size)
    if image_size != actual_image_size:
        raise ValueError(f"measurement imageSize {image_size} does not match source image {actual_image_size}")
    source_fingerprint = fingerprint_file(image_path)
    measured_image_hash = raw.get("imageSha256")
    if not isinstance(measured_image_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", measured_image_hash):
        raise ValueError("measurements JSON must include the verified source image SHA-256 as imageSha256")
    if measured_image_hash != source_fingerprint["sha256"]:
        raise ValueError("measurement source image SHA-256 does not match the supplied image")

    roads = parse_measurements(raw, image_size[0], image_size[1])
    groups = {
        f"{width}ft_{axis}": [road for road in roads
                              if road["stated_width_ft"] == width and road["measurement_axis"] == axis]
        for width in (60, 40) for axis in ("x", "y")
    }
    counts = {key: len(value) for key, value in groups.items()}
    checks = {
        "minimum_three_clicks_per_width_and_orientation": all(
            count >= MIN_PER_WIDTH_AXIS for count in counts.values()),
        "both_reference_widths_present": all(counts[f"{width}ft_{axis}"] > 0
                                               for width in (40, 60) for axis in ("x", "y")),
    }
    widths = {width: [road["measured_width_px"] for road in roads
                      if road["stated_width_ft"] == width] for width in (40, 60)}
    if not widths[40] or not widths[60]:
        raise ValueError("at least one 40 ft and one 60 ft road measurement are required")

    medians_by_axis = {
        width: {axis: statistics.median(road["measured_width_px"] for road in groups[f"{width}ft_{axis}"])
                for axis in ("x", "y") if groups[f"{width}ft_{axis}"]}
        for width in (40, 60)
    }
    median_40 = statistics.median(widths[40])
    median_60 = statistics.median(widths[60])
    ratio_60_to_40 = median_60 / median_40
    checks["60_to_40_ratio_within_ten_percent_of_1_5"] = abs(ratio_60_to_40 / 1.5 - 1) <= RELATIVE_TOLERANCE

    def relative_spread(values: dict[str, float]) -> float | None:
        if len(values) < 2:
            return None
        center = statistics.mean(values.values())
        return (max(values.values()) - min(values.values())) / center if center else None

    orientation_spread = {
        width: relative_spread(values) for width, values in medians_by_axis.items()
    }
    checks["orientation_spread_within_ten_percent"] = all(
        spread is not None and spread <= RELATIVE_TOLERANCE for spread in orientation_spread.values())

    fit_axis_scale = {axis: 60 / medians_by_axis[60][axis] for axis in ("x", "y")
                      if axis in medians_by_axis[60]}
    candidate_ft_per_px = statistics.median(road["ft_per_px"] for road in roads
                                             if road["stated_width_ft"] == 60)
    fit_scales = [road["ft_per_px"] for road in roads if road["stated_width_ft"] == 60]
    fit_scale_median = statistics.median(fit_scales)
    fit_scale_mad = statistics.median(abs(value - fit_scale_median) for value in fit_scales)
    held_out = {}
    for axis in ("x", "y"):
        measured_40 = medians_by_axis[40].get(axis)
        fit_scale = fit_axis_scale.get(axis)
        if measured_40 is not None and fit_scale is not None:
            predicted_px = 40 / fit_scale
            error = measured_40 / predicted_px - 1
            held_out[axis] = {
                "observed_median_px": round(measured_40, 3),
                "predicted_px_from_60ft_fit": round(predicted_px, 3),
                "relative_error": round(error, 5),
                "within_ten_percent": abs(error) <= RELATIVE_TOLERANCE,
            }
    checks["40ft_held_out_scale_check_within_ten_percent"] = (
        len(held_out) == 2 and all(result["within_ten_percent"] for result in held_out.values())
    )
    evidence_ready = all(checks.values())

    endpoint_rel_uncertainty = math.sqrt(2) * args.endpoint_uncertainty_px / median_60
    width_rel_uncertainty = args.reference_width_uncertainty_ft / 60
    scale_rel_uncertainty = math.hypot(endpoint_rel_uncertainty, width_rel_uncertainty)
    measurement_fingerprint = {
        "bytes": len(measurements_bytes),
        "sha256": hashlib.sha256(measurements_bytes).hexdigest(),
    }

    return {
        "schema_version": 1,
        "status": "ready_for_owner_review" if evidence_ready else "needs_review",
        "recorded_at_utc": utc_timestamp(args.recorded_at),
        "reviewer": args.reviewer.strip(),
        "reference_source": args.reference_source.strip(),
        "uncertainty": {
            "endpoint_each_axis_px": args.endpoint_uncertainty_px,
            "reference_width_ft": args.reference_width_uncertainty_ft,
            "input_contribution_relative": round(scale_rel_uncertainty, 5),
            "input_contribution_ft_per_px": round(candidate_ft_per_px * scale_rel_uncertainty, 6),
            "assumption": "independent endpoint and stated-width uncertainties combined in quadrature",
            "limitation": "input contribution only; does not include observed sample spread or systematic reference/map error",
        },
        "recorder": {
            "name": "record-road-calibration.py",
            "schema_version": 1,
            "python_version": platform.python_version(),
            "pillow_version": PILLOW_VERSION,
        },
        "measurement_tool": {
            "name": "measure-roads.html",
            "exported_canvas_scale": display_scale,
            "coordinates": "source-image pixel coordinates",
        },
        "source_image": {"name": image_path.name, "width": image_size[0], "height": image_size[1],
                         **source_fingerprint},
        "raw_measurements": {"name": measurement_path.name, **measurement_fingerprint},
        "measurement_count": len(roads),
        "measurements": roads,
        "summary": {
            "fit_reference_width_ft": 60,
            "candidate_ft_per_px": round(candidate_ft_per_px, 6),
            "candidate_input_uncertainty_ft_per_px": round(candidate_ft_per_px * scale_rel_uncertainty, 6),
            "fit_reference_scale_mad_ft_per_px": round(fit_scale_mad, 6),
            "fit_reference_scale_mad_relative": round(fit_scale_mad / fit_scale_median, 5),
            "held_out_reference_width_ft": 40,
            "median_width_px": {str(width): round(statistics.median(widths[width]), 3)
                                 for width in (40, 60)},
            "median_width_px_by_orientation": {
                str(width): {axis: round(value, 3) for axis, value in axis_values.items()}
                for width, axis_values in medians_by_axis.items()
            },
            "orientation_scale_spread_relative": {
                str(width): round(value, 5) if value is not None else None
                for width, value in orientation_spread.items()
            },
            "held_out_40ft_checks": held_out,
            "ratio_60_to_40": round(ratio_60_to_40, 5),
            "checks": checks,
            "scale_status": "pending_owner_review" if evidence_ready else "unavailable",
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--measurements", required=True, help="raw road-measurements.json export")
    parser.add_argument("--image", required=True, help="the exact source image used for the clicks")
    parser.add_argument("--reference-source", required=True,
                        help="approved drawing/survey identifier, revision, and page/feature")
    parser.add_argument("--reviewer", required=True, help="person who reviewed the reference and clicks")
    parser.add_argument("--endpoint-uncertainty-px", required=True, type=float,
                        help="estimated uncertainty per clicked endpoint coordinate axis, in native pixels")
    parser.add_argument("--reference-width-uncertainty-ft", required=True, type=float,
                        help="stated road-width uncertainty, in feet")
    parser.add_argument("--recorded-at", default=None,
                        help="ISO-8601 timestamp with timezone; defaults to current UTC")
    parser.add_argument("--out", default=None, help="output path (default: next to --measurements)")
    args = parser.parse_args()

    if not args.reviewer.strip() or not args.reference_source.strip():
        fail("--reviewer and --reference-source must not be blank")
    if not math.isfinite(args.endpoint_uncertainty_px) or args.endpoint_uncertainty_px <= 0:
        fail("--endpoint-uncertainty-px must be a positive finite number")
    if not math.isfinite(args.reference_width_uncertainty_ft) or args.reference_width_uncertainty_ft <= 0:
        fail("--reference-width-uncertainty-ft must be a positive finite number")
    try:
        record = build_record(args)
    except (OSError, json.JSONDecodeError, ValueError, RuntimeError) as exc:
        fail(str(exc))

    output = Path(args.out) if args.out else Path(args.measurements).with_name("road-calibration.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        fail(f"refusing to overwrite existing evidence: {output}")
    temp_path = None
    try:
        fd, temp_name = tempfile.mkstemp(prefix=f".{output.name}.", suffix=".tmp", dir=output.parent)
        temp_path = Path(temp_name)
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            target.write(json.dumps(record, indent=2) + "\n")
            target.flush()
            os.fsync(target.fileno())
        # Exclusive creation prevents clobbering evidence that appeared during the write.
        os.link(temp_path, output)
    except FileExistsError:
        fail(f"refusing to overwrite existing evidence: {output}")
    except OSError as exc:
        fail(f"could not write calibration record: {exc}")
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)

    print(f"road calibration evidence: {output}")
    print(f"status: {record['status']}; scale: {record['summary']['scale_status']}")
    print(f"candidate ft/px: {record['summary']['candidate_ft_per_px']}; 60:40 ratio: {record['summary']['ratio_60_to_40']}")


if __name__ == "__main__":
    main()
