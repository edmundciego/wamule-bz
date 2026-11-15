#!/usr/bin/env node
/** Apply the candidate Admin project-application RPC migration to local PostgreSQL only. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const replayDir = resolve(process.env.REPLAY_DIR ?? "");
const databaseUrl = process.env.SCHEMA_QUERY_DATABASE_URL ?? "";
const migrationName = "20261115052849_project_application_admin_settings.sql";
const expectedSha256 = "270e4b856ac77e684b9f0bac290efcb5028fba344dde0d5367bd452eedf2d098";

function fail(message) {
  throw new Error(message);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function psql(args) {
  const result = spawnSync("psql", [databaseUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PGPASSWORD: undefined },
  });
  if (result.error) fail(`Local PostgreSQL command failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").split(/\r?\n/).filter(Boolean).slice(-18).join("\n");
    fail(`Local Admin overlay step failed (exit ${result.status}).\n${detail}`);
  }
  return result.stdout.trim();
}

async function main() {
  if (!databaseUrl || !process.env.REPLAY_DIR) fail("SCHEMA_QUERY_DATABASE_URL and REPLAY_DIR are required.");
  const database = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1", "::1"].includes(database.hostname)) fail("Refusing a non-local PostgreSQL target.");

  const appliedPath = resolve(replayDir, "applied-migrations.json");
  const applied = JSON.parse(await readFile(appliedPath, "utf8"));
  const inventory = JSON.parse(await readFile(resolve(replayDir, "staging-inventory.json"), "utf8"));
  const versions = applied.applied_migrations?.map((row) => String(row.version)) ?? [];
  if (applied.applied_migration_count !== 73 || applied.inventory_entry_count !== 73
      || applied.ordered_manifest_match !== true || versions.length !== 73
      || inventory.files?.length !== 73 || versions.includes("20261112040000")
      || applied.m1_5_view_security_overlay?.applied !== true
      || applied.m1_5_view_security_overlay?.included_in_numbered_ledger !== false) {
    fail("Admin overlay requires the exact 73-entry inventory, separate M1.5, and excluded broad compatibility migration.");
  }

  const migrationPath = resolve(ROOT, "supabase/migrations", migrationName);
  const migrationSha256 = digest(await readFile(migrationPath));
  if (migrationSha256 !== expectedSha256) fail(`Admin migration SHA-256 differs from the reviewed feature overlay: ${migrationSha256}`);
  psql(["-f", migrationPath]);

  const functions = psql(["-t", "-A", "-F", "|", "-c", `SELECT
    to_regprocedure('public.get_project_application_settings(uuid,uuid)') IS NOT NULL,
    to_regprocedure('public.save_project_application_settings(uuid,uuid,jsonb)') IS NOT NULL;`]);
  if (functions !== "t|t") fail(`Admin project-application RPCs are incomplete after overlay: ${functions}`);

  const report = {
    name: migrationName,
    sha256: migrationSha256,
    hosted_target_used: false,
    applied_after_inventory_count: 73,
    included_in_numbered_inventory: false,
    local_postgres_only: true,
    authorized_admin_rpc_signatures_verified: [
      "public.get_project_application_settings(uuid,uuid)",
      "public.save_project_application_settings(uuid,uuid,jsonb)",
    ],
  };
  await writeFile(resolve(replayDir, "project-application-admin-settings-overlay.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`[admin-project-application-overlay] FAIL: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
