#!/usr/bin/env python3
"""Local extraction adapter. Reads one supplied file; writes JSON to stdout.

DXF uses actual CAD paths/text; vector PDFs use closed page paths; raster
sources reuse detect-lots.py with an operator-supplied category palette.
Nothing contacts Supabase or uploads a source document.
"""
import argparse
import base64
import hashlib
import io
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[2]
LABEL = re.compile(r"^(?:(?:LOT|PLOT|PARCEL)\s*(?:NO\.?\s*)?[#:]?\s*)?([A-Za-z]?\d+[A-Za-z]?(?:[-/]\d+)?)$", re.I)


def area(points):
    return abs(sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(points, points[1:] + points[:1]))) / 2


def contains(points, x, y):
    inside = False
    j = len(points) - 1
    for i, p in enumerate(points):
        q = points[j]
        if (p[1] > y) != (q[1] > y) and x < (q[0] - p[0]) * (y - p[1]) / (q[1] - p[1]) + p[0]:
            inside = not inside
        j = i
    return inside


def dedupe(points):
    result = []
    for x, y in points:
        if not math.isfinite(x) or not math.isfinite(y):
            raise ValueError("A boundary has non-finite coordinates.")
        p = (float(x), float(y))
        if not result or math.dist(p, result[-1]) > 1e-9:
            result.append(p)
    if len(result) > 2 and math.dist(result[0], result[-1]) < 1e-9:
        result.pop()
    return result


def read_dxf(path, options):
    import ezdxf
    from ezdxf.path import make_path
    doc = ezdxf.readfile(path)
    raw_units = doc.header.get("$INSUNITS", 0)
    units = options.get("units") or {6: "m", 2: "ft", 21: "us-ft"}.get(raw_units, "unknown")
    shapes, labels, layers, unsupported = [], [], {}, {}
    wanted = options.get("boundary_layer")
    label_layer = options.get("label_layer")

    def walk(entities, prefix="", inherited="0", depth=0):
        if depth > 8:
            raise ValueError("Nested CAD blocks exceed the supported depth of 8.")
        for index, entity in enumerate(entities):
            kind = entity.dxftype()
            layer = entity.dxf.get("layer", "0")
            if layer == "0":
                layer = inherited
            handle = prefix + (entity.dxf.get("handle") or f"v{index}")
            layers[layer] = layers.get(layer, 0) + 1
            if kind == "INSERT":
                for attr in entity.attribs:
                    if not label_layer or attr.dxf.layer == label_layer:
                        labels.append((attr.dxf.text.strip(), float(attr.dxf.insert.x), float(attr.dxf.insert.y)))
                try:
                    walk(entity.virtual_entities(), handle + "/", layer, depth + 1)
                except ezdxf.DXFError:
                    unsupported["unreadable-block"] = unsupported.get("unreadable-block", 0) + 1
            elif kind in ("TEXT", "MTEXT") and (not label_layer or layer == label_layer):
                value = entity.plain_text() if kind == "MTEXT" else entity.dxf.text
                labels.append((value.strip(), float(entity.dxf.insert.x), float(entity.dxf.insert.y)))
            elif kind in ("LWPOLYLINE", "POLYLINE") and (not wanted or layer == wanted):
                closed = entity.closed if kind == "LWPOLYLINE" else entity.is_closed
                if not closed:
                    unsupported["open-boundary"] = unsupported.get("open-boundary", 0) + 1
                    continue
                try:
                    curve = make_path(entity)
                    # Error tolerance is in source drawing units. Preserve the
                    # source coordinates and flag any flattened arc explicitly.
                    points = dedupe([(v.x, v.y) for v in curve.flattening(distance=0.01, segments=8)])
                    if len(points) > 200:
                        unsupported["boundary-over-200-vertices"] = unsupported.get("boundary-over-200-vertices", 0) + 1
                        continue
                    if len(points) >= 3 and area(points) > 1e-10:
                        shapes.append({"key": "cad/" + handle, "layer": layer, "points": points,
                                       "curved": bool(getattr(entity, "has_arc", False))})
                except (ezdxf.DXFError, ValueError, TypeError):
                    unsupported["unreadable-boundary"] = unsupported.get("unreadable-boundary", 0) + 1
            elif kind in ("ACAD_PROXY_ENTITY", "ACADPROXYENTITY", "REGION", "BODY", "3DSOLID"):
                unsupported[kind] = unsupported.get(kind, 0) + 1

    walk(doc.modelspace())
    return shapes, labels, units, layers, unsupported


def vector_pdf(path, options):
    import fitz
    doc = fitz.open(path)
    page_index = int(options.get("page", 0))
    if page_index < 0 or page_index >= len(doc):
        raise ValueError(f"Choose a PDF page from 1 to {len(doc)}.")
    page = doc[page_index]
    shapes, labels = [], []
    for index, drawing in enumerate(page.get_drawings()):
        points, unsupported = [], False
        for item in drawing["items"]:
            if item[0] == "re":
                r = item[1]
                if points:
                    unsupported = True
                    break
                points = [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)]
            elif item[0] == "l":
                a, b = item[1:3]
                if points and math.dist(points[-1], (a.x, a.y)) > 0.01:
                    unsupported = True
                    break
                if not points:
                    points.append((a.x, a.y))
                points.append((b.x, b.y))
            else:
                unsupported = True
        closed = drawing.get("closePath") or (len(points) > 2 and math.dist(points[0], points[-1]) < 0.01) or (len(drawing["items"]) == 1 and drawing["items"][0][0] == "re")
        points = dedupe(points)
        if closed and not unsupported and 3 <= len(points) <= 200 and 4 < area(points) < page.rect.width * page.rect.height * 0.95:
            shapes.append({"key": f"pdf/p{page_index + 1}/{index}", "layer": "PDF paths", "points": points, "curved": False})
    for word in page.get_text("words"):
        x0, y0, x1, y1, value = word[:5]
        labels.append((value, (x0 + x1) / 2, (y0 + y1) / 2))
    return shapes, labels, doc, page


def raster(path, options, pdf_page=None):
    from PIL import Image, ImageOps
    if pdf_page:
        pix = pdf_page.get_pixmap(matrix=__import__("fitz").Matrix(min(3, 5700 / pdf_page.rect.width), min(3, 5700 / pdf_page.rect.width)), alpha=False)
        image = Image.open(io.BytesIO(pix.tobytes("png")))
    else:
        image = ImageOps.exif_transpose(Image.open(path))
    if image.width * image.height > 50_000_000:
        raise ValueError("Image exceeds 50 megapixels. Export a smaller display image.")
    image = image.convert("RGB")
    image.thumbnail((5700, 5700))
    categories = options.get("categories") or []
    if not categories:
        raise ValueError("This source is a raster. Add the plan's category colors first, then extract again.")
    tiers = {c["key"]: {"label": c["label"], "price": max(1, (c.get("price_cents") or 0) / 100), "fill": c["color"], "tolerance": 50} for c in categories}
    with tempfile.TemporaryDirectory(prefix="wamule-raster-") as tmp:
        tmp = Path(tmp)
        image.save(tmp / "source.png")
        (tmp / "tiers.json").write_text(json.dumps({"tiers": tiers}))
        result = subprocess.run([sys.executable, str(ROOT / "scripts/detect-lots.py"), "--source", str(tmp / "source.png"), "--tiers", str(tmp / "tiers.json"), "--out-dir", str(tmp / "out"), "--expected-min", "1", "--expected-max", "5000", "--max-blob-frac", "0.9", "--work-width", "2000"], capture_output=True, text=True, timeout=80)
        if result.returncode:
            raise ValueError("Raster extraction failed. Check category colors and boundary separation. " + (result.stderr or result.stdout)[-600:])
        lots = json.loads((tmp / "out/lots.json").read_text())
    buffer = io.BytesIO()
    image.save(buffer, "WEBP", quality=90)
    data = buffer.getvalue()
    if len(data) > 10 * 1024 * 1024:
        raise ValueError("Display image exceeds 10 MB. Reduce the source image size.")
    plots = []
    for i, lot in enumerate(lots):
        plots.append({"key": f"raster/{i + 1}", "number": None, "kind": "plot", "polygon": lot["polygon_pct"], "source_polygon": None,
                      "source_layer": "Raster detections", "category_key": lot["tier_key"], "area_value": None, "area_unit": None,
                      "area_basis": "unknown", "dimensions": None, "price_cents": None, "currency": None, "price_basis": None,
                      "reviewed": False, "issues": ["Raster boundary: compare with the original plan.", "No plot number has been assigned."]})
    return {"width": image.width, "height": image.height, "background": {"mime": "image/webp", "sha256": hashlib.sha256(data).hexdigest(), "data_base64": base64.b64encode(data).decode()}}, plots


def extract(path, name, options):
    extension = Path(name).suffix.lower()
    if extension == ".dwg":
        raise ValueError("DWG is not read directly. Export DXF from the CAD application and keep the DWG as the original source.")
    source_format = "dxf" if extension == ".dxf" else "pdf" if extension == ".pdf" else "image"
    notes, layers, units, shapes, labels, unsupported = [], {}, "unknown", [], [], {}
    canvas, plots = None, None
    if source_format == "dxf":
        shapes, labels, units, layers, unsupported = read_dxf(path, options)
    elif source_format == "pdf":
        shapes, labels, document, page = vector_pdf(path, options)
        if not shapes:
            canvas, plots = raster(path, options, pdf_page=page)
            notes.append("The selected PDF page has no supported closed vector outlines; raster extraction was used.")
        else:
            notes.append("PDF coordinates describe the page, not surveyed land area. Import recorded areas separately.")
        document.close()
    elif extension in (".png", ".jpg", ".jpeg", ".webp"):
        canvas, plots = raster(path, options)
    else:
        raise ValueError("Choose DXF, PDF, PNG, JPEG, WebP or a saved Map Studio package.")
    if shapes:
        if len(shapes) > 5000:
            raise ValueError("More than 5,000 boundaries. Choose a narrower boundary layer.")
        xs = [p[0] for s in shapes for p in s["points"]]
        ys = [p[1] for s in shapes for p in s["points"]]
        left, right, top, bottom = min(xs), max(xs), min(ys), max(ys)
        w, h = right - left, bottom - top
        if w <= 0 or h <= 0:
            raise ValueError("Drawing has no two-dimensional plot extent.")
        # Equal physical padding; keep aspect and source coordinates intact.
        pad = max(w, h) * 0.025
        left -= pad; top -= pad; w += 2 * pad; h += 2 * pad
        canvas = {"width": 2000, "height": 2000 * h / w, "background": None}
        plots, numbers = [], {}
        for s in shapes:
            found = sorted({m.group(1) for value, x, y in labels if (m := LABEL.fullmatch(value.strip())) and contains(s["points"], x, y)})
            issues = []
            if len(found) != 1:
                issues.append("No unique plot number inside the boundary." if not found else "Multiple plot numbers inside this boundary: " + ", ".join(found))
            if s["curved"]:
                issues.append("Curved CAD edges were flattened at 0.01 drawing-unit tolerance; source coordinates are retained.")
            value = found[0] if len(found) == 1 else None
            if value:
                numbers.setdefault(value, []).append(len(plots))
            shape_area = area(s["points"])
            measured_area = shape_area if source_format == "dxf" and units in ("m", "ft") else shape_area * (1200 / 3937) ** 2 if units == "us-ft" else None
            area_unit = "ft2" if units == "ft" else "m2" if measured_area is not None else None
            polygon = [{"x": round((x - left) / w * 100, 8), "y": round(((top + h - y) if source_format == "dxf" else (y - top)) / h * 100, 8)} for x, y in s["points"]]
            plots.append({"key": s["key"], "number": value, "kind": "plot", "polygon": polygon,
                          "source_polygon": [{"x": x, "y": y} for x, y in s["points"]], "source_layer": s["layer"],
                          "area_value": round(measured_area, 6) if measured_area is not None else None, "area_unit": area_unit,
                          "area_basis": "cad-calculated" if measured_area is not None else "unknown", "dimensions": None,
                          "category_key": None, "price_cents": None, "currency": None, "price_basis": None, "reviewed": False, "issues": issues})
        for value, indices in numbers.items():
            if len(indices) > 1:
                for index in indices:
                    plots[index]["number"] = None
                    plots[index]["issues"].append("Plot number appears in more than one boundary: " + value)
    if not plots:
        raise ValueError("No supported closed boundaries found. Choose the plot layer or request a DXF with closed plot polylines.")
    if unsupported:
        notes.append("Excluded entities: " + ", ".join(f"{key}: {value}" for key, value in unsupported.items()))
    if source_format == "dxf" and units == "unknown":
        notes.append("Drawing units are unspecified. Areas remain blank until units or recorded areas are provided.")
    package = {"format": "wamule-map-package", "version": 1, "dataset_id": str(uuid.uuid4()), "revision": 1,
               "title": Path(name).stem, "source": {"name": Path(name).name, "format": source_format,
               "sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest(), "units": units},
               "canvas": canvas, "categories": options.get("categories") or [], "plots": plots}
    return {"package": package, "layers": layers, "notes": notes}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--options", default="{}")
    args = parser.parse_args()
    try:
        print(json.dumps(extract(args.source, args.name, json.loads(args.options)), allow_nan=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(2)
