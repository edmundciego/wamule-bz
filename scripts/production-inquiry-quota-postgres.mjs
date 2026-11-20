import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
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
async function reserve(c, recipient, ip) {
  const r = await c.query('select public.reserve_inquiry_confirmation_quota($1, $2) as allowed', [recipient, ip]);
  return r.rows[0].allowed;
}
try {
  await database.initialise();
  await database.start();
  started = true;
  const admin = await client();
  await admin.query('create role anon; create role authenticated; create role service_role bypassrls');
  const migration = new URL('../supabase/migrations/20261120002343_inquiry_confirmation_email_quota.sql', import.meta.url);
  await admin.query(await readFile(migration, 'utf8'));
  const s = await client('service_role');
  const migrationPrivileges = await admin.query(`select
    has_table_privilege('anon','public.inquiry_confirmation_email_attempts','select') as anon_read,
    has_table_privilege('authenticated','public.inquiry_confirmation_email_attempts','insert') as auth_write,
    has_function_privilege('anon','public.reserve_inquiry_confirmation_quota(text,text)','execute') as anon_exec,
    has_function_privilege('authenticated','public.reserve_inquiry_confirmation_quota(text,text)','execute') as auth_exec,
    has_function_privilege('service_role','public.reserve_inquiry_confirmation_quota(text,text)','execute') as service_exec,
    (select relrowsecurity from pg_class where oid='public.inquiry_confirmation_email_attempts'::regclass) as rls`);
  assert.deepEqual(migrationPrivileges.rows[0], { anon_read: false, auth_write: false, anon_exec: false, auth_exec: false, service_exec: true, rls: true });
  const anon = await client('anon');
  await assert.rejects(() => reserve(anon, hash('a'), hash('b')), {code: '42501'});
  await assert.rejects(() => anon.query('select * from public.inquiry_confirmation_email_attempts'), {code: '42501'});
  const auth = await client('authenticated');
  await assert.rejects(() => reserve(auth, hash('a'), hash('b')), {code: '42501'});
  assert.equal(await reserve(s, null, hash('ip')), false);
  assert.equal(await reserve(s, 'not-a-digest', hash('ip')), false);
  assert.equal(await reserve(s, hash('recipient'), 'A'.repeat(64)), false);
  assert.equal((await admin.query('select count(*)::int as n from public.inquiry_confirmation_email_attempts')).rows[0].n, 0);

  const c1 = await client('service_role');
  const c2 = await client('service_role');
  await c1.query('begin');
  assert.equal(await reserve(c1, hash('blocked-recipient'), hash('first-ip')), true);
  const blocked = reserve(c2, hash('blocked-recipient'), hash('second-ip'));
  const early = await Promise.race([blocked.then(() => 'resolved'), new Promise((r) => setTimeout(() => r('blocked'), 100))]);
  assert.equal(early, 'blocked');
  await c1.query('commit');
  assert.equal(await blocked, false);

  const batch1 = await Promise.all(Array.from({length: 24}, () => client('service_role')));
  const sameRecipient = await Promise.all(batch1.map((c, i) => reserve(c, hash('same-recipient'), hash(`different-ip-${i}`))));
  assert.equal(sameRecipient.filter(Boolean).length, 1);
  const batch2 = await Promise.all(Array.from({length: 24}, () => client('service_role')));
  const sameIp = await Promise.all(batch2.map((c, i) => reserve(c, hash(`different-recipient-${i}`), hash('same-ip'))));
  assert.equal(sameIp.filter(Boolean).length, 10);
  const deniedIndex = sameIp.findIndex((allowed) => !allowed);
  assert.equal(await reserve(s, hash(`different-recipient-${deniedIndex}`), hash('another-ip')), true, 'rejected IP reservation must not consume recipient quota');

  const oldEmail = hash('old-email');
  const oldIp = hash('old-ip');
  await admin.query(`insert into public.inquiry_confirmation_email_attempts values ($1, $2, clock_timestamp() - interval '24 hours 1 second')`, [oldEmail, oldIp]);
  assert.equal(await reserve(s, oldEmail, oldIp), true, 'expired recipient and IP attempts must not count');
  const oldRows = await admin.query(`select count(*)::int as n from public.inquiry_confirmation_email_attempts where attempted_at <= clock_timestamp() - interval '24 hours'`);
  assert.equal(oldRows.rows[0].n, 0, 'reservation prunes expired rows');

  const failedReservation = hash('consumed-even-with-no-provider-call');
  assert.equal(await reserve(s, failedReservation, hash('unused-ip')), true);
  assert.equal(await reserve(s, failedReservation, hash('another-unused-ip')), false);
  console.log('PASS: migration applied; privileges and RLS; invalid input; blocking concurrency; 1/24 recipient and 10/24 IP concurrent reservations; denied reservation; rolling expiry and pruning; reservation retained without provider call');
} finally {
  await Promise.allSettled(clients.map((c) => c.end()));
  if (started) await database.stop();
  await rm(directory, {recursive:true, force:true});
}
