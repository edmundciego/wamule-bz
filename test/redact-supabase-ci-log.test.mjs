import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);

test("CI failure excerpts redact URLs, JWTs, and named credential values", () => {
  const directory = mkdtempSync(join(tmpdir(), "wamule-redacted-log-"));
  const input = join(directory, "cli.log");
  try {
    const jwt = "eyJabcdefghij.abcdefghij.abcdefghij";
    writeFileSync(input, `failed at postgres://local:secret@127.0.0.1:54322/postgres anon key: ${jwt} service_role_key=local-secret\n`);
    const result = execFileSync("python3", ["scripts/redact-supabase-ci-log.py", input], { cwd: root, encoding: "utf8" });
    assert.match(result, /\[URL REDACTED\]/);
    assert.match(result, /\[JWT REDACTED\]/);
    assert.match(result, /\[CREDENTIAL REDACTED\]/);
    assert.equal(result.includes("secret@"), false);
    assert.equal(result.includes(jwt), false);
    assert.equal(result.includes("local-secret"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
