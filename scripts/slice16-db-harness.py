#!/usr/bin/env python3
"""Slice 1.6 DB harness: boot embedded Postgres via pgserver, apply
supabase/migrations/20260925000000_correction_slice15.sql, run DB-level tests.

Local only. No push/deploy/hosted writes. Uses GUC app.uid + SET ROLE
authenticated to exercise RLS as the hosted JWT context would.

Usage:
  python3 scripts/slice16-db-harness.py [--pgdata /tmp/wamule-slice16-pgdata] [--reset]

Exit 0 on all-pass, 1 on any failure. Prints TAP-ish lines.
"""
import argparse, os, pathlib, sys
import pgserver
import psycopg

ROOT = pathlib.Path(__file__).resolve().parent.parent
BOOTSTRAP = ROOT / "scripts" / "slice16-bootstrap.sql"
MIGRATION = ROOT / "supabase" / "migrations" / "20260925000000_correction_slice15.sql"

T1 = "11111111-1111-1111-1111-111111111111"
T2 = "22222222-2222-2222-2222-222222222222"
U1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"  # admin of T1
U2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"  # admin of T2
USUP = "cccccccc-cccc-cccc-cccc-cccccccccccc"  # super admin (null tenant)

results = []
def check(name, fn):
    try:
        fn()
        results.append((name, True, ""))
        print(f"ok - {name}")
    except Exception as e:
        results.append((name, False, str(e)[:800]))
        print(f"FAIL - {name}: {e}")

def expect_raises(conn, sql, params=None, match=None):
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params or ())
            # force row consumption for SELECTs
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
    ap.add_argument("--pgdata", default="/tmp/wamule-slice16-pgdata")
    ap.add_argument("--reset", action="store_true", help="wipe pgdata and re-init")
    args = ap.parse_args()
    import shutil
    if args.reset and os.path.exists(args.pgdata):
        # stop server first if running on same path
        shutil.rmtree(args.pgdata, ignore_errors=True)
    os.makedirs(args.pgdata, exist_ok=True)
    srv = pgserver.get_server(args.pgdata)
    uri = srv.get_uri("postgres")
    print(f"# embedded pg uri: {uri}")

    admin = psycopg.connect(uri, autocommit=True)
    # 1. bootstrap + migration
    # NOTE: pgserver embedded build ships without pgcrypto files, but PG16
    # provides gen_random_uuid() in core, so strip the extension line.
    def _strip_pgcrypto(sql: str) -> str:
        return "\n".join(
            ln for ln in sql.splitlines()
            if "create extension" not in ln.lower() or "pgcrypto" not in ln.lower()
        )
    with admin.cursor() as cur:
        cur.execute(_strip_pgcrypto(BOOTSTRAP.read_text()))
        cur.execute(_strip_pgcrypto(MIGRATION.read_text()))
        # grants so RLS (not privilege lack) decides access
        cur.execute("grant usage on schema public to authenticated;")
        for t in ["onboarding_states", "correction_drafts", "correction_waivers", "correction_edits", "organizations", "admin_profiles"]:
            try:
                cur.execute(f"grant all on public.{t} to authenticated;")
            except Exception as e:
                print(f"# grant {t}: {e}")
                admin.rollback()
            else:
                pass
        # seed tenants + users (as superuser, bypasses RLS)
        cur.execute("insert into public.organizations (id,name,slug) values (%s,'Tenant One','t1'),(%s,'Tenant Two','t2') on conflict (id) do nothing;", (T1, T2))
        cur.execute("insert into auth.users (id) values (%s),(%s),(%s) on conflict do nothing;", (U1, U2, USUP))
        cur.execute("insert into public.admin_profiles (user_id,tenant_id,role) values (%s,%s,'Admin'),(%s,%s,'Admin'),(%s,NULL,'Super Admin') on conflict (user_id) do update set tenant_id=excluded.tenant_id, role=excluded.role;", (U1, T1, U2, T2, USUP))
        # clean slate for correction tables (TRUNCATE bypasses row triggers;
        # plain DELETE on correction_edits would hit the append-only trigger)
        for t in ["correction_edits", "correction_waivers", "correction_drafts", "onboarding_states"]:
            cur.execute(f"truncate public.{t};")

    def as_user(uid):
        c = psycopg.connect(uri, autocommit=True)
        with c.cursor() as cur:
            cur.execute("set role authenticated;")
            cur.execute("select set_config('app.uid', %s, false);", (uid,))
        return c

    u1 = as_user(U1)
    u2 = as_user(U2)
    sup = as_user(USUP)

    # convenience: insert a T1 draft as u1 for later tests
    with u1.cursor() as cur:
        cur.execute("insert into public.correction_drafts (tenant_id, project_slug, rev, doc) values (%s,'hopkins',0,'{\"lots\":{}}') returning id;", (T1,))
        draft_t1 = cur.fetchone()[0]
    print(f"# draft_t1={draft_t1}")

    # --- 1. cross-tenant read refusal ---
    def t_cross_read():
        with u2.cursor() as cur:
            cur.execute("select count(*) from public.correction_drafts where tenant_id=%s;", (T1,))
            n = cur.fetchone()[0]
            assert n == 0, f"u2 (T2) can see T1 drafts: count={n}"
        with u1.cursor() as cur:
            cur.execute("select count(*) from public.correction_drafts;")
            n = cur.fetchone()[0]
            assert n == 1, f"u1 should see own draft, got {n}"
    check("cross-tenant read refusal (drafts)", t_cross_read)

    def t_cross_read_log_waivers():
        # seed a T1 edit + waiver as u1, then verify u2 sees none
        with u1.cursor() as cur:
            cur.execute("insert into public.correction_edits (tenant_id,project_slug,batch_id,lot_id,field,actor) values (%s,'hopkins','b1','L-001','number','u1');", (T1,))
            cur.execute("insert into public.correction_waivers (tenant_id,project_slug,scope,target,reason,actor) values (%s,'hopkins','lot','L-001','checked on plan','u1');", (T1,))
        with u2.cursor() as cur:
            cur.execute("select count(*) from public.correction_edits;")
            assert cur.fetchone()[0] == 0, "u2 sees T1 edits"
            cur.execute("select count(*) from public.correction_waivers;")
            assert cur.fetchone()[0] == 0, "u2 sees T1 waivers"
        with sup.cursor() as cur:
            cur.execute("select count(*) from public.correction_edits;")
            assert cur.fetchone()[0] == 1, "superadmin should see all"
    check("cross-tenant read refusal (edits/waivers)", t_cross_read_log_waivers)

    # --- 2. cross-tenant write refusal ---
    def t_cross_write():
        expect_raises(u2, "insert into public.correction_drafts (tenant_id,project_slug,rev,doc) values (%s,'hopkins',0,'{}');", (T1,), match=None)
        expect_raises(u2, "insert into public.correction_edits (tenant_id,project_slug,batch_id,lot_id,field,actor) values (%s,'hopkins','bX','L-1','number','u2');", (T1,))
        expect_raises(u2, "insert into public.correction_waivers (tenant_id,project_slug,scope,target,reason,actor) values (%s,'hopkins','lot','L-1','r','u2');", (T1,))
        expect_raises(u1, "insert into public.correction_drafts (tenant_id,project_slug,rev,doc) values (%s,'evil',0,'{}');", (T2,))
    check("cross-tenant write refusal (drafts/log/waivers)", t_cross_write)

    # --- 3. edit log rejects UPDATE/DELETE ---
    def t_append_only():
        # (a) RLS layer: no UPDATE/DELETE policy, so authenticated writes
        # affect 0 rows (silently refused, not applied).
        with u1.cursor() as cur:
            cur.execute("update public.correction_edits set field='area' where batch_id='b1';")
            assert cur.rowcount == 0, f"RLS should refuse edits UPDATE, rowcount={cur.rowcount}"
            cur.execute("delete from public.correction_edits where batch_id='b1';")
            assert cur.rowcount == 0, f"RLS should refuse edits DELETE, rowcount={cur.rowcount}"
            cur.execute("select count(*) from public.correction_edits where batch_id='b1';")
            assert cur.fetchone()[0] == 1, "edit row must survive RLS-blocked UPDATE/DELETE"
        # (b) Trigger layer: a privileged writer bypassing RLS still hits
        # the append-only trigger (belt-and-braces).
        expect_raises(admin, "update public.correction_edits set field='area' where batch_id='b1';", match="append-only")
        expect_raises(admin, "delete from public.correction_edits where batch_id='b1';", match="append-only")
    check("edit log rejects UPDATE/DELETE (RLS 0-rows + trigger)", t_append_only)

    # --- 4. rev monotonicity ---
    def t_rev_mono():
        with u1.cursor() as cur:
            cur.execute("select rev from public.correction_drafts where tenant_id=%s;", (T1,))
            rev = cur.fetchone()[0]
            cur.execute("update public.correction_drafts set rev=rev+1 where tenant_id=%s;", (T1,))
            cur.execute("select rev from public.correction_drafts where tenant_id=%s;", (T1,))
            assert cur.fetchone()[0] == rev + 1
        expect_raises(u1, "update public.correction_drafts set rev=0 where tenant_id=%s;", (T1,), match="cannot move backwards")
    check("rev-monotonicity trigger rejects backwards moves", t_rev_mono)

    # --- 5. waiver reason check ---
    def t_waiver_reason():
        expect_raises(u1, "insert into public.correction_waivers (tenant_id,project_slug,scope,target,reason,actor) values (%s,'hopkins','lot','L-002','   ','u1');", (T1,), match="correction_waivers_reason_present")
        expect_raises(u1, "insert into public.correction_waivers (tenant_id,project_slug,scope,target,reason,actor) values (%s,'hopkins','bogus','L-002','ok','u1');", (T1,), match="correction_waivers_scope_valid")
    check("waiver reason/scope check constraints", t_waiver_reason)

    # --- 6. direct-insert bypass attempts ---
    def t_bypass_rev_negative():
        expect_raises(u1, "insert into public.correction_drafts (tenant_id,project_slug,rev,doc) values (%s,'bypass-neg',-1,'{}');", (T1,), match="correction_drafts_rev_nonnegative")
    check("direct insert bypass: negative rev rejected", t_bypass_rev_negative)

    def t_bypass_stage_skip_is_db_visible():
        # Gates live in the publish path, NOT in DB constraints (by design).
        # So a direct stage write succeeds at the DB layer — this test pins
        # that fact: skipping gates via raw SQL is possible, hence publish
        # MUST re-evaluate gates server-side (edge function).
        with u1.cursor() as cur:
            cur.execute("insert into public.onboarding_states (tenant_id,project_slug,stage) values (%s,'hopkins','correct') on conflict do nothing;", (T1,))
            cur.execute("update public.onboarding_states set stage='live' where tenant_id=%s and project_slug='hopkins';", (T1,))
            cur.execute("select stage from public.onboarding_states where tenant_id=%s;", (T1,))
            assert cur.fetchone()[0] == "live", "direct stage write should succeed (gates are not DB constraints)"
            # restore
            cur.execute("update public.onboarding_states set stage='correct' where tenant_id=%s;", (T1,))
    check("direct stage skip succeeds at DB (gates must be server-enforced)", t_bypass_stage_skip_is_db_visible)

    def t_anon_denied():
        anon = psycopg.connect(uri, autocommit=True)
        with anon.cursor() as cur:
            cur.execute("set role anon;")
            cur.execute("select set_config('app.uid', '', false);")
        expect_raises(anon, "select * from public.correction_drafts limit 1;")
        anon.close()
    check("anon (no uid) sees nothing", t_anon_denied)

    print(f"# --- {sum(1 for _,ok,_ in results if ok)}/{len(results)} passed ---")
    for name, ok, msg in results:
        if not ok:
            print(f"# FAIL {name}: {msg}")
    admin.close(); u1.close(); u2.close(); sup.close()
    sys.exit(0 if all(ok for _,ok,_ in results) else 1)

if __name__ == "__main__":
    main()
