#!/usr/bin/env python3
"""Plan and apply the reviewed homepage database upgrade on Wamule staging."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "node_modules/.bin/supabase"
PROJECT_REF = "kvocwmrcuhiaezlcgzjf"
RELEASE_SHA = "fc7872decf962c5b643e8ec5ec0510acd0310b9f"
BASELINE = ROOT / "evidence/admin-launch-controls-staging-inventory-73-reconciled.json"
RELEASE_MIGRATIONS = {
    "20261115052849": "project_application_admin_settings",
    "20261118170926": "reconcile_project_homepage_settings",
    "20261118170937": "restore_tenant_storage_and_inventory_contracts",
}
OPTIONAL_HISTORY = {
    "20261017090000": "public_site_ui_restriction_flag",
    "20261105000100": "harden_sensitive_view_access",
    "20261112040000": "postgrest_json_jwt_role_claims",
}
HOMEPAGE_MIGRATION = "20261118170926"
GET_SIGNATURE = ("get_project_site_experience", "uuid, uuid", 0, "jsonb")
SAVE_RPC = "save_project_site_experience"
FINAL_SIGNATURES = {
    GET_SIGNATURE,
    (SAVE_RPC, "uuid, uuid, text, jsonb, boolean, text", 2, "jsonb"),
}
LEGACY_SIGNATURES = {
    GET_SIGNATURE,
    (SAVE_RPC, "uuid, uuid, text, jsonb", 0, "jsonb"),
    (SAVE_RPC, "uuid, uuid, text, jsonb, boolean", 0, "jsonb"),
    (SAVE_RPC, "uuid, uuid, text, jsonb, boolean", 1, "jsonb"),
}

INVENTORY_SQL = """
select
  (select coalesce(jsonb_agg(to_jsonb(m) order by m.version), '[]'::jsonb)
   from (select version, name from supabase_migrations.schema_migrations) m) as migration_ledger,
  (select coalesce(jsonb_agg(to_jsonb(f) order by f.proname, f.types), '[]'::jsonb)
   from (
     select p.proname, oidvectortypes(p.proargtypes) as types, p.pronargdefaults as defaults,
            pg_get_function_arguments(p.oid) as arguments, pg_get_function_result(p.oid) as returns
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('get_project_site_experience', 'save_project_site_experience')
   ) f) as homepage_rpc_signatures;
"""


def normalize_name(version: str, name: str) -> str:
    return name.removesuffix(".sql").removeprefix(f"{version}_")


def migration_plan(inventory: dict) -> dict[str, str]:
    baseline = json.loads(BASELINE.read_text())
    required = {row["version"]: normalize_name(row["version"], row["name"]) for row in baseline["files"]}
    known = required | OPTIONAL_HISTORY | RELEASE_MIGRATIONS
    ledger = inventory["migration_ledger"]
    applied = set()
    for row in ledger:
        version, name = row["version"], row["name"]
        if version in applied or not isinstance(name, str) or normalize_name(version, name) != known.get(version):
            raise ValueError(f"Unexpected migration entry {version} {name!r}. Review the recorded live ledger.")
        applied.add(version)

    missing_baseline = required.keys() - applied
    if missing_baseline:
        raise ValueError(f"Live staging is missing historical migrations: {', '.join(sorted(missing_baseline))}.")

    signatures = {
        (row["proname"], row["types"], row["defaults"], row["returns"])
        for row in inventory["homepage_rpc_signatures"]
    }
    if HOMEPAGE_MIGRATION in applied:
        valid_signatures = signatures == FINAL_SIGNATURES
    else:
        valid_signatures = signatures <= LEGACY_SIGNATURES
    if not valid_signatures:
        raise ValueError("Unexpected homepage RPC signatures. Review the recorded live inventory.")

    return {version: name for version, name in RELEASE_MIGRATIONS.items() if version not in applied}


def stage_migrations(migration_dir: Path, ledger: list[dict], pending: dict[str, str]) -> list[str]:
    for row in ledger:
        version = row["version"]
        name = normalize_name(version, row["name"])
        # The CLI matches applied files by version. Abort if the ledger changes
        # and this file is ever selected for execution.
        (migration_dir / f"{version}_{name}.sql").write_text(
            f"DO $$ BEGIN RAISE EXCEPTION 'Applied staging migration {version} is missing from the ledger'; END $$;\n"
        )

    filenames = []
    for version, name in pending.items():
        filename = f"{version}_{name}.sql"
        sql = subprocess.check_output(
            ["git", "show", f"{RELEASE_SHA}:supabase/migrations/{filename}"], cwd=ROOT
        )
        (migration_dir / filename).write_bytes(sql)
        filenames.append(filename)
    return filenames


def read_inventory(cli: list[str], target: list[str]) -> dict:
    output = subprocess.check_output(
        cli + ["db", "query", *target, "--output", "json", INVENTORY_SQL], text=True
    )
    (inventory,) = json.loads(output)["rows"]
    return inventory


def record_inventory(path: Path, inventory: dict) -> None:
    evidence = {"project_ref": PROJECT_REF, "release_sha": RELEASE_SHA, **inventory}
    path.write_text(json.dumps(evidence, indent=2) + "\n")


def run_push(cli: list[str], target: list[str], log: Path, *, dry_run: bool) -> str:
    args = [*cli, "db", "push", *target, "--yes"]
    if dry_run:
        args.append("--dry-run")
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    log.write_text(result.stdout)
    if result.returncode:
        raise ValueError(f"Supabase CLI exited with {result.returncode}. See {log}.")
    return result.stdout


def check_dry_run(output: str, filenames: list[str]) -> None:
    listed = list(dict.fromkeys(re.findall(r"\b[0-9]{14}_[A-Za-z0-9_]+\.sql\b", output)))
    if listed != filenames or (not filenames and "Remote database is up to date." not in output):
        raise ValueError("The CLI dry run differs from the reviewed migration plan.")


def release(record_dir: Path, apply: bool) -> None:
    if not CLI.is_file():
        raise ValueError("Run npm ci to install the repository's Supabase CLI.")
    record_dir.mkdir(mode=0o700, parents=True)
    with tempfile.TemporaryDirectory(prefix="wamule-staging-db-") as directory:
        workdir = Path(directory)
        migration_dir = workdir / "supabase/migrations"
        migration_dir.mkdir(parents=True)
        (workdir / "supabase/config.toml").write_text(f'project_id = "{PROJECT_REF}"\n[db]\nmajor_version = 17\n')
        cli = [str(CLI), "--workdir", directory]
        target = ["--linked"]
        subprocess.run(cli + ["link", "--project-ref", PROJECT_REF], check=True)
        if (workdir / "supabase/.temp/project-ref").read_text().strip() != PROJECT_REF:
            raise ValueError("The working directory did not link to Wamule staging.")

        before = read_inventory(cli, target)
        record_inventory(record_dir / "live-ledger-before.json", before)
        pending = migration_plan(before)
        filenames = stage_migrations(migration_dir, before["migration_ledger"], pending)
        dry_run = run_push(cli, target, record_dir / "cli-dry-run.log", dry_run=True)
        check_dry_run(dry_run, filenames)
        print(dry_run, end="")

        if apply and filenames:
            if read_inventory(cli, target) != before:
                raise ValueError("The staging database changed during the dry run. Re-run with a new record directory.")
            run_push(cli, target, record_dir / "cli-apply.log", dry_run=False)
            after = read_inventory(cli, target)
            record_inventory(record_dir / "live-ledger-after.json", after)
            if migration_plan(after):
                raise ValueError("Staging still has pending release migrations.")

    print(f"Database release record saved in {record_dir.resolve()}.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record-dir", type=Path, required=True, help="New directory for database evidence and CLI logs.")
    parser.add_argument("--apply", action="store_true", help="Apply the reviewed plan after a matching CLI dry run.")
    args = parser.parse_args()
    try:
        release(args.record_dir, args.apply)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
