import assert from "node:assert/strict";
import test from "node:test";
import {
  planOcrCommands,
  validateAreaValidationPolicy,
  validateScaleConfig,
} from "../scripts/tenant-build-ocr.mjs";

test("a scale-free tenant build runs OCR before matching and never validates area", () => {
  const commands = planOcrCommands("out/map", "tiers.json", ["tesseract", "rapidocr"], null);
  assert.deepEqual(commands, [
    {
      label: "ocr (S1)",
      args: ["scripts/ocr-match.py", "--dir", "out/map", "--tiers", "tiers.json",
        "--engines", "both", "--stage", "ocr"],
    },
    {
      label: "ocr-match (S2)",
      args: ["scripts/ocr-match.py", "--dir", "out/map", "--tiers", "tiers.json",
        "--engines", "both", "--stage", "match"],
    },
  ]);
});

test("scale plus an approved policy path enables area-policy evaluation", () => {
  const commands = planOcrCommands("out/map", "tiers.json", ["tesseract"], {
    road_band: [10, 90],
    road_width_ft: 40,
  }, "tenants/demo/evidence/area-validation-policy.json");
  assert.deepEqual(commands, [{
    label: "ocr-match (S1-S3)",
    args: ["scripts/ocr-match.py", "--dir", "out/map", "--tiers", "tiers.json",
      "--engines", "tesseract", "--road-band", "10,90", "--road-width-ft", "40",
      "--area-policy", "tenants/demo/evidence/area-validation-policy.json", "--stage", "all"],
  }]);
});

test("area-policy contract has an explicit pending state and validates approvals", () => {
  assert.equal(validateAreaValidationPolicy({
    schema_version: 1,
    status: "pending",
    policy_id: null,
    policy_version: null,
    tolerance_fraction: null,
    approved_by: null,
    approved_at: null,
    basis: null,
    evidence_reference: null,
  }), null);
  const policy = {
    schema_version: 1,
    status: "approved",
    policy_id: "fixture-policy",
    policy_version: 1,
    tolerance_fraction: 0.37,
    approved_by: "fixture reviewer",
    approved_at: "2026-10-11T12:00:00Z",
    basis: "Synthetic contract test",
    evidence_reference: "fixture only",
  };
  assert.deepEqual(validateAreaValidationPolicy(policy), policy);
  assert.throws(() => validateAreaValidationPolicy({ ...policy, tolerance_fraction: 1 }), /tolerance_fraction/);
  assert.throws(() => validateAreaValidationPolicy({ ...policy, policy_version: 0 }), /policy_version/);
  assert.throws(() => validateAreaValidationPolicy({ ...policy, approved_at: "2026-02-31T12:00:00Z" }), /approved_at/);
  assert.throws(() => validateAreaValidationPolicy({
    schema_version: 1, status: "pending", tolerance_fraction: 0.08,
  }), /pending area policy/);
  assert.throws(() => validateAreaValidationPolicy({
    schema_version: 1, status: "pending",
  }), /set all approval fields to null/);
});

test("scale validation keeps absent values unavailable and rejects malformed references", () => {
  assert.equal(validateScaleConfig(null), null);
  assert.throws(() => validateScaleConfig({ road_width_ft: 60, road_band: null }), /road_band must be/);
  assert.throws(() => validateScaleConfig({ road_width_ft: 0, road_band: [10, 90] }), /road_width_ft must be/);
  assert.throws(() => validateScaleConfig({ road_width_ft: 60, road_band: [90, 10] }), /coordinates must be ordered/);
  assert.deepEqual(validateScaleConfig({ road_width_ft: 60, road_band: [10, 90, 20, 80] }), {
    road_width_ft: 60,
    road_band: [10, 90, 20, 80],
  });
});
