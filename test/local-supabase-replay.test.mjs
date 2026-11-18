import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

test("replay preparation matches every 73 staging migration version, filename, and SHA-256 in order", () => {
  const directory = mkdtempSync(join(tmpdir(), "wamule-staging-replay-"));
  const output = join(directory, "replay");
  try {
    execFileSync("python3", ["scripts/prepare-local-supabase-replay.py", "--out", output], {
      cwd: root,
      stdio: "pipe",
    });
    const manifest = JSON.parse(readFileSync(join(output, "replay-manifest.json"), "utf8"));
    const inventory = JSON.parse(readFileSync(join(output, "staging-inventory.json"), "utf8"));
    assert.equal(manifest.numbered_migration_count, 73);
    assert.equal(manifest.inventory_entry_count, 73);
    assert.equal(manifest.staging_inventory.ordered_version_filename_sha256_match, true);
    assert.equal(manifest.staging_inventory.broad_compatibility_migration_excluded, "20261112040000");
    assert.equal(inventory.files.length, 73);
    assert.deepEqual(manifest.migrations.map((row) => ({
      version: row.version,
      name: row.path.split("/").at(-1).split("_").slice(1).join("_"),
      sha256: row.sha256,
    })), inventory.files);
    for (const filename of [
      "20261016065252_modular_public_site_experience.sql",
      "20261016185842_public_template_default_independent_of_scope.sql",
    ]) {
      const path = join("supabase", "migrations", filename);
      assert.equal(existsSync(join(root, path)), false, `${filename} must stay out of forward migrations`);
      assert.equal(existsSync(join(output, path)), true, `${filename} must stay in the historical replay`);
    }
    assert.equal(manifest.migrations.some((row) => row.version === "20261112040000"), false);
    assert.deepEqual(manifest.foundation_schema_bootstrap, {
      path: "supabase/foundation.sql",
      sha256: "5671fe8bfb5e0fcd6318f92dc0147367ffb543234d7d8cc6d2bc0f8eaa3d265a",
      included_in_migration_count: false,
    });
    assert.equal(readFileSync(join(output, "supabase/foundation.sql"), "utf8").length, 49693);
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
    assert.deepEqual(manifest.m1_5_separate_overlay, {
      path: "supabase/local-overlays/20261105000100_harden_sensitive_view_access.sql",
      sha256: "d16b6fba02cb210e9e628f5cf11c555f74db7e18fbe6afe663150158cb72d631",
      apply_after_version: "20261112033403",
      included_in_numbered_ledger: false,
    });
    assert.deepEqual(manifest.local_data_preconditions.map(({ before_migration, sha256, included_in_migration_count }) => ({ before_migration, sha256, included_in_migration_count })), [
      { before_migration: "20261016054341", sha256: "7d44c34ccfa421e0b23a4ddce5b16448fb6366103a7c11834d694c7967fcc3bc", included_in_migration_count: false },
    ]);
    const fixture = readFileSync(join(output, "supabase/replay-fixtures/hopkins-workflow-precondition.sql"), "utf8");
    assert.match(fixture, /Hopkins Grove \(Local Replay Fixture\)/);
    assert.match(fixture, /slug/);
    assert.equal(manifest.migrations.filter((row) => row.version === "20261016054341").length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
