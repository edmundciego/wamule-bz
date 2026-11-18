import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";

const repo = decodeURIComponent(new URL("..", import.meta.url).pathname);

test("blind crop generation is deterministic and keeps identity mapping outside the served sheet", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "blind-sheet-test-"));
  const inputLots = join(repo, "e2e/fixtures/ocr-unit/lots.json");
  const inputImage = join(repo, "e2e/fixtures/ocr-unit/masterplan_background.webp");
  const outputs = [join(tempRoot, "sheet-a"), join(tempRoot, "sheet-b")];
  const mappings = outputs.map((output) => `${output}-mapping.json`);
  const generate = (output) => execFileSync("python3", [
    "scripts/blind-sheet.py",
    "--lots", inputLots,
    "--image", inputImage,
    "--out", output,
    "--n", "4",
    "--seed", "7",
  ], { cwd: repo, encoding: "utf8" });

  try {
    generate(outputs[0]);
    generate(outputs[1]);
    const mappingA = JSON.parse(readFileSync(mappings[0], "utf8"));
    const mappingB = JSON.parse(readFileSync(mappings[1], "utf8"));
    assert.deepEqual(mappingA, mappingB);
    assert.equal(Object.keys(mappingA).length, 4);
    assert.ok(relative(outputs[0], mappings[0]).startsWith(".."));

    const expectedCrops = ["S001.png", "S002.png", "S003.png", "S004.png"];
    assert.deepEqual(readdirSync(join(outputs[0], "sheet-crops")).sort(), expectedCrops);
    assert.deepEqual(readdirSync(join(outputs[1], "sheet-crops")).sort(), expectedCrops);
    for (const name of expectedCrops) {
      const cropA = readFileSync(join(outputs[0], "sheet-crops", name));
      const cropB = readFileSync(join(outputs[1], "sheet-crops", name));
      assert.ok(cropA.length > 0);
      assert.ok(cropA.equals(cropB), `${name} should be reproducible for a fixed seed`);
    }
    const csv = readFileSync(join(outputs[0], "labels_template.csv"), "utf8").trim().split(/\r?\n/);
    assert.equal(csv.length, 5);
    assert.equal(csv[0], "id,printed_number,printed_area_sqm,ambiguous,unreadable");
    assert.deepEqual(csv.slice(1), expectedCrops.map((_, index) => `S${String(index + 1).padStart(3, "0")},,,,`));
    const pageA = readFileSync(join(outputs[0], "label.html"), "utf8");
    const pageB = readFileSync(join(outputs[1], "label.html"), "utf8");
    assert.equal(pageA, pageB, "review page should be reproducible for the same sample");
    assert.match(pageA, /const CROP_COUNT = 4;/);
    assert.match(pageA, /printed_number', 'printed_area_sqm', 'ambiguous', 'unreadable'/);
    assert.match(pageA, /unreadable \? '1' : ''/);
    assert.doesNotMatch(pageA, /\{\{(?:CROP_COUNT|REVIEW_KEY)\}\}|mapping\.json|lots\.json|ocr\.json|Hopkins/i);
    const elements = new Map();
    for (const [, id] of pageA.matchAll(/id="([^"]+)"/g)) {
      const attributes = new Map();
      const handlers = new Map();
      elements.set(id, {
        attributes,
        handlers,
        value: "",
        textContent: "",
        disabled: false,
        style: {},
        classList: { add() {}, remove() {} },
        addEventListener(type, handler) { handlers.set(type, handler); },
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name) ?? null; },
      });
    }
    const pageScript = pageA.match(/<script>([\s\S]*?)<\/script>/)[1];
    const sandbox = {
      document: {
        getElementById: (id) => elements.get(id),
        addEventListener() {},
      },
      localStorage: { getItem: () => null, setItem() {} },
      setTimeout: () => 1,
      clearTimeout() {},
      URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
      Blob: class {},
    };
    runInNewContext(pageScript, sandbox);
    elements.get("unreadableBtn").handlers.get("click")();
    assert.equal(sandbox.buildCsv().split(/\r?\n/)[1], "S001,,,,1");
    elements.get("ambiguousBtn").handlers.get("click")();
    assert.equal(sandbox.buildCsv().split(/\r?\n/)[1], "S001,,,1,");
    assert.ok(!readFileSync(join(outputs[0], "README.md"), "utf8").includes("lot_number"));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("blind crop generator refuses a sample larger than the source before writing", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "blind-sheet-size-"));
  const output = join(tempRoot, "too-many");
  try {
    assert.throws(() => execFileSync("python3", [
      "scripts/blind-sheet.py",
      "--lots", join(repo, "e2e/fixtures/ocr-unit/lots.json"),
      "--image", join(repo, "e2e/fixtures/ocr-unit/masterplan_background.webp"),
      "--out", output,
      "--n", "6",
    ], { cwd: repo, stdio: "pipe" }), (error) =>
      error.status === 1 && String(error.stderr).includes("cannot exceed available lot count"));
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
