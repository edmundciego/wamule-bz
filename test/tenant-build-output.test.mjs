import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareBuildOutput } from "../scripts/tenant-build-output.mjs";

function tempTenant() {
  const root = mkdtempSync(join(tmpdir(), "tenant-build-history-"));
  const tenantDir = join(root, "tenants", "alpha");
  mkdirSync(tenantDir, { recursive: true });
  return { root, tenantDir, buildDir: join(tenantDir, "build") };
}

test("repeat builds archive prior output intact and leave a clean stable build directory", () => {
  const { root, tenantDir, buildDir } = tempTenant();
  try {
    mkdirSync(buildDir);
    writeFileSync(join(buildDir, "build-manifest.json"), "old manifest\n");
    writeFileSync(join(buildDir, "build-failure.json"), "old failure\n");
    const allowedRoot = root;
    const first = prepareBuildOutput(tenantDir, null, allowedRoot);
    assert.equal(first.outDir, buildDir);
    assert.ok(first.archivedPath);
    assert.equal(readFileSync(join(first.archivedPath, "build-manifest.json"), "utf8"), "old manifest\n");
    assert.equal(readFileSync(join(first.archivedPath, "build-failure.json"), "utf8"), "old failure\n");
    assert.deepEqual(readdirSync(buildDir), []);

    writeFileSync(join(buildDir, "lots.json"), "new build\n");
    const second = prepareBuildOutput(tenantDir, null, allowedRoot);
    assert.notEqual(second.archivedPath, first.archivedPath);
    assert.equal(readFileSync(join(first.archivedPath, "build-manifest.json"), "utf8"), "old manifest\n");
    assert.equal(readFileSync(join(second.archivedPath, "lots.json"), "utf8"), "new build\n");
    assert.deepEqual(readdirSync(buildDir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty initial build stays in place and source files inside build are refused", () => {
  const { root, tenantDir, buildDir } = tempTenant();
  try {
    mkdirSync(buildDir);
    const allowedRoot = root;
    const first = prepareBuildOutput(tenantDir, null, allowedRoot);
    assert.equal(first.archivedPath, null);
    const source = join(buildDir, "masterplan.webp");
    writeFileSync(source, "source");
    assert.throws(() => prepareBuildOutput(tenantDir, source, allowedRoot), /source must not be read/);
    assert.equal(readFileSync(source, "utf8"), "source");
    const sourceAlias = join(tenantDir, "source-link.webp");
    symlinkSync(source, sourceAlias, "file");
    assert.throws(() => prepareBuildOutput(tenantDir, sourceAlias, allowedRoot), /source resolves into/);
    assert.equal(readFileSync(source, "utf8"), "source");
    assert.equal(existsSync(join(tenantDir, "build-history")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("symlinked build paths are rejected without touching their targets", () => {
  const { root, tenantDir, buildDir } = tempTenant();
  const target = join(root, "outside-build");
  try {
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "preserve");
    symlinkSync(target, buildDir, "dir");
    assert.throws(() => prepareBuildOutput(tenantDir, null, root), /symlink/);
    assert.equal(readFileSync(join(target, "keep.txt"), "utf8"), "preserve");
    assert.equal(existsSync(join(target, "build-manifest.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("symlinked build-history path cannot redirect archival outside the package", () => {
  const { root, tenantDir, buildDir } = tempTenant();
  const target = join(root, "outside-history");
  try {
    mkdirSync(buildDir);
    writeFileSync(join(buildDir, "evidence.json"), "keep");
    mkdirSync(target);
    symlinkSync(target, join(tenantDir, "build-history"), "dir");
    assert.throws(() => prepareBuildOutput(tenantDir, null, root), /build-history.*symlink/);
    assert.equal(readFileSync(join(buildDir, "evidence.json"), "utf8"), "keep");
    assert.deepEqual(readdirSync(target), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
