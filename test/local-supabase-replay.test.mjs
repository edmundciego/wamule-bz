import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

test("replay preparation matches all 69 captured staging migrations in order and aliases Map Studio once", () => {
  const directory = mkdtempSync(join(tmpdir(), "wamule-staging-replay-"));
  const output = join(directory, "replay");
  try {
    execFileSync("python3", ["scripts/prepare-local-supabase-replay.py", "--out", output], {
      cwd: root,
      stdio: "pipe",
    });
    const manifest = JSON.parse(readFileSync(join(output, "replay-manifest.json"), "utf8"));
    assert.equal(manifest.numbered_migration_count, 69);
    assert.equal(manifest.captured_ledger_comparison.ordered_version_name_match, true);
    assert.equal(manifest.captured_ledger_comparison.captured_entry_count, 69);
    assert.deepEqual(manifest.map_studio_alias, {
      applied_version: "20261019225217",
      source_version: "20261019194346",
      source_path: "supabase/migrations/20261019194346_map_studio_packages_and_project_plot_content.sql",
      sha256: "86766d43a0335a046e2224fdbb43c78f66ac02df91230f803b7959d56ec775f5",
      included_exactly_once: true,
    });
    assert.equal(manifest.migrations.filter((row) => row.version === "20261019225217").length, 1);
    assert.equal(manifest.migrations.some((row) => row.version === "20261019194346"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
