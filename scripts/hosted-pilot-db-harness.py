#!/usr/bin/env python3
"""Local-only hosted-pilot migration and RLS rehearsal on embedded Postgres.

This intentionally uses pgserver/psycopg, not Docker or a hosted Supabase
project. It starts from a small schema fixture representing the reviewed
pre-pilot tenant/project baseline, applies the tracked project-scope migration
plus the two new pilot migrations, then exercises tenant/project/phase rules.
The fixture is not a substitute for the real hosted migration-history audit.
"""
from pathlib import Path
import json
import psutil
import shutil
import subprocess
import sys
import tempfile
import uuid

import pgserver
import psycopg
from fasteners import InterProcessLock
from pgserver.postgres_server import PostgresServer
from pgserver._commands import POSTGRES_BIN_PATH

ROOT = Path(__file__).resolve().parent.parent
BOOTSTRAP = ROOT / "scripts" / "hosted-pilot-db-bootstrap.sql"
BASE_MIGRATION = ROOT / "supabase/migrations/20261012020651_project_scoped_public_maps.sql"
PILOT_MIGRATION = ROOT / "supabase/migrations/20261014000000_project_phase_hosted_pilot.sql"
INQUIRY_MIGRATION = ROOT / "supabase/migrations/20261014010000_scoped_public_inquiry_rpc.sql"
SECURITY_MIGRATION = ROOT / "supabase/migrations/20261015022233_tenant_rpc_secret_application_document_isolation.sql"
SUPER_ADMIN_ONBOARDING_MIGRATION = ROOT / "supabase/migrations/20261015100000_hopkins_super_admin_workspace_onboarding.sql"

T1 = "11111111-1111-4111-8111-111111111111"
T2 = "22222222-2222-4222-8222-222222222222"
U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
U3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
U4 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
U5 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
P1 = "11111111-aaaa-4aaa-8aaa-111111111111"
P2 = "22222222-aaaa-4aaa-8aaa-222222222222"
L3 = "33333333-aaaa-4aaa-8aaa-333333333333"

APPROVED_HOPKINS_SNAPSHOT_FINGERPRINT = "07307f5a63e73911604fb3d2ecb57fc708fb0ba5ff3a7a16b4a945533ffc9c26"

def load_approved_hopkins_snapshot():
    """Use the production importer builder; return geometry only in memory."""
    node_script = r"""
      import { buildHopkinsFeatureSnapshot } from './scripts/lib/hopkins-feature-snapshot.mjs';
      const built = await buildHopkinsFeatureSnapshot({
        manifestPath: 'artifacts/hopkins-five-plot-approval-20261014/local-corrections.approved.json',
        lotsPath: 'out/hopkins-ocr/lots.json',
        imagePath: 'out/hopkins-ocr/masterplan_background.webp',
      });
      process.stdout.write(JSON.stringify({
        snapshotFingerprint: built.snapshotFingerprint,
        imageSha: built.imageSha,
        detectionSha: built.detectionSha,
        manifestSha: built.manifestSha,
        manifestRevision: built.manifest.revision,
        features: built.features,
      }));
    """
    result = subprocess.run(
        ["node", "--input-type=module", "-e", node_script],
        cwd=ROOT, capture_output=True, text=True, timeout=120, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "Approved Hopkins rehearsal inputs could not be verified with the importer builder: "
            + result.stderr[-1200:]
        )
    snapshot = json.loads(result.stdout)
    if snapshot.get("manifestRevision") != 24:
        raise RuntimeError("The Hopkins rehearsal source is not approved manifest revision 24.")
    if snapshot.get("snapshotFingerprint") != APPROVED_HOPKINS_SNAPSHOT_FINGERPRINT:
        raise RuntimeError("The Hopkins rehearsal source does not match the approved 775-outline fingerprint.")
    if len(snapshot.get("features", [])) != 775:
        raise RuntimeError("The approved Hopkins snapshot must contain exactly 775 geometry features.")
    return snapshot

THEME = '{"tokens":{"primary":"#173f2d"}}'
PROFILE = '{"company_name":"Hopkins Grove"}'

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

def user_conn(uri, uid, role="authenticated"):
    conn = psycopg.connect(uri, autocommit=True)
    with conn.cursor() as cur:
        cur.execute(f"set role {role}")
        cur.execute("select set_config('request.jwt.claim.sub', %s, false)", (uid,))
        cur.execute("select set_config('request.jwt.claim.role', %s, false)", (role,))
    return conn

def main():
    actual_hopkins = "--actual-hopkins" in sys.argv[1:]
    hopkins_snapshot = load_approved_hopkins_snapshot() if actual_hopkins else None
    # Keep the AF_UNIX socket path below macOS's length limit.
    work = Path(tempfile.mkdtemp(prefix="wp-", dir="/private/tmp"))
    server = None
    connections = []
    passed = 0
    failures = []
    def check(name, fn):
        nonlocal passed
        try:
            fn()
            passed += 1
            print(f"ok - {name}")
        except Exception as error:
            failures.append((name, str(error)))
            print(f"FAIL - {name}: {error}")

    try:
        # The sandbox denies pgserver's default per-user Library/Caches lock
        # directory. Keep its lock/socket runtime next to this disposable
        # cluster under the approved temporary root instead.
        PostgresServer.runtime_path = work / "runtime"
        PostgresServer.runtime_path.mkdir()
        PostgresServer.lock_path = PostgresServer.runtime_path / ".lockfile"
        PostgresServer._lock = InterProcessLock(str(PostgresServer.lock_path))
        try:
            list(psutil.process_iter(attrs=["name", "cmdline"]))
        except PermissionError:
            # `work` is a newly-created unique directory, so no prior process
            # can be using this PGDATA. The sandbox blocks macOS sysctl-based
            # process enumeration; skip only pgserver's stale-path scan here.
            if work.parent != Path("/private/tmp"):
                raise
            psutil.process_iter = lambda *args, **kwargs: iter(())
        server = pgserver.get_server(str(work / "data"), cleanup_mode="delete")
        admin = psycopg.connect(server.get_uri("postgres"), autocommit=True)
        connections.append(admin)
        bootstrap = BOOTSTRAP.read_text()
        # pgserver's embedded distribution omits the pgcrypto control files;
        # PG16 provides gen_random_uuid() natively, so skip only extension DDL.
        bootstrap = "\n".join(line for line in bootstrap.splitlines() if "create extension" not in line.lower())
        with admin.cursor() as cur:
            cur.execute(bootstrap)
            cur.execute("insert into public.organizations(id,name,slug,gemini_api_key) values (%s,'Existing Tenant','existing','fixture-private-key-one'),(%s,'Other Tenant','other','fixture-private-key-two')", (T1,T2))
            cur.execute("insert into public.projects(id,tenant_id,slug,name,is_default) values (%s,%s,'main','Main',true),(%s,%s,'main','Main',true)", (P1,T1,P2,T2))
            cur.execute("insert into auth.users(id,email,raw_user_meta_data) values (%s,'one@example.test','{}'),(%s,'two@example.test','{}'),(%s,'hopkins@example.test','{\"full_name\":\"Hopkins Reviewer\"}'),(%s,'readonly@example.test','{}'),(%s,'superadmin@example.test','{}')", (U1,U2,U3,U4,U5))
            cur.execute("insert into public.admin_profiles(user_id,email,full_name,role,tenant_id) values (%s,'one@example.test','Tenant One Admin','Admin',%s),(%s,'two@example.test','Tenant Two Admin','Admin',%s),(%s,'readonly@example.test','Tenant One Read Only','Read Only',%s),(%s,'superadmin@example.test','Tenant One Super Admin','Super Admin',%s)", (U1,T1,U2,T2,U4,T1,U5,T1))
            cur.execute("insert into public.parcels(tenant_id,lot_number,status,base_price,map_polygon) values (%s,'OLD-1','Available',12345,'[{\"x\":1,\"y\":1},{\"x\":2,\"y\":1},{\"x\":2,\"y\":2}]')", (T1,))
            cur.execute("insert into public.masterplan_versions(tenant_id,version_number,image_url,file_name,is_active) values (%s,1,'https://assets.test/existing.webp','existing.webp',true)", (T1,))
            cur.execute("insert into public.leads(tenant_id,full_name,email,source,client_reference_id) values (%s,'Other Tenant Buyer','other@example.test','manual','other-reference')", (T2,))
            cur.execute("select id from public.parcels where tenant_id=%s and lot_number='OLD-1'", (T1,))
            parcel_id = cur.fetchone()[0]
            cur.execute("""
              insert into public.leads(tenant_id,full_name,email,phone,parcel_id,source,client_reference_id)
                values (%s,'Existing Buyer','existing@example.test','5550101',%s,'manual','existing-reference') returning id
            """, (T1, parcel_id))
            lead_id = cur.fetchone()[0]
            cur.execute("insert into public.lead_activities(tenant_id,lead_id,activity_type,title) values (%s,%s,'note','Existing activity')", (T1,lead_id))
            cur.execute("insert into public.follow_up_tasks(tenant_id,lead_id,title,due_at) values (%s,%s,'Existing follow-up',now()) returning id", (T1,lead_id))
            task_id = cur.fetchone()[0]
            cur.execute("insert into public.information_topics(tenant_id,code,name,default_content) values (%s,'overview','Overview','Existing topic') returning id", (T1,))
            topic_id = cur.fetchone()[0]
            cur.execute("insert into public.information_requests(tenant_id,lead_id,parcel_id,project_name,follow_up_task_id) values (%s,%s,%s,'Existing Project',%s) returning id", (T1,lead_id,parcel_id,task_id))
            request_id = cur.fetchone()[0]
            cur.execute("insert into public.information_request_topics(request_id,topic_id,tenant_id) values (%s,%s,%s)", (request_id,topic_id,T1))
            cur.execute("insert into public.information_packs(tenant_id,request_id,document_number,title) values (%s,%s,'DOC-1','Existing pack')", (T1,request_id))
            cur.execute("insert into public.site_visits(tenant_id,lead_id,scheduled_at) values (%s,%s,now())", (T1,lead_id))
            cur.execute(BASE_MIGRATION.read_text())
            cur.execute(PILOT_MIGRATION.read_text())
            cur.execute(INQUIRY_MIGRATION.read_text())
            security_sql = "\n".join(
                line for line in SECURITY_MIGRATION.read_text().splitlines()
                if not line.strip().lower().startswith("create extension")
            )
            cur.execute(security_sql)
            cur.execute(SUPER_ADMIN_ONBOARDING_MIGRATION.read_text())
            cur.execute("select id from public.development_phases where tenant_id=%s and project_id=%s and is_default", (T1,P1))
            default_phase_t1 = cur.fetchone()[0]
            cur.execute("""
              insert into public.customers(id,tenant_id,first_name,last_name) values
                (101,%s,'Tenant','One Buyer'),(202,%s,'Tenant','Two Buyer')
            """, (T1,T2))
            cur.execute("""
              insert into public.parcels(id,tenant_id,project_id,lot_number,status,base_price)
                overriding system value values
                (1001,%s,%s,'APP-ONE','Available',12345),
                (2002,%s,%s,'APP-TWO','Available',98765)
            """, (T1,P1,T2,P2))
            cur.execute("""
              insert into public.applications(id,tenant_id,first_name,last_name,phone,email,applicant_address,parcel_id)
                overriding system value values
                (1001,%s,'Tenant','One','5551001','one-buyer@example.test','One address',1001),
                (2002,%s,'Tenant','Two','5552002','two-buyer@example.test','Two address',2002)
            """, (T1,T2))
            cur.execute("""
              insert into public.contracts(id,tenant_id,customer_id,parcel_id,signed_contract_file_path,final_purchase_price)
                overriding system value values
                (101,%s,101,1001,'101/contract-one.pdf',1000),
                (202,%s,202,2002,'202/contract-two.pdf',2000)
            """, (T1,T2))
            # Deliberately inconsistent but FK-valid business references prove
            # that SECURITY DEFINER code checks related-row ownership, not just
            # the target row's tenant. These remain untouched unless a bad RPC
            # call fails to reject them.
            cur.execute("""
              insert into public.contracts(id,tenant_id,customer_id,parcel_id,signed_contract_file_path,final_purchase_price)
                overriding system value values (303,%s,202,2002,'303/cross-reference-contract.pdf',3000)
            """, (T1,))
            cur.execute("""
              insert into public.transactions(id,tenant_id,customer_id,contract_id,receipt_number,amount,collection_method,transaction_type)
                overriding system value values
                (101,%s,101,101,'RCPT-ONE',125,'manual','installment'),
                (202,%s,202,202,'RCPT-TWO',250,'manual','installment')
            """, (T1,T2))
            cur.execute("""
              insert into public.transactions(id,tenant_id,customer_id,contract_id,receipt_number,amount,collection_method,transaction_type)
                overriding system value values (303,%s,202,303,'RCPT-CROSS-REF',325,'manual','installment')
            """, (T1,))
            cur.execute("""
              insert into public.payment_documents(tenant_id,customer_id,file_path)
              values (%s,101,'101/unlinked/payment-one.pdf'),(%s,202,'202/unlinked/payment-two.pdf')
            """, (T1,T2))
            cur.execute("""
              insert into public.lot_reservations(id,tenant_id,application_id,customer_id,parcel_id,status)
              values
                ('88888888-aaaa-4aaa-8aaa-888888888801',%s,1001,101,1001,'reserved'),
                ('88888888-aaaa-4aaa-8aaa-888888888802',%s,1001,101,null,'reserved'),
                ('88888888-aaaa-4aaa-8aaa-888888888803',%s,2002,202,2002,'reserved'),
                ('88888888-aaaa-4aaa-8aaa-888888888804',%s,2002,202,2002,'reserved'),
                ('88888888-aaaa-4aaa-8aaa-888888888805',%s,1001,101,null,'reserved'),
                ('88888888-aaaa-4aaa-8aaa-888888888806',%s,1001,101,null,'reserved'),
                ('88888888-aaaa-4aaa-8aaa-888888888807',%s,1001,101,null,'reserved'),
                ('88888888-aaaa-4aaa-8aaa-888888888808',%s,1001,101,null,'reserved')
            """, (T1,T1,T2,T1,T1,T1,T1,T1))
            cur.execute("update public.lot_reservations set payment_id=202 where id='88888888-aaaa-4aaa-8aaa-888888888805'")
            cur.execute("update public.lot_reservations set converted_application_id=2002 where id='88888888-aaaa-4aaa-8aaa-888888888806'")
            cur.execute("update public.lot_reservations set converted_contract_id=202 where id='88888888-aaaa-4aaa-8aaa-888888888807'")
            cur.execute("update public.lot_reservations set payment_id=202 where id='88888888-aaaa-4aaa-8aaa-888888888808'")
            cur.execute("""
              insert into storage.objects(bucket_id,name) values
                ('contracts','101/contract-one.pdf'),('contracts','202/contract-two.pdf'),
                ('receipts','101/RCPT-ONE.pdf'),('receipts','202/RCPT-TWO.pdf'),
                ('payment-documents','101/unlinked/payment-one.pdf'),('payment-documents','202/unlinked/payment-two.pdf'),
                ('application-documents','101/application-private.pdf')
            """)
            cur.execute("insert into public.parcels(tenant_id,lot_number,status,base_price,map_polygon) values (%s,'T2-LOT','Available',1,'[]'::jsonb)", (T2,))

        # Service-role connection models the server-only Edge/RPC/import path.
        service = user_conn(server.get_uri("postgres"), U3, "service_role")
        connections.append(service)

        def preserved_tenant_records():
            with admin.cursor() as cur:
                cur.execute("select tenant_id,project_id,phase_id from public.parcels where lot_number='OLD-1'")
                row = cur.fetchone()
                assert str(row[0]) == T1 and str(row[1]) == P1 and row[2] is not None, row
                cur.execute("select tenant_id,project_id,phase_id,id from public.leads where id=%s", (lead_id,))
                row = cur.fetchone()
                assert str(row[0]) == T1 and str(row[1]) == P1 and row[2] is not None and row[3] == lead_id, row
                cur.execute("select count(*) from public.lead_activities where lead_id=%s", (lead_id,))
                assert cur.fetchone()[0] == 1
                cur.execute("select count(*) from public.follow_up_tasks where lead_id=%s", (lead_id,))
                assert cur.fetchone()[0] == 1
                for table, where, params in [
                    ("information_requests", "id=%s", (request_id,)),
                    ("information_request_topics", "request_id=%s", (request_id,)),
                    ("information_packs", "request_id=%s", (request_id,)),
                    ("site_visits", "lead_id=%s", (lead_id,)),
                ]:
                    cur.execute(f"select tenant_id,project_id,phase_id from public.{table} where {where}", params)
                    scoped = cur.fetchone()
                    assert str(scoped[0]) == T1 and str(scoped[1]) == P1 and scoped[2] is not None, (table,scoped)
                cur.execute("select count(*) from public.organizations where id in (%s,%s)", (T1,T2))
                assert cur.fetchone()[0] == 2, "existing organizations were changed or lost"
        check("existing tenant business rows are preserved and default-phase scoped", preserved_tenant_records)

        onboard_sql = "select public.onboard_project_tenant('hopkins-grove','Hopkins Grove','hopkins-grove','Hopkins Grove','initial','Initial phase',%s::jsonb,%s::jsonb,%s,'owner',true)"
        with service.cursor() as cur:
            cur.execute(onboard_sql, (THEME, PROFILE, U3))
            onboarded = cur.fetchone()[0]
            tenant_id, project_id, phase_id = onboarded["tenant_id"], onboarded["project_id"], onboarded["phase_id"]
            cur.execute(onboard_sql, (THEME, PROFILE, U3))
            repeated = cur.fetchone()[0]
            assert repeated == onboarded, "onboarding RPC did not return the same scope on retry"

        def onboarding_is_repeatable_and_isolated():
            with admin.cursor() as cur:
                cur.execute("select count(*) from public.organizations where slug='hopkins-grove'")
                assert cur.fetchone()[0] == 1
                cur.execute("select count(*) from public.projects where tenant_id=%s and slug='hopkins-grove'", (tenant_id,))
                assert cur.fetchone()[0] == 1
                cur.execute("select count(*) from public.development_phases where tenant_id=%s and project_id=%s and slug='initial'", (tenant_id,project_id))
                assert cur.fetchone()[0] == 1
                cur.execute("select count(*) from public.project_memberships where tenant_id=%s and project_id=%s and phase_id=%s and user_id=%s", (tenant_id,project_id,phase_id,U3))
                assert cur.fetchone()[0] == 1
                cur.execute("select count(*) from public.admin_profiles where user_id=%s and tenant_id=%s", (U3,tenant_id))
                assert cur.fetchone()[0] == 1
                cur.execute("select count(*) from public.leads where tenant_id=%s", (tenant_id,))
                assert cur.fetchone()[0] == 0, "onboarding moved existing business rows into Hopkins"
        check("Hopkins onboarding retry reuses one tenant/project/phase/membership", onboarding_is_repeatable_and_isolated)

        def super_admin_uses_hopkins_membership_without_profile_reassignment():
            with service.cursor() as cur:
                cur.execute(onboard_sql, (THEME, PROFILE, U5))
                super_scope = cur.fetchone()[0]
                assert super_scope["tenant_id"] == tenant_id and super_scope["project_id"] == project_id and super_scope["phase_id"] == phase_id
                cur.execute(onboard_sql, (THEME, PROFILE, U5))
                assert cur.fetchone()[0] == super_scope, "Super Admin onboarding retry changed its workspace scope"
            with admin.cursor() as cur:
                cur.execute("select role,tenant_id from public.admin_profiles where user_id=%s", (U5,))
                profile = cur.fetchone()
                assert profile == ("Super Admin", uuid.UUID(T1)), f"Super Admin profile was reassigned: {profile}"
                cur.execute("select member_role from public.project_memberships where user_id=%s and tenant_id=%s and project_id=%s and phase_id=%s", (U5,T1,P1,default_phase_t1))
                assert cur.fetchall() == [("staff",)], "existing Wamule membership changed"
                cur.execute("select count(*) from public.project_memberships where user_id=%s and tenant_id=%s and project_id=%s and phase_id=%s and member_role='owner'", (U5,tenant_id,project_id,phase_id))
                assert cur.fetchone()[0] == 1, "Hopkins owner membership missing or duplicated"
                cur.execute("select count(*) from public.admin_profiles where user_id=%s", (U5,))
                assert cur.fetchone()[0] == 1, "onboarding created a second admin profile"
            superadmin = user_conn(server.get_uri("postgres"), U5)
            connections.append(superadmin)
            with superadmin.cursor() as cur:
                cur.execute("select public.is_super_admin_user()")
                assert cur.fetchone()[0] is True
        check("Super Admin gets Hopkins workspace access without changing its Wamule profile or permissions", super_admin_uses_hopkins_membership_without_profile_reassignment)

        def branding_conflict_does_not_overwrite():
            expect_error(service, onboard_sql, ('{"tokens":{"primary":"#000000"}}', PROFILE, U3))
            with admin.cursor() as cur:
                cur.execute("select value from public.project_settings where project_id=%s and key='tenant_theme'", (project_id,))
                assert cur.fetchone()[0] == {"tokens":{"primary":"#173f2d"}}
        check("repeat onboarding refuses branding drift without overwriting saved theme", branding_conflict_does_not_overwrite)

        # The default portable run keeps a tiny synthetic snapshot for clean CI.
        # --actual-hopkins exercises the exact fingerprinted private 775-feature
        # package in this same disposable database/backup/restore path.
        if actual_hopkins:
            feature_records = hopkins_snapshot["features"]
            snapshot_fingerprint = hopkins_snapshot["snapshotFingerprint"]
            source_image_sha = hopkins_snapshot["imageSha"]
            detection_source_sha = hopkins_snapshot["detectionSha"]
            correction_manifest_sha = hopkins_snapshot["manifestSha"]
            correction_manifest_revision = hopkins_snapshot["manifestRevision"]
        else:
            feature_records = [
                {"feature_key": "child:a", "demo_label": "Plot 001", "feature_kind": "demo_plot",
                 "parent_feature_key": "detection:L-028", "source_detection_id": "L-028",
                 "map_polygon": [{"x": 1, "y": 1}, {"x": 2, "y": 1}, {"x": 2, "y": 2}],
                 "provenance": {"label_status": "pending-unverified-demo-label"}},
                {"feature_key": "child:b", "demo_label": "Plot 002", "feature_kind": "demo_plot",
                 "parent_feature_key": "detection:L-028", "source_detection_id": "L-028",
                 "map_polygon": [{"x": 3, "y": 3}, {"x": 4, "y": 3}, {"x": 4, "y": 4}],
                 "provenance": {"label_status": "pending-unverified-demo-label"}},
            ]
            snapshot_fingerprint = "a" * 64
            source_image_sha = "b" * 64
            detection_source_sha = "c" * 64
            correction_manifest_sha = "d" * 64
            correction_manifest_revision = 24
        feature_count = len(feature_records)
        snapshot_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"wamule-hosted-pilot:{snapshot_fingerprint}"))
        identity_by_key = {
            item["feature_key"]: str(uuid.uuid5(uuid.NAMESPACE_URL,
                f"wamule-hosted-pilot:{tenant_id}:{project_id}:{phase_id}:{item['feature_key']}"))
            for item in feature_records
        }
        identity_a = identity_by_key[feature_records[0]["feature_key"]]
        version_id = "77777777-aaaa-4aaa-8aaa-777777777777"
        with service.cursor() as cur:
            cur.execute("insert into public.map_feature_snapshots(id,tenant_id,project_id,phase_id,snapshot_fingerprint,source_image_sha256,detection_source_sha256,correction_manifest_sha256,correction_manifest_revision,snapshot_version,outline_count) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,1,%s)", (snapshot_id,tenant_id,project_id,phase_id,snapshot_fingerprint,source_image_sha,detection_source_sha,correction_manifest_sha,correction_manifest_revision,feature_count))
            for item in feature_records:
                cur.execute("insert into public.map_feature_identities(id,tenant_id,project_id,phase_id,feature_key) values (%s,%s,%s,%s,%s) on conflict(tenant_id,project_id,phase_id,feature_key) do nothing", (identity_by_key[item["feature_key"]],tenant_id,project_id,phase_id,item["feature_key"]))
            feature_sql = """insert into public.map_features
                (tenant_id,project_id,phase_id,snapshot_id,identity_id,demo_label,feature_kind,
                 parent_feature_key,source_detection_id,map_polygon,provenance,public_visible)
                values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,true)
                on conflict(snapshot_id,identity_id) do update set
                  demo_label=excluded.demo_label, feature_kind=excluded.feature_kind,
                  parent_feature_key=excluded.parent_feature_key,
                  source_detection_id=excluded.source_detection_id,
                  map_polygon=excluded.map_polygon, provenance=excluded.provenance"""
            for item in feature_records:
                cur.execute(feature_sql, (tenant_id,project_id,phase_id,snapshot_id,
                    identity_by_key[item["feature_key"]],item["demo_label"],item["feature_kind"],
                    item.get("parent_feature_key"),item.get("source_detection_id"),
                    json.dumps(item["map_polygon"]),json.dumps(item["provenance"])))
            # Repeat the exact import as the idempotency/reimport assertion.
            for item in feature_records:
                cur.execute("insert into public.map_feature_identities(tenant_id,project_id,phase_id,feature_key) values (%s,%s,%s,%s) on conflict(tenant_id,project_id,phase_id,feature_key) do nothing", (tenant_id,project_id,phase_id,item["feature_key"]))
                cur.execute(feature_sql, (tenant_id,project_id,phase_id,snapshot_id,
                    identity_by_key[item["feature_key"]],item["demo_label"],item["feature_kind"],
                    item.get("parent_feature_key"),item.get("source_detection_id"),
                    json.dumps(item["map_polygon"]),json.dumps(item["provenance"])))
            cur.execute("insert into public.masterplan_versions(id,tenant_id,project_id,phase_id,version_number,image_url,file_name,is_active) values (%s,%s,%s,%s,1,'https://assets.test/hopkins.webp','hopkins.webp',false)", (version_id,tenant_id,project_id,phase_id))
            cur.execute("select public.activate_project_demo_map_snapshot(%s,%s)", (snapshot_id,version_id))

        def feature_reimport_is_idempotent_parent_suppressed():
            with admin.cursor() as cur:
                cur.execute("select count(*) from public.map_feature_identities where tenant_id=%s and project_id=%s", (tenant_id,project_id))
                assert cur.fetchone()[0] == feature_count
                cur.execute("select count(*),count(distinct identity_id) from public.map_features where snapshot_id=%s", (snapshot_id,))
                assert cur.fetchone() == (feature_count,feature_count)
                cur.execute("select outline_count,snapshot_fingerprint from public.map_feature_snapshots where id=%s", (snapshot_id,))
                assert cur.fetchone() == (feature_count,snapshot_fingerprint)
                cur.execute("""select count(*) from public.map_features f
                    join public.map_feature_identities i on i.id=f.identity_id
                    where f.snapshot_id=%s and f.parent_feature_key is not null
                      and exists (select 1 from public.map_feature_identities p
                        join public.map_features pf on pf.identity_id=p.id and pf.snapshot_id=f.snapshot_id
                        where p.feature_key=f.parent_feature_key)""", (snapshot_id,))
                assert cur.fetchone()[0] == 0, "a replaced parent detection is still displayed with its children"
                cur.execute("select is_active from public.map_feature_snapshots where id=%s", (snapshot_id,))
                assert cur.fetchone()[0] is True
                cur.execute("select map_experience_mode from public.projects where id=%s", (project_id,))
                assert cur.fetchone()[0] == "demo"
        check("geometry snapshot reimport is idempotent and contains child outlines, not a duplicate parent", feature_reimport_is_idempotent_parent_suppressed)

        with service.cursor() as cur:
            cur.execute("select id from public.leads where tenant_id=%s and client_reference_id='existing-reference'", (T1,))
            existing_lead = cur.fetchone()[0]
            cur.execute("select count(*) from public.lead_activities where lead_id=%s", (existing_lead,))
            existing_activity_count = cur.fetchone()[0]
            cur.execute("select count(*) from public.follow_up_tasks where lead_id=%s", (existing_lead,))
            existing_task_count = cur.fetchone()[0]

            inquiry_sql = "select public.create_scoped_public_inquiry(%s,%s,%s,'Demo Buyer','demo@example.test','5550123','Question','https://demo.test/map','[\"A specific lot\"]'::jsonb,'hopkins-inquiry-0001',null,%s,null)"
            cur.execute(inquiry_sql, (tenant_id,project_id,phase_id,identity_a))
            first = cur.fetchone()[0]
            cur.execute(inquiry_sql, (tenant_id,project_id,phase_id,identity_a))
            retry = cur.fetchone()[0]

        def inquiry_is_atomic_scoped_and_idempotent():
            assert first["ok"] is True and first["deduplicated"] is False
            assert retry["ok"] is True and retry["deduplicated"] is True
            with admin.cursor() as cur:
                cur.execute("select tenant_id,project_id,phase_id,map_feature_id,parcel_id from public.leads where id=%s", (first["lead_id"],))
                row = cur.fetchone()
                assert tuple(map(str,row[:4])) == (tenant_id,project_id,phase_id,identity_a) and row[4] is None, row
                cur.execute("select count(*) from public.leads where tenant_id=%s and client_reference_id='hopkins-inquiry-0001'", (tenant_id,))
                assert cur.fetchone()[0] == 1
                cur.execute("select count(*) from public.lead_activities where lead_id=%s", (first["lead_id"],))
                assert cur.fetchone()[0] == 1
                cur.execute("select count(*) from public.follow_up_tasks where lead_id=%s", (first["lead_id"],))
                assert cur.fetchone()[0] == 1
                cur.execute("select count(*) from public.lead_activities where lead_id=%s", (existing_lead,))
                assert cur.fetchone()[0] == existing_activity_count
                cur.execute("select count(*) from public.follow_up_tasks where lead_id=%s", (existing_lead,))
                assert cur.fetchone()[0] == existing_task_count
        check("selected demo feature creates a scoped lead/activity/follow-up once across retries", inquiry_is_atomic_scoped_and_idempotent)

        def inquiry_rejects_forged_scope_and_inventory_on_demo():
            expect_error(service, "select public.create_scoped_public_inquiry(%s,%s,%s,'Buyer','b@example.test',null,null,null,'[]'::jsonb,'forged-inquiry-0001',null,%s,null)", (T1,project_id,phase_id,identity_a))
            expect_error(service, "select public.create_scoped_public_inquiry(%s,%s,%s,'Buyer','b@example.test',null,null,null,'[]'::jsonb,'forged-inquiry-0002',%s,null,null)", (tenant_id,project_id,phase_id,parcel_id))
            expect_error(service, "insert into public.leads(tenant_id,project_id,phase_id,map_feature_id,full_name,client_reference_id) values (%s,%s,%s,%s,'Forged','forged-direct-0001')", (T1,project_id,phase_id,identity_a))
        check("forged tenant/project/phase combinations and demo-as-inventory inquiries are rejected", inquiry_rejects_forged_scope_and_inventory_on_demo)

        user1 = user_conn(server.get_uri("postgres"), U1)
        user2 = user_conn(server.get_uri("postgres"), U2)
        hopkins_user = user_conn(server.get_uri("postgres"), U3)
        read_only = user_conn(server.get_uri("postgres"), U4)
        anon = user_conn(server.get_uri("postgres"), U1, "anon")
        connections.extend([user1,user2,hopkins_user,read_only,anon])

        def tenant_secrets_are_server_only_and_migrated():
            with admin.cursor() as cur:
                cur.execute("select count(*) from information_schema.columns where table_schema='public' and table_name='organizations' and column_name='gemini_api_key'")
                assert cur.fetchone()[0] == 0, "plaintext organization key column remains"
                cur.execute("select has_function_privilege('authenticated','public.get_organization_gemini_api_key(uuid)','execute')")
                assert cur.fetchone()[0] is False, "authenticated role can execute the secret reader"
                cur.execute("select has_function_privilege('anon','public.get_organization_gemini_api_key(uuid)','execute')")
                assert cur.fetchone()[0] is False, "anon can execute the secret reader"
                cur.execute("select has_function_privilege('service_role','public.get_organization_gemini_api_key(uuid)','execute')")
                assert cur.fetchone()[0] is True, "server role cannot execute the secret reader"
            expect_error(user1, "select public.get_organization_gemini_api_key(%s)", (T1,))
            with service.cursor() as cur:
                cur.execute("select public.get_organization_gemini_api_key(%s)", (T1,))
                assert cur.fetchone()[0] == "fixture-private-key-one"
            claimed_service = user_conn(server.get_uri("postgres"), U1)
            connections.append(claimed_service)
            with claimed_service.cursor() as cur:
                cur.execute("select set_config('request.jwt.claim.role','service_role',false)")
            expect_error(claimed_service, "select public.get_organization_gemini_api_key(%s)", (T1,))
            with admin.cursor() as cur:
                cur.execute("select count(*) from vault.mock_secrets where name in ('organization-'||%s||'-gemini-api-key','organization-'||%s||'-gemini-api-key')", (T1,T2))
                assert cur.fetchone()[0] == 2, "tenant credentials were not migrated into the Vault fixture"
        check("organization AI credentials move to server-only Vault access without client exposure", tenant_secrets_are_server_only_and_migrated)

        def legacy_business_rpcs_reject_cross_tenant_record_ids():
            # Two-argument approval: tenant-one staff cannot pass tenant-two's lot.
            expect_error(user1, "select public.approve_application(%s,%s)", (1001,2002))
            # One-argument overload: tenant-one staff cannot approve tenant-two's known application ID.
            expect_error(user1, "select public.approve_application(%s)", (2002,))
            with admin.cursor() as cur:
                cur.execute("select status from public.applications where id in (1001,2002) order by id")
                assert cur.fetchall() == [("Pending Review",),("Pending Review",)]
                cur.execute("select status from public.parcels where id in (1001,2002) order by id")
                assert cur.fetchall() == [("Available",),("Available",)]
                # Application's own tenant is valid, but its linked parcel is
                # deliberately corrupted after preflight to test RPC-level
                # reference validation.
                cur.execute("insert into public.applications(id,tenant_id,first_name,last_name,phone,parcel_id,status) overriding system value values (1003,%s,'Bad','Reference','5551003',2002,'Pending Review')", (T1,))
            expect_error(user1, "select public.approve_application(%s)", (1003,))
            with admin.cursor() as cur:
                cur.execute("select status,parcel_id from public.applications where id=1003")
                assert cur.fetchone() == ("Pending Review",2002), "approval changed a cross-tenant linked application"
            # Successful same-tenant calls exercise both overloads.
            with user1.cursor() as cur:
                cur.execute("select public.approve_application(%s)", (1001,))
            with user2.cursor() as cur:
                cur.execute("select public.approve_application(%s,%s)", (2002,2002))

            expect_error(user1, "select public.void_contract(%s,'cross-tenant test')", (202,))
            expect_error(user1, "select public.void_payment_record(%s,'cross-tenant test')", (202,))
            expect_error(user1, "select public.void_contract(%s,'cross-reference test')", (303,))
            expect_error(user1, "select public.void_payment_record(%s,'cross-reference test')", (303,))
            with admin.cursor() as cur:
                cur.execute("select status,is_active from public.contracts where id=202")
                assert cur.fetchone() == ("active",True), "cross-tenant contract void had a side effect"
                cur.execute("select status,voided_at from public.transactions where id=202")
                assert cur.fetchone() == ("posted",None), "cross-tenant payment void had a side effect"
                cur.execute("select status,is_active from public.contracts where id=303")
                assert cur.fetchone() == ("active",True), "contract with cross-tenant customer/lot was voided"
                cur.execute("select status,voided_at from public.transactions where id=303")
                assert cur.fetchone() == ("posted",None), "payment with cross-tenant customer/contract was voided"

            # The mixed list deliberately places a same-tenant alternate first;
            # the tenant-two ID must reject the whole call before any release.
            expect_error(user1, "select * from public.release_alternate_reservations(%s,%s::uuid[],'cross-tenant test')",
                ('88888888-aaaa-4aaa-8aaa-888888888801',
                 ['88888888-aaaa-4aaa-8aaa-888888888802','88888888-aaaa-4aaa-8aaa-888888888803']))
            with admin.cursor() as cur:
                cur.execute("select status from public.lot_reservations where id in ('88888888-aaaa-4aaa-8aaa-888888888802','88888888-aaaa-4aaa-8aaa-888888888803') order by id")
                assert cur.fetchall() == [("reserved",),("reserved",)], "cross-tenant reservation call partially mutated rows"
            expect_error(user1, "select * from public.release_alternate_reservations(%s,%s::uuid[],'cross-reference test')",
                ('88888888-aaaa-4aaa-8aaa-888888888801',
                 ['88888888-aaaa-4aaa-8aaa-888888888802','88888888-aaaa-4aaa-8aaa-888888888804']))
            for invalid_reference in (
                '88888888-aaaa-4aaa-8aaa-888888888805',
                '88888888-aaaa-4aaa-8aaa-888888888806',
                '88888888-aaaa-4aaa-8aaa-888888888807',
            ):
                expect_error(user1, "select * from public.release_alternate_reservations(%s,%s::uuid[],'cross-reference test')",
                    ('88888888-aaaa-4aaa-8aaa-888888888801',
                     ['88888888-aaaa-4aaa-8aaa-888888888802',invalid_reference]))
            expect_error(user1, "select * from public.release_alternate_reservations(%s,%s::uuid[],'cross-reference test')",
                ('88888888-aaaa-4aaa-8aaa-888888888808',['88888888-aaaa-4aaa-8aaa-888888888802']))
            with admin.cursor() as cur:
                cur.execute("select status from public.lot_reservations where id='88888888-aaaa-4aaa-8aaa-888888888802'")
                assert cur.fetchone()[0] == "reserved", "release changed a valid row before discovering a cross-tenant reference"

            with user1.cursor() as cur:
                cur.execute("select public.void_payment_record(%s,'same-tenant test')", (101,))
                cur.fetchone()
                cur.execute("select public.void_contract(%s,'same-tenant test')", (101,))
                cur.fetchone()
                cur.execute("select * from public.release_alternate_reservations(%s,%s::uuid[],'same-tenant test')",
                    ('88888888-aaaa-4aaa-8aaa-888888888801',['88888888-aaaa-4aaa-8aaa-888888888802']))
                released=cur.fetchone()[0]
                assert [str(item) for item in released] == ['88888888-aaaa-4aaa-8aaa-888888888802'], f"same-tenant alternate release did not return expected child: {released}"
            with user2.cursor() as cur:
                cur.execute("select public.void_payment_record(%s,'same-tenant test')", (202,))
                cur.fetchone()
                cur.execute("select public.void_contract(%s,'same-tenant test')", (202,))
                cur.fetchone()
            with admin.cursor() as cur:
                cur.execute("select id from public.contract_void_resolutions where tenant_id=%s and contract_id=202", (T2,))
                tenant_two_resolution=cur.fetchone()[0]
            expect_error(user1, "select * from public.resolve_contract_void_resolution(%s,'release_lot','cross-tenant test',null)", (tenant_two_resolution,))
            with admin.cursor() as cur:
                cur.execute("select status from public.contract_void_resolutions where id=%s", (tenant_two_resolution,))
                assert cur.fetchone()[0] == "pending", "cross-tenant resolution changed state"
            for rpc, args in [
                ("select public.approve_application(%s)", (1001,)),
                ("select public.approve_application(%s,%s)", (1001,1001)),
                ("select public.void_contract(%s,'read-only')", (101,)),
                ("select public.void_payment_record(%s,'read-only')", (101,)),
                ("select * from public.release_alternate_reservations(%s,%s::uuid[],'read-only')", ('88888888-aaaa-4aaa-8aaa-888888888801',['88888888-aaaa-4aaa-8aaa-888888888802'])),
            ]:
                expect_error(read_only, rpc, args)
        check("both approval overloads and contract/payment/reservation RPCs reject cross-tenant IDs atomically", legacy_business_rpcs_reject_cross_tenant_record_ids)

        def project_and_business_isolation():
            with user1.cursor() as cur:
                cur.execute("select count(*) from public.projects")
                assert cur.fetchone()[0] == 1, "ordinary account can see another tenant project"
                cur.execute("select count(*) from public.leads")
                assert cur.fetchone()[0] == 1, "ordinary account does not see exactly its tenant lead"
                cur.execute("select count(*) from public.map_features")
                assert cur.fetchone()[0] == 0, "ordinary tenant can see Hopkins private feature geometry"
                cur.execute("select count(*) from public.organizations")
                assert cur.fetchone()[0] == 1, "ordinary account can read another tenant's organization configuration"
                cur.execute("select count(*) from public.leads where client_reference_id='hopkins-inquiry-0001'")
                assert cur.fetchone()[0] == 0, "tenant one can see a Hopkins inquiry lead"
                cur.execute("select count(*) from public.parcel_board_view")
                assert cur.fetchone()[0] == 2, "parcel board view bypassed tenant RLS"
                cur.execute("select count(*) from public.public_parcel_options")
                assert cur.fetchone()[0] == 2, "parcel options view bypassed tenant RLS"
                cur.execute("update public.leads set full_name='Forged update' where tenant_id=%s", (T2,))
                assert cur.rowcount == 0
            with user2.cursor() as cur:
                cur.execute("select count(*) from public.leads")
                assert cur.fetchone()[0] == 1, "ordinary account cannot see its own tenant lead"
                cur.execute("select count(*) from public.organizations")
                assert cur.fetchone()[0] == 1, "second ordinary account can read another organization's configuration"
                cur.execute("select count(*) from public.leads where client_reference_id='hopkins-inquiry-0001'")
                assert cur.fetchone()[0] == 0, "tenant two can see a Hopkins inquiry lead"
                cur.execute("select count(*) from public.parcel_board_view")
                assert cur.fetchone()[0] == 2, "second tenant can read the first tenant through the parcel view"
            with hopkins_user.cursor() as cur:
                cur.execute("select count(*) from public.map_features")
                assert cur.fetchone()[0] == feature_count, "authorized Hopkins member cannot see the complete imported snapshot"
                cur.execute("select id from public.leads where client_reference_id='hopkins-inquiry-0001'")
                staff_lead = cur.fetchone()
                assert staff_lead is not None, "authorized Hopkins staff cannot see the new public inquiry"
                cur.execute("select count(*) from public.lead_activities where lead_id=%s", (staff_lead[0],))
                assert cur.fetchone()[0] >= 1, "authorized Hopkins staff cannot see inquiry activity"
                cur.execute("select count(*) from public.follow_up_tasks where lead_id=%s", (staff_lead[0],))
                assert cur.fetchone()[0] == 1, "authorized Hopkins staff cannot see inquiry follow-up"
            with admin.cursor() as cur:
                cur.execute("select has_table_privilege('anon','public.public_parcel_options','select')")
                assert cur.fetchone()[0] is False, "anonymous role can query the unscoped legacy parcel view"
                for table in ("map_feature_snapshots","map_feature_identities","map_features"):
                    cur.execute("select has_table_privilege('anon',%s,'select')", (f"public.{table}",))
                    assert cur.fetchone()[0] is False, f"anon has direct access to {table}"
        check("two ordinary tenant accounts are isolated by project/phase RLS and features stay non-anonymous", project_and_business_isolation)

        def private_files_are_tenant_scoped_and_record_linked():
            with user1.cursor() as cur:
                cur.execute("select bucket_id,name from storage.objects where bucket_id in ('contracts','receipts','payment-documents','application-documents') order by bucket_id,name")
                visible_one = cur.fetchall()
                assert visible_one == [
                    ('contracts','101/contract-one.pdf'),
                    ('payment-documents','101/unlinked/payment-one.pdf'),
                    ('receipts','101/RCPT-ONE.pdf'),
                ], visible_one
                cur.execute("update storage.objects set name='101/forged.pdf' where name='202/contract-two.pdf'")
                assert cur.rowcount == 0, "tenant one modified tenant two's contract object"
                cur.execute("delete from storage.objects where name='202/contract-two.pdf'")
                assert cur.rowcount == 0, "tenant one deleted tenant two's contract object"
            expect_error(user1, "insert into storage.objects(bucket_id,name) values ('contracts','202/forged-upload.pdf')")
            with user2.cursor() as cur:
                cur.execute("select bucket_id,name from storage.objects where bucket_id in ('contracts','receipts','payment-documents') order by bucket_id,name")
                visible_two = cur.fetchall()
                assert visible_two == [
                    ('contracts','202/contract-two.pdf'),
                    ('payment-documents','202/unlinked/payment-two.pdf'),
                    ('receipts','202/RCPT-TWO.pdf'),
                ], visible_two
            expect_error(user2, "insert into storage.objects(bucket_id,name) values ('application-documents','202/unlinked/file.pdf')")
            expect_error(user1, "insert into public.application_documents(tenant_id,application_id,original_file_name,uploaded_by) values (%s,2002,'forged.pdf',%s)", (T1,U1))
            # Register a document through its composite tenant/application FK,
            # then exercise Storage's SELECT/sign, upload, update and delete RLS.
            with user1.cursor() as cur:
                cur.execute("insert into public.application_documents(tenant_id,application_id,original_file_name,uploaded_by) values (%s,1001,'application.pdf',%s) returning object_name", (T1,U1))
                application_path=cur.fetchone()[0]
                cur.execute("select public.can_write_application_document(%s,1001)", (T1,))
                assert cur.fetchone()[0] is True, "tenant document writer check denied its linked application"
                cur.execute("select count(*) from public.application_documents where object_name=%s", (application_path,))
                assert cur.fetchone()[0] == 1, "tenant cannot see its own application document registry row"
                cur.execute("select exists(select 1 from public.application_documents d where d.object_name=%s and public.can_write_application_document(d.tenant_id,d.application_id))", (application_path,))
                assert cur.fetchone()[0] is True, "tenant policy join does not match the registered object path"
                cur.execute("insert into storage.objects(bucket_id,name) values ('application-documents',%s)", (application_path,))
                cur.execute("select name from storage.objects where bucket_id='application-documents' and name=%s", (application_path,))
                assert cur.fetchone()[0] == application_path, "tenant could not read/list/sign its linked application file"
                cur.execute("select has_table_privilege('authenticated','public.application_documents','delete')")
                assert cur.fetchone()[0] is False, "tenant can delete application-document audit metadata"
            expect_error(user1, "update public.application_documents set application_id=2002 where object_name=%s", (application_path,))
            expect_error(user1, "update storage.objects set name='forged/application/path' where name=%s", (application_path,))
            with user2.cursor() as cur:
                cur.execute("select count(*) from storage.objects where bucket_id='application-documents' and name=%s", (application_path,))
                assert cur.fetchone()[0] == 0, "other tenant can read/sign application file"
                cur.execute("select count(*) from public.application_documents where object_name=%s", (application_path,))
                assert cur.fetchone()[0] == 0, "other tenant can list application file metadata"
                cur.execute("update storage.objects set name='cross-tenant.pdf' where name=%s", (application_path,))
                assert cur.rowcount == 0
                cur.execute("delete from storage.objects where name=%s", (application_path,))
                assert cur.rowcount == 0
            expect_error(user2, "insert into storage.objects(bucket_id,name) values ('application-documents',%s)", (application_path,))
            with user1.cursor() as cur:
                cur.execute("delete from storage.objects where bucket_id='application-documents' and name=%s", (application_path,))
                assert cur.rowcount == 1, "authorized tenant staff cannot delete its application document"
        check("private files follow tenant-linked records; cross-tenant and unscoped app files are blocked", private_files_are_tenant_scoped_and_record_linked)

        def privileged_rpcs_are_not_client_callable():
            with user1.cursor() as cur:
                cur.execute("select has_function_privilege('authenticated','public.onboard_project_tenant(text,text,text,text,text,text,jsonb,jsonb,uuid,text,boolean)','execute')")
                assert cur.fetchone()[0] is False, "ordinary authenticated role can call onboarding RPC"
                cur.execute("select has_function_privilege('authenticated','public.create_scoped_public_inquiry(uuid,uuid,uuid,text,text,text,text,text,jsonb,text,bigint,uuid,text)','execute')")
                assert cur.fetchone()[0] is False, "public inquiry writer is directly callable from a browser client"
        check("onboarding and atomic inquiry RPCs remain service-role-only", privileged_rpcs_are_not_client_callable)

        def membership_protects_storage_paths():
            object_name=f"{tenant_id}/{project_id}/{phase_id}/maps/test.webp"
            with hopkins_user.cursor() as cur:
                cur.execute("""with o as (select 'project-map-public'::text as bucket_id,%s::text as name)
                  select auth.uid()::text,public.user_can_manage_project(%s,%s),storage.foldername(o.name),
                    o.bucket_id='project-map-public' and o.name ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/maps/[a-z0-9_-]+\\.(webp|avif|png|jpe?g)$'
                    and exists(select 1 from public.development_phases ph where ph.tenant_id::text=(storage.foldername(o.name))[1] and ph.project_id::text=(storage.foldername(o.name))[2] and ph.id::text=(storage.foldername(o.name))[3] and public.user_can_manage_project(ph.tenant_id,ph.project_id)) from o""", (object_name,tenant_id,project_id))
                auth_id, can_manage, folders, policy_check = cur.fetchone()
                cur.execute("select roles,cmd,with_check from pg_policies where schemaname='storage' and tablename='objects' and policyname='Project managers upload map display images'")
                policy = cur.fetchone()
                assert auth_id == U3 and can_manage and folders[0] == tenant_id and folders[1] == project_id and folders[2] == phase_id and policy_check and policy is not None, (auth_id,can_manage,folders,policy_check,policy)
                cur.execute("insert into storage.objects(bucket_id,name) values ('project-map-public',%s)", (object_name,))
            expect_error(user2, "insert into storage.objects(bucket_id,name) values ('project-map-public',%s)", (f"{T1}/{P1}/{default_phase_t1}/maps/not-manager.webp",))
            expect_error(hopkins_user, "insert into storage.objects(bucket_id,name) values ('project-map-public',%s)", (f"{tenant_id}/{project_id}/{phase_id}/maps/source.pdf",))
        check("only the mapped Hopkins member can upload display rasters; private source formats are refused", membership_protects_storage_paths)

        def database_backup_restore_preserves_representative_rows():
            backup_path = work / "rehearsal-pre-restore.dump"
            pg_dump = POSTGRES_BIN_PATH / "pg_dump"
            pg_restore = POSTGRES_BIN_PATH / "pg_restore"
            dumped = subprocess.run(
                [str(pg_dump), "--format=custom", "--no-owner", "--no-privileges",
                 "--dbname", server.get_uri("postgres"), "--file", str(backup_path)],
                capture_output=True, text=True, timeout=90, check=False,
            )
            assert dumped.returncode == 0, f"embedded pg_dump failed: {dumped.stderr[:500]}"
            assert backup_path.is_file() and backup_path.stat().st_size > 0, "database backup artifact is empty"
            with admin.cursor() as cur:
                cur.execute("create database rehearsal_restore")
            restored = subprocess.run(
                [str(pg_restore), "--no-owner", "--no-privileges", "--dbname",
                 server.get_uri("rehearsal_restore"), str(backup_path)],
                capture_output=True, text=True, timeout=120, check=False,
            )
            assert restored.returncode == 0, f"embedded pg_restore failed: {restored.stderr[:700]}"
            tables = (
                "organizations", "applications", "parcels", "customers", "contracts",
                "transactions", "lot_reservations", "leads", "lead_activities",
                "follow_up_tasks", "map_feature_snapshots", "map_feature_identities",
                "map_features", "application_documents",
            )
            with psycopg.connect(server.get_uri("rehearsal_restore"), autocommit=True) as restored_db:
                with restored_db.cursor() as restored_cur, admin.cursor() as source_cur:
                    for table in tables:
                        source_cur.execute(f"select count(*) from public.{table}")
                        expected_count = source_cur.fetchone()[0]
                        restored_cur.execute(f"select count(*) from public.{table}")
                        actual_count = restored_cur.fetchone()[0]
                        assert actual_count == expected_count, f"restore changed {table} row count: {expected_count} -> {actual_count}"
                    source_cur.execute("select snapshot_fingerprint,outline_count from public.map_feature_snapshots order by created_at desc limit 1")
                    expected_snapshot = source_cur.fetchone()
                    restored_cur.execute("select snapshot_fingerprint,outline_count from public.map_feature_snapshots order by created_at desc limit 1")
                    assert restored_cur.fetchone() == expected_snapshot, "restore changed the geometry snapshot identity/count"
                    source_cur.execute("select count(*) from public.organization_secret_refs")
                    secret_reference_count = source_cur.fetchone()[0]
                    restored_cur.execute("select count(*) from public.organization_secret_refs")
                    assert restored_cur.fetchone()[0] == secret_reference_count, "restore dropped tenant secret references"
            # Intentionally do not print the dump or any row contents; tempdir
            # cleanup removes the rehearsal artifact after this process exits.
        check("database backup can be restored with tenant records and map snapshot identity intact", database_backup_restore_preserves_representative_rows)

        mode = f"actual Hopkins {feature_count}-feature snapshot {snapshot_fingerprint}" if actual_hopkins else "portable synthetic snapshot"
        print(f"# --- {passed}/{passed + len(failures)} passed (embedded PostgreSQL; no Docker; {mode}) ---")
        if failures:
            for name, message in failures:
                print(f"# FAIL {name}: {message}")
            raise SystemExit(1)
    finally:
        for connection in connections:
            try:
                connection.close()
            except Exception:
                pass
        if server is not None:
            try:
                server.cleanup()
            except Exception:
                pass
        shutil.rmtree(work, ignore_errors=True)

if __name__ == "__main__":
    main()
