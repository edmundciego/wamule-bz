import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repo = decodeURIComponent(new URL("..", import.meta.url).pathname);

test("road review page generation is source-bound and refuses to overwrite existing evidence", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "road-tool-test-"));
  const imagePath = join(tempRoot, "source.webp");
  const outputPath = join(tempRoot, "measure-roads.html");
  cpSync(join(repo, "e2e/fixtures/ocr-unit/masterplan_background.webp"), imagePath);
  const expectedHash = createHash("sha256").update(readFileSync(imagePath)).digest("hex");

  try {
    execFileSync("python3", [
      "scripts/build-road-measurement-tool.py",
      "--image", imagePath,
      "--out", outputPath,
    ], { cwd: repo, encoding: "utf8" });
    const html = readFileSync(outputPath, "utf8");
    assert.match(html, /const IMAGE_WIDTH = 400;/);
    assert.match(html, /const IMAGE_HEIGHT = 400;/);
    assert.match(html, new RegExp(`const EXPECTED_IMAGE_SHA256 = "${expectedHash}";`));
    assert.match(html, /event\.clientX - rect\.left - canvas\.clientLeft\) \/ displayWidth \* IMAGE_WIDTH/);
    assert.match(html, /event\.clientY - rect\.top - canvas\.clientTop\) \/ displayHeight \* IMAGE_HEIGHT/);
    assert.match(html, /Do not infer road widths from typical streets, lot-area medians, or OCR/);
    assert.match(html, /clicks can be recorded/);
    assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);

    const before = readFileSync(outputPath);
    assert.throws(() => execFileSync("python3", [
      "scripts/build-road-measurement-tool.py",
      "--image", imagePath,
      "--out", outputPath,
    ], { cwd: repo, stdio: "pipe" }), (error) =>
      error.status === 2 && String(error.stderr).includes("refusing to overwrite existing review artifact"));
    assert.deepEqual(readFileSync(outputPath), before);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
