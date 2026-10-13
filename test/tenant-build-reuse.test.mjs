import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reusePreviousDetection } from "../scripts/tenant-build-reuse.mjs";

function fixture({ includeDetectionSnapshots = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tenant-build-reuse-"));
  const archiveDir = join(root, "build-history", "run-1");
  const outDir = join(root, "build");
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(outDir);
  const outputs = [];
  const files = [
    ["lots.json", "final post-OCR lots\n"],
    ["ingest-report.json", "final post-OCR report\n"],
  ];
  if (includeDetectionSnapshots) {
    files.push(
      ["detection-lots.json", "detector-only lots evidence\n"],
      ["detection-ingest-report.json", "detector-only report\n"],
    );
  }
  for (const [name, content] of files) {
    writeFileSync(join(archiveDir, name), content);
    const bytes = Buffer.byteLength(content);
    const sha256 = createHash("sha256").update(content).digest("hex");
    outputs.push({ role: "build-output", path: `tenants/alpha/build/${name}`, bytes, sha256 });
  }
  const roles = ["source", "tenant-config", "tier-catalogue", "builder", "detector"];
  const inputs = roles.map((role) => ({ role, bytes: 64, sha256: `${role.length}`.padStart(64, "0") }));
  const manifest = {
    schema_version: 1,
    workflow: "tenant-build",
    status: "completed",
    invocation: { forwarded_build_args: ["--expected-min", "50"] },
    inputs,
    outputs,
  };
  writeFileSync(join(archiveDir, "build-manifest.json"), JSON.stringify(manifest));
  return { root, archiveDir, outDir, inputs };
}

test("skip-detect reuses only fingerprint-verified detections from the same inputs", () => {
  const data = fixture();
  try {
    const result = reusePreviousDetection({
      ...data,
      currentInputs: data.inputs,
      currentForwardedArgs: ["--skip-detect", "--expected-min", "50"],
    });
    assert.equal(result.archivedBuild, data.archiveDir);
    assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.files.map((file) => file.name), ["lots.json", "ingest-report.json"]);
    assert.equal(readFileSync(join(data.outDir, "lots.json"), "utf8"), "detector-only lots evidence\n");
    assert.equal(readFileSync(join(data.outDir, "ingest-report.json"), "utf8"), "detector-only report\n");
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("skip-detect refuses changed inputs or changed detector arguments before copying", () => {
  const data = fixture();
  try {
    const changedInputs = data.inputs.map((input) => input.role === "source" ? { ...input, sha256: "f".repeat(64) } : input);
    assert.throws(() => reusePreviousDetection({ ...data, currentInputs: changedInputs, currentForwardedArgs: ["--skip-detect", "--expected-min", "50"] }), /source fingerprint changed/);
    assert.throws(() => reusePreviousDetection({ ...data, currentInputs: data.inputs, currentForwardedArgs: ["--skip-detect", "--expected-min", "60"] }), /arguments changed/);
    assert.deepEqual(readdirSync(data.outDir), []);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("skip-detect refuses tampered prior outputs and incomplete build histories", () => {
  const data = fixture();
  try {
    writeFileSync(join(data.archiveDir, "detection-lots.json"), "tampered\n");
    assert.throws(() => reusePreviousDetection({ ...data, currentInputs: data.inputs, currentForwardedArgs: ["--skip-detect", "--expected-min", "50"] }), /fingerprint does not match detector-stage snapshot detection-lots.json/);
    const noArchive = { ...data, archiveDir: null };
    assert.throws(() => reusePreviousDetection({ ...noArchive, currentInputs: data.inputs, currentForwardedArgs: ["--skip-detect"] }), /requires a prior completed/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("skip-detect refuses legacy builds without detector-stage snapshots", () => {
  const data = fixture({ includeDetectionSnapshots: false });
  try {
    assert.throws(
      () => reusePreviousDetection({ ...data, currentInputs: data.inputs, currentForwardedArgs: ["--skip-detect", "--expected-min", "50"] }),
      /does not record detector-stage snapshot detection-lots\.json; run a full detection build first/,
    );
    assert.deepEqual(readdirSync(data.outDir), []);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

