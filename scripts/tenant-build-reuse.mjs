import { createHash } from "node:crypto";
import { copyFileSync, constants, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

function fail(message) {
  throw new Error(message);
}

function fingerprint(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`reused detection input is not a regular file: ${path}`);
  const bytes = readFileSync(path);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function withoutSkipDetect(args) {
  return args.filter((arg) => arg !== "--skip-detect");
}

/**
 * Rehydrate only a verified prior detection stage for an explicit --skip-detect
 * build. Source, tier catalogue, detector, pipeline, and detector flags must
 * still match; otherwise the old geometry is not safe to reuse.
 */
export function reusePreviousDetection({ archiveDir, outDir, currentInputs, currentForwardedArgs }) {
  if (!archiveDir) fail("--skip-detect requires a prior completed tenant build");
  const manifestPath = join(archiveDir, "build-manifest.json");
  let manifestBytes;
  let manifest;
  try {
    manifestBytes = readFileSync(manifestPath);
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    fail(`prior build manifest is unavailable or invalid: ${error.message}`);
  }
  if (manifest.schema_version !== 1 || manifest.workflow !== "tenant-build" || manifest.status !== "completed") {
    fail("--skip-detect requires a completed prior tenant build manifest");
  }

  const previousInputs = new Map((manifest.inputs ?? []).map((input) => [input.role, input]));
  const currentByRole = new Map(currentInputs.map((input) => [input.role, input]));
  for (const role of ["source", "tenant-config", "tier-catalogue", "builder", "detector"]) {
    const previous = previousInputs.get(role);
    const current = currentByRole.get(role);
    if (!previous || !current || previous.bytes !== current.bytes || previous.sha256 !== current.sha256) {
      fail(`cannot reuse prior detections: ${role} fingerprint changed or is missing`);
    }
  }
  if (JSON.stringify(withoutSkipDetect(manifest.invocation?.forwarded_build_args ?? [])) !==
      JSON.stringify(withoutSkipDetect(currentForwardedArgs))) {
    fail("cannot reuse prior detections: forwarded detector/build arguments changed");
  }

  const outputs = new Map((manifest.outputs ?? []).map((output) => [
    typeof output.path === "string" ? output.path.split(/[\\/]/).at(-1) : "",
    output,
  ]));
  const reusedFiles = [];
  for (const { snapshotName, targetName } of [
    { snapshotName: "detection-lots.json", targetName: "lots.json" },
    { snapshotName: "detection-ingest-report.json", targetName: "ingest-report.json" },
  ]) {
    const archivedFile = join(archiveDir, snapshotName);
    const recorded = outputs.get(snapshotName);
    if (!recorded) fail(`prior build manifest does not record detector-stage snapshot ${snapshotName}; run a full detection build first`);
    const actual = fingerprint(archivedFile);
    if (recorded.bytes !== actual.bytes || recorded.sha256 !== actual.sha256) {
      fail(`prior build fingerprint does not match detector-stage snapshot ${snapshotName}`);
    }
    const targetFile = join(outDir, targetName);
    copyFileSync(archivedFile, targetFile, constants.COPYFILE_EXCL);
    reusedFiles.push({ path: archivedFile, name: targetName, snapshotName, ...actual });
  }

  return {
    manifestPath,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    archivedBuild: archiveDir,
    files: reusedFiles.map(({ path, name, bytes, sha256 }) => ({ path, name, bytes, sha256 })),
  };
}
