#!/usr/bin/env python3
"""Disposable embedded-Postgres verification for project-scoped public maps.

No hosted project is contacted. The harness recreates only the old relevant
schema, applies the new migration, and checks its data/trigger/privilege rules.
"""
import argparse
import os
import pathlib
import shutil
import sys

import pgserver
import psycopg

ROOT = pathlib.Path(__file__).resolve().parent.parent
BOOTSTRAP = ROOT / "scripts" / "project-scope-db-bootstrap.sql"
MIGRATION = ROOT / "supabase" / "migrations" / "20261012020651_project_scoped_public_maps.sql"
TENANT = "11111111-1111-1111-1111-111111111111"
DEFAULT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
PHASE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
OTHER = "22222222-2222-2222-2222-222222222222"

results = []

def check(name, fn):
    try:
        fn()
        results.append((name, True, ""))
        print(f"ok - {name}")
    except Exception as exc:
        results.append((name, False, str(exc)[:900]))
        print(f"FAIL - {name}: {exc}")

def expect_error(conn, sql, params=()):
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            try:
                cur.fetchall()
            except Exception:
                pass
        conn.rollback()
    except Exception:
        conn.rollback()
        return
    raise AssertionError("expected database statement to fail")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pgdata", required=True)
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()
    if args.reset and os.path.exists(args.pgdata):
        shutil.rmtree(args.pgdata, ignore_errors=True)
    os.makedirs(args.pgdata, exist_ok=True)
    server = pgserver.get_server(args.pgdata)
    uri = server.get_uri("postgres")
    conn = psycopg.connect(uri, autocommit=True)

    bootstrap = BOOTSTRAP.read_text()
    # The bundled pgserver build has no pgcrypto files; PostgreSQL 16 already
    # provides gen_random_uuid(), so only this disposable fixture line is skipped.
    bootstrap = "\n".join(line for line in bootstrap.splitlines() if "create extension" not in line.lower())
    with conn.cursor() as cur:
        cur.execute(bootstrap)
        cur.execute("insert into public.organizations (id,name,slug,masterplan_image_url) values (%s,'Tenant','tenant','https://assets.test/default-v1.webp'),(%s,'Other','other',null)", (TENANT, OTHER))
        cur.execute("insert into public.projects (id,tenant_id,slug,name,is_default) values (%s,%s,'main','Main',true),(%s,%s,'phase-two','Phase Two',false)", (DEFAULT, TENANT, PHASE, TENANT))
        cur.execute("insert into public.parcels (tenant_id,lot_number,base_price) values (%s,'A-01',100)", (TENANT,))
        cur.execute("insert into public.masterplan_versions (tenant_id,version_number,image_url,file_name,is_active) values (%s,1,'https://assets.test/default-v1.webp','default-v1.webp',true)", (TENANT,))
        cur.execute(MIGRATION.read_text())

    def t_backfill_and_project_number_uniqueness():
        with conn.cursor() as cur:
            cur.execute("select project_id from public.parcels where tenant_id=%s and lot_number='A-01'", (TENANT,))
            assert str(cur.fetchone()[0]) == DEFAULT, "legacy parcel did not land in default project"
            cur.execute("insert into public.parcels (tenant_id,project_id,lot_number) values (%s,%s,'A-01')", (TENANT, PHASE))
        expect_error(conn, "insert into public.parcels (tenant_id,project_id,lot_number) values (%s,%s,'A-01')", (TENANT, DEFAULT))
    check("legacy parcels backfill to default and same displayed number is project-unique", t_backfill_and_project_number_uniqueness)

    def t_project_settings_tenant_pair():
        with conn.cursor() as cur:
            cur.execute("insert into public.project_settings (tenant_id,project_id,key,value) values (%s,%s,'tenant_theme','{}')", (TENANT, PHASE))
        expect_error(conn, "insert into public.project_settings (tenant_id,project_id,key,value) values (%s,%s,'tenant_theme','{}')", (OTHER, PHASE))
    check("project settings enforce owning tenant", t_project_settings_tenant_pair)

    def t_project_tier_tenant_pair():
        with conn.cursor() as cur:
            cur.execute("insert into public.project_lot_tiers (tenant_id,project_id,tier_key,label,price_cents,color_hex) values (%s,%s,'standard','Standard',100,'#112233')", (TENANT, PHASE))
        expect_error(conn, "insert into public.project_lot_tiers (tenant_id,project_id,tier_key,label,price_cents,color_hex) values (%s,%s,'bad','Bad',100,'#112233')", (OTHER, PHASE))
    check("project tiers enforce owning tenant", t_project_tier_tenant_pair)

    def t_core_parent_consistency():
        expect_error(conn, "insert into public.parcels (tenant_id,project_id,lot_number) values (%s,%s,'wrong-parent')", (OTHER, PHASE))
        expect_error(conn, "insert into public.masterplan_versions (tenant_id,project_id,version_number,image_url,file_name) values (%s,%s,99,'https://assets.test/wrong-parent.webp','wrong-parent.webp')", (OTHER, PHASE))
    check("parcel and map-version composite FKs reject mismatched parents", t_core_parent_consistency)

    def t_active_versions_are_independent_and_numbered():
        with conn.cursor() as cur:
            cur.execute("select id, project_id, is_active from public.masterplan_versions where tenant_id=%s", (TENANT,))
            default_v1 = cur.fetchone()
            assert str(default_v1[1]) == DEFAULT and default_v1[2] is True, "legacy active map did not migrate to default project"
            cur.execute("insert into public.masterplan_versions (tenant_id,project_id,image_url,file_name,is_active) values (%s,%s,'https://assets.test/phase-v1.webp','phase-v1.webp',true) returning version_number", (TENANT, PHASE))
            assert cur.fetchone()[0] == 1, "phase version numbering should start at one"
            cur.execute("insert into public.masterplan_versions (tenant_id,project_id,image_url,file_name,is_active) values (%s,%s,'https://assets.test/phase-v2.webp','phase-v2.webp',false) returning id,version_number", (TENANT, PHASE))
            phase_v2, number = cur.fetchone()
            assert number == 2, "phase numbering should be isolated from default version count"
            cur.execute("update public.masterplan_versions set is_active=true where id=%s", (phase_v2,))
            cur.execute("select is_active from public.masterplan_versions where id=%s", (default_v1[0],))
            assert cur.fetchone()[0] is True, "activating a phase map demoted the default map"
            cur.execute("select masterplan_image_url from public.organizations where id=%s", (TENANT,))
            assert cur.fetchone()[0] == "https://assets.test/default-v1.webp", "phase activation overwrote legacy/default image mirror"
            # Legacy admin insert shape intentionally omits project_id; the
            # migration routes new uploads to the is_default project.
            cur.execute("insert into public.masterplan_versions (tenant_id,image_url,file_name,is_active) values (%s,'https://assets.test/default-v2.webp','default-v2.webp',false) returning id,project_id,version_number", (TENANT,))
            default_v2, inserted_project, number = cur.fetchone()
            assert str(inserted_project) == DEFAULT and number == 2, "unscoped admin upload did not default to project and continue its sequence"
            cur.execute("update public.masterplan_versions set is_active=true where id=%s", (default_v2,))
            cur.execute("select is_active from public.masterplan_versions where id=%s", (default_v1[0],))
            assert cur.fetchone()[0] is False, "default activation did not demote its previous active map"
            cur.execute("select masterplan_image_url from public.organizations where id=%s", (TENANT,))
            assert cur.fetchone()[0] == "https://assets.test/default-v2.webp", "default activation failed to maintain legacy mirror"
    check("map versions number and activate independently per project", t_active_versions_are_independent_and_numbered)

    def t_api_privileges():
        with conn.cursor() as cur:
            for role in ("anon", "authenticated"):
                for table in ("project_settings", "project_lot_tiers"):
                    cur.execute("select has_table_privilege(%s, %s, 'select')", (role, f"public.{table}"))
                    assert cur.fetchone()[0] is False, f"{role} unexpectedly has direct SELECT on {table}"
            for table in ("project_settings", "project_lot_tiers"):
                cur.execute("select has_table_privilege('service_role', %s, 'select')", (f"public.{table}",))
                assert cur.fetchone()[0] is True, f"service_role lacks SELECT on {table}"
    check("project settings/catalogue are service-only, not Data API readable", t_api_privileges)

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"# --- {passed}/{len(results)} passed ---")
    for name, ok, message in results:
        if not ok:
            print(f"# FAIL {name}: {message}")
    conn.close()
    sys.exit(0 if passed == len(results) else 1)

if __name__ == "__main__":
    main()
