import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);

test("ocr-match --help exits 0", () => {
  const output = execFileSync("python3", ["scripts/ocr-match.py", "--help"], { encoding: "utf8" });
  assert.match(output, /--area-policy/);
  assert.doesNotMatch(output, /--area-tolerance/);
});

test("Python area-policy parser keeps pending unavailable and accepts only complete approvals", () => {
  const dir = mkdtempSync(join(tmpdir(), "area-policy-"));
  const policyPath = join(dir, "policy.json");
  const loader = `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("ocr_match", "scripts/ocr-match.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
policy, provenance = module.load_area_validation_policy(Path(sys.argv[1]))
print(json.dumps({"policy": policy, "provenance": provenance}))
`;
  const pending = {
    schema_version: 1, status: "pending", policy_id: null, policy_version: null,
    tolerance_fraction: null, approved_by: null, approved_at: null, basis: null, evidence_reference: null,
  };
  writeFileSync(policyPath, JSON.stringify(pending));
  const pendingResult = JSON.parse(execFileSync("python3", ["-c", loader, policyPath], {
    cwd: root.pathname,
    encoding: "utf8",
  }));
  assert.equal(pendingResult.policy, null);
  assert.equal(pendingResult.provenance.name, "policy.json");
  assert.match(pendingResult.provenance.sha256, /^[a-f0-9]{64}$/);

  const approved = {
    schema_version: 1, status: "approved", policy_id: "fixture-policy", policy_version: 1,
    tolerance_fraction: 0.37, approved_by: "fixture reviewer", approved_at: "2026-10-11T12:00:00Z",
    basis: "Synthetic contract test", evidence_reference: "fixture only",
  };
  writeFileSync(policyPath, JSON.stringify(approved));
  const approvedResult = JSON.parse(execFileSync("python3", ["-c", loader, policyPath], {
    cwd: root.pathname,
    encoding: "utf8",
  }));
  assert.deepEqual(approvedResult.policy, approved);

  writeFileSync(policyPath, JSON.stringify({ ...approved, tolerance_fraction: 1 }));
  assert.throws(
    () => execFileSync("python3", ["-c", loader, policyPath], { cwd: root.pathname, stdio: "pipe" }),
    (error) => error.status === 2 && String(error.stderr).includes("tolerance_fraction"),
  );
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

test("benchmark positional score rejects a token outside the actual polygon but inside its bbox", () => {
  const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("ocr_match", "scripts/ocr-match.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
labels = {"tokens": [{"lot": "A", "kind": "number", "text": "07", "bbox": [0, 0, 10, 10],
                     "polygon": [[0, 0], [10, 0], [0, 10]]}]}
outside = module.evaluate_engine(
    {"tokens": [{"kind": "number", "text": "7", "box": [7, 7, 9, 9]}]},
    labels,
    {"A": "standard"},
)
near_miss = module.evaluate_engine(
    {"tokens": [{"kind": "number", "text": "08", "box": [1, 1, 3, 3]}]},
    {"tokens": [{"lot": "A", "kind": "number", "text": "07", "bbox": [0, 0, 10, 10],
                 "polygon": [[0, 0], [10, 0], [0, 10]]}]},
    {"A": "standard"},
)
print(json.dumps({"outside": outside, "near_miss": near_miss}))
`;
  const result = JSON.parse(execFileSync("python3", ["-c", script], {
    cwd: root.pathname,
    encoding: "utf8",
  }));
  assert.equal(result.outside.token_accuracy, 0);
  assert.equal(result.outside.char_accuracy, 0);
  assert.equal(result.near_miss.token_accuracy, 0);
  assert.equal(result.near_miss.char_accuracy, 0.5);
});

test("blind-label scoring requires fresh image and geometry fingerprints", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-label-score-"));
  cpSync(new URL("e2e/fixtures/ocr-unit/", root), dir, { recursive: true });

  const buildArtifact = `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("ocr_match", "scripts/ocr-match.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
build = Path(sys.argv[1])
lots = json.loads((build / "lots.json").read_text())
ocr = json.loads((build / "ocr.json").read_text())
image = build / "masterplan_background.webp"
from PIL import Image
width, height = Image.open(image).size
provenance = {
    "image": {"name": image.name, "width": width, "height": height,
              **module.fingerprint_file(image)},
    "lot_geometry_sha256": module.fingerprint_lot_geometry(lots),
    "environment": {"tesseract": "fixture"},
}
module.write_ocr_artifact(build, ocr["engines"], provenance)
`;
  execFileSync("python3", ["-c", buildArtifact, dir], {
    cwd: root.pathname,
    encoding: "utf8",
  });

  writeFileSync(join(dir, "mapping.json"), JSON.stringify({ S001: { lot_number: "A" } }));
  const labelsCsv = "id,printed_number,printed_area_sqm,ambiguous\nS001,07,100.000,\n";
  writeFileSync(join(dir, "labels.csv"), labelsCsv);
  const output = join(dir, "scores.json");
  execFileSync("python3", [
    "scripts/score-labels.py",
    "--mapping", join(dir, "mapping.json"),
    "--lots", join(dir, "lots.json"),
    "--labels", join(dir, "labels.csv"),
    "--ocr", join(dir, "ocr.json"),
    "--out", output,
  ], { cwd: root.pathname, encoding: "utf8" });

  const scores = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(scores.schema_version, 2);
  assert.match(scores.method.character_accuracy, /Levenshtein/);
  const expectedImageHash = createHash("sha256")
    .update(readFileSync(join(dir, "masterplan_background.webp")))
    .digest("hex");
  assert.equal(scores.provenance.source_image.sha256, expectedImageHash);
  assert.equal(scores.provenance.engine_environment.tesseract, "fixture");
  assert.match(scores.provenance.score_labels_code.sha256, /^[a-f0-9]{64}$/);
  assert.match(scores.provenance.ocr_match_code.sha256, /^[a-f0-9]{64}$/);
  assert.ok(scores.engines.tesseract);
  assert.equal(scores.label_summary.expected_crops, 1);
  assert.equal(scores.label_summary.review_coverage_complete, true);
  assert.equal(scores.label_summary.unreadable_status_column_present, false);

  writeFileSync(join(dir, "mapping.json"), JSON.stringify({
    S001: { lot_number: "A" },
    S002: { lot_number: "B" },
  }));
  writeFileSync(join(dir, "labels.csv"),
    "id,printed_number,printed_area_sqm,ambiguous,unreadable\nS001,07,100.000,,\nS002,,,,1\n");
  execFileSync("python3", [
    "scripts/score-labels.py",
    "--mapping", join(dir, "mapping.json"),
    "--lots", join(dir, "lots.json"),
    "--labels", join(dir, "labels.csv"),
    "--ocr", join(dir, "ocr.json"),
    "--out", join(dir, "status-scores.json"),
  ], { cwd: root.pathname, encoding: "utf8" });
  const statusScores = JSON.parse(readFileSync(join(dir, "status-scores.json"), "utf8"));
  assert.equal(statusScores.label_summary.unreadable_excluded, 1);
  assert.equal(statusScores.label_summary.unreadable_status_column_present, true);
  assert.equal(statusScores.label_summary.review_coverage_complete, true);

  writeFileSync(join(dir, "mapping.json"), JSON.stringify({
    S001: { lot_number: "A" },
    S002: { lot_number: "B" },
    S003: { lot_number: "C" },
  }));
  writeFileSync(join(dir, "labels.csv"),
    "id,printed_number,printed_area_sqm,ambiguous,unreadable,skipped\n" +
    "S001,07,100.000,,,\nS002,,,,1,\nS003,,,,,1\n");
  execFileSync("python3", [
    "scripts/score-labels.py",
    "--mapping", join(dir, "mapping.json"),
    "--lots", join(dir, "lots.json"),
    "--labels", join(dir, "labels.csv"),
    "--ocr", join(dir, "ocr.json"),
    "--out", join(dir, "skip-scores.json"),
  ], { cwd: root.pathname, encoding: "utf8" });
  const skipScores = JSON.parse(readFileSync(join(dir, "skip-scores.json"), "utf8"));
  assert.equal(skipScores.label_summary.skipped_excluded, 1);
  assert.equal(skipScores.label_summary.skipped_status_column_present, true);
  assert.equal(skipScores.label_summary.review_coverage_complete, false);

  writeFileSync(join(dir, "labels.csv"),
    "id,printed_number,printed_area_sqm,ambiguous,unreadable,skipped\nS001,07,100.000,1,,1\n");
  assert.throws(
    () => execFileSync("python3", [
      "scripts/score-labels.py",
      "--mapping", join(dir, "mapping.json"),
      "--lots", join(dir, "lots.json"),
      "--labels", join(dir, "labels.csv"),
      "--ocr", join(dir, "ocr.json"),
      "--out", join(dir, "conflicting-status-scores.json"),
    ], { cwd: root.pathname, encoding: "utf8", stdio: "pipe" }),
    (error) => error.status === 2 && String(error.stderr).includes("mutually exclusive"),
  );

  writeFileSync(join(dir, "mapping.json"), JSON.stringify({ S001: { lot_number: "A" } }));
  writeFileSync(join(dir, "labels.csv"), labelsCsv);

  // Duplicate and unknown IDs must not silently overwrite or disappear.
  writeFileSync(join(dir, "labels.csv"), `${labelsCsv}S001,08,,\n`);
  assert.throws(
    () => execFileSync("python3", [
      "scripts/score-labels.py",
      "--mapping", join(dir, "mapping.json"),
      "--lots", join(dir, "lots.json"),
      "--labels", join(dir, "labels.csv"),
      "--ocr", join(dir, "ocr.json"),
      "--out", join(dir, "duplicate-scores.json"),
    ], { cwd: root.pathname, encoding: "utf8", stdio: "pipe" }),
    (error) => error.status === 2 && String(error.stderr).includes("duplicate crop id"),
  );
  writeFileSync(join(dir, "labels.csv"), "id,printed_number,printed_area_sqm,ambiguous\nS999,07,100.000,\n");
  assert.throws(
    () => execFileSync("python3", [
      "scripts/score-labels.py",
      "--mapping", join(dir, "mapping.json"),
      "--lots", join(dir, "lots.json"),
      "--labels", join(dir, "labels.csv"),
      "--ocr", join(dir, "ocr.json"),
      "--out", join(dir, "unknown-scores.json"),
    ], { cwd: root.pathname, encoding: "utf8", stdio: "pipe" }),
    (error) => error.status === 2 && String(error.stderr).includes("unknown crop id"),
  );
  writeFileSync(join(dir, "labels.csv"), labelsCsv);

  // Non-geometric QA fields do not invalidate spatial predictions.
  const lots = JSON.parse(readFileSync(join(dir, "lots.json"), "utf8"));
  lots[0].match_status = "matched";
  writeFileSync(join(dir, "lots.json"), JSON.stringify(lots));
  execFileSync("python3", [
    "scripts/score-labels.py",
    "--mapping", join(dir, "mapping.json"),
    "--lots", join(dir, "lots.json"),
    "--labels", join(dir, "labels.csv"),
    "--ocr", join(dir, "ocr.json"),
    "--out", join(dir, "scores-again.json"),
  ], { cwd: root.pathname, encoding: "utf8" });

  // A polygon edit must force predictions to be regenerated before scoring.
  lots[0].polygon_pct[0].x += 1;
  writeFileSync(join(dir, "lots.json"), JSON.stringify(lots));
  assert.throws(
    () => execFileSync("python3", [
      "scripts/score-labels.py",
      "--mapping", join(dir, "mapping.json"),
      "--lots", join(dir, "lots.json"),
      "--labels", join(dir, "labels.csv"),
      "--ocr", join(dir, "ocr.json"),
      "--out", join(dir, "stale-scores.json"),
    ], { cwd: root.pathname, encoding: "utf8", stdio: "pipe" }),
    (error) => error.status === 2 && String(error.stderr).includes("lot-geometry fingerprint"),
  );
});
