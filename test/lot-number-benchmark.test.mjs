import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repo = decodeURIComponent(new URL("..", import.meta.url).pathname);

test("target-outlined benchmark is stratified, source-bound, and prediction-blind", (t) => {
  const root = mkdtempSync(join(tmpdir(), "lot-number-benchmark-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const imagePath = join(root, "reference.png");
  const lotsPath = join(root, "lots.json");
  const pagePath = join(root, "page-ocr.json");
  const cropPath = join(root, "crop-ocr.json");
  const areaPath = join(root, "area-ocr.json");
  const output = join(root, "review-pack");
  const mappingPath = `${output}-mapping.json`;
  const evidencePath = `${output}-selection-evidence.json`;
  const width = 1200;
  const height = 1200;
  const lots = [];
  const cropRows = [];
  const assembled = {};

  for (let index = 0; index < 60; index += 1) {
    const row = Math.floor(index / 10);
    const column = index % 10;
    const x = 20 + column * 116;
    const y = 20 + row * 185;
    const narrow = index >= 50 && index < 55;
    const lotId = `L-${String(index + 1).padStart(3, "0")}`;
    const number = index < 20 ? String(1000 + index) : index < 40 ? String(2000 + index) : "";
    const cropNumber = index < 20 ? number : index < 40 ? String(3000 + index) :
      index >= 50 && index < 55 ? String(6000 + index) : index >= 55 ? String(4000 + index) : "";
    const areaNumber = index >= 55 ? String(5000 + index) : "";
    const matchStatus = index < 40 ? "matched" : index < 45 ? "duplicate" : "unmatched";
    const points = [
      { x, y },
      { x: x + (narrow ? 18 : 82), y: y + (narrow ? 130 : 76) },
      { x: x + (narrow ? 12 : 70), y: y + 122 },
      { x: x - (narrow ? 3 : 2), y: y + 115 },
    ].map((point) => ({ x: point.x / width * 100, y: point.y / height * 100 }));
    lots.push({
      lot_number: lotId,
      tier_key: "standard",
      match_status: matchStatus,
      printed_lot_number: number || null,
      polygon_pct: points,
    });
    cropRows.push({ lot_number: lotId, number: cropNumber || null, private_guess: "OCR_SECRET_Z9QX" });
    assembled[lotId] = { number: areaNumber || null, private_guess: "OCR_SECRET_Z9QX" };
  }

  writeFileSync(lotsPath, JSON.stringify(lots));
  writeFileSync(pagePath, JSON.stringify({
    image: { width, height },
    engines: { tesseract: { tokens: [{ text: "OCR_SECRET_Z9QX" }] },
      private_candidate: "OCR_SECRET_Z9QX" },
  }));
  writeFileSync(cropPath, JSON.stringify({ image: "reference.png", lots: cropRows }));
  writeFileSync(areaPath, JSON.stringify({ image: "reference.png", assembled_units: assembled }));
  execFileSync("python3", ["-c", `from PIL import Image\nImage.new("RGB", (${width}, ${height}), "white").save(${JSON.stringify(imagePath)})`], {
    cwd: repo,
  });

  execFileSync("python3", [
    "scripts/blind-sheet.py",
    "--benchmark", "--n", "60", "--seed", "7",
    "--lots", lotsPath,
    "--image", imagePath,
    "--page-ocr", pagePath,
    "--crop-ocr", cropPath,
    "--area-ocr", areaPath,
    "--out", output,
  ], { cwd: repo, encoding: "utf8" });

  const manifest = JSON.parse(readFileSync(join(output, "benchmark-manifest.json"), "utf8"));
  const selection = JSON.parse(readFileSync(evidencePath, "utf8"));
  const mapping = JSON.parse(readFileSync(mappingPath, "utf8"));
  assert.equal(manifest.cases.length, 60);
  assert.equal(selection.strata_counts.ocr_methods_agree, 20);
  assert.equal(selection.strata_counts.ocr_methods_disagree, 20);
  assert.equal(selection.strata_counts.difficult_cases, 20);
  for (const stratum of [
    "duplicate_or_conflicting_page_tokens",
    "no_number_from_any_path",
    "narrow_or_irregular_geometry",
    "crop_vs_area_conflict",
  ]) assert.equal(selection.strata_counts[stratum], 5);
  assert.equal(manifest.source_image.sha256, createHash("sha256").update(readFileSync(imagePath)).digest("hex"));
  assert.equal(Object.keys(mapping).length, 60);

  const first = manifest.cases[0];
  const [left, top] = first.crop_box_px;
  const target = lots.find((lot) => lot.lot_number === first.detection_id);
  const [targetPoint] = target.polygon_pct;
  const targetX = Math.round(targetPoint.x / 100 * width - left);
  const targetY = Math.round(targetPoint.y / 100 * height - top);
  const cropPathOnDisk = join(output, first.crop_file);
  const cropBytes = readFileSync(cropPathOnDisk);
  assert.equal(first.crop_sha256, createHash("sha256").update(cropBytes).digest("hex"));
  const pixels = JSON.parse(execFileSync("python3", ["-c", `from PIL import Image\nimport json,sys\nim=Image.open(sys.argv[1]).convert("RGB")\nx,y=map(int,sys.argv[2:4])\npixels=[im.getpixel((px,py)) for px in range(max(0,x-3),min(im.width,x+4)) for py in range(max(0,y-3),min(im.height,y+4))]\nprint(json.dumps(pixels))`, cropPathOnDisk, String(targetX), String(targetY)], { encoding: "utf8" }));
  assert.ok(pixels.some((pixel) => pixel[0] === 208 && pixel[1] === 0 && pixel[2] === 112),
    "magenta target outline should land on the native-coordinate polygon vertex");

  const servedText = [
    readFileSync(join(output, "label.html"), "utf8"),
    readFileSync(join(output, "benchmark-manifest.json"), "utf8"),
  ].join("\n");
  assert.equal(readdirSync(join(output, "sheet-crops")).length, 60);
  assert.doesNotMatch(servedText, /OCR_SECRET_Z9QX/, "OCR candidate sentinel must not appear in served text files");
  assert.doesNotMatch(servedText, /selection_stratum|private_guess|engines/);
});
