import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);

test("ocr-match --help exits 0", () => {
  execFileSync("python3", ["scripts/ocr-match.py", "--help"], { encoding: "utf8" });
});

test("matcher gates: match, multi-token, cross-lot-both, confidence floor", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-unit-"));
  cpSync(new URL("e2e/fixtures/ocr-unit/", root), dir, { recursive: true });
  execFileSync("python3", ["scripts/ocr-match.py", "--dir", dir, "--stage", "match"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lots = Object.fromEntries(
    JSON.parse(readFileSync(join(dir, "lots.json"), "utf8")).map((lot) => [lot.lot_number, lot]),
  );
  // Clean match + area attach.
  assert.equal(lots.A.match_status, "matched");
  assert.equal(lots.A.printed_lot_number, "07");
  assert.equal(lots.A.printed_area_sqm, 100.0);
  assert.equal(lots.A.needs_review, false);
  assert.equal(lots.A.area_status, "not-run");
  // Two distinct numbers in one polygon -> duplicate.
  assert.equal(lots.B.match_status, "duplicate");
  assert.equal(lots.B.needs_review, true);
  // Same value in two lots -> BOTH flagged, never first-claim.
  assert.equal(lots.C.match_status, "duplicate");
  assert.equal(lots.D.match_status, "duplicate");
  assert.equal(lots.C.printed_lot_number, null);
  // Below the confidence floor -> unmatched, not matched.
  assert.equal(lots.E.match_status, "unmatched");
  assert.equal(lots.E.needs_review, true);
});

test("ocr-match refuses without lots.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-empty-"));
  assert.throws(() => execFileSync("python3", ["scripts/ocr-match.py", "--dir", dir, "--stage", "match"], { stdio: "pipe" }));
});
