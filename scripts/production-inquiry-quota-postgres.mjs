import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.WAMULE_EMBEDDED_POSTGRES_MODULE;
if (!modulePath) throw new Error('Set WAMULE_EMBEDDED_POSTGRES_MODULE to the external embedded-postgres dist/index.js path.');
const { default: EmbeddedPostgres } = await import(pathToFileURL(resolve(modulePath)).href);
const portProbe = createServer();
await new Promise((resolvePromise, reject) => {
  portProbe.once('error', reject);
  portProbe.listen(0, '127.0.0.1', resolvePromise);
});
const port = portProbe.address().port;
await new Promise((resolvePromise, reject) => portProbe.close((error) => error ? reject(error) : resolvePromise()));

const directory = await mkdtemp(join(tmpdir(), 'wamule-quota-pg-'));
const database = new EmbeddedPostgres({
  databaseDir: join(directory, 'db'), user: 'postgres', password: randomBytes(32).toString('hex'),
  port, persistent: true, postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {},
});
const clients = [];
const hash = (value) => createHash('sha256').update(value).digest('hex');
let started = false;
async function client(role) {
  const c = database.getPgClient('postgres', '127.0.0.1');
  await c.connect();
  clients.push(c);
  if (role) await c.query(`set role ${role}`);
  return c;
}
async function reserve(c, projectId, recipient, ip = null) {
  const r = await c.query('select public.reserve_inquiry_confirmation_quota($1, $2, $3) as allowed', [projectId, recipient, ip]);
  return r.rows[0].allowed;
}
const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';
const PROJECT_CAP = '33333333-3333-4333-8333-333333333333';
try {
  await database.initialise();
  await database.start();
  started = true;
  const admin = await client();
  await admin.query(`create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.projects (id uuid primary key);
    create table public.leads (
      id uuid primary key,
      tenant_id uuid not null,
      project_id uuid not null references public.projects(id),
      phase_id uuid,
      source text not null,
      client_reference_id text,
      created_at timestamptz not null default pg_catalog.clock_timestamp(),
      unique (tenant_id, client_reference_id)
    );
    grant select, insert on public.leads to service_role`);
  await admin.query('insert into public.projects (id) values ($1), ($2), ($3)', [PROJECT_A, PROJECT_B, PROJECT_CAP]);
  await admin.query(`insert into public.leads (id, tenant_id, project_id, source, client_reference_id)
    values ($1, $2, $3, 'public_inquiry', 'pre-migration-inquiry')`,
  ['55555555-5555-4555-8555-555555555555', '99999999-9999-4999-8999-999999999999', PROJECT_A]);
  for (const name of [
    '20261120002343_inquiry_confirmation_email_quota.sql',
    '20261123033951_slice_b_public_inquiry_quotas_and_limits.sql',
  ]) {
    const migration = new URL(`../supabase/migrations/${name}`, import.meta.url);
    await admin.query(await readFile(migration, 'utf8'));
  }
  assert.deepEqual((await admin.query(`select max_leads, rolling_window::text from public.project_public_inquiry_limits
    where project_id = any($1::uuid[]) order by project_id`, [[PROJECT_A, PROJECT_B, PROJECT_CAP]])).rows,
  [
    { max_leads: 100, rolling_window: '24:00:00' },
    { max_leads: 100, rolling_window: '24:00:00' },
    { max_leads: 100, rolling_window: '24:00:00' },
  ], 'migration seeds all existing projects with the B1 100/24h allowance');
  assert.equal((await admin.query(`select count(*)::int as n from public.public_inquiry_lead_reservations
    where project_id=$1`, [PROJECT_A])).rows[0].n, 1,
  'migration backfills recent public leads into the protected rolling ledger');
  const PROJECT_NEW = '44444444-4444-4444-8444-444444444444';
  await admin.query('insert into public.projects (id) values ($1)', [PROJECT_NEW]);
  assert.deepEqual((await admin.query(`select max_leads, rolling_window::text from public.project_public_inquiry_limits
    where project_id = $1`, [PROJECT_NEW])).rows[0],
  { max_leads: 100, rolling_window: '24:00:00' }, 'new projects receive the same B1 allowance');
  const s = await client('service_role');
  const migrationPrivileges = await admin.query(`select
    has_table_privilege('anon','public.inquiry_confirmation_email_attempts','select') as anon_read,
    has_table_privilege('authenticated','public.inquiry_confirmation_email_attempts','insert') as auth_write,
    has_function_privilege('anon','public.reserve_inquiry_confirmation_quota(uuid,text,text)','execute') as anon_exec,
    has_function_privilege('authenticated','public.reserve_inquiry_confirmation_quota(uuid,text,text)','execute') as auth_exec,
    has_function_privilege('service_role','public.reserve_inquiry_confirmation_quota(uuid,text,text)','execute') as service_exec,
    has_table_privilege('anon','public.project_public_inquiry_limits','select') as anon_limit_read,
    has_table_privilege('service_role','public.project_public_inquiry_limits','select') as service_limit_read,
    has_table_privilege('anon','public.public_inquiry_lead_reservations','select') as anon_ledger_read,
    has_table_privilege('service_role','public.public_inquiry_lead_reservations','select') as service_ledger_read,
    (select relrowsecurity from pg_class where oid='public.inquiry_confirmation_email_attempts'::regclass) as email_rls,
    (select relrowsecurity from pg_class where oid='public.project_public_inquiry_limits'::regclass) as lead_limit_rls,
    (select relrowsecurity from pg_class where oid='public.public_inquiry_lead_reservations'::regclass) as lead_ledger_rls`);
  assert.deepEqual(migrationPrivileges.rows[0], {
    anon_read: false, auth_write: false, anon_exec: false, auth_exec: false, service_exec: true,
    anon_limit_read: false, service_limit_read: false, anon_ledger_read: false, service_ledger_read: false,
    email_rls: true, lead_limit_rls: true, lead_ledger_rls: true,
  });
  const anon = await client('anon');
  await assert.rejects(() => reserve(anon, PROJECT_A, hash('a'), hash('b')), {code: '42501'});
  await assert.rejects(() => anon.query('select * from public.inquiry_confirmation_email_attempts'), {code: '42501'});
  const auth = await client('authenticated');
  await assert.rejects(() => reserve(auth, PROJECT_A, hash('a'), hash('b')), {code: '42501'});
  await assert.rejects(() => s.query('select * from public.project_public_inquiry_limits'), {code: '42501'});
  assert.equal(await reserve(s, null, hash('recipient'), null), false);
  assert.equal(await reserve(s, PROJECT_A, 'not-a-digest', null), false);
  assert.equal(await reserve(s, PROJECT_A, hash('recipient'), 'A'.repeat(64)), false);
  assert.equal((await admin.query('select count(*)::int as n from public.inquiry_confirmation_email_attempts')).rows[0].n, 0);

  const c1 = await client('service_role');
  const c2 = await client('service_role');
  await c1.query('begin');
  assert.equal(await reserve(c1, PROJECT_A, hash('blocked-recipient'), hash('first-ip')), true);
  const blocked = reserve(c2, PROJECT_B, hash('blocked-recipient'), hash('second-ip'));
  const early = await Promise.race([blocked.then(() => 'resolved'), new Promise((r) => setTimeout(() => r('blocked'), 100))]);
  assert.equal(early, 'blocked');
  await c1.query('commit');
  assert.equal(await blocked, false);

  const batch1 = await Promise.all(Array.from({length: 24}, () => client('service_role')));
  const sameRecipient = await Promise.all(batch1.map((c, i) => reserve(c, PROJECT_A, hash('same-recipient'), hash(`different-ip-${i}`))));
  assert.equal(sameRecipient.filter(Boolean).length, 1);
  const batch2 = await Promise.all(Array.from({length: 24}, () => client('service_role')));
  const sameIp = await Promise.all(batch2.map((c, i) => reserve(c, PROJECT_A, hash(`different-recipient-${i}`), hash('same-ip'))));
  assert.equal(sameIp.filter(Boolean).length, 10);
  const deniedIndex = sameIp.findIndex((allowed) => !allowed);
  assert.equal(await reserve(s, PROJECT_B, hash(`different-recipient-${deniedIndex}`), hash('another-ip')), true, 'rejected IP reservation must not consume recipient quota');

  const oldEmail = hash('old-email');
  const oldIp = hash('old-ip');
  await admin.query(`insert into public.inquiry_confirmation_email_attempts (project_id,recipient_hash,ip_hash,attempted_at) values ($1,$2,$3,clock_timestamp() - interval '24 hours 1 second')`, [PROJECT_A, oldEmail, oldIp]);
  assert.equal(await reserve(s, PROJECT_A, oldEmail, oldIp), true, 'expired recipient, project, and IP attempts must not count');
  const oldRows = await admin.query(`select count(*)::int as n from public.inquiry_confirmation_email_attempts where attempted_at <= clock_timestamp() - interval '24 hours'`);
  assert.equal(oldRows.rows[0].n, 0, 'reservation prunes expired rows');

  const failedReservation = hash('consumed-even-with-no-provider-call');
  assert.equal(await reserve(s, PROJECT_A, failedReservation), true);
  assert.equal(await reserve(s, PROJECT_A, failedReservation, hash('another-unused-ip')), false);

  const projectCapClients = [...batch1, ...batch2, ...await Promise.all(Array.from({length: 3}, () => client('service_role')))];
  const projectAttempts = await Promise.all(projectCapClients.map((c, i) =>
    reserve(c, PROJECT_CAP, hash(`project-cap-concurrent-${i}`))));
  assert.equal(projectAttempts.filter(Boolean).length, 50, 'exactly 50 concurrent project reservations should succeed');
  assert.equal(await reserve(s, PROJECT_CAP, hash('project-cap-overflow')), false, 'the 51st project attempt must be refused');
  assert.equal(await reserve(s, PROJECT_B, hash('project-cap-overflow')), true, 'project allowance is independent across projects');

  await admin.query(`insert into public.project_public_inquiry_limits (project_id, max_leads, rolling_window)
    values ($1, 2, $2::interval) on conflict (project_id) do update
    set max_leads=excluded.max_leads, rolling_window=excluded.rolling_window`, [PROJECT_B, '24 hours']);
  const leadTenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const leadClients = projectCapClients.slice(0, 24);
  const leadAttempts = await Promise.all(leadClients.map(async (c, i) => {
    const reference = `lead-limit-${i}`;
    try {
      await c.query(`insert into public.leads (id, tenant_id, project_id, phase_id, source, client_reference_id)
        values ($1, $2, $3, $4, 'public_inquiry', $5)`, [randomUUID(), leadTenant, PROJECT_B, i % 2 ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', reference]);
      return { allowed: true, reference };
    } catch (error) {
      if (error.code !== 'P0001' || error.message !== 'public_inquiry_lead_limit_reached') throw error;
      return { allowed: false, reference };
    }
  }));
  assert.equal(leadAttempts.filter((attempt) => attempt.allowed).length, 2, 'a project-wide lead cap remains atomic across concurrent phases');
  const winningReference = leadAttempts.find((attempt) => attempt.allowed).reference;
  await admin.query(`insert into public.leads (id, tenant_id, project_id, phase_id, source, client_reference_id)
    values ($1, $2, $3, $4, 'public_inquiry', $5) on conflict (tenant_id, client_reference_id) do nothing`, [randomUUID(), leadTenant, PROJECT_B, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', winningReference]);
  assert.equal((await admin.query("select count(*)::int as n from public.leads where project_id=$1 and source='public_inquiry'", [PROJECT_B])).rows[0].n, 2, 'a retry reuses the existing lead and does not consume another slot at capacity');
  assert.equal((await admin.query('select count(*)::int as n from public.public_inquiry_lead_reservations where project_id=$1', [PROJECT_B])).rows[0].n, 2);
  const nonWinningReference = leadAttempts.find((attempt) => attempt.allowed && attempt.reference !== winningReference).reference;
  await admin.query(`update public.leads set source='staff_referral', created_at=clock_timestamp() - interval '30 days'
    where tenant_id=$1 and client_reference_id=$2`, [leadTenant, winningReference]);
  await admin.query('delete from public.leads where tenant_id=$1 and client_reference_id=$2', [leadTenant, nonWinningReference]);
  assert.equal((await admin.query('select count(*)::int as n from public.public_inquiry_lead_reservations where project_id=$1', [PROJECT_B])).rows[0].n, 2,
    'lead edits and deletion do not free B1 slots during the rolling window');
  await assert.rejects(() => s.query(`insert into public.leads (id, tenant_id, project_id, phase_id, source, client_reference_id)
    values ($1, $2, $3, $4, 'public_inquiry', 'lead-limit-after-edit-or-delete')`,
  [randomUUID(), leadTenant, PROJECT_B, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd']),
  {code: 'P0001', message: 'public_inquiry_lead_limit_reached'});
  await admin.query(`insert into public.leads (id, tenant_id, project_id, phase_id, source, client_reference_id)
    values ($1, $2, $3, $4, 'staff_referral', $5)`, [randomUUID(), leadTenant, PROJECT_B, null, 'staff-referral-unmetered']);

  console.log('PASS: fresh migration; service-role-only email RPC and RLS; 100/24h B1 allowance seeded for existing/new projects; recent-lead backfill; inaccessible rolling ledger; invalid input; cross-project recipient limit; blocking concurrency; 1/24 recipient and 10/24 IP limits; optional IP; concurrent project 50/24 email cap; 2-slot Postgres lead cap across phases with retry reuse and edit/delete resistance; expiry/pruning; reservations retained after provider failure');
} finally {
  await Promise.allSettled(clients.map((c) => c.end()));
  if (started) await database.stop();
  await rm(directory, {recursive:true, force:true});
}
