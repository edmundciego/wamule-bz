import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("project-scoped map migration enforces data, activation, and API boundaries", { timeout: 120000 }, () => {
  const pgdata = mkdtempSync(join(tmpdir(), "wamule-project-scope-pg-"));
  const out = execFileSync(
    "python3",
    ["scripts/project-scope-db-harness.py", "--pgdata", pgdata, "--reset"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.match(out, /6\/6 passed/);
});
