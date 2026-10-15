from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[4]
SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "plat_digitize.py"


class PlatDigitizerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="plat-digitizer-test-")
        self.directory = Path(self.temp.name)
        self.image_path = self.directory / "synthetic-plat.png"
        self.detections_path = self.directory / "lots.json"
        self.output_path = self.directory / "parent-proposal"
        self.make_fixture()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def make_fixture(self) -> None:
        image = np.full((300, 400, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (60, 50), (340, 250), (0, 0, 240), thickness=-1)
        cv2.line(image, (60, 50), (60, 250), (0, 0, 0), 3)
        cv2.line(image, (340, 50), (340, 250), (0, 0, 0), 3)
        cv2.line(image, (60, 50), (340, 50), (0, 0, 0), 3)
        cv2.line(image, (60, 250), (340, 250), (0, 0, 0), 3)
        for x in (153, 246):
            cv2.line(image, (x, 50), (x, 250), (0, 0, 0), 3)
        cv2.putText(image, "101", (86, 150), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)
        cv2.putText(image, "102", (180, 150), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)
        cv2.putText(image, "103", (274, 150), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)
        self.assertTrue(cv2.imwrite(str(self.image_path), image))
        self.detections_path.write_text(json.dumps([{
            "lot_number": "TEST-001",
            "polygon_pct": [
                {"x": 15, "y": 16.66666667},
                {"x": 85, "y": 16.66666667},
                {"x": 85, "y": 83.33333333},
                {"x": 15, "y": 83.33333333},
            ],
        }]), encoding="utf-8")

    def run_parent(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run([
            sys.executable, str(SCRIPT),
            "--image", str(self.image_path),
            "--detections", str(self.detections_path),
            "--parent-id", "TEST-001",
            "--output-dir", str(self.output_path),
            "--no-ocr",
        ], cwd=ROOT, capture_output=True, text=True, check=False)

    def test_proposes_separate_source_aligned_drafts_idempotently(self) -> None:
        original_image_sha = hashlib.sha256(self.image_path.read_bytes()).hexdigest()
        original_detection_sha = hashlib.sha256(self.detections_path.read_bytes()).hexdigest()
        first = self.run_parent()
        self.assertEqual(first.returncode, 0, first.stderr)
        proposal = json.loads((self.output_path / "proposal.json").read_text(encoding="utf-8"))
        self.assertEqual(proposal["detection_source"]["selected_parent_detection_id"], "TEST-001")
        self.assertEqual(len(proposal["children"]), 3)
        self.assertTrue(proposal["validation"]["all_child_shapes_valid"])
        self.assertEqual(proposal["validation"]["pairwise_child_overlaps"], [])
        self.assertTrue(all(child["review_status"] == "unreviewed" for child in proposal["children"]))
        self.assertTrue(all(child["parent_detection_id"] == "TEST-001" for child in proposal["children"]))
        self.assertTrue(all(len(child["polygon_pct"]) >= 4 for child in proposal["children"]))
        self.assertFalse(proposal["safety"]["original_detection_modified"])
        self.assertFalse(proposal["safety"]["canonical_parcel_data_modified"])
        self.assertTrue((self.output_path / "comparison.png").is_file())
        self.assertTrue((self.output_path / "overlay.png").is_file())
        report = (self.output_path / "report.md").read_text(encoding="utf-8")
        self.assertIn("No source PDF was opened or fingerprinted", report)
        self.assertNotIn("The source raster, source PDF", report)
        with Image.open(self.output_path / "comparison.png") as preview:
            self.assertGreater(preview.width, preview.height)
        first_manifest = (self.output_path / "manifest.json").read_bytes()
        second = self.run_parent()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual((self.output_path / "manifest.json").read_bytes(), first_manifest)
        self.assertEqual(hashlib.sha256(self.image_path.read_bytes()).hexdigest(), original_image_sha)
        self.assertEqual(hashlib.sha256(self.detections_path.read_bytes()).hexdigest(), original_detection_sha)

    def test_supports_explicit_source_pixel_region_without_parent_identity(self) -> None:
        result = subprocess.run([
            sys.executable, str(SCRIPT),
            "--image", str(self.image_path),
            "--region-px", "60,50,341,251",
            "--output-dir", str(self.directory / "region-proposal"),
            "--no-ocr",
        ], cwd=ROOT, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        proposal = json.loads((self.directory / "region-proposal" / "proposal.json").read_text(encoding="utf-8"))
        self.assertIsNone(proposal["detection_source"]["selected_parent_detection_id"])
        self.assertIsNone(proposal["children"][0]["parent_detection_id"])
        self.assertEqual(len(proposal["children"]), 3)
        self.assertEqual(proposal["review"]["status"], "unreviewed")


if __name__ == "__main__":
    unittest.main()
