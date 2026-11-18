import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  fingerprintFile,
  REQUIRED_BUILD_INPUT_ROLES,
  REQUIRED_DETECTION_SNAPSHOT_NAMES,
  verifyTenantBuild,
} from "../scripts/tenant-build-evidence.mjs";

const ROLE_PATHS = {
  source: "tenants/alpha/source/map.pdf",
  "tenant-config": "tenants/alpha/tenant.json",
  "tier-catalogue": "tenants/alpha/tiers.json",
  builder: "scripts/build-interactive-map.mjs",
  "alignment-checker": "scripts/check-lot-alignment.py",
  detector: "scripts/detect-lots.py",
  "tenant-build-entrypoint": "scripts/tenant-build.mjs",
  "build-capacity-preflight": "scripts/tenant-build-capacity.mjs",
  "ocr-stage-planner": "scripts/tenant-build-ocr.mjs",
  "build-evidence-inventory": "scripts/tenant-build-evidence.mjs",
  "build-output-lifecycle": "scripts/tenant-build-output.mjs",
  "detection-reuse": "scripts/tenant-build-reuse.mjs",
  "ocr-stage": "scripts/ocr-match.py",
  "package-lock.json": "package-lock.json",
  "package.json": "package.json",
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tenant-build-verify-"));
  const buildDir = join(root, "tenants", "alpha", "build");
  mkdirSync(buildDir, { recursive: true });
  const inputs = REQUIRED_BUILD_INPUT_ROLES.map((role) => {
    const path = join(root, ROLE_PATHS[role]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `fixture input ${role}\n`);
    return { role, path: ROLE_PATHS[role], path_scope: "repository-relative", ...fingerprintFile(path) };
  });
  const outputPaths = [
    "lots.json",
    ...REQUIRED_DETECTION_SNAPSHOT_NAMES,
  ].map((name) => {
    const path = join(buildDir, name);
    writeFileSync(path, `fixture output ${name}\n`);
    return {
      role: "build-output",
      path: `tenants/alpha/build/${name}`,
      path_scope: "repository-relative",
      ...fingerprintFile(path),
    };
  });
  const evidencePath = join(root, "tenants", "alpha", "evidence", "source-audit.json");
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, '{"source":"fixture"}\n');
  const reviewEvidence = {
    role: "review-evidence",
    path: "tenants/alpha/evidence/source-audit.json",
    path_scope: "repository-relative",
    ...fingerprintFile(evidencePath),
  };
  writeFileSync(join(buildDir, "build-manifest.json"), JSON.stringify({
    schema_version: 1,
    workflow: "tenant-build",
    status: "completed",
    tenant: "alpha",
    inputs,
    review_evidence: [reviewEvidence],
    outputs: outputPaths,
  }));
  return { root, buildDir, evidencePath, inputs };
}

test("tenant build verifier validates every required input and recorded output hash", () => {
  const data = fixture();
  try {
    const result = verifyTenantBuild({ repositoryRoot: data.root, slug: "alpha" });
    assert.equal(result.ok, true);
    assert.equal(result.inputsVerified, REQUIRED_BUILD_INPUT_ROLES.length);
    assert.equal(result.evidenceVerified, 1);
    assert.equal(result.outputsVerified, 1 + REQUIRED_DETECTION_SNAPSHOT_NAMES.length);
    assert.deepEqual(result.issues, []);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("tenant build verifier reports modified inputs and outputs", () => {
  const data = fixture();
  try {
    writeFileSync(join(data.root, ROLE_PATHS.source), "changed source\n");
    writeFileSync(data.evidencePath, "changed reviewer evidence\n");
    writeFileSync(join(data.buildDir, "lots.json"), "changed output\n");
    const result = verifyTenantBuild({ repositoryRoot: data.root, slug: "alpha" });
    assert.equal(result.ok, false);
    assert.ok(result.issues.includes("input fingerprint mismatch: source"));
    assert.ok(result.issues.includes("review evidence fingerprint mismatch: review-evidence"));
    assert.ok(result.issues.includes("output fingerprint mismatch: lots.json"));
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("tenant build verifier requires clean detector-stage snapshots", () => {
  const data = fixture();
  try {
    const manifestPath = join(data.buildDir, "build-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.outputs = manifest.outputs.filter((output) => output.path !== "tenants/alpha/build/detection-lots.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = verifyTenantBuild({ repositoryRoot: data.root, slug: "alpha" });
    assert.equal(result.ok, false);
    assert.ok(result.issues.includes("manifest is missing required detector-stage snapshot: detection-lots.json"));
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("tenant build verifier refuses unrecorded outputs, unverified external inputs, and symlinks", () => {
  const data = fixture();
  try {
    const manifestPath = join(data.buildDir, "build-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const externalOutput = join(data.buildDir, "ocr.json");
    writeFileSync(externalOutput, "extra output\n");
    manifest.inputs.push({ role: "external-config", path: "config.json", path_scope: "external-basename-only", bytes: 7, sha256: "0".repeat(64) });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = verifyTenantBuild({ repositoryRoot: data.root, slug: "alpha" });
    assert.equal(result.ok, false);
    assert.equal(result.unverifiableInputs.length, 1);
    assert.ok(result.issues.includes("build output is present but not fingerprinted: ocr.json"));

    unlinkSync(externalOutput);
    const outside = join(data.root, "outside.json");
    writeFileSync(outside, "outside\n");
    const lotOutputPath = join(data.buildDir, "lots.json");
    unlinkSync(lotOutputPath);
    symlinkSync(outside, lotOutputPath);
    const symlinkResult = verifyTenantBuild({ repositoryRoot: data.root, slug: "alpha" });
    assert.equal(symlinkResult.ok, false);
    assert.ok(symlinkResult.issues.some((issue) => issue.includes("symlink")));
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("tenant build verifier rejects unsafe tenant slugs and missing dependency fingerprints", () => {
  const data = fixture();
  try {
    assert.throws(() => verifyTenantBuild({ repositoryRoot: data.root, slug: "../alpha" }), /tenant slug/);
    const manifestPath = join(data.buildDir, "build-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.inputs = manifest.inputs.filter((input) => input.role !== "build-evidence-inventory");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = verifyTenantBuild({ repositoryRoot: data.root, slug: "alpha" });
    assert.equal(result.ok, false);
    assert.ok(result.issues.includes("manifest is missing required input fingerprint: build-evidence-inventory"));
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

