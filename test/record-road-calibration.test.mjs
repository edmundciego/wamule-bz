import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);
const tempDirs = new Set();

test.afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "road-calibration-"));
  tempDirs.add(dir);
  const sourceImagePath = new URL("e2e/fixtures/ocr-unit/masterplan_background.webp", root);
  cpSync(sourceImagePath, join(dir, "source.webp"));
  const imageSha256 = createHash("sha256").update(readFileSync(join(dir, "source.webp"))).digest("hex");
  const roads = [];
  for (const stated of [60, 40]) {
    const width = stated === 60 ? 44 : 44 * 40 / 60;
    for (const [axis, offset] of [["x", 30], ["y", 80]]) {
      for (let index = 0; index < 3; index += 1) {
        const x = 40 + index * 100;
        const y = 40 + index * 100;
        roads.push({
          stated,
          p1: axis === "x" ? { x, y: y + offset / 2 } : { x: x + offset / 2, y },
          p2: axis === "x" ? { x: x + width, y: y + offset / 2 } : { x: x + offset / 2, y: y + width },
          width,
        });
      }
    }
  }
  const measurementsPath = join(dir, "road-measurements.json");
  writeFileSync(measurementsPath, JSON.stringify({ roads, scale: 1, imageSize: [400, 400], imageSha256 }));
  return { dir, measurementsPath, roads, imageSha256 };
}

function runCalibration({ dir, measurementsPath }, extra = []) {
  return execFileSync("python3", [
    "scripts/record-road-calibration.py",
    "--measurements", measurementsPath,
    "--image", join(dir, "source.webp"),
    "--reference-source", "Approved survey rev C, sheet 2, road dimensions",
    "--reviewer", "Map reviewer",
    "--endpoint-uncertainty-px", "0.5",
    "--reference-width-uncertainty-ft", "1",
    "--recorded-at", "2026-10-11T12:00:00-06:00",
    ...extra,
  ], { cwd: root.pathname, encoding: "utf8" });
}

test("road calibration records provenance and keeps scale pending owner review", () => {
  const data = fixture();
  runCalibration(data);
  const record = JSON.parse(readFileSync(join(data.dir, "road-calibration.json"), "utf8"));
  assert.equal(record.schema_version, 1);
  assert.equal(record.status, "ready_for_owner_review");
  assert.equal(record.recorded_at_utc, "2026-10-11T18:00:00Z");
  assert.equal(record.measurement_count, 12);
  assert.equal(record.source_image.width, 400);
  assert.equal(record.measurement_tool.exported_canvas_scale, 1);
  assert.equal(record.uncertainty.limitation.includes("does not include observed sample spread"), true);
  assert.match(record.source_image.sha256, /^[a-f0-9]{64}$/);
  assert.match(record.raw_measurements.sha256, /^[a-f0-9]{64}$/);
  assert.equal(record.summary.checks.minimum_three_clicks_per_width_and_orientation, true);
  assert.equal(record.summary.checks["40ft_held_out_scale_check_within_ten_percent"], true);
  assert.equal(record.summary.scale_status, "pending_owner_review");
  assert.equal(record.summary.candidate_ft_per_px, 1.363636);
});

test("failed calibration checks stay unavailable and existing evidence is not overwritten", () => {
  const data = fixture();
  for (const road of data.roads.slice(0, 3)) {
    road.width *= 2;
    road.p2.x = road.p1.x + road.width;
  }
  writeFileSync(data.measurementsPath, JSON.stringify({ roads: data.roads, scale: 1, imageSize: [400, 400], imageSha256: data.imageSha256 }));
  runCalibration(data);
  const output = join(data.dir, "road-calibration.json");
  const record = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(record.status, "needs_review");
  assert.equal(record.summary.scale_status, "unavailable");
  const before = readFileSync(output, "utf8");
  assert.throws(() => runCalibration(data), (error) =>
    error.status === 2 && String(error.stderr).includes("refusing to overwrite existing evidence"));
  assert.equal(readFileSync(output, "utf8"), before);
});

test("road calibration rejects endpoints inconsistent with the exported width", () => {
  const data = fixture();
  data.roads[0].width += 5;
  writeFileSync(data.measurementsPath, JSON.stringify({ roads: data.roads, scale: 1, imageSize: [400, 400], imageSha256: data.imageSha256 }));
  assert.throws(() => runCalibration(data), (error) =>
    error.status === 2 && String(error.stderr).includes("width does not match its endpoints"));
  assert.equal(existsSync(join(data.dir, "road-calibration.json")), false);
});

test("road calibration refuses duplicate endpoint pairs and source-image hash mismatches", () => {
  const data = fixture();
  const original = data.roads[0];
  data.roads[1] = { ...original, p1: { ...original.p2 }, p2: { ...original.p1 } };
  writeFileSync(data.measurementsPath, JSON.stringify({ roads: data.roads, scale: 1, imageSize: [400, 400], imageSha256: data.imageSha256 }));
  assert.throws(() => runCalibration(data), (error) =>
    error.status === 2 && String(error.stderr).includes("duplicates road #1"));
  assert.equal(existsSync(join(data.dir, "road-calibration.json")), false);

  data.roads[1] = data.roads[2];
  writeFileSync(data.measurementsPath, JSON.stringify({ roads: data.roads, scale: 1, imageSize: [400, 400], imageSha256: "0".repeat(64) }));
  assert.throws(() => runCalibration(data), (error) =>
    error.status === 2 && String(error.stderr).includes("SHA-256 does not match"));
  assert.equal(existsSync(join(data.dir, "road-calibration.json")), false);
});
