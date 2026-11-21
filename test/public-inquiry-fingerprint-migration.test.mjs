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

test("unverified-lot migration keeps fallback notes atomic and fingerprints retry semantics", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20261121120000_scoped_unverified_inquiry_lot_fallback.sql", import.meta.url), "utf8");
  const previous = await readFile(new URL("../supabase/migrations/20261120221140_safe_public_intake_retry_fingerprints.sql", import.meta.url), "utf8");
  assert.match(migration, /p_unverified_lot_reference text/);
  assert.match(migration, /snap\.is_active/);
  assert.match(migration, /pkg\.published_at is not null/);
  assert.match(migration, /f\.is_active and f\.public_visible/);
  assert.match(migration, /pc\.public_visible/);
  assert.match(migration, /not coalesce\(v_needs_review, true\)/);
  assert.match(migration, /for share of snap, pkg, f, pc/i);
  assert.match(migration, /p_hostname text/);
  assert.match(migration, /resolve_public_hostname\(v_hostname\)/);
  assert.match(migration, /create function public\.revalidate_public_inquiry_hostname/);
  assert.match(migration, /for share of b/i);
  assert.match(migration, /grant execute on function public\.revalidate_public_inquiry_hostname[\s\S]*?to service_role/i);
  assert.match(migration, /p_parcel_id := null/);
  assert.match(migration, /Unverified buyer-supplied lot reference:/);
  assert.match(migration, /'unverified_lot_reference',v_unverified_lot_reference/);
  assert.match(migration, /v_existing_fingerprint is null and v_existing\.parcel_id is distinct from p_parcel_id/);
  assert.match(migration, /'unverified_lot',v_existing_unverified_lot_reference is not null/);
  assert.match(migration, /follow_up_tasks[\s\S]*?the submitted lot reference is unverified/);
  assert.match(migration, /revoke all on function public\.create_scoped_public_inquiry\([\s\S]*?from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.create_scoped_public_inquiry\([\s\S]*?to service_role/i);
  assert.doesNotMatch(previous, /p_unverified_lot_reference/);
});
