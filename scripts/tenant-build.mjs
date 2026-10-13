#!/usr/bin/env node
/**
 * Tenant package builder — runs the implemented pipeline stages for one
 * tenant package, writing ONLY into tenants/<slug>/build/.
 * Non-empty prior builds are moved intact into build-history/ before a new
 * build starts; the stable build/ path always points at the latest attempt.
 *
 *   npm run tenant:build -- --slug <slug> --source <file> [-- <build-flags>]
 *
 * Stages (existing, delegated to scripts/build-interactive-map.mjs):
 *   source classification, single-image extract at native resolution,
 *   detection, validation gates, ingest report, QA viewer.
 * OCR number/area reading and polygon matching run when at least one OCR
 * engine is installed. Area validation runs only with a declared scale
 * reference; paint-out and tiles remain explicitly NOT IMPLEMENTED.
 *
 * Extra build-local step: a ≤1600px preview rendition
 * (build/masterplan_preview.webp) for the mobile cap.
 * Successful builds write build-manifest.json; failed stages write
 * build-failure.json with the stage and a concise failure reason.
 *
 * Exit codes: 0 ok, 2 bad usage / missing package / stage failure.
 */
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { planOcrCommands, validateAreaValidationPolicy, validateScaleConfig } from "./tenant-build-ocr.mjs";
import {
  fingerprintFile,
  listReviewEvidenceFiles,
  MANIFEST_OUTPUT_NAMES,
  resolveTenantSourcePath,
} from "./tenant-build-evidence.mjs";
import { prepareBuildOutput } from "./tenant-build-output.mjs";
import { reusePreviousDetection } from "./tenant-build-reuse.mjs";
import { checkBuildCapacity, parseMinimumFreeBytes } from "./tenant-build-capacity.mjs";

const NOT_IMPLEMENTED_STAGES = [
  { name: "paint-out", status: "NOT IMPLEMENTED", note: "Painted-out clean base with preserved roads/creek/boundaries (clean-base plan S4)." },
  { name: "tiles", status: "NOT IMPLEMENTED", note: "Tile pyramid for the display image (clean-base plan S5)." },
];

const OCR_STAGES = ["ocr-numbers-areas", "match-polygons", "area-validation"];
const MANIFEST_NAME = "build-manifest.json";
const FAILURE_NAME = "build-failure.json";
let activeBuild = null;

function hasTesseract() {
  try {
    return spawnSync("tesseract", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function hasRapidOcr() {
  try {
    return spawnSync("python3", ["-c", "import rapidocr_onnxruntime"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const IMPLEMENTED_STAGES = [
  "source-classification",
  "disk-capacity-preflight",
  "streamed-input-fingerprints",
  "build-manifest",
  "failure-report",
  "single-image-extract",
  "detection",
  "validation-gates",
  "ingest-report",
  "qa-viewer",
  "preview-rendition",
];

function usage() {
  return `Usage:
  node scripts/tenant-build.mjs --slug <slug> --source source/<file> [-- <build-interactive-map flags>]

  The latest attempt is written to tenants/<slug>/build/; non-empty previous
  output is preserved in build-history/. Extra flags after -- are forwarded.
  Source files stay in tenants/<slug>/source/ (private and gitignored); this
  avoids duplicating large plats while keeping every build reproducible.
  A 1 GiB free-space floor is checked on output and temp filesystems before
  archiving; set WAMULE_BUILD_MIN_FREE_BYTES to an explicit byte threshold.
  --skip-detect reuses only a completed prior detection with matching source,
  tiers, detector, builder, and forwarded arguments.`;
}

function fail(message, stageOverride = null) {
  if (activeBuild) {
    const failedAt = new Date().toISOString();
    const stage = stageOverride || activeBuild.stage || "setup";
    if (activeBuild.manifest) {
      activeBuild.manifest.status = "failed";
      activeBuild.manifest.failed_at = failedAt;
      activeBuild.manifest.failure = { stage, message };
      try {
        writeJson(join(activeBuild.outDir, MANIFEST_NAME), activeBuild.manifest);
      } catch (error) {
        console.error(`[tenant:build] could not write manifest: ${error.message}`);
      }
    }
    try {
      writeJson(join(activeBuild.outDir, FAILURE_NAME), {
        schema_version: 1,
        status: "failed",
        failed_at: failedAt,
        tenant: activeBuild.slug,
        stage,
        source: activeBuild.source ? sourceReference(activeBuild.source) : null,
        message,
        manifest: MANIFEST_NAME,
      });
    } catch (error) {
      console.error(`[tenant:build] could not write failure report: ${error.message}`);
    }
  }
  console.error(`error: ${message}\n${usage()}`);
  process.exit(2);
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function sourceReference(path) {
  const relativePath = relative(process.cwd(), path);
  const isRepositoryRelative = relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
  return {
    path: isRepositoryRelative ? relativePath : basename(path),
    path_scope: isRepositoryRelative ? "repository-relative" : "external-basename-only",
  };
}

function fingerprintInput(role, path, displayPath = path) {
  return { role, ...sourceReference(displayPath), ...fingerprintFile(path) };
}

function firstVersionLine(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout || ""}${result.stderr || ""}`.trim().split(/\r?\n/, 1)[0] || null;
}

function resolveCwebpCommand() {
  if (process.env.CWEBP_BIN && existsSync(process.env.CWEBP_BIN)) return resolve(process.env.CWEBP_BIN);
  for (const candidate of ["/usr/local/bin/cwebp", "/Applications/XAMPP/xamppfiles/bin/cwebp"]) {
    if (existsSync(candidate)) return candidate;
  }
  const probe = spawnSync("cwebp", ["-version"], { stdio: "ignore" });
  return probe.status === 0 ? "cwebp" : null;
}

function pythonPackageVersions() {
  const script = "import json\nfrom importlib.metadata import version\npackages = ('Pillow', 'numpy', 'scipy', 'pypdfium2', 'rapidocr-onnxruntime')\nversions = {}\nfor name in packages:\n    try:\n        versions[name] = version(name)\n    except Exception:\n        versions[name] = None\nprint(json.dumps(versions, sort_keys=True))";
  const result = spawnSync("python3", ["-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = { forward: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      out.forward = argv.slice(i + 1);
      break;
    }
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "help" || key === "h") {
      console.log(usage());
      process.exit(0);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${arg}`);
    out[key] = value;
    i++;
  }
  return out;
}

/** Classify by magic bytes (not extension): pdf, png, webp, jpeg. */
function classifySource(path) {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(16);
    const bytesRead = readSync(fd, head, 0, head.length, 0);
    const signature = head.subarray(0, bytesRead);
    if (signature[0] === 0x25 && signature[1] === 0x50 && signature[2] === 0x44 && signature[3] === 0x46) return "pdf";
    if (signature[0] === 0x89 && signature[1] === 0x50 && signature[2] === 0x4e && signature[3] === 0x47) return "png";
    if (signature.toString("ascii", 0, 4) === "RIFF" && signature.toString("ascii", 8, 12) === "WEBP") return "webp";
    if (signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) return "jpeg";
    return null;
  } finally {
    closeSync(fd);
  }
}

function run(cmd, args, label) {
  if (activeBuild) activeBuild.stage = label;
  console.log(`[tenant:build] ${label}: ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.error) fail(`${label} could not start: ${res.error.message}`);
  if (res.status !== 0) fail(`${label} failed (exit ${res.status ?? "signal"})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const slug = ((args.slug || "").trim() || "").toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) fail("--slug must be lowercase letters, digits, hyphens");
  const tenantDir = resolve(join("tenants", slug));
  const tenantJson = join(tenantDir, "tenant.json");
  if (!existsSync(tenantJson)) fail(`tenants/${slug}/ not found — run tenant:init first`);
  const tenant = JSON.parse(readFileSync(tenantJson, "utf8"));
  if (tenant.slug !== slug) fail(`tenant.json slug mismatch (expected ${slug})`);
  let scale;
  const areaPolicyPath = join(tenantDir, "evidence", "area-validation-policy.json");
  let areaPolicy;
  try {
    scale = validateScaleConfig(tenant.scale);
    areaPolicy = validateAreaValidationPolicy(
      existsSync(areaPolicyPath) ? JSON.parse(readFileSync(areaPolicyPath, "utf8")) : null,
    );
  } catch (error) {
    fail(`scale/area policy configuration invalid: ${error.message}`, "scale-validation");
  }
  if (!args.source) fail("--source source/<file> is required");
  let source;
  try {
    source = resolveTenantSourcePath(tenantDir, args.source);
  } catch (error) {
    fail(error.message, "source-validation");
  }
  let kind;
  try {
    kind = classifySource(source);
  } catch (error) {
    fail(`source cannot be read: ${error.message}`);
  }
  if (!kind) fail(`unsupported source (need PDF/PNG/WebP/JPEG magic bytes): ${source}`);
  console.log(`[tenant:build] source classification: ${kind} (${source})`);
  const tiersPath = join(tenantDir, "tiers.json");
  if (!existsSync(tiersPath)) fail(`tiers.json missing in tenants/${slug}/`);

  try {
    const minimumFreeBytes = parseMinimumFreeBytes(process.env.WAMULE_BUILD_MIN_FREE_BYTES);
    const checks = checkBuildCapacity({ outputPath: tenantDir, minimumFreeBytes });
    for (const { label, path, availableBytes, requiredBytes } of checks) {
      console.log(`[tenant:build] disk preflight: ${label} (${path}) ${availableBytes} bytes free; ${requiredBytes} required`);
    }
  } catch (error) {
    fail(`disk-capacity preflight failed: ${error.message}`, "disk-capacity-preflight");
  }

  let output;
  try {
    output = prepareBuildOutput(tenantDir, source, process.cwd());
  } catch (error) {
    fail(`build output preparation failed: ${error.message}`);
  }
  const { outDir, archivedPath } = output;
  activeBuild = { outDir, slug, source, stage: "input-fingerprinting", manifest: null };
  if (archivedPath) console.log(`[tenant:build] prior build preserved -> ${archivedPath}`);

  activeBuild.stage = "input-fingerprinting";
  console.log("[tenant:build] fingerprinting source and configuration in bounded memory ...");
  let inputFiles;
  try {
    inputFiles = [
      fingerprintInput("source", source, source),
      fingerprintInput("tenant-config", tenantJson),
      fingerprintInput("tier-catalogue", tiersPath),
      fingerprintInput("builder", resolve("scripts/build-interactive-map.mjs")),
      fingerprintInput("alignment-checker", resolve("scripts/check-lot-alignment.py")),
      fingerprintInput("detector", resolve("scripts/detect-lots.py")),
      fingerprintInput("tenant-build-entrypoint", resolve("scripts/tenant-build.mjs")),
      fingerprintInput("build-capacity-preflight", resolve("scripts/tenant-build-capacity.mjs")),
      fingerprintInput("ocr-stage-planner", resolve("scripts/tenant-build-ocr.mjs")),
      fingerprintInput("build-evidence-inventory", resolve("scripts/tenant-build-evidence.mjs")),
      fingerprintInput("build-output-lifecycle", resolve("scripts/tenant-build-output.mjs")),
      fingerprintInput("detection-reuse", resolve("scripts/tenant-build-reuse.mjs")),
    ];
    if (existsSync("scripts/ocr-match.py")) {
      inputFiles.push(fingerprintInput("ocr-stage", resolve("scripts/ocr-match.py")));
    }
    for (const lockPath of ["package-lock.json", "package.json"]) {
      if (existsSync(lockPath)) inputFiles.push(fingerprintInput(lockPath, resolve(lockPath)));
    }
  } catch (error) {
    fail(`input fingerprinting failed: ${error.message}`);
  }
  let reusedDetection = null;
  let reviewEvidence = [];
  try {
    reviewEvidence = listReviewEvidenceFiles(join(tenantDir, "evidence"))
      .map((path) => fingerprintInput("review-evidence", path));
  } catch (error) {
    fail(`review evidence inventory failed: ${error.message}`, "review-evidence-inventory");
  }
  if (args.forward.includes("--skip-detect")) {
    try {
      reusedDetection = reusePreviousDetection({
        archiveDir: archivedPath,
        outDir,
        currentInputs: inputFiles,
        currentForwardedArgs: args.forward,
      });
      inputFiles.push(fingerprintInput("reused-detection-manifest", reusedDetection.manifestPath));
      for (const file of reusedDetection.files) {
        inputFiles.push(fingerprintInput(`reused-detection-${file.name}`, file.path));
      }
    } catch (error) {
      fail(`prior detection reuse refused: ${error.message}`, "detection-reuse-validation");
    }
  }
  const cwebpCommand = resolveCwebpCommand();
  activeBuild.manifest = {
    schema_version: 1,
    workflow: "tenant-build",
    status: "running",
    started_at: new Date().toISOString(),
    tenant: slug,
    invocation: {
      executable: "node",
      builder: "scripts/build-interactive-map.mjs",
      tenant: slug,
      source: sourceReference(source),
      source_type: kind,
      tier_catalogue: sourceReference(tiersPath),
      output_directory: `tenants/${slug}/build`,
      previous_build_archive: archivedPath ? sourceReference(archivedPath) : null,
      reused_detection: reusedDetection ? {
        archived_build: sourceReference(reusedDetection.archivedBuild),
        manifest_sha256: reusedDetection.manifestSha256,
        outputs: reusedDetection.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
      } : null,
      forwarded_build_args: args.forward,
    },
    inputs: inputFiles,
    review_evidence: reviewEvidence,
    toolchain: {
      node: process.version,
      python: firstVersionLine("python3", ["--version"]),
      python_packages: pythonPackageVersions(),
      tesseract: firstVersionLine("tesseract", ["--version"]),
      cwebp: cwebpCommand ? {
        command: cwebpCommand,
        version: firstVersionLine(cwebpCommand, ["-version"]),
      } : null,
      git_commit: firstVersionLine("git", ["rev-parse", "HEAD"]),
    },
    outputs: [],
  };
  try {
    writeJson(join(outDir, MANIFEST_NAME), activeBuild.manifest);
  } catch (error) {
    fail(`could not write build manifest: ${error.message}`);
  }

  run("node", [
    "scripts/build-interactive-map.mjs",
    "--tenant", slug,
    "--source", source,
    "--tiers", tiersPath,
    "--out", outDir,
    ...args.forward,
  ], "pipeline");

  // Preserve the clean detector stage before OCR/matching mutates lots.json
  // and the ingest report. --skip-detect may reuse only these manifest-bound
  // snapshots, never the final post-OCR artifacts.
  try {
    copyFileSync(join(outDir, "lots.json"), join(outDir, "detection-lots.json"));
    copyFileSync(join(outDir, "ingest-report.json"), join(outDir, "detection-ingest-report.json"));
  } catch (error) {
    fail(`could not preserve detector-stage snapshots: ${error.message}`, "detection-snapshot");
  }

  // Preview rendition for the mobile cap (python3+PIL already required).
  const bg = join(outDir, "masterplan_background.webp");
  if (existsSync(bg)) {
    run("python3", ["-c",
      "from PIL import Image; import sys; img = Image.open(sys.argv[1]); img.thumbnail((1600, 1600), Image.LANCZOS); img.save(sys.argv[2], 'WEBP', quality=78); print('preview:', img.size)",
      bg, join(outDir, "masterplan_preview.webp"),
    ], "preview-rendition");
  } else {
    console.warn("[tenant:build] no masterplan_background.webp — preview rendition skipped");
  }

  // OCR stages S1-S3 (scripts/ocr-match.py). Engines: tesseract and/or
  // rapidocr when installed; otherwise these stages stay NOT IMPLEMENTED
  // (never silently skipped). Scale comes from tenant.json scale
  // ({road_width_ft, road_band:[x0,x1]}); the initializer leaves this unset.
  // S3 also needs a separate approved versioned area policy from evidence/.
  // Without it run OCR first and then polygon matching; malformed declared
  // scale fails closed instead of being silently treated as available.
  const ocrStages = [];
  {
    const engines = [
      hasTesseract() ? "tesseract" : null,
      hasRapidOcr() ? "rapidocr" : null,
    ].filter(Boolean);
    if (!engines.length) {
      for (const name of OCR_STAGES) {
        ocrStages.push({ name, status: "NOT IMPLEMENTED", note: "no OCR engine installed (tesseract binary or rapidocr_onnxruntime)" });
      }
      console.warn("[tenant:build] no OCR engines — S1-S3 recorded NOT IMPLEMENTED");
    } else {
      for (const command of planOcrCommands(
        outDir, tiersPath, engines, scale, existsSync(areaPolicyPath) ? areaPolicyPath : null,
      )) {
        run("python3", command.args, command.label);
      }
      ocrStages.push(
        { name: "ocr-numbers-areas", status: "IMPLEMENTED" },
        { name: "match-polygons", status: "IMPLEMENTED" },
        !scale
          ? { name: "area-validation", status: "NOT IMPLEMENTED", note: "no scale reference (tenant.json scale.road_band) to measure against" }
          : areaPolicy
          ? { name: "area-validation", status: "IMPLEMENTED" }
          : { name: "area-validation", status: "NOT IMPLEMENTED", note: "no approved versioned area-validation policy in evidence/area-validation-policy.json" },
      );
    }
  }

  // Record the stage ledger (implemented + NOT IMPLEMENTED) in the report.
  const reportPath = join(outDir, "ingest-report.json");
  let finalReport = null;
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.tenant_workflow = {
      tenant: slug,
      source: { file: source, classification: kind },
      stages: [
        ...IMPLEMENTED_STAGES.map((name) => ({ name, status: "IMPLEMENTED" })),
        ...ocrStages,
        ...NOT_IMPLEMENTED_STAGES,
      ],
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    finalReport = report;
  }

  activeBuild.stage = "manifest-finalization";
  try {
    const sourceInput = activeBuild.manifest.inputs.find((input) => input.role === "source");
    const sourceAfterBuild = statSync(source);
    if (sourceAfterBuild.size !== sourceInput.bytes || sourceAfterBuild.mtime.toISOString() !== sourceInput.modified_at) {
      fail("source changed during the build; discard these outputs and rerun from the unchanged source", "source-integrity-check");
    }
    activeBuild.manifest.outputs = MANIFEST_OUTPUT_NAMES
      .filter((name) => existsSync(join(outDir, name)))
      .map((name) => fingerprintInput("build-output", join(outDir, name)));
    activeBuild.manifest.status = "completed";
    activeBuild.manifest.completed_at = new Date().toISOString();
    const sourceMeta = finalReport?.source_meta ?? null;
    activeBuild.manifest.map_result = finalReport ? {
      source_meta: sourceMeta ? { ...sourceMeta, source: sourceReference(source) } : null,
      background: finalReport.background ?? null,
      aspect: finalReport.aspect ?? null,
      alignment: finalReport.alignment ?? null,
      gate_errors: finalReport.errors ?? [],
      warnings: finalReport.warnings ?? [],
    } : null;
    activeBuild.manifest.stages = [
      ...IMPLEMENTED_STAGES.map((name) => ({ name, status: "IMPLEMENTED" })),
      ...ocrStages,
      ...NOT_IMPLEMENTED_STAGES,
    ];
    writeJson(join(outDir, MANIFEST_NAME), activeBuild.manifest);
  } catch (error) {
    fail(`manifest finalization failed: ${error.message}`);
  }
  console.log("[tenant:build] stages:");
  for (const name of IMPLEMENTED_STAGES) console.log(`  IMPLEMENTED      ${name}`);
  for (const stage of [...ocrStages, ...NOT_IMPLEMENTED_STAGES]) {
    console.log(`  ${stage.status === "IMPLEMENTED" ? "IMPLEMENTED     " : "NOT IMPLEMENTED "} ${stage.name}${stage.status === "IMPLEMENTED" ? "" : ` — ${stage.note}`}`);
  }
  console.log(`[tenant:build] done -> ${outDir} (writes confined to build/)`);
}

main().catch((error) => {
  const stage = activeBuild?.stage || "unexpected-error";
  fail(`unexpected build failure: ${error.message}`, stage);
});
