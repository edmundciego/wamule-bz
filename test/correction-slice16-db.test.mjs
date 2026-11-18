import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Slice 1.6 DB parity: applies supabase/migrations/20260925000000 to an
// embedded Postgres (pgserver, local only) with a stub auth.uid() and runs
// cross-tenant / append-only / rev-monotonic / waiver-reason / bypass checks.
// No push, deploy, or hosted writes — pgdata lives in a temp dir.
test("slice15 migration applies to embedded Postgres; DB invariants hold", { timeout: 120000 }, () => {
  const pgdata = mkdtempSync(join(tmpdir(), "wamule-slice16-pg-"));
  const out = execFileSync(
    "python3",
    ["scripts/slice16-db-harness.py", "--pgdata", pgdata, "--reset"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.match(out, /9\/9 passed/);
});
