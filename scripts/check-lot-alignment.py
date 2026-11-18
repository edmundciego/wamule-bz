#!/usr/bin/env python3
"""Check lot polygons against the display raster using interior and edge samples."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage


def hex_rgb(value: str) -> np.ndarray:
    value = value.strip().lstrip("#")
    return np.array([int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)], float)


def inside(x: float, y: float, polygon: list[tuple[float, float]]) -> bool:
    result = False
    for index, (x1, y1) in enumerate(polygon):
        x2, y2 = polygon[(index + 1) % len(polygon)]
        if ((y1 > y) != (y2 > y)) and (x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1):
            result = not result
    return result


def edge_strength(gradient: np.ndarray, lots: list[dict], width: int, height: int,
                  dx: float, dy: float, samples_per_polygon: int = 16) -> float:
    total = 0.0
    lot_count = 0
    for lot in lots[::3]:
        polygon = lot.get("polygon_pct", [])
        if len(polygon) < 3:
            continue
        strength = 0.0
        for index in range(samples_per_polygon):
            position = index / samples_per_polygon * len(polygon)
            edge_index = int(position) % len(polygon)
            fraction = position - int(position)
            point = polygon[edge_index]
            following = polygon[(edge_index + 1) % len(polygon)]
            x = (point["x"] + (following["x"] - point["x"]) * fraction + dx) / 100 * width
            y = (point["y"] + (following["y"] - point["y"]) * fraction + dy) / 100 * height
            strength += gradient[min(height - 1, max(0, int(y))), min(width - 1, max(0, int(x)))]
        total += strength / samples_per_polygon
        lot_count += 1
    return total / max(1, lot_count)


EDGE_PROBE_OFFSETS_PCT = ((0.35, 0), (-0.35, 0), (0, 0.35), (0, -0.35))


def edge_probe_metrics(gradient: np.ndarray, lots: list[dict], width: int, height: int) -> dict:
    zero = edge_strength(gradient, lots, width, height, 0, 0)
    probes = [
        {
            "dx_pct": dx,
            "dy_pct": dy,
            "strength": edge_strength(gradient, lots, width, height, dx, dy),
        }
        for dx, dy in EDGE_PROBE_OFFSETS_PCT
    ]
    best = max(range(len(probes)), key=lambda index: probes[index]["strength"])
    best_strength = probes[best]["strength"]
    return {
        "zero": zero,
        "probes": probes,
        "best_strength": best_strength,
        "best_offset": (
            {"dx_pct": probes[best]["dx_pct"], "dy_pct": probes[best]["dy_pct"]}
            if best_strength > 0
            else None
        ),
        "ratio": (zero / best_strength) if best_strength > 0 else 0.0,
    }


def check_alignment(lots: list[dict], tiers: dict, image: Image.Image,
                    edge_width: int = 1500) -> dict:
    width, height = image.size
    pixels = np.asarray(image.convert("RGB")).astype(float)
    fills = {key: hex_rgb(tier["fill"]) for key, tier in tiers.items()}
    tolerances = {key: float(tier.get("tolerance", 60)) for key, tier in tiers.items()}

    def tier_of(pixel: np.ndarray) -> str | None:
        best_distance, best_tier = 1e9, None
        for key, fill in fills.items():
            distance = float(np.sqrt(((pixel - fill) ** 2).sum()))
            if distance <= tolerances[key] and distance < best_distance:
                best_distance, best_tier = distance, key
        return best_tier

    checked = passed = 0
    for lot in lots:
        polygon = lot.get("polygon_pct", [])
        if len(polygon) < 3:
            continue
        points = [(p["x"] / 100 * width, p["y"] / 100 * height) for p in polygon]
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        hits = matches = 0
        for sample_x in np.linspace(min(xs), max(xs), 6):
            for sample_y in np.linspace(min(ys), max(ys), 6):
                if not inside(sample_x, sample_y, points):
                    continue
                pixel = pixels[min(height - 1, max(0, int(sample_y))), min(width - 1, max(0, int(sample_x)))]
                brightness = float(pixel.mean())
                if brightness < 100 or brightness > 240:
                    continue
                hits += 1
                if tier_of(pixel) == lot.get("tier_key"):
                    matches += 1
        if hits >= 3:
            checked += 1
            if matches / hits >= 0.6:
                passed += 1

    # This image-wide gradient is intentionally computed once, not once per lot.
    edge_height = int(edge_width * height / width)
    edge_image = image.convert("L").resize((edge_width, edge_height))
    edge_pixels = np.asarray(edge_image).astype(float)
    gradient_x = ndimage.sobel(edge_pixels, axis=1)
    gradient_y = ndimage.sobel(edge_pixels, axis=0)
    gradient = np.hypot(gradient_x, gradient_y)
    edge_metrics = edge_probe_metrics(gradient, lots, edge_width, edge_height)
    edge_regions = {}
    for name in ("top_left", "top_right", "bottom_left", "bottom_right"):
        region_lots = []
        for lot in lots:
            polygon = lot.get("polygon_pct", [])
            if len(polygon) < 3:
                continue
            mean_x = sum(point["x"] for point in polygon) / len(polygon)
            mean_y = sum(point["y"] for point in polygon) / len(polygon)
            left = name.endswith("left")
            top = name.startswith("top")
            if (mean_x < 50) == left and (mean_y < 50) == top:
                region_lots.append(lot)
        metrics = edge_probe_metrics(gradient, region_lots, edge_width, edge_height)
        sampled_count = sum(
            1 for lot in region_lots[::3] if len(lot.get("polygon_pct", [])) >= 3
        )
        edge_regions[name] = {
            "candidate_lots": len(region_lots),
            "sampled_lots": sampled_count,
            "edge_zero": metrics["zero"],
            "edge_probe_best": metrics["best_strength"],
            "edge_ratio": metrics["ratio"],
            "best_probe_offset_pct": metrics["best_offset"],
        }
    return {
        "rate": (passed / checked) if checked else 0.0,
        "checked": checked,
        "passed": passed,
        "edge_ratio": edge_metrics["ratio"],
        "edge_zero": edge_metrics["zero"],
        "edge_probe_best": edge_metrics["best_strength"],
        "edge_probes": edge_metrics["probes"],
        "edge_best_probe_offset_pct": edge_metrics["best_offset"],
        "edge_regions": edge_regions,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lots", required=True)
    parser.add_argument("--tiers", required=True)
    parser.add_argument("--background", required=True)
    args = parser.parse_args()
    try:
        lots = json.loads(Path(args.lots).read_text())
        raw_tiers = json.loads(Path(args.tiers).read_text())
        tiers = raw_tiers.get("tiers", raw_tiers)
        with Image.open(args.background) as source:
            result = check_alignment(lots, tiers, source)
        print(json.dumps(result))
        return 0
    except Exception as error:
        print(f"alignment check failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
