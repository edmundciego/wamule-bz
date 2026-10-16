import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runProbe(...args) {
  return spawnSync("python3", ["scripts/probe-migration-bootstrap.py", ...args], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
}

test("legacy foundation candidates replay locally but retain distinct contracts", { timeout: 240_000 }, () => {
  const result = runProbe("--compare-candidates", "--diff-lines", "0");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /archive candidate:[\s\S]*PASS: all 43 migrations in the legacy comparison scope applied in order\./);
  assert.match(result.stdout, /root candidate:[\s\S]*PASS: all 43 migrations in the legacy comparison scope applied in order\./);
  assert.match(result.stdout, /admin_profiles primary key: PRIMARY KEY \(id\)/);
  assert.match(result.stdout, /admin_profiles primary key: PRIMARY KEY \(user_id\)/);
  assert.match(result.stdout, /receipt_job_status: Pending, Processing, Completed, Failed/);
  assert.match(result.stdout, /receipt_job_status: Queued, Processing, Completed, Failed/);
  assert.match(result.stdout, /parcels: 24 total; 24 numeric lot numbers/);
  assert.match(result.stdout, /Post-chain public-schema DDL comparison/);
  assert.match(result.stdout, /result: DIFFERENT/);
  assert.match(result.stdout, /catalog objects: 21 archive-only, 60 root-only, 16 changed in both/);
  assert.match(result.stdout, /TABLE: admin_profiles/);
  assert.match(result.stdout, /TYPE: receipt_job_status/);
  assert.match(result.stdout, /ROW SECURITY: transactions/);
  assert.match(result.stdout, /FUNCTION: approve_application\(bigint\)/);
  assert.match(result.stdout, /FUNCTION: handle_application_approval\(\)/);
  assert.match(result.stdout, /ACL: TABLE admin_profiles/);
  assert.match(result.stdout, /POLICY: applications Internal can read applications/);
  assert.match(result.stdout, /VIEW: customer_balance_view/);
  assert.match(result.stdout, /not Hopkins\/register evidence/);
});

test("fresh tracked migrations refuse to pass without an app-schema baseline", { timeout: 120_000 }, () => {
  const result = runProbe();
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /BLOCKED: 20260610000100_fix_lots_public_options\.sql/);
  const trackedCount = result.stdout.match(/Tracked migrations: (\d+)/)?.[1];
  assert.ok(trackedCount, result.stdout);
  assert.match(result.stdout, new RegExp(`Applied before blocker: 0/${trackedCount}`));
  assert.match(result.stdout, /type "public\.parcel_status" does not exist/);
});
