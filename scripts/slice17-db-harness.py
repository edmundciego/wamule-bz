#!/usr/bin/env python3
"""Slice 1.7 DB harness: embedded Postgres via pgserver, apply bootstrap +
slice-1.5 migration + local-only hardening (scripts/slice17-db-hardening.sql),
run DB-level tests.

Local only. No push/deploy/hosted writes. Roles:
- superuser connection == service_role equivalent (bypassrls + GRANT ALL).
- SET ROLE authenticated + app.uid == staff/admin JWT context.

Usage:
  python3 scripts/slice17-db-harness.py [--pgdata /tmp/wamule-slice17-pgdata] [--reset]
Exit 0 on all-pass, 1 on any failure.
"""
import argparse, os, pathlib, sys
import pgserver
import psycopg

ROOT = pathlib.Path(__file__).resolve().parent.parent
BOOTSTRAP = ROOT / "scripts" / "slice16-bootstrap.sql"
MIGRATION = ROOT / "supabase" / "migrations" / "20260925000000_correction_slice15.sql"
HARDENING = ROOT / "scripts" / "slice17-db-hardening.sql"

T1 = "11111111-1111-1111-1111-111111111111"
T2 = "22222222-2222-2222-2222-222222222222"
U1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"  # Staff of T1 (least privilege)
U2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"  # Admin of T2
USUP = "cccccccc-cccc-cccc-cccc-cccccccccccc"  # Super Admin (null tenant)

results = []
def check(name, fn):
    try:
        fn()
        results.append((name, True, ""))
        print(f"ok - {name}")
    except Exception as e:
        results.append((name, False, str(e)[:900]))
        print(f"FAIL - {name}: {e}")

def expect_raises(conn, sql, params=None, match=None):
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params or ())
            try:
                cur.fetchall()
            except Exception:
                pass
        conn.rollback()
    except Exception as e:
        conn.rollback()
        msg = str(e)
        if match and match not in msg:
            raise AssertionError(f"raised {msg!r} but missing {match!r}")
        return msg
    raise AssertionError(f"expected error ({match}) but statement succeeded: {sql[:160]}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pgdata", default="/tmp/wamule-slice17-pgdata")
    ap.add_argument("--reset", action="store_true")
    args = ap.parse_args()
    import shutil
    if args.reset and os.path.exists(args.pgdata):
        shutil.rmtree(args.pgdata, ignore_errors=True)
    os.makedirs(args.pgdata, exist_ok=True)
    srv = pgserver.get_server(args.pgdata)
    uri = srv.get_uri("postgres")
    print(f"# embedded pg uri: {uri}")

    admin = psycopg.connect(uri, autocommit=True)
    def _strip_pgcrypto(sql: str) -> str:
        return "\n".join(
            ln for ln in sql.splitlines()
            if "create extension" not in ln.lower() or "pgcrypto" not in ln.lower()
        )
    with admin.cursor() as cur:
        cur.execute(_strip_pgcrypto(BOOTSTRAP.read_text()))
        cur.execute(_strip_pgcrypto(MIGRATION.read_text()))
        cur.execute(_strip_pgcrypto(HARDENING.read_text()))
        cur.execute("grant usage on schema public to authenticated;")
        cur.execute("grant all on all tables in schema public to service_role;")
        # Authenticated grants for the slice-1.5 working tables (hardening SQL
        # owns onboarding/drafts/gate/seeds/masterplan privileges; do NOT
        # re-grant those here or the revocation tests become meaningless).
        for t in ["correction_waivers", "correction_edits", "organizations", "admin_profiles"]:
            cur.execute(f"grant all on public.{t} to authenticated;")
        cur.execute("insert into public.organizations (id,name,slug) values (%s,'Tenant One','t1'),(%s,'Tenant Two','t2') on conflict (id) do nothing;", (T1, T2))
        cur.execute("insert into auth.users (id) values (%s),(%s),(%s) on conflict do nothing;", (U1, U2, USUP))
        cur.execute("insert into public.admin_profiles (user_id,tenant_id,role) values (%s,%s,'Staff'),(%s,%s,'Admin'),(%s,NULL,'Super Admin') on conflict (user_id) do update set tenant_id=excluded.tenant_id, role=excluded.role;", (U1, T1, U2, T2, USUP))
        for t in ["correction_edits", "correction_waivers", "correction_drafts", "onboarding_states",
                  "correction_gate_results", "correction_bulk_seeds", "masterplan_versions"]:
            cur.execute(f"truncate public.{t};")
        # Seed stage + draft rows as the service role would (edge function).
        cur.execute("insert into public.onboarding_states (tenant_id,project_slug,stage) values (%s,'hopkins','correct');", (T1,))
        cur.execute("insert into public.correction_drafts (tenant_id,project_slug,rev,doc,stage) values (%s,'hopkins',0,'{\"lots\":{}}','correct') returning id;", (T1,))
        print(f"# draft_t1={cur.fetchone()[0]}")

    def as_user(uid):
        c = psycopg.connect(uri, autocommit=True)
        with c.cursor() as cur:
            cur.execute("set role authenticated;")
            cur.execute("select set_config('app.uid', %s, false);", (uid,))
        return c

    def as_service():
        # Service-role equivalent: bypassrls + full grants (mirrors hosted
        # edge-function context, which carries no end-user JWT uid).
        c = psycopg.connect(uri, autocommit=True)
        with c.cursor() as cur:
            cur.execute("set role service_role;")
        return c

    u1 = as_user(U1)   # Staff, T1
    u2 = as_user(U2)   # Admin, T2
    svc = as_service()

    # --- regression: tenant isolation still holds ---
    def t_cross_read():
        with u1.cursor() as cur:
            cur.execute("insert into public.correction_edits (tenant_id,project_slug,batch_id,lot_id,field,actor) values (%s,'hopkins','b1','L-001','number','u1');", (T1,))
            cur.execute("insert into public.correction_waivers (tenant_id,project_slug,scope,target,reason,actor) values (%s,'hopkins','lot','L-001','checked','u1');", (T1,))
        with u2.cursor() as cur:
            cur.execute("select count(*) from public.correction_drafts;")
            assert cur.fetchone()[0] == 0, "u2 sees T1 drafts"
            cur.execute("select count(*) from public.correction_edits;")
            assert cur.fetchone()[0] == 0, "u2 sees T1 edits"
    check("tenant isolation intact (drafts/edits hidden cross-tenant)", t_cross_read)

    def t_append_only():
        with u1.cursor() as cur:
            cur.execute("update public.correction_edits set field='area' where batch_id='b1';")
            assert cur.rowcount == 0, f"RLS should refuse edits UPDATE, got {cur.rowcount}"
        expect_raises(admin, "update public.correction_edits set field='area' where batch_id='b1';", match="append-only")
    check("edit log still append-only", t_append_only)

    def t_rev_mono():
        with u1.cursor() as cur:
            cur.execute("update public.correction_drafts set rev=rev+1 where tenant_id=%s;", (T1,))
        expect_raises(u1, "update public.correction_drafts set rev=0 where tenant_id=%s;", (T1,), match="cannot move backwards")
    check("rev monotonicity intact", t_rev_mono)

    def t_waiver_overlap_scope():
        # New 'overlap' scope accepted with reason/actor; empty reason refused.
        with svc.cursor() as cur:
            cur.execute("insert into public.correction_waivers (tenant_id,project_slug,scope,target,reason,actor) values (%s,'hopkins','overlap','L-020<->L-021','shared wall confirmed on plan','svc') returning id;", (T1,))
            wid = cur.fetchone()[0]
            cur.execute("delete from public.correction_waivers where id=%s;", (wid,))
        expect_raises(u1, "insert into public.correction_waivers (tenant_id,project_slug,scope,target,reason,actor) values (%s,'hopkins','overlap','L-1<->L-2','   ','u1');", (T1,), match="correction_waivers_reason_present")
    check("waiver overlap scope + reason check", t_waiver_overlap_scope)

    # --- 1.7: staff cannot write stage; service can ---
    def t_onboarding_staff_denied():
        expect_raises(u1, "insert into public.onboarding_states (tenant_id,project_slug,stage) values (%s,'evil','live');", (T1,), match="permission denied")
        expect_raises(u1, "update public.onboarding_states set stage='live' where tenant_id=%s and project_slug='hopkins';", (T1,), match="permission denied")
        with u1.cursor() as cur:
            cur.execute("select stage from public.onboarding_states where tenant_id=%s;", (T1,))
            assert cur.fetchone()[0] == "correct", "staff write must not have landed"
    check("staff direct stage write refused (onboarding_states)", t_onboarding_staff_denied)

    def t_drafts_stage_column_denied():
        expect_raises(u1, "update public.correction_drafts set stage='live' where tenant_id=%s;", (T1,), match="permission denied")
        # ...but the normal save path (doc/rev columns) still works.
        with u1.cursor() as cur:
            cur.execute("select rev from public.correction_drafts where tenant_id=%s;", (T1,))
            before = cur.fetchone()[0]
            cur.execute("update public.correction_drafts set rev=rev+1 where tenant_id=%s;", (T1,))
            cur.execute("select rev from public.correction_drafts where tenant_id=%s;", (T1,))
            assert cur.fetchone()[0] == before + 1
    check("staff direct drafts.stage write refused; doc/rev saves still work", t_drafts_stage_column_denied)

    def t_service_stage_writes():
        with svc.cursor() as cur:
            cur.execute("update public.onboarding_states set stage='validate' where tenant_id=%s and project_slug='hopkins';", (T1,))
            cur.execute("update public.correction_drafts set stage='validate' where tenant_id=%s;", (T1,))
            cur.execute("select stage from public.onboarding_states where tenant_id=%s;", (T1,))
            assert cur.fetchone()[0] == "validate"
            # restore for later tests
            cur.execute("update public.onboarding_states set stage='correct' where tenant_id=%s;", (T1,))
            cur.execute("update public.correction_drafts set stage='correct' where tenant_id=%s;", (T1,))
    check("service role stage writes succeed", t_service_stage_writes)

    # --- 1.7: masterplan activation needs a recorded passing gate result ---
    def t_activation_refused_without_record():
        with svc.cursor() as cur:
            cur.execute("insert into public.masterplan_versions (tenant_id,version_number,image_url,file_name,is_active) values (%s,1,'https://x/v1.webp','v1.webp',false) returning id;", (T1,))
            vid = cur.fetchone()[0]
        expect_raises(u1, "update public.masterplan_versions set is_active=true where id=%s;", (vid,), match="no recorded passing masterplan-activation gate result")
        expect_raises(svc, "update public.masterplan_versions set is_active=true where id=%s;", (vid,), match="no recorded passing masterplan-activation gate result")
        return vid
    vid = []
    def t_activation_wrap():
        vid.append(t_activation_refused_without_record())
    check("direct activation refused without gate record (staff AND service)", t_activation_wrap)

    def t_gate_results_staff_cannot_forge():
        expect_raises(u1, "insert into public.correction_gate_results (tenant_id,gate,pass,actor) values (%s,'masterplan-activation',true,'u1');", (T1,), match="permission denied")
    check("staff cannot forge gate results", t_gate_results_staff_cannot_forge)

    def t_activation_after_record():
        with svc.cursor() as cur:
            cur.execute("insert into public.correction_gate_results (tenant_id,project_slug,gate,pass,actor) values (%s,'hopkins','masterplan-activation',true,'publish-draft fn');", (T1,))
        with u1.cursor() as cur:
            cur.execute("update public.masterplan_versions set is_active=true where id=%s;", (vid[0],))
            cur.execute("select is_active from public.masterplan_versions where id=%s;", (vid[0],))
            assert cur.fetchone()[0] is True, "activation with recorded pass should succeed"
    check("activation succeeds once a passing result is recorded", t_activation_after_record)

    # --- 1.7: bulk-seed nonces, single-use in the database ---
    seed = []
    def t_seed_issue_consume():
        with svc.cursor() as cur:
            cur.execute("insert into public.correction_bulk_seeds (tenant_id,project_slug,seed,proposal,sample,created_by) values (%s,'hopkins',12345,'[\"a\",\"b\"]','[\"a\"]','svc') returning seed_id;", (T1,))
            seed.append(cur.fetchone()[0])
        with svc.cursor() as cur:
            cur.execute("select * from public.consume_correction_bulk_seed(%s,%s,'alice');", (seed[0], T1))
            row = cur.fetchone()
            assert row is not None, "consume should return proposal/sample"
    check("seed consume returns proposal/sample", t_seed_issue_consume)

    def t_seed_single_use():
        expect_raises(svc, "select * from public.consume_correction_bulk_seed(%s,%s,'alice');", (seed[0], T1), match="already used")
    check("seed replay refused (single-use)", t_seed_single_use)

    def t_seed_cross_tenant_unknown_actor():
        with svc.cursor() as cur:
            cur.execute("insert into public.correction_bulk_seeds (tenant_id,project_slug,seed,proposal,sample,created_by) values (%s,'hopkins',999,'[]','[]','svc') returning seed_id;", (T2,))
            other = cur.fetchone()[0]
        expect_raises(svc, "select * from public.consume_correction_bulk_seed(%s,%s,'alice');", (other, T1), match="cross-tenant")
        expect_raises(svc, "select * from public.consume_correction_bulk_seed(%s,%s,'  ');", (other, T2), match="actor is required")
        import uuid as _uuid
        expect_raises(svc, "select * from public.consume_correction_bulk_seed(%s,%s,'alice');", (str(_uuid.uuid4()), T1), match="unknown seed")
    check("seed cross-tenant / unknown / empty-actor refused", t_seed_cross_tenant_unknown_actor)

    def t_seed_staff_direct_write_denied():
        expect_raises(u1, "update public.correction_bulk_seeds set used=false where seed_id=%s;", (seed[0],), match="permission denied")
        expect_raises(u1, "insert into public.correction_bulk_seeds (tenant_id,project_slug,seed,created_by) values (%s,'hopkins',1,'u1');", (T1,), match="permission denied")
    check("staff direct seed writes refused", t_seed_staff_direct_write_denied)

    print(f"# --- {sum(1 for _,ok,_ in results if ok)}/{len(results)} passed ---")
    for name, ok, msg in results:
        if not ok:
            print(f"# FAIL {name}: {msg}")
    admin.close(); u1.close(); u2.close(); svc.close()
    sys.exit(0 if all(ok for _,ok,_ in results) else 1)

if __name__ == "__main__":
    main()
