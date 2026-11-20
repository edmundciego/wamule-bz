import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("inquiry retry migration adds semantic fingerprints without changing the canonical source migration", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20261120221140_safe_public_intake_retry_fingerprints.sql", import.meta.url), "utf8");
  const previous = await readFile(new URL("../supabase/migrations/20261019194346_map_studio_packages_and_project_plot_content.sql", import.meta.url), "utf8");
  assert.match(migration, /keep the legacy signature while adding the fingerprint-aware overload/i);
  assert.doesNotMatch(migration, /drop function[^;]*create_scoped_public_inquiry/i);
  assert.match(migration, /create function public\.create_scoped_public_inquiry\(/i);
  assert.match(migration, /p_submission_fingerprint text/);
  assert.match(migration, /metadata->>'submission_fingerprint'/);
  assert.match(migration, /v_existing_fingerprint<>p_submission_fingerprint/);
  assert.match(migration, /'submission_fingerprint',p_submission_fingerprint/);
  assert.match(migration, /revoke all on function public\.create_scoped_public_inquiry\([\s\S]*?from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.create_scoped_public_inquiry\([\s\S]*?to service_role/i);
  assert.doesNotMatch(previous, /p_submission_fingerprint/);
});
