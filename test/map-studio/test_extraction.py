import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("studio_extract", ROOT / "scripts/map-studio/extract.py")
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)


def create_dxf(path, units=6):
    import ezdxf
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = units
    doc.layers.new("PLOTS")
    doc.layers.new("NUMBERS")
    model = doc.modelspace()
    for index in range(3):
        x = index * 15
        model.add_lwpolyline([(x, 0), (x + 10, 0), (x + 10, 15), (x, 15)], close=True, dxfattribs={"layer": "PLOTS"})
        model.add_text(str(index + 101), dxfattribs={"layer": "NUMBERS", "insert": (x + 5, 7), "height": 1})
    model.add_line((0, 30), (50, 30), dxfattribs={"layer": "ROAD"})
    doc.saveas(path)


class ExtractionTests(unittest.TestCase):
    def test_cad_reads_shapes_numbers_and_units_without_ocr(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "plots.dxf"
            create_dxf(path)
            result = extractor.extract(path, path.name, {"boundary_layer": "PLOTS"})
            package = result["package"]
            self.assertEqual(len(package["plots"]), 3)
            self.assertEqual([p["number"] for p in package["plots"]], ["101", "102", "103"])
            self.assertEqual([p["area_value"] for p in package["plots"]], [150, 150, 150])
            self.assertTrue(all(p["area_unit"] == "m2" and not p["reviewed"] for p in package["plots"]))
            self.assertIsNone(package["canvas"]["background"])
            self.assertIsNone(package["plots"][0]["price_cents"])
            self.assertEqual(package["plots"][0]["source_polygon"][0], {"x": 0.0, "y": 0.0})
            self.assertGreater(package["plots"][0]["polygon"][0]["y"], package["plots"][0]["polygon"][2]["y"])

    def test_unset_units_leave_area_blank(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "plots.dxf"
            create_dxf(path, 0)
            package = extractor.extract(path, path.name, {})["package"]
            self.assertTrue(all(p["area_value"] is None for p in package["plots"]))
            fixed = extractor.extract(path, path.name, {"units": "ft"})["package"]
            self.assertEqual(fixed["plots"][0]["area_unit"], "ft2")
            self.assertEqual(fixed["plots"][0]["area_value"], 150)

    def test_duplicate_and_multiple_numbers_are_not_assigned(self):
        import ezdxf
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "plots.dxf"
            create_dxf(path)
            doc = ezdxf.readfile(path)
            doc.modelspace().add_text("104", dxfattribs={"insert": (6, 6)})
            texts = list(doc.modelspace().query("TEXT"))
            texts[2].dxf.text = "102"
            doc.saveas(path)
            package = extractor.extract(path, path.name, {})["package"]
            self.assertTrue(all(p["number"] is None for p in package["plots"]))
            self.assertTrue(all(p["issues"] for p in package["plots"]))

    def test_vector_pdf_reads_text_without_inventing_ground_area(self):
        import fitz
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "plots.pdf"
            doc = fitz.open()
            page = doc.new_page(width=300, height=200)
            page.draw_rect(fitz.Rect(20, 20, 100, 120))
            page.insert_text((45, 70), "25")
            page.draw_rect(fitz.Rect(120, 20, 200, 120))
            page.insert_text((145, 70), "26")
            doc.save(path)
            result = extractor.extract(path, path.name, {})
            self.assertEqual([p["number"] for p in result["package"]["plots"]], ["25", "26"])
            self.assertTrue(all(p["area_value"] is None for p in result["package"]["plots"]))

    def test_raster_reuses_detector_and_keeps_numbers_unassigned(self):
        from PIL import Image, ImageDraw
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "plots.png"
            image = Image.new("RGB", (400, 300), "white")
            drawing = ImageDraw.Draw(image)
            drawing.rectangle((40, 50, 120, 200), fill="#e8c34b")
            drawing.rectangle((160, 50, 240, 200), fill="#e8c34b")
            drawing.rectangle((280, 50, 360, 200), fill="#e8c34b")
            image.save(path)
            result = extractor.extract(path, path.name, {"categories": [{"key": "standard", "label": "Standard", "color": "#e8c34b", "price_cents": None, "currency": None, "price_basis": None}]})
            self.assertGreaterEqual(len(result["package"]["plots"]), 3)
            self.assertTrue(all(p["number"] is None for p in result["package"]["plots"]))
            self.assertEqual(result["package"]["canvas"]["background"]["mime"], "image/webp")

    def test_dwg_has_actionable_export_instruction(self):
        with self.assertRaisesRegex(ValueError, "Export DXF"):
            extractor.extract("does-not-need-to-exist", "drawing.dwg", {})


if __name__ == "__main__":
    unittest.main()
