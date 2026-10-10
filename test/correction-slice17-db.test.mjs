import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Slice 1.7 DB hardening: stage-write revocation, masterplan activation gate,
// bulk-seed nonces — all on embedded Postgres (pgserver, local only).
// No push, deploy, or hosted writes — pgdata lives in a temp dir.
test("slice17 hardening applies; stage/activation/seed invariants hold", { timeout: 120000 }, () => {
  const pgdata = mkdtempSync(join(tmpdir(), "wamule-slice17-pg-"));
  const out = execFileSync(
    "python3",
    ["scripts/slice17-db-harness.py", "--pgdata", pgdata, "--reset"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.match(out, /14\/14 passed/);
});
