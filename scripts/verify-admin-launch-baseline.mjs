#!/usr/bin/env node
/** Verify the exact 73-migration local replay, separate M1.5 placement, and Map Studio publish scope. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const replayDir = resolve(process.env.REPLAY_DIR ?? "");
const databaseUrl = process.env.SCHEMA_QUERY_DATABASE_URL ?? "";
const EXCLUDED_VERSION = "20261112040000";
const M1_5_NAME = "20261105000100_harden_sensitive_view_access.sql";
const M1_5_SHA256 = "d16b6fba02cb210e9e628f5cf11c555f74db7e18fbe6afe663150158cb72d631";

function fail(message) {
  throw new Error(message);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function query(sql) {
  const result = spawnSync("psql", [databaseUrl, "-X", "-q", "-t", "-A", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PGPASSWORD: undefined },
  });
  if (result.error || result.status !== 0) fail(`Local PostgreSQL verification failed: ${result.stderr || result.error?.message || "unknown error"}`);
  return result.stdout.trim();
}

async function main() {
  if (!process.env.REPLAY_DIR || !databaseUrl) fail("REPLAY_DIR and SCHEMA_QUERY_DATABASE_URL are required.");
  const target = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1", "::1"].includes(target.hostname)) fail("Refusing a non-local PostgreSQL target.");

  const applied = JSON.parse(await readFile(resolve(replayDir, "applied-migrations.json"), "utf8"));
  const numbered = JSON.parse(await readFile(resolve(replayDir, "numbered-migrations.json"), "utf8"));
  const inventory = JSON.parse(await readFile(resolve(replayDir, "staging-inventory.json"), "utf8"));
  const versions = applied.applied_migrations?.map((row) => String(row.version)) ?? [];
  const appliedRows = applied.applied_migrations?.map((row) => ({
    version: String(row.version),
    name: String(row.filename).split("_").slice(1).join("_"),
    sha256: row.sha256,
  })) ?? [];
  if (applied.applied_migration_count !== 73 || applied.inventory_entry_count !== 73
      || applied.ordered_manifest_match !== true || numbered.numbered_migration_count !== 73
      || numbered.inventory_entry_count !== 73 || numbered.ordered_manifest_match !== true
      || JSON.stringify(appliedRows) !== JSON.stringify(inventory.files)
      || JSON.stringify(numbered.migrations) !== JSON.stringify(applied.applied_migrations)
      || versions.includes(EXCLUDED_VERSION)) {
    fail("Local applied ledger does not exactly match all 73 ordered inventory versions, filenames, and hashes.");
  }
  const m1_5 = applied.m1_5_view_security_overlay;
  if (m1_5?.name !== M1_5_NAME || m1_5.sha256 !== M1_5_SHA256 || m1_5.applied !== true
      || m1_5.included_in_numbered_ledger !== false || m1_5.apply_after_version !== "20261112033403"
      || numbered.separately_applied_overlay?.name !== M1_5_NAME
      || numbered.separately_applied_overlay?.sha256 !== M1_5_SHA256
      || numbered.separately_applied_overlay?.included_in_numbered_ledger !== false) {
    fail("M1.5 was not separately applied at the inventory-recorded position and hash.");
  }

  const mapObjects = query(`SELECT
    to_regclass('public.project_map_packages') IS NOT NULL,
    to_regclass('public.project_plot_content') IS NOT NULL,
    to_regprocedure('public.publish_project_map_package(uuid,uuid,boolean)') IS NOT NULL;`);
  if (mapObjects !== "t|t|t") fail(`Map Studio publish objects are missing from the local replay: ${mapObjects}`);
  const m1_5State = query(`SELECT
    (SELECT coalesce(array_to_string(c.reloptions, ','), '') LIKE '%security_invoker=true%' FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='analytics_snapshot'),
    (SELECT coalesce(array_to_string(c.reloptions, ','), '') LIKE '%security_invoker=true%' FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='community_fee_account_status'),
    (SELECT coalesce(array_to_string(c.reloptions, ','), '') LIKE '%security_invoker=true%' FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='contract_balances'),
    has_table_privilege('anon', 'public.analytics_snapshot', 'SELECT'),
    has_table_privilege('anon', 'public.community_fee_account_status', 'SELECT'),
    has_table_privilege('authenticated', 'public.analytics_snapshot', 'SELECT');`);
  if (m1_5State !== "t|t|t|f|f|t") fail(`M1.5 view security and grants did not persist through replay: ${m1_5State}`);

  const report = {
    target: "disposable-local-supabase-postgresql-17",
    hosted_target_used: false,
    schema_baseline_commit: process.env.WAMULE_SCHEMA_BASE_COMMIT ?? null,
    tested_commit: process.env.GITHUB_SHA ?? null,
    migration_inventory_count: 73,
    ordered_version_filename_sha256_match: true,
    excluded_compatibility_migration: EXCLUDED_VERSION,
    m1_5: { name: m1_5.name, sha256: m1_5.sha256, apply_after_version: m1_5.apply_after_version, separate_overlay_applied: true },
    map_studio: { package_table: true, plot_content_table: true, publish_project_map_package_rpc: true },
    m1_5_security: { security_invoker_views: 3, anon_select_denied: 2, authenticated_select_preserved: true },
  };
  await writeFile(resolve(replayDir, "admin-launch-baseline.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`[admin-launch-baseline] FAIL: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
