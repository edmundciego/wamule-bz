import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  listReviewEvidenceFiles,
  MANIFEST_OUTPUT_NAMES,
  resolveTenantSourcePath,
} from "../scripts/tenant-build-evidence.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tenant-build-evidence-"));
  const tenantDir = join(root, "tenants", "alpha");
  const sourceDir = join(tenantDir, "source");
  mkdirSync(sourceDir, { recursive: true });
  const source = join(sourceDir, "plat.pdf");
  writeFileSync(source, "%PDF-1.7\nprivate source\n");
  return { root, tenantDir, sourceDir, source };
}

test("tenant build accepts relative or absolute sources only from the private package source directory", () => {
  const data = fixture();
  try {
    assert.equal(resolveTenantSourcePath(data.tenantDir, "source/plat.pdf"), realpathSync(data.source));
    assert.equal(resolveTenantSourcePath(data.tenantDir, data.source), realpathSync(data.source));
    mkdirSync(join(data.root, "tenants", "elsewhere"));
    writeFileSync(join(data.root, "tenants", "elsewhere", "plat.pdf"), "%PDF outside package source\n");
    assert.throws(() => resolveTenantSourcePath(data.tenantDir, "../elsewhere/plat.pdf"), /inside the tenant's private source/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("tenant build refuses source-file symlinks", () => {
  const data = fixture();
  const external = join(data.root, "external.pdf");
  writeFileSync(external, "%PDF outside source directory\n");
  try {
    const link = join(data.sourceDir, "outside.pdf");
    symlinkSync(external, link, "file");
    assert.throws(() => resolveTenantSourcePath(data.tenantDir, "source/outside.pdf"), /must not be a symlink/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("tenant build refuses a source directory redirected outside the package", () => {
  const root = mkdtempSync(join(tmpdir(), "tenant-build-source-redirect-"));
  const tenantDir = join(root, "tenants", "alpha");
  const outside = join(root, "external-source");
  mkdirSync(tenantDir, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "plat.pdf"), "%PDF external source\n");
  symlinkSync(outside, join(tenantDir, "source"), "dir");
  try {
    assert.throws(() => resolveTenantSourcePath(tenantDir, "source/plat.pdf"), /source\/ path must be a real directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review evidence inventory is sorted, recursive, and rejects symlinks", () => {
  const data = fixture();
  const evidenceDir = join(data.tenantDir, "evidence");
  const external = join(data.root, "private-not-in-evidence.txt");
  mkdirSync(join(evidenceDir, "labels"), { recursive: true });
  writeFileSync(join(evidenceDir, "area-validation-policy.json"), '{"schema_version":1,"status":"pending"}\n');
  writeFileSync(join(evidenceDir, "z-road-calibration.json"), "{}\n");
  writeFileSync(join(evidenceDir, "labels", "labels.csv"), "lot,label\n");
  writeFileSync(external, "private\n");
  try {
    assert.deepEqual(listReviewEvidenceFiles(evidenceDir), [
      join(evidenceDir, "area-validation-policy.json"),
      join(evidenceDir, "labels", "labels.csv"),
      join(evidenceDir, "z-road-calibration.json"),
    ]);
    symlinkSync(external, join(evidenceDir, "leak.txt"), "file");
    assert.throws(() => listReviewEvidenceFiles(evidenceDir), /must not contain symlinks/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("build manifest fingerprints OCR and QA evidence as well as detected and display artifacts", () => {
  assert.deepEqual(MANIFEST_OUTPUT_NAMES, [
    "detection-lots.json",
    "detection-ingest-report.json",
    "lots.json",
    "ingest-report.json",
    "ocr.json",
    "ocr-qa.html",
    "masterplan_background.webp",
    "masterplan_preview.webp",
    "poc.html",
  ]);
});

test("tenant build fingerprints the extracted alignment checker as a build input", async () => {
  const builder = await readFile(new URL("../scripts/tenant-build.mjs", import.meta.url), "utf8");
  assert.match(builder, /fingerprintInput\("alignment-checker", resolve\("scripts\/check-lot-alignment\.py"\)\)/);
  assert.match(builder, /fingerprintInput\("build-evidence-inventory", resolve\("scripts\/tenant-build-evidence\.mjs"\)\)/);
});

test("publisher only selects the display background and preview, never private source or OCR evidence", async () => {
  const publisher = await readFile(new URL("../scripts/tenant-publish.mjs", import.meta.url), "utf8");
  assert.match(publisher, /uploadMapAsset\(bgPath, "background"\)/);
  assert.match(publisher, /uploadMapAsset\(join\(buildDir, "masterplan_preview\.webp"\), "preview"\)/);
  assert.match(publisher, /preview_url: previewUrl/);
  assert.match(publisher, /insert\(versionRow\)/);
  assert.doesNotMatch(publisher, /for \(const \[local, suffix, mime\]/);
  const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(gitignore, /tenants\/\*\/source\//);
  assert.match(gitignore, /tenants\/\*\/evidence\//);
  assert.match(gitignore, /tenants\/\*\/build\//);
});
