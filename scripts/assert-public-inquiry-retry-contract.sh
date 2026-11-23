#!/usr/bin/env bash
set -euo pipefail

database_url="${SCHEMA_QUERY_DATABASE_URL:?SCHEMA_QUERY_DATABASE_URL is required}"
tenant_id="f0000000-0000-4000-8000-000000000001"
project_id="f0000000-0000-4000-8000-000000000002"
phase_id="f0000000-0000-4000-8000-000000000003"
second_phase_id="f0000000-0000-4000-8000-000000000004"
reference="rpc-contract-inquiry-concurrency-2026"
fingerprint="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
fallback_reference="rpc-contract-inquiry-unverified-lot-2026"
fallback_fingerprint="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
tmpdir="$(mktemp -d)"

cleanup() {
  psql "$database_url" -X -q -v ON_ERROR_STOP=1 <<SQL
delete from public.follow_up_tasks
where lead_id in (select id from public.leads where tenant_id='${tenant_id}' and client_reference_id in ('${reference}','${fallback_reference}'));
delete from public.leads where tenant_id='${tenant_id}' and client_reference_id in ('${reference}','${fallback_reference}');
delete from public.development_phases where id='${phase_id}';
delete from public.development_phases where id='${second_phase_id}';
delete from public.projects where id='${project_id}';
delete from public.organizations where id='${tenant_id}';
SQL
  rm -rf "$tmpdir"
}
trap cleanup EXIT

psql "$database_url" -X -q -v ON_ERROR_STOP=1 <<SQL
insert into public.organizations(id, name, slug)
values ('${tenant_id}', 'RPC Contract Tenant', 'rpc-contract-tenant')
on conflict (id) do nothing;
insert into public.projects(id, tenant_id, slug, name, is_default, map_experience_mode)
values ('${project_id}', '${tenant_id}', 'rpc-contract-project', 'RPC Contract Project', true, 'sales')
on conflict (id) do nothing;
insert into public.development_phases(id, tenant_id, project_id, slug, name, is_default, is_active)
values ('${phase_id}', '${tenant_id}', '${project_id}', 'initial', 'Initial', true, true)
on conflict (id) do nothing;
insert into public.development_phases(id, tenant_id, project_id, slug, name, is_default, is_active)
values ('${second_phase_id}', '${tenant_id}', '${project_id}', 'phase-two', 'Phase Two', false, true)
on conflict (id) do nothing;
insert into public.project_public_inquiry_limits(project_id, max_leads, rolling_window)
values ('${project_id}', 2, interval '24 hours')
on conflict (project_id) do update
set max_leads=excluded.max_leads, rolling_window=excluded.rolling_window;
SQL

cat > "$tmpdir/call.sql" <<SQL
set role service_role;
select public.create_scoped_public_inquiry(
  p_tenant_id => '${tenant_id}'::uuid,
  p_project_id => '${project_id}'::uuid,
  p_phase_id => '${phase_id}'::uuid,
  p_name => 'RPC Contract Buyer',
  p_email => 'rpc-contract@example.test',
  p_phone => null,
  p_message => 'Please send project details.',
  p_page_url => 'https://rpc-contract.example.test/project',
  p_interests => '["General project interest"]'::jsonb,
  p_client_reference_id => '${reference}',
  p_submission_fingerprint => '${fingerprint}',
  p_parcel_id => null,
  p_map_feature_id => null,
  p_duplicate_reason => null,
  p_unverified_lot_reference => null,
  p_hostname => null
);
reset role;
SQL

{
  printf 'begin;\n'
  cat "$tmpdir/call.sql"
  printf 'select pg_sleep(8);\ncommit;\n'
} > "$tmpdir/leader.sql"

PGAPPNAME=public-inquiry-retry-leader psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At \
  -f "$tmpdir/leader.sql" > "$tmpdir/leader.json" &
leader_pid=$!

leader_ready=false
for _ in $(seq 1 50); do
  active="$(psql "$database_url" -X -q -At -v ON_ERROR_STOP=1 -c \
    "select exists(select 1 from pg_stat_activity where application_name='public-inquiry-retry-leader' and state='active' and wait_event='PgSleep');")"
  if [[ "$active" == "t" ]]; then
    leader_ready=true
    break
  fi
  sleep 0.1
done
if [[ "$leader_ready" != true ]]; then
  echo "The first inquiry RPC did not reach its held-open transaction." >&2
  exit 1
fi

PGAPPNAME=public-inquiry-retry-retry psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At \
  -f "$tmpdir/call.sql" > "$tmpdir/retry.json" &
retry_pid=$!

retry_waiting=false
for _ in $(seq 1 50); do
  waiting="$(psql "$database_url" -X -q -At -v ON_ERROR_STOP=1 -c \
    "select exists(select 1 from pg_stat_activity where application_name='public-inquiry-retry-retry' and state='active' and wait_event_type='Lock');")"
  if [[ "$waiting" == "t" ]]; then
    retry_waiting=true
    break
  fi
  sleep 0.1
done
if [[ "$retry_waiting" != true ]]; then
  echo "The concurrent retry did not wait on PostgreSQL's unique-key arbitration." >&2
  exit 1
fi

wait "$leader_pid"
wait "$retry_pid"
node --input-type=module - "$tmpdir/leader.json" "$tmpdir/retry.json" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readResult(path) {
  const line = readFileSync(path, "utf8").split(/\r?\n/).find((value) => value.startsWith("{"));
  assert.ok(line, `missing RPC result in ${path}`);
  return JSON.parse(line);
}

const results = [readResult(process.argv[2]), readResult(process.argv[3])];
assert.ok(results.every((result) => result.ok === true), "both retry results must succeed");
assert.equal(results.filter((result) => result.deduplicated === false).length, 1, "one call must create the lead");
assert.equal(results.filter((result) => result.deduplicated === true).length, 1, "one call must deduplicate");
assert.equal(new Set(results.map((result) => result.lead_id)).size, 1, "both calls must resolve to one lead");
NODE

cat > "$tmpdir/conflict.sql" <<SQL
set role service_role;
select public.create_scoped_public_inquiry(
  p_tenant_id => '${tenant_id}'::uuid,
  p_project_id => '${project_id}'::uuid,
  p_phase_id => '${phase_id}'::uuid,
  p_name => 'RPC Contract Buyer',
  p_email => 'rpc-contract@example.test',
  p_phone => null,
  p_message => 'Please send different project details.',
  p_page_url => 'https://rpc-contract.example.test/project',
  p_interests => '["General project interest"]'::jsonb,
  p_client_reference_id => '${reference}',
  p_submission_fingerprint => 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  p_parcel_id => null,
  p_map_feature_id => null,
  p_duplicate_reason => null,
  p_unverified_lot_reference => null,
  p_hostname => null
);
reset role;
SQL
psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At -f "$tmpdir/conflict.sql" > "$tmpdir/conflict.json"
node --input-type=module - "$tmpdir/conflict.json" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const line = readFileSync(process.argv[2], "utf8").split(/\r?\n/).find((value) => value.startsWith("{"));
assert.ok(line, "missing changed-content RPC result");
assert.equal(JSON.parse(line).conflict, true, "changed content with the same reference must conflict");
NODE

counts="$(psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At <<SQL
select
  (select count(*) from public.leads where tenant_id='${tenant_id}' and client_reference_id='${reference}') || '|' ||
  (select count(*) from public.lead_activities where tenant_id='${tenant_id}' and metadata->>'submission_fingerprint'='${fingerprint}') || '|' ||
  (select count(*) from public.follow_up_tasks where lead_id=(select id from public.leads where tenant_id='${tenant_id}' and client_reference_id='${reference}'));
SQL
)"
if [[ "$counts" != "1|1|1" ]]; then
  echo "Expected one lead, activity, and follow-up; observed ${counts}." >&2
  exit 1
fi

cat > "$tmpdir/unverified.sql" <<SQL
set role service_role;
select public.create_scoped_public_inquiry(
  p_tenant_id => '${tenant_id}'::uuid,
  p_project_id => '${project_id}'::uuid,
  p_phase_id => '${phase_id}'::uuid,
  p_name => 'RPC Contract Fallback Buyer',
  p_email => 'rpc-contract-fallback@example.test',
  p_phone => null,
  p_message => 'Please send current options.',
  p_page_url => 'https://rpc-contract.example.test/project',
  p_interests => '["Available lots"]'::jsonb,
  p_client_reference_id => '${fallback_reference}',
  p_submission_fingerprint => '${fallback_fingerprint}',
  p_parcel_id => null,
  p_map_feature_id => null,
  p_duplicate_reason => null,
  p_unverified_lot_reference => 'plr2:rpc-contract-project:initial:unpublished-lot',
  p_hostname => null
);
reset role;
SQL
psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At -f "$tmpdir/unverified.sql" > "$tmpdir/unverified.json"
psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At -f "$tmpdir/unverified.sql" > "$tmpdir/unverified-retry.json"
node --input-type=module - "$tmpdir/unverified.json" "$tmpdir/unverified-retry.json" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readResult(path) {
  const line = readFileSync(path, "utf8").split(/\r?\n/).find((value) => value.startsWith("{"));
  assert.ok(line, `missing fallback RPC result in ${path}`);
  return JSON.parse(line);
}

const results = [readResult(process.argv[2]), readResult(process.argv[3])];
assert.equal(results[0].ok, true);
assert.equal(results[0].unverified_lot, true);
assert.equal(results[1].ok, true);
assert.equal(results[1].deduplicated, true);
assert.equal(results[1].unverified_lot, true);
assert.equal(results[0].lead_id, results[1].lead_id);
NODE

fallback_counts="$(psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At <<SQL
select
  (select count(*) from public.leads where tenant_id='${tenant_id}' and client_reference_id='${fallback_reference}') || '|' ||
  (select count(*) from public.leads where tenant_id='${tenant_id}' and client_reference_id='${fallback_reference}' and parcel_id is null) || '|' ||
  (select count(*) from public.lead_activities where tenant_id='${tenant_id}' and metadata->>'unverified_lot_reference'='plr2:rpc-contract-project:initial:unpublished-lot') || '|' ||
  (select count(*) from public.follow_up_tasks where lead_id=(select id from public.leads where tenant_id='${tenant_id}' and client_reference_id='${fallback_reference}'));
SQL
)"
if [[ "$fallback_counts" != "1|1|1|1" ]]; then
  echo "Expected one unlinked fallback lead, internal note, and follow-up; observed ${fallback_counts}." >&2
  exit 1
fi

psql "$database_url" -X -q -v ON_ERROR_STOP=1 <<SQL
set role service_role;
do \$\$
begin
  perform public.create_scoped_public_inquiry(
    p_tenant_id => '${tenant_id}'::uuid,
    p_project_id => '${project_id}'::uuid,
    p_phase_id => '${second_phase_id}'::uuid,
    p_name => 'RPC Contract Over-Limit Buyer',
    p_email => 'rpc-contract-over-limit@example.test',
    p_phone => null,
    p_message => 'This third inquiry should be rejected.',
    p_page_url => 'https://rpc-contract.example.test/phase-two',
    p_interests => '["General project interest"]'::jsonb,
    p_client_reference_id => 'rpc-contract-inquiry-over-limit-2026',
    p_submission_fingerprint => 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    p_parcel_id => null,
    p_map_feature_id => null,
    p_duplicate_reason => null
  );
  raise exception 'expected project lead limit to reject the third inquiry';
exception when sqlstate 'P0001' then
  if sqlerrm <> 'public_inquiry_lead_limit_reached' then raise; end if;
end;
\$\$;
reset role;
SQL

project_limit_counts="$(psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At <<SQL
select
  (select count(*) from public.leads where project_id='${project_id}' and source='public_inquiry') || '|' ||
  (select count(*) from public.follow_up_tasks where lead_id in (select id from public.leads where project_id='${project_id}' and source='public_inquiry'));
SQL
)"
if [[ "$project_limit_counts" != "2|2" ]]; then
  echo "Expected two project-wide inquiries with one follow-up each after limit rejection; observed ${project_limit_counts}." >&2
  exit 1
fi

# B1 charges accepted lead creation, not the current contents of the mutable
# leads table. Editing or deleting recent leads must not free rolling slots.
psql "$database_url" -X -q -v ON_ERROR_STOP=1 <<SQL
update public.leads
set source='staff_referral', created_at=clock_timestamp() - interval '30 days'
where tenant_id='${tenant_id}' and client_reference_id='${reference}';
delete from public.leads
where tenant_id='${tenant_id}' and client_reference_id='${fallback_reference}';
SQL

ledger_count="$(psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At -c \
  "select count(*) from public.public_inquiry_lead_reservations where project_id='${project_id}'")"
if [[ "$ledger_count" != "2" ]]; then
  echo "Expected two retained rolling reservations after lead edit/delete; observed ${ledger_count}." >&2
  exit 1
fi

psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At -f "$tmpdir/call.sql" > "$tmpdir/edit-retry.json"
node --input-type=module - "$tmpdir/edit-retry.json" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const line = readFileSync(process.argv[2], "utf8").split(/\r?\n/).find((value) => value.startsWith("{"));
assert.ok(line, "missing edited-lead retry result");
assert.equal(JSON.parse(line).ok, true);
assert.equal(JSON.parse(line).deduplicated, true, "an existing idempotency reference remains successful at capacity after a lead edit/delete");
NODE

psql "$database_url" -X -q -v ON_ERROR_STOP=1 <<SQL
set role service_role;
do \$\$
begin
  perform public.create_scoped_public_inquiry(
    p_tenant_id => '${tenant_id}'::uuid,
    p_project_id => '${project_id}'::uuid,
    p_phase_id => '${second_phase_id}'::uuid,
    p_name => 'RPC Contract Over-Limit After Lead Changes',
    p_email => 'rpc-contract-over-limit-after-changes@example.test',
    p_phone => null,
    p_message => 'Lead edits and deletion must not create another slot.',
    p_page_url => 'https://rpc-contract.example.test/phase-two',
    p_interests => '["General project interest"]'::jsonb,
    p_client_reference_id => 'rpc-contract-inquiry-over-limit-after-lead-changes-2026',
    p_submission_fingerprint => 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    p_parcel_id => null,
    p_map_feature_id => null,
    p_duplicate_reason => null,
    p_unverified_lot_reference => null,
    p_hostname => null
  );
  raise exception 'expected retained project lead reservations to reject a new inquiry';
exception when sqlstate 'P0001' then
  if sqlerrm <> 'public_inquiry_lead_limit_reached' then raise; end if;
end;
\$\$;
reset role;
SQL

echo "Public inquiry concurrency and semantic retry contract passed."
