import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("interactive-map builder records interior and edge alignment from a small fixture", () => {
  const temp = mkdtempSync(join(tmpdir(), "map-alignment-build-"));
  const fixture = resolve("e2e/fixtures/ocr-synthetic");
  const outputDir = join(temp, "build");
  const lotsPath = join(outputDir, "lots.json");
  const tiersPath = join(temp, "tiers.json");
  const backgroundPath = join(temp, "masterplan_background.webp");
  try {
    mkdirSync(outputDir);
    const lots = JSON.parse(readFileSync(join(fixture, "lots.json"), "utf8"));
    // The checked-in fixture is post-OCR; this direct skip-detect build only
    // needs detector-stage geometry for its alignment diagnostic.
    for (const lot of lots) {
      for (const field of ["printed_lot_number", "printed_area_sqm", "match_status", "area_status", "area_ratio"]) {
        delete lot[field];
      }
    }
    writeFileSync(lotsPath, `${JSON.stringify(lots)}\n`);
    const tiers = JSON.parse(readFileSync(join(fixture, "tiers.json"), "utf8"));
    for (const tier of Object.values(tiers.tiers)) {
      tier.fill = tier.legend;
      tier.tolerance = 255;
    }
    writeFileSync(tiersPath, `${JSON.stringify(tiers)}\n`);
    writeFileSync(backgroundPath, readFileSync(join(fixture, "masterplan_background.webp")));

    const result = spawnSync(process.execPath, [
      "scripts/build-interactive-map.mjs",
      "--tenant", "synthetic",
      "--source", backgroundPath,
      "--tiers", tiersPath,
      "--out", outputDir,
      "--skip-detect",
      "--expected-min", "1",
      "--expected-max", "200",
      "--alignment-min", "0",
      "--alignment-edge-ratio", "0",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(readFileSync(join(outputDir, "ingest-report.json"), "utf8"));
    assert.equal(report.alignment.checked, true);
    assert.ok(report.alignment.lots_checked > 0);
    assert.ok(Number.isFinite(report.alignment.rate));
    assert.ok(Number.isFinite(report.alignment.edge_ratio));
    assert.equal(report.alignment.edge_probes.length, 4);
    assert.ok(report.alignment.edge_best_probe_offset_pct);
    assert.deepEqual(Object.keys(report.alignment.edge_regions).sort(), [
      "bottom_left", "bottom_right", "top_left", "top_right",
    ]);
    assert.ok(Number.isFinite(report.alignment.edge_regions.top_left.edge_ratio));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("alignment diagnostics report probe direction without proposing a geometry change", () => {
  const script = `
import importlib.util
import json
import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location("alignment", "scripts/check-lot-alignment.py")
alignment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alignment)
pixels = np.full((1000, 1000, 3), 30, dtype=np.uint8)
pixels[200:600, 203:603] = 220
lots = [{"tier_key": "standard", "polygon_pct": [
    {"x": 20, "y": 20}, {"x": 60, "y": 20},
    {"x": 60, "y": 60}, {"x": 20, "y": 60}
]}]
tiers = {"standard": {"fill": "#dcdcdc", "tolerance": 20}}
print(json.dumps(alignment.check_alignment(lots, tiers, Image.fromarray(pixels), edge_width=1000)))
`;
  const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.edge_best_probe_offset_pct, { dx_pct: 0.35, dy_pct: 0 });
  assert.ok(report.edge_ratio < 1, "the unshifted line should be weaker than the deliberately shifted boundary");
  assert.equal(report.edge_regions.top_left.candidate_lots, 1);
  assert.equal(report.edge_regions.top_left.sampled_lots, 1);
  assert.equal(report.edge_regions.top_right.candidate_lots, 0);
});
