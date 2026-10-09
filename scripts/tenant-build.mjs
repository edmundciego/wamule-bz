#!/usr/bin/env node
/**
 * Tenant package builder — runs the implemented pipeline stages for one
 * tenant package, writing ONLY into tenants/<slug>/build/.
 *
 *   npm run tenant:build -- --slug <slug> --source <file> [-- <build-flags>]
 *
 * Stages (existing, delegated to scripts/build-interactive-map.mjs):
 *   source classification, single-image extract at native resolution,
 *   detection, validation gates, ingest report, QA viewer.
 * Stages not built yet — OCR number/area reading, area validation,
 * paint-out, tiles — are recorded as NOT IMPLEMENTED in
 * build/ingest-report.json (tenant_workflow.stages) and printed, never
 * silently skipped.
 *
 * Extra build-local step: a ≤1600px preview rendition
 * (build/masterplan_preview.webp) for the mobile cap.
 *
 * Exit codes: 0 ok, 2 bad usage / missing package / stage failure.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const NOT_IMPLEMENTED_STAGES = [
  { name: "paint-out", status: "NOT IMPLEMENTED", note: "Painted-out clean base with preserved roads/creek/boundaries (clean-base plan S4)." },
  { name: "tiles", status: "NOT IMPLEMENTED", note: "Tile pyramid for the display image (clean-base plan S5)." },
];

const OCR_STAGES = ["ocr-numbers-areas", "match-polygons", "area-validation"];

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
  "single-image-extract",
  "detection",
  "validation-gates",
  "ingest-report",
  "qa-viewer",
  "preview-rendition",
];

function usage() {
  return `Usage:
  node scripts/tenant-build.mjs --slug <slug> --source <file> [-- <build-interactive-map flags>]

  Runs the implemented stages into tenants/<slug>/build/ only. Extra flags
  after -- are forwarded (e.g. -- --skip-detect --expected-min 50).`;
}

function fail(message) {
  console.error(`error: ${message}\n${usage()}`);
  process.exit(2);
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
  const head = readFileSync(path).subarray(0, 16);
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return "pdf";
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "png";
  if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  return null;
}

function run(cmd, args, label) {
  console.log(`[tenant:build] ${label}: ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.status !== 0) fail(`${label} failed (exit ${res.status ?? "signal"})`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const slug = ((args.slug || "").trim() || "").toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) fail("--slug must be lowercase letters, digits, hyphens");
  const tenantDir = resolve(join("tenants", slug));
  const tenantJson = join(tenantDir, "tenant.json");
  if (!existsSync(tenantJson)) fail(`tenants/${slug}/ not found — run tenant:init first`);
  const tenant = JSON.parse(readFileSync(tenantJson, "utf8"));
  if (tenant.slug !== slug) fail(`tenant.json slug mismatch (expected ${slug})`);
  if (!args.source) fail("--source <file> is required");
  const source = resolve(args.source);
  if (!existsSync(source)) fail(`source not found: ${source}`);
  const kind = classifySource(source);
  if (!kind) fail(`unsupported source (need PDF/PNG/WebP/JPEG magic bytes): ${source}`);
  console.log(`[tenant:build] source classification: ${kind} (${source})`);
  const outDir = join(tenantDir, "build");
  mkdirSync(outDir, { recursive: true });
  const resolvedOut = resolve(outDir);
  if (resolvedOut !== resolve(join("tenants", slug, "build"))) fail("refusing to write outside the tenant build dir");
  const tiersPath = join(tenantDir, "tiers.json");
  if (!existsSync(tiersPath)) fail(`tiers.json missing in tenants/${slug}/`);

  run("node", [
    "scripts/build-interactive-map.mjs",
    "--tenant", slug,
    "--source", source,
    "--tiers", tiersPath,
    "--out", outDir,
    ...args.forward,
  ], "pipeline");

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
  // ({road_width_ft, road_band:[x0,x1]}); without it only match runs and
  // area validation is recorded NOT IMPLEMENTED (no reference to measure).
  const ocrStages = [];
  {
    const engines = [
      hasTesseract() ? "tesseract" : null,
      hasRapidOcr() ? "rapidocr" : null,
    ].filter(Boolean);
    let scale = null;
    try {
      const tenant = JSON.parse(readFileSync(join(tenantDir, "tenant.json"), "utf8"));
      if (tenant.scale && Array.isArray(tenant.scale.road_band)) scale = tenant.scale;
    } catch {
      scale = null;
    }
    if (!engines.length) {
      for (const name of OCR_STAGES) {
        ocrStages.push({ name, status: "NOT IMPLEMENTED", note: "no OCR engine installed (tesseract binary or rapidocr_onnxruntime)" });
      }
      console.warn("[tenant:build] no OCR engines — S1-S3 recorded NOT IMPLEMENTED");
    } else {
      const ocrArgs = ["scripts/ocr-match.py", "--dir", outDir, "--tiers", tiersPath,
        "--engines", engines.length > 1 ? "both" : engines[0]];
      if (scale) ocrArgs.push("--road-band", scale.road_band.join(","), "--road-width-ft", String(scale.road_width_ft ?? 60));
      // Without a scale reference there is nothing honest to validate areas
      // against: run through matching only.
      if (!scale) ocrArgs.push("--stage", "match");
      run("python3", ocrArgs, "ocr-match (S1-S3)");
      ocrStages.push(
        { name: "ocr-numbers-areas", status: "IMPLEMENTED" },
        { name: "match-polygons", status: "IMPLEMENTED" },
        scale
          ? { name: "area-validation", status: "IMPLEMENTED" }
          : { name: "area-validation", status: "NOT IMPLEMENTED", note: "no scale reference (tenant.json scale.road_band) to measure against" },
      );
    }
  }

  // Record the stage ledger (implemented + NOT IMPLEMENTED) in the report.
  const reportPath = join(outDir, "ingest-report.json");
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
  }
  console.log("[tenant:build] stages:");
  for (const name of IMPLEMENTED_STAGES) console.log(`  IMPLEMENTED      ${name}`);
  for (const stage of [...ocrStages, ...NOT_IMPLEMENTED_STAGES]) {
    console.log(`  ${stage.status === "IMPLEMENTED" ? "IMPLEMENTED     " : "NOT IMPLEMENTED "} ${stage.name}${stage.status === "IMPLEMENTED" ? "" : ` — ${stage.note}`}`);
  }
  console.log(`[tenant:build] done -> ${outDir} (writes confined to build/)`);
}

main();
