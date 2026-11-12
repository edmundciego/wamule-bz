#!/usr/bin/env python3
"""Replay the captured staging migration ledger in disposable embedded PostgreSQL.

This local-only rehearsal never connects to Supabase, never uses Docker, and
does not modify the current migration directory or migration history.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
DEPLOYED_COMMIT = "968e74449135006d1962e9f5352339270a7dbf76"
PROJECT_REF = "kvocwmrcuhiaezlcgzjf"
SNAPSHOT_PATH = ROOT / "evidence" / "M2.2-staging-schema-history-2026-11-05.json"
LEDGER_BODY_PATH = ROOT / "evidence" / "M2.4-applied-ledger-body-20261016070858.json"
COMPARISON_PATH = ROOT / "evidence" / "M2.4-staging-migration-comparison-2026-11-05.json"
BASELINE_PATH = ROOT / "wamuale_supabase_foundation_migration.sql"
PROBE_PATH = ROOT / "scripts" / "probe-migration-bootstrap.py"
M1_PATCH_PATH = ROOT / "supabase" / "staging-migrations" / "20261105000100_harden_sensitive_view_access.sql"
EXPECTED_BASELINE_SHA256 = "5671fe8bfb5e0fcd6318f92dc0147367ffb543234d7d8cc6d2bc0f8eaa3d265a"

VAULT_EXTENSION = re.compile(
    r"(?im)^[ \t]*CREATE[ \t]+EXTENSION(?:[ \t]+IF[ \t]+NOT[ \t]+EXISTS)?"
    r"[ \t]+supabase_vault\b[^;]*;[ \t]*$"
)

VIEW_CONTRACT = {
    "analytics_snapshot": (False, True, True),
    "community_fee_account_status": (False, True, True),
    "contract_balances": (False, True, True),
    "contract_financial_summary": (True, True, True),
    "customer_balance_view": (True, True, True),
    "parcel_board_view": (True, False, True),
    "public_parcel_options": (True, False, True),
}

PROPOSED_VIEW_CONTRACT = {
    name: (True, False, True)
    for name in (
        "analytics_snapshot",
        "community_fee_account_status",
        "contract_balances",
        "contract_financial_summary",
        "customer_balance_view",
        "parcel_board_view",
        "public_parcel_options",
    )
}


def normalized(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def source_name(path: str) -> str:
    return Path(path).stem.split("_", 1)[1]


def migration_paths() -> dict[str, str]:
    paths = subprocess.check_output(
        ["git", "ls-tree", "-r", "--name-only", DEPLOYED_COMMIT, "--", "supabase/migrations"],
        cwd=ROOT,
        text=True,
    ).splitlines()
    result: dict[str, str] = {}
    for path in paths:
        name = source_name(path)
        if name in result:
            raise RuntimeError(f"More than one deployed migration source has name {name}")
        result[name] = path
    return result


def staging_file(path: str) -> str:
    return subprocess.check_output(
        ["git", "show", f"{DEPLOYED_COMMIT}:{path}"],
        cwd=ROOT,
        text=True,
    )


def create_replay_migrations(directory: Path) -> tuple[list[dict[str, str]], dict[str, Any]]:
    inventory = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))["inventory"]
    ledger = inventory["migrations"]
    applied_body = json.loads(LEDGER_BODY_PATH.read_text(encoding="utf-8"))
    comparison = json.loads(COMPARISON_PATH.read_text(encoding="utf-8"))

    joined = "\n".join(applied_body["statements"])
    if len(applied_body["statements"]) != applied_body["statement_count"]:
        raise RuntimeError("Captured AI migration statement count no longer matches the staging ledger")
    if len(joined) != 1566:
        raise RuntimeError("Captured AI migration body length no longer matches the staging ledger")
    if hashlib.md5(joined.encode("utf-8")).hexdigest() != "1698eba6efa573b0d5826116eaa3b22d":
        raise RuntimeError("Captured AI migration body digest no longer matches the staging ledger")

    body_rows = {row["migration_name"]: row for row in comparison["rows"]}
    sources = migration_paths()
    created: list[dict[str, str]] = []
    for row in ledger:
        version, name = row["version"], row["name"]
        if name not in sources or name not in body_rows:
            raise RuntimeError(f"No explicit deployed source mapping recorded for {version} {name}")
        mapping = body_rows[name]
        if mapping["migration_version"] != version or mapping["source_location"] != sources[name]:
            raise RuntimeError(f"Migration mapping changed for {version} {name}; review M2.4 evidence")
        if not mapping["body_equivalent"] and name != applied_body["name"]:
            raise RuntimeError(f"Unresolved source/body difference for {version} {name}")

        if name == applied_body["name"]:
            # Supabase runs each migration in a transaction. The captured
            # ledger array omits outer semicolon delimiters and transaction
            # wrappers, so add those wrappers only in this disposable replay.
            sql = "BEGIN;\n" + ";\n".join(applied_body["statements"]) + ";\nCOMMIT;\n"
        else:
            sql = staging_file(sources[name])

        target = directory / f"{version}_{name}.sql"
        target.write_text(sql, encoding="utf-8")
        created.append({"version": version, "name": name, "source": sources[name]})

    if len(created) != 55:
        raise RuntimeError(f"Expected 55 applied migration files, found {len(created)}")
    return created, inventory


def compare_public_catalog(
    conn: Any,
    inventory: dict[str, Any],
    expected_view_contract: dict[str, tuple[bool, bool, bool]],
    label: str,
) -> bool:
    expected_tables = {
        item["name"].split(".", 1)[1]: item
        for item in inventory["tables"]
        if item["name"].startswith("public.")
    }
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT c.relname, c.relrowsecurity
            FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind IN ('r','p','m','f')
            ORDER BY c.relname
            """
        )
        actual_tables = {name: rls for name, rls in cur.fetchall()}

        cur.execute(
            """
            SELECT table_name, column_name, data_type, udt_name, is_nullable,
                   column_default, is_generated, generation_expression
            FROM information_schema.columns
            WHERE table_schema='public'
            ORDER BY table_name, ordinal_position
            """
        )
        actual_columns: dict[str, dict[str, tuple[Any, ...]]] = {}
        for table, column, data_type, udt_name, nullable, default, generated, expression in cur.fetchall():
            actual_columns.setdefault(table, {})[column] = (
                data_type, udt_name, nullable == "YES", default, generated, expression
            )

        cur.execute(
            """
            SELECT c.relname, con.conname, con.contype, pg_get_constraintdef(con.oid)
            FROM pg_constraint con
            JOIN pg_class c ON c.oid=con.conrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public'
            ORDER BY c.relname, con.conname
            """
        )
        actual_constraint_rows = cur.fetchall()
        actual_constraint_keys = {
            (table, name, kind) for table, name, kind, _ in actual_constraint_rows
        }

        cur.execute(
            """
            SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
            FROM pg_policies WHERE schemaname='public'
            ORDER BY tablename, policyname
            """
        )
        actual_policies = {
            (
                table, name, permissive, tuple(sorted(roles)), command,
                normalized(qual), normalized(check),
            )
            for table, name, permissive, roles, command, qual, check in cur.fetchall()
        }

        cur.execute(
            """
            SELECT c.relname, pg_get_userbyid(c.relowner), c.reloptions,
                   has_table_privilege('anon', c.oid, 'SELECT'),
                   has_table_privilege('authenticated', c.oid, 'SELECT')
            FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='v'
            ORDER BY c.relname
            """
        )
        actual_views = {
            name: (
                owner == "postgres",
                bool(options and "security_invoker=true" in options),
                anon_select,
                authenticated_select,
            )
            for name, owner, options, anon_select, authenticated_select in cur.fetchall()
        }

    missing_tables = set(expected_tables) - set(actual_tables)
    extra_tables = set(actual_tables) - set(expected_tables)
    rls_mismatches = {
        name for name in set(expected_tables) & set(actual_tables)
        if expected_tables[name]["rls_enabled"] != actual_tables[name]
    }

    column_mismatches: list[str] = []
    for table, expected_table in expected_tables.items():
        expected_columns = {column["name"]: column for column in expected_table["columns"]}
        actual = actual_columns.get(table, {})
        if set(expected_columns) != set(actual):
            column_mismatches.append(f"{table}:column-set")
        for name in set(expected_columns) & set(actual):
            expected = expected_columns[name]
            got = actual[name]
            generated = "generated" in expected.get("options", [])
            expected_expression = normalized(expected.get("default_value"))
            actual_expression = normalized(got[5] if generated else got[3])
            if (
                expected["data_type"] != got[0]
                or expected["format"] != got[1]
                or ("nullable" in expected.get("options", [])) != got[2]
                or expected_expression != actual_expression
            ):
                column_mismatches.append(f"{table}.{name}")

    expected_constraint_keys = {
        (row["table"], row["name"], row["type"])
        for row in inventory["constraints"] if row["schema"] == "public"
    }
    expected_policies = {
        (
            row["table"], row["policy"], row["permissive"], tuple(sorted(row["roles"])),
            row["command"], normalized(row.get("using")), normalized(row.get("check")),
        )
        for row in inventory["policies"] if row["schema"] == "public"
    }
    policy_missing = expected_policies - actual_policies
    policy_extra = actual_policies - expected_policies

    definition_rendering_diffs = 0
    expected_definitions = {
        (row["table"], row["name"], row["type"], normalized(row["definition"]))
        for row in inventory["constraints"] if row["schema"] == "public"
    }
    actual_definitions = {
        (table, name, kind, normalized(definition))
        for table, name, kind, definition in actual_constraint_rows
    }
    definition_rendering_diffs = len(expected_definitions - actual_definitions)

    expected_views = {
        name: (True, invoker, anon, authenticated)
        for name, (invoker, anon, authenticated) in expected_view_contract.items()
    }
    view_missing = set(expected_views) - set(actual_views)
    view_extra = set(actual_views) - set(expected_views)
    view_mismatches = {
        name for name in set(expected_views) & set(actual_views)
        if expected_views[name] != actual_views[name]
    }

    print(f"{label} public catalog comparison (Auth/Storage managed objects excluded):")
    print(
        f"  public tables: expected={len(expected_tables)} actual={len(actual_tables)} "
        f"missing={len(missing_tables)} extra={len(extra_tables)}"
    )
    print(
        f"  columns/type/default/generated: mismatches={len(column_mismatches)}; "
        f"RLS mismatches={len(rls_mismatches)}"
    )
    print(
        f"  public constraints: expected={len(expected_constraint_keys)} "
        f"actual={len(actual_constraint_keys)} key-missing="
        f"{len(expected_constraint_keys-actual_constraint_keys)} key-extra="
        f"{len(actual_constraint_keys-expected_constraint_keys)}; raw PG definition "
        f"rendering differences={definition_rendering_diffs}"
    )
    print(
        f"  public policies: expected={len(expected_policies)} actual={len(actual_policies)} "
        f"missing={len(policy_missing)} extra={len(policy_extra)}"
    )
    print(
        f"  M1.1 views: expected={len(expected_views)} actual={len(actual_views)} "
        f"missing={len(view_missing)} extra={len(view_extra)} contract mismatches="
        f"{len(view_mismatches)}"
    )
    for name in sorted(view_mismatches):
        print(f"  view contract mismatch {name}: expected={expected_views[name]} actual={actual_views[name]}")
    if column_mismatches:
        print("  column mismatches: " + ", ".join(column_mismatches))

    return not (
        missing_tables or extra_tables or rls_mismatches or column_mismatches
        or expected_constraint_keys != actual_constraint_keys
        or policy_missing or policy_extra or view_missing or view_extra or view_mismatches
    )


def main() -> int:
    for required in (SNAPSHOT_PATH, LEDGER_BODY_PATH, COMPARISON_PATH, BASELINE_PATH, PROBE_PATH, M1_PATCH_PATH):
        if not required.is_file():
            print(f"error: required local input is missing: {required}", file=sys.stderr)
            return 2
    baseline_hash = hashlib.sha256(BASELINE_PATH.read_bytes()).hexdigest()
    if baseline_hash != EXPECTED_BASELINE_SHA256:
        print("error: local foundation candidate hash changed; review it before replay", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory(prefix="wamule-staging-ledger-replay-") as temp:
        migration_dir = Path(temp) / "supabase" / "migrations"
        migration_dir.mkdir(parents=True)
        created, inventory = create_replay_migrations(migration_dir)
        print(f"Target: staging project {PROJECT_REF}; deployed source {DEPLOYED_COMMIT}")
        print(f"Applied staging ledger migrations prepared: {len(created)}; unapplied UI migration excluded.")
        print(f"Local foundation candidate SHA-256: {baseline_hash}")

        spec = importlib.util.spec_from_file_location("wamule_migration_probe", PROBE_PATH)
        if spec is None or spec.loader is None:
            print("error: unable to load the existing disposable migration probe", file=sys.stderr)
            return 2
        probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(probe)
        probe.ROOT = ROOT
        probe.MIGRATIONS = migration_dir
        probe.FOUNDATION_CANDIDATES["root"] = BASELINE_PATH

        original_install = probe.install_platform_stubs

        def install_local_platform_stubs(conn: Any) -> None:
            original_install(conn)
            with conn.cursor() as cur:
                cur.execute("CREATE SCHEMA vault")
                cur.execute(
                    "CREATE TABLE vault.decrypted_secrets "
                    "(id uuid PRIMARY KEY, decrypted_secret text)"
                )
                cur.execute(
                    "CREATE FUNCTION vault.create_secret(secret_value text, secret_name text, "
                    "description text) RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$"
                )
                # Reproduce the staging project's captured Supabase default ACL
                # for postgres-created public objects. The 2026-11-06 read-only
                # staging query showed defaults for relations, sequences, and
                # functions to anon/authenticated/service_role.
                for statement in (
                    "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public "
                    "GRANT ALL ON TABLES TO anon, authenticated, service_role",
                    "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public "
                    "GRANT ALL ON SEQUENCES TO anon, authenticated, service_role",
                    "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public "
                    "GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role",
                ):
                    cur.execute(statement)

        original_execute = probe.execute_repository_sql
        vault_stub_used = False

        def execute_with_managed_service_stubs(cur: Any, sql: str) -> bool:
            nonlocal vault_stub_used
            if "The published Hopkins tenant/project/phase scope is missing or ambiguous." in sql:
                cur.execute(
                    """
                    DO $fixture$
                    DECLARE tenant uuid; project uuid;
                    BEGIN
                      INSERT INTO public.organizations(name,slug,is_active)
                      VALUES ('M2.4 isolated replay fixture','hopkins-grove',true)
                      ON CONFLICT (slug) DO NOTHING;
                      SELECT id INTO tenant FROM public.organizations
                        WHERE slug='hopkins-grove' AND is_active;
                      IF NOT EXISTS (
                        SELECT 1 FROM public.projects
                        WHERE tenant_id=tenant AND slug='hopkins-grove'
                      ) THEN
                        INSERT INTO public.projects
                          (tenant_id,slug,name,is_default,map_experience_mode)
                        VALUES (tenant,'hopkins-grove','M2.4 isolated replay fixture',false,'sales');
                      END IF;
                      SELECT id INTO project FROM public.projects
                        WHERE tenant_id=tenant AND slug='hopkins-grove';
                      IF NOT EXISTS (
                        SELECT 1 FROM public.development_phases
                        WHERE tenant_id=tenant AND project_id=project AND slug='initial'
                      ) THEN
                        INSERT INTO public.development_phases
                          (tenant_id,project_id,slug,name,is_default,is_active)
                        VALUES (tenant,project,'initial','Initial',false,true);
                      END IF;
                    END;
                    $fixture$;
                    """
                )
                print("Local-only Hopkins scope fixture added; no users, customer rows, map features, or revisions.")
            sanitized, count = VAULT_EXTENSION.subn(
                "-- Local replay shim: Supabase Vault install omitted.", sql
            )
            if count:
                vault_stub_used = True
            return original_execute(cur, sanitized)

        original_report = probe.report_candidate_markers
        catalog_ok = False
        baseline_catalog_ok = False
        proposed_catalog_ok = False

        def report_and_compare(conn: Any) -> None:
            nonlocal catalog_ok, baseline_catalog_ok, proposed_catalog_ok
            original_report(conn)
            baseline_catalog_ok = compare_public_catalog(
                conn, inventory, VIEW_CONTRACT, "Captured staging baseline"
            )
            if not baseline_catalog_ok:
                return
            with conn.cursor() as cur:
                execute_with_managed_service_stubs(
                    cur, M1_PATCH_PATH.read_text(encoding="utf-8")
                )
            print("Applied M1.2 patch to the disposable replay only; hosted staging is unchanged.")
            proposed_catalog_ok = compare_public_catalog(
                conn, inventory, PROPOSED_VIEW_CONTRACT, "Proposed post-M1.2 staging state"
            )
            catalog_ok = baseline_catalog_ok and proposed_catalog_ok

        probe.install_platform_stubs = install_local_platform_stubs
        probe.execute_repository_sql = execute_with_managed_service_stubs
        probe.report_candidate_markers = report_and_compare
        sys.argv = [str(PROBE_PATH), "--baseline", "root"]
        result = probe.main()
        print(
            "Managed service limits: embedded PostgreSQL 16.2 vs staging 17.6.1; "
            f"pgcrypto install skipped by the probe; Supabase Vault shim used={vault_stub_used}; "
            "Auth/Storage are minimal compatibility stubs; captured staging default ACLs are "
            "reproduced for local public relations."
        )
        if result != 0:
            return result
        if not catalog_ok:
            print("error: local catalog comparison did not pass", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
