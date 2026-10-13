import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const MANIFEST_OUTPUT_NAMES = [
  "detection-lots.json",
  "detection-ingest-report.json",
  "lots.json",
  "ingest-report.json",
  "ocr.json",
  "ocr-qa.html",
  "masterplan_background.webp",
  "masterplan_preview.webp",
  "poc.html",
];

export const REQUIRED_DETECTION_SNAPSHOT_NAMES = [
  "detection-lots.json",
  "detection-ingest-report.json",
];

export const REQUIRED_BUILD_INPUT_ROLES = [
  "source",
  "tenant-config",
  "tier-catalogue",
  "builder",
  "alignment-checker",
  "detector",
  "tenant-build-entrypoint",
  "build-capacity-preflight",
  "ocr-stage-planner",
  "build-evidence-inventory",
  "build-output-lifecycle",
  "detection-reuse",
  "ocr-stage",
  "package-lock.json",
  "package.json",
];

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Stream a build input/output into SHA-256 without loading it all in memory. */
export function fingerprintFile(path) {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`fingerprint target must be a regular non-symlink file: ${path}`);
  }
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    const after = lstatSync(path);
    if (
      before.size !== bytes || after.size !== bytes ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      before.ino !== after.ino || before.dev !== after.dev
    ) {
      throw new Error(`file changed while fingerprinting: ${path}`);
    }
    return { bytes, sha256: hash.digest("hex"), modified_at: before.mtime.toISOString() };
  } finally {
    closeSync(fd);
  }
}

function safeRepositoryPath(root, repositoryPath) {
  if (
    typeof repositoryPath !== "string" || !repositoryPath ||
    isAbsolute(repositoryPath) || /^[A-Za-z]:[\\/]/.test(repositoryPath)
  ) {
    throw new Error("manifest path must be repository-relative");
  }
  const normalized = repositoryPath.split(/[\\/]+/).filter(Boolean).join(sep);
  const absolutePath = resolve(root, normalized);
  if (!isWithin(root, absolutePath) || absolutePath === root) {
    throw new Error("manifest path escapes the repository root");
  }
  let cursor = root;
  for (const part of relative(root, absolutePath).split(sep)) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`manifest path contains a symlink: ${repositoryPath}`);
  }
  if (!isWithin(root, realpathSync(absolutePath))) {
    throw new Error(`manifest path resolves outside the repository: ${repositoryPath}`);
  }
  return absolutePath;
}

function verifyFingerprintRecords(root, records, label, issues, unverifiableInputs) {
  if (!Array.isArray(records)) {
    issues.push(`manifest ${label} must be an array`);
    return 0;
  }
  let verified = 0;
  for (const record of records) {
    if (!record || typeof record !== "object") {
      issues.push(`manifest contains an invalid ${label} fingerprint`);
      continue;
    }
    if (record.path_scope !== "repository-relative") {
      unverifiableInputs.push({
        kind: label,
        role: record.role ?? "unknown",
        path: record.path ?? null,
        path_scope: record.path_scope ?? null,
      });
      continue;
    }
    try {
      const target = safeRepositoryPath(root, record.path);
      const actual = fingerprintFile(target);
      if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256) {
        issues.push(`${label} fingerprint mismatch: ${record.role ?? record.path}`);
      } else {
        verified += 1;
      }
    } catch (error) {
      issues.push(`${label} could not be verified (${record.role ?? record.path}): ${error.message}`);
    }
  }
  return verified;
}

/**
 * Verify a completed private tenant build against its input and output hashes.
 * External-basename-only inputs are reported as unverifiable, never as a pass.
 */
export function verifyTenantBuild({ repositoryRoot = process.cwd(), slug }) {
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(slug)) {
    throw new Error("tenant slug must contain 1-63 letters, digits, or interior hyphens");
  }
  const root = realpathSync(resolve(repositoryRoot));
  const buildRelative = join("tenants", slug, "build");
  const buildPath = safeRepositoryPath(root, buildRelative);
  if (!lstatSync(buildPath).isDirectory()) throw new Error("tenant build path is not a directory");

  const manifestRelative = join(buildRelative, "build-manifest.json");
  const manifestPath = safeRepositoryPath(root, manifestRelative);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const issues = [];
  const unverifiableInputs = [];
  if (manifest.schema_version !== 1 || manifest.workflow !== "tenant-build" || manifest.status !== "completed") {
    issues.push("manifest must describe a completed schema-version-1 tenant-build");
  }
  if (manifest.tenant !== slug) issues.push(`manifest tenant ${String(manifest.tenant)} does not match ${slug}`);
  if (!Array.isArray(manifest.inputs)) issues.push("manifest inputs must be an array");
  if (!Array.isArray(manifest.review_evidence)) issues.push("manifest review_evidence must be an array");
  if (!Array.isArray(manifest.outputs)) issues.push("manifest outputs must be an array");

  const inputs = Array.isArray(manifest.inputs) ? manifest.inputs : [];
  const inputRoles = new Set(inputs.map((input) => input?.role).filter((role) => typeof role === "string"));
  for (const role of REQUIRED_BUILD_INPUT_ROLES) {
    if (!inputRoles.has(role)) issues.push(`manifest is missing required input fingerprint: ${role}`);
  }
  const inputsVerified = verifyFingerprintRecords(root, inputs, "input", issues, unverifiableInputs);
  const evidenceVerified = verifyFingerprintRecords(
    root,
    Array.isArray(manifest.review_evidence) ? manifest.review_evidence : [],
    "review evidence",
    issues,
    unverifiableInputs,
  );

  const outputs = Array.isArray(manifest.outputs) ? manifest.outputs : [];
  const outputNames = new Set();
  let outputsVerified = 0;
  for (const output of outputs) {
    if (!output || typeof output !== "object" || output.role !== "build-output") {
      issues.push("manifest contains an invalid build-output fingerprint");
      continue;
    }
    const normalizedOutputPath = typeof output.path === "string" ? output.path.replaceAll("\\", "/") : null;
    const name = normalizedOutputPath?.split("/").at(-1) ?? null;
    if (!name || !MANIFEST_OUTPUT_NAMES.includes(name)) {
      issues.push(`unexpected build output path: ${String(output.path)}`);
      continue;
    }
    if (outputNames.has(name)) {
      issues.push(`duplicate output fingerprint: ${name}`);
      continue;
    }
    outputNames.add(name);
    const expectedPath = join(buildRelative, name);
    if (output.path_scope !== "repository-relative" || normalizedOutputPath !== expectedPath.split(sep).join("/")) {
      issues.push(`output path does not match this tenant build: ${String(output.path)}`);
      continue;
    }
    try {
      const target = safeRepositoryPath(root, output.path);
      const actual = fingerprintFile(target);
      if (actual.bytes !== output.bytes || actual.sha256 !== output.sha256) {
        issues.push(`output fingerprint mismatch: ${name}`);
      } else {
        outputsVerified += 1;
      }
    } catch (error) {
      issues.push(`output could not be verified (${name}): ${error.message}`);
    }
  }

  for (const name of MANIFEST_OUTPUT_NAMES) {
    const path = join(buildPath, name);
    if (existsSync(path) && !outputNames.has(name)) {
      issues.push(`build output is present but not fingerprinted: ${name}`);
    }
  }
  for (const name of REQUIRED_DETECTION_SNAPSHOT_NAMES) {
    if (!outputNames.has(name)) issues.push(`manifest is missing required detector-stage snapshot: ${name}`);
  }
  if (outputs.length === 0) issues.push("manifest contains no build output fingerprints");

  return {
    ok: issues.length === 0 && unverifiableInputs.length === 0,
    manifestPath: manifestRelative,
    inputsVerified,
    evidenceVerified,
    outputsVerified,
    unverifiableInputs,
    issues,
  };
}

/**
 * Resolve a tenant build input only from its private source/ directory.
 * Relative CLI paths are package-relative (e.g. source/plat.pdf); absolute
 * paths are accepted only when they still resolve inside that directory.
 */
export function resolveTenantSourcePath(tenantDir, sourceArgument) {
  if (typeof sourceArgument !== "string" || !sourceArgument.trim()) {
    throw new Error("--source must name a file in the tenant's private source/ directory");
  }
  const tenantRoot = resolve(tenantDir);
  const sourceRoot = join(tenantRoot, "source");
  if (!existsSync(sourceRoot)) throw new Error("tenant source/ directory is missing; run tenant:init first");

  const sourceRootStat = lstatSync(sourceRoot);
  if (sourceRootStat.isSymbolicLink() || !sourceRootStat.isDirectory()) {
    throw new Error("tenant source/ path must be a real directory, not a symlink or file");
  }
  const sourceRootReal = realpathSync(sourceRoot);
  const candidate = isAbsolute(sourceArgument)
    ? resolve(sourceArgument)
    : resolve(tenantRoot, sourceArgument);
  if (!existsSync(candidate)) throw new Error(`source not found: ${candidate}`);

  const candidateStat = lstatSync(candidate);
  if (candidateStat.isSymbolicLink()) throw new Error("tenant source file must not be a symlink");
  if (!candidateStat.isFile()) throw new Error("tenant source must be a regular file");
  const sourceReal = realpathSync(candidate);
  if (!isWithin(sourceRootReal, sourceReal) || sourceReal === sourceRootReal) {
    throw new Error("--source must resolve inside the tenant's private source/ directory");
  }
  return sourceReal;
}

/** List immutable reviewer artifacts without following symlinks. */
export function listReviewEvidenceFiles(evidenceDir) {
  const root = resolve(evidenceDir);
  if (!existsSync(root)) return [];
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("tenant evidence/ path must be a real directory, not a symlink or file");
  }

  const files = [];
  function visit(directory) {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`review evidence must not contain symlinks: ${path}`);
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        files.push(path);
        if (files.length > 5000) throw new Error("tenant evidence/ contains more than 5000 files");
      } else {
        throw new Error(`review evidence must contain only regular files and directories: ${path}`);
      }
    }
  }
  visit(root);
  return files;
}
