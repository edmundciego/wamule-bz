#!/usr/bin/env node
/** Build an isolated production CLI workdir containing migrations up to a cutoff. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const sourceDir = path.join(root, "supabase/migrations");
const configSource = path.join(root, "artifacts/hopkins-owner-pilot-release-20261016/supabase.production.toml");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument ${key}.`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}.`);
    args[key.slice(2)] = value;
  }
  return args;
}

function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: node scripts/prepare-hopkins-production-migration-phase.mjs --through-version <14-digit-version> [--out <new-temp-directory>]");
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const cutoff = args["through-version"];
  if (!/^\d{14}$/.test(cutoff ?? "")) throw new Error("Pass --through-version as a 14-digit migration version.");
  if (!existsSync(configSource)) throw new Error("Production Supabase config is missing from the release package.");
  const output = args.out ? path.resolve(args.out) : mkdtempSync(path.join(os.tmpdir(), "wamule-hopkins-prod-migrations-"));
  if (args.out && existsSync(output)) throw new Error("The requested output directory already exists; refusing to overwrite it.");
  if (!existsSync(output)) mkdirSync(output, { recursive: true, mode: 0o700 });
  const migrationsTarget = path.join(output, "supabase/migrations");
  mkdirSync(migrationsTarget, { recursive: true, mode: 0o700 });
  cpSync(sourceDir, migrationsTarget, { recursive: true });
  const migrationFiles = readdirSync(migrationsTarget).filter((name) => name.endsWith(".sql"));
  const included = [];
  for (const name of migrationFiles) {
    const version = name.slice(0, 14);
    if (!/^\d{14}$/.test(version)) throw new Error(`Unexpected migration filename ${name}.`);
    if (version > cutoff) rmSync(path.join(migrationsTarget, name));
    else included.push({ version, name });
  }
  if (!included.some((migration) => migration.version === cutoff)) throw new Error(`No migration found for cutoff ${cutoff}.`);
  cpSync(configSource, path.join(output, "supabase/config.toml"));
  writeFileSync(path.join(output, "PREPARED-PRODUCTION-MIGRATION-PHASE.json"), `${JSON.stringify({
    target_project_ref: "mtjlvzrtihslcftxnlso", through_version: cutoff, included_migration_count: included.length,
    included, config: "supabase/config.toml", production_database_url_required_in_process_environment: true
  }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ prepared: true, path: output, target_project_ref: "mtjlvzrtihslcftxnlso",
    through_version: cutoff, included_migration_count: included.length, command: `cd "${output}" && supabase db push --db-url "$PRODUCTION_DATABASE_URL"` }, null, 2));
}

try { main(); } catch (error) {
  console.error(`[prepare-hopkins-production-migration-phase] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
