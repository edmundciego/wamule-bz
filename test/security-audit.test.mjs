import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const PUBLIC_PARCEL_FIELDS = new Set([
  "public_ref",
  "lot_number",
  "status",
  "price",
  "dimensions",
  "map_polygon",
  "tier_key",
  "tier_label",
  "tier_color_hex",
  "is_corner",
  "effective_price_cents",
  "sales_selectable",
  "inquiry_eligible",
  "is_map_detection",
]);

test("security hardening migration pins search_path on every SECURITY DEFINER function", async () => {
  const migration = await read("supabase/migrations/20260920000000_security_hardening_audit.sql");

  // Multi-tenant RLS helpers must be explicitly pinned.
  for (const fn of [
    "public.set_default_tenant_id()",
    "public.get_current_user_tenant_id()",
    "public.user_has_tenant_access(uuid)",
    "public.sync_active_masterplan()",
    "public.set_tenant_masterplan(uuid, text)",
  ]) {
    assert.ok(
      migration.includes(`'${fn}'`),
      `Expected explicit search_path pinning for ${fn}.`,
    );
  }

  // Every pin uses the hardened form: public first, pg_temp last.
  const pinMatches = migration.match(/alter function %s set search_path = public, pg_temp/g) ?? [];
  assert.ok(pinMatches.length >= 2, "Expected both explicit-list and catch-all sweeps to pin search_path = public, pg_temp.");

  // A catch-all sweep guarantees functions added later are also covered.
  assert.match(migration, /from pg_proc p/);
  assert.match(migration, /p\.prosecdef/);

  // The migration self-verifies: it fails loudly if any definer is left unpinned.
  assert.match(migration, /SECURITY DEFINER functions without pinned search_path/);
  assert.match(migration, /search_path=%pg_temp%/);
});

test("existing migration suite keeps SECURITY DEFINER functions pinnable by the hardening sweep", async () => {
  const migrations = await Promise.all([
    read("supabase/migrations/20260915000000_multi_tenant_foundation.sql"),
    read("supabase/migrations/20260916000000_tenant_default_trigger_and_vision.sql"),
    read("supabase/migrations/20260918000000_masterplan_image_storage.sql"),
    read("supabase/migrations/20260919000000_masterplan_versioning.sql"),
    read("supabase/migrations/20260714223959_20260714210447_critical_correctness_batch_1.sql"),
  ]);
  const combined = migrations.join("\n");
  const definerCount = (combined.match(/security definer/gi) ?? []).length;
  assert.ok(definerCount >= 15, `Expected at least 15 SECURITY DEFINER definitions across the audited migrations, found ${definerCount}.`);
  // Functions with default args must be pinned with their full signature so
  // the catch-all sweep's regprocedure lookup resolves them deterministically.
  assert.match(combined, /resolve_contract_void_resolution\(\s*p_resolution_id uuid/);
});

test("hosted pilot migration keeps legacy RPCs tenant-bound and provider secrets server-only", async () => {
  const [migration, inbound, clientTypes] = await Promise.all([
    read("supabase/migrations/20261015022233_tenant_rpc_secret_application_document_isolation.sql"),
    read("supabase/functions/receive-inbound-email/index.ts"),
    read("src/types/database.ts"),
  ]);

  for (const [declaration, privilege] of [
    [/create or replace function public\.approve_application\(p_application_id bigint\)/, /revoke all on function public\.approve_application\(bigint\) from service_role/],
    [/create or replace function public\.approve_application\(p_application_id bigint,\s*p_parcel_id bigint\)/, /revoke all on function public\.approve_application\(bigint,bigint\) from service_role/],
    [/create or replace function public\.void_contract\(p_contract_id bigint,p_void_reason text\)/, /revoke all on function public\.void_contract\(bigint,text\) from service_role/],
    [/create or replace function public\.void_payment_record\(p_transaction_id bigint,p_reason text\)/, /revoke all on function public\.void_payment_record\(bigint,text\) from service_role/],
    [/create or replace function public\.resolve_contract_void_resolution\([\s\S]*?p_reservation_id uuid default null/, /revoke all on function public\.resolve_contract_void_resolution\(uuid,text,text,uuid\) from service_role/],
    [/create or replace function public\.release_alternate_reservations\([\s\S]*?p_release_reason text/, /revoke all on function public\.release_alternate_reservations\(uuid,uuid\[\],text\) from service_role/],
  ]) {
    assert.ok(declaration.test(migration), `Missing or changed RPC declaration: ${declaration}`);
    assert.ok(privilege.test(migration), `Missing service_role revoke: ${privilege}`);
  }
  assert.match(migration, /public\._assert_tenant_actor\(v_application\.tenant_id/);
  assert.match(migration, /public\._assert_tenant_actor\(v_contract\.tenant_id/);
  assert.match(migration, /public\._assert_tenant_actor\(v_payment\.tenant_id/);
  assert.match(migration, /one or more selected reservations belong to another tenant/i);
  assert.match(migration, /create or replace function public\.get_organization_gemini_api_key/);
  assert.match(migration, /auth\.jwt\(\)->>'role'/);
  assert.match(migration, /vault\.create_secret/);
  assert.match(migration, /drop column gemini_api_key/);
  assert.match(migration, /grant execute on function public\.get_organization_gemini_api_key\(uuid\) to service_role/);
  assert.doesNotMatch(inbound, /select\([^\"]*gemini_api_key/);
  assert.match(inbound, /rpc\("get_organization_gemini_api_key"/);
  assert.doesNotMatch(clientTypes, /gemini_api_key/);
});

test("application documents require immutable tenant/application links for private storage access", async () => {
  const migration = await read("supabase/migrations/20261015022233_tenant_rpc_secret_application_document_isolation.sql");
  assert.ok(/foreign key \(application_id, tenant_id\)[\s\S]*?references public\.applications\(id, tenant_id\)/.test(migration));
  assert.ok(/generated always as[\s\S]*tenant_id::text \|\| '\/' \|\| application_id::text/.test(migration));
  assert.ok(/prevent_application_document_reparenting/.test(migration));
  assert.ok(/revoke delete on public\.application_documents from authenticated/.test(migration));
  assert.ok(/can_read_application_document\(d\.tenant_id,\s*d\.application_id\)/.test(migration));
  assert.ok(/can_write_application_document\(d\.tenant_id,\s*d\.application_id\)/.test(migration));
  assert.ok(/no legacy application-file path column/.test(migration));
});

test("get-public-lots rejects unauthorized field selects and allowlists the public payload", async () => {
  const fn = await read("supabase/functions/get-public-lots/index.ts");

  // Tight select bounds: public-safe parcel columns plus the tier/version/
  // project/provenance inputs needed server-side for price math, eligibility,
  // version and project
  // scoping (all stripped from the payload below). The internal row id is not
  // needed and is never selected.
  assert.match(fn, /\.select\("lot_number, status, base_price, dimensions, map_polygon, tier_key, is_corner, price_override_cents, masterplan_version_id, project_id, geometry_source, needs_review"\)/);
  assert.doesNotMatch(fn, /\.select\("id, lot_number/);

  // Sensitive columns must never be requested...
  for (const forbidden of ["zoning", "authorized_by", "internal_notes", "created_by", "auth_user_id", "gemini_api_key", "tenant_id", "confidence"]) {
    assert.ok(
      !fn.match(new RegExp(`\\.select\\("[^"]*\\b${forbidden}\\b`, "i")),
      `get-public-lots must not select sensitive column: ${forbidden}`,
    );
  }

  // Tier reads are project-scoped; the selected display fields are still
  // server-only inputs and never enter the parcel allowlist directly.
  assert.match(fn, /const tierFields = "tier_key, label, price_cents, corner_premium_cents, color_hex"/);
  assert.match(fn, /from\("project_lot_tiers"\)/);
  assert.match(fn, /from\("lot_tiers"\)/);

  // ...and the response layer must enforce an allowlist so unknown columns can
  // never leak even if the query bounds change later.
  assert.match(fn, /PUBLIC_PARCEL_FIELDS/);
  const allowlistMatch = fn.match(/const PUBLIC_PARCEL_FIELDS = \[([^\]]+)\]/s);
  assert.ok(allowlistMatch, "PUBLIC_PARCEL_FIELDS allowlist must be declared.");
  const allowlisted = allowlistMatch[1].split(",").map((entry) => entry.replaceAll('"', "").trim()).filter(Boolean);
  assert.deepEqual(
    new Set(allowlisted),
    PUBLIC_PARCEL_FIELDS,
    "Public parcel allowlist must contain exactly the fourteen public-safe fields.",
  );

  // Server-side price/version/project/provenance inputs must not leak into the payload.
  for (const hidden of ["price_override_cents", "masterplan_version_id", "project_id", "tenant_id", "confidence", "needs_review", "geometry_source"]) {
    assert.ok(!allowlisted.includes(hidden), `Public payload must not contain ${hidden}.`);
  }

  // Theme comes only from the shared allowlist (unknown keys dropped).
  assert.match(fn, /allowlistTheme/);

  // Response mapping must route through the allowlist serializer.
  assert.match(fn, /parcels: \(parcels \?\? \[\]\)\.map\(\(parcel, index\) =>\s+toPublicParcel/);
});

test("receive-inbound-email verifies Resend/Svix webhook signatures before processing", async () => {
  const fn = await read("supabase/functions/receive-inbound-email/index.ts");

  // Raw body must be captured before JSON parsing (HMAC is over exact bytes).
  assert.match(fn, /await request\.text\(\)/);
  assert.doesNotMatch(fn, /await request\.json\(\)\.catch/);

  // Svix headers must be read and required.
  for (const header of ["svix-id", "svix-timestamp", "svix-signature"]) {
    assert.match(fn, new RegExp(`request\\.headers\\.get\\("${header}"\\)`));
  }

  // HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` via Web Crypto.
  assert.match(fn, /name: "HMAC", hash: "SHA-256"/);
  assert.match(fn, /\$\{svixId\}\.\$\{svixTimestamp\}\.\$\{rawBody\}/);
  assert.match(fn, /crypto\.subtle\.verify/);
  assert.match(fn, /RESEND_WEBHOOK_SECRET/);

  // Missing/invalid signatures reject with 401; replay window is enforced.
  assert.match(fn, /Missing webhook signature headers\./);
  assert.match(fn, /Webhook signature verification failed\./);
  assert.match(fn, /status: 401/);
  assert.match(fn, /WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS/);

  // Bypass exists ONLY under an explicit development environment guard.
  const bypassMatch = fn.match(/if \(environment === "development"\) \{[\s\S]*?return \{ ok: true \};/);
  assert.ok(bypassMatch, "Development-only signature bypass must be guarded by ENVIRONMENT === 'development'.");
  assert.ok(bypassMatch.index > fn.indexOf("if (!secret) {"), "Bypass must live inside the missing-secret branch.");
});

test("needs_review transactions never mutate customer_balance_view totals", async () => {
  const [hardeningMigration, correctnessMigration] = await Promise.all([
    read("supabase/migrations/20260920000000_security_hardening_audit.sql"),
    read("supabase/migrations/20260714223959_20260714210447_critical_correctness_batch_1.sql"),
  ]);

  // contract_financial_summary counts ONLY posted contract-linked land payments.
  const summaryMatch = correctnessMigration.match(/create or replace view public\.contract_financial_summary[\s\S]*?group by c\.id;/);
  assert.ok(summaryMatch, "contract_financial_summary definition must exist in the correctness migration.");
  assert.match(summaryMatch[0], /t\.status = 'posted'/);
  assert.match(summaryMatch[0], /filter \(/);
  assert.doesNotMatch(summaryMatch[0], /'needs_review'/);

  // customer_balance_view must derive land figures from the posted-only summary
  // and filter community fees to posted as well.
  const balanceMatch = correctnessMigration.match(/create or replace view public\.customer_balance_view[\s\S]*?from public\.customers cu/);
  assert.ok(balanceMatch, "customer_balance_view definition must exist in the correctness migration.");
  assert.match(balanceMatch[0], /total_posted_land_paid/);
  assert.match(balanceMatch[0], /t\.status = 'posted'/);
  assert.doesNotMatch(balanceMatch[0], /'needs_review'/);

  // The hardening migration re-asserts both definitions with identical
  // posted-only filters, so a future filter removal fails migration deploy.
  const hardeningSummary = hardeningMigration.match(/create or replace view public\.contract_financial_summary[\s\S]*?group by c\.id;/);
  assert.ok(hardeningSummary, "Hardening migration must re-assert contract_financial_summary.");
  assert.match(hardeningSummary[0], /t\.status = 'posted'/);
  assert.doesNotMatch(hardeningSummary[0], /'needs_review'/);
  const hardeningBalance = hardeningMigration.match(/create or replace view public\.customer_balance_view[\s\S]*?from public\.customers cu/);
  assert.ok(hardeningBalance, "Hardening migration must re-assert customer_balance_view.");
  assert.match(hardeningBalance[0], /t\.status = 'posted'/);
  assert.doesNotMatch(hardeningBalance[0], /'needs_review'/);
});
test("masterplan preview warns when draft aspect ratio drifts from the active map", async () => {
  const [modal, helper] = await Promise.all([
    read("src/components/admin/settings/MasterplanPreviewModal.tsx"),
    read("src/lib/masterplan.ts"),
  ]);

  // Pure helper: computes relative variance between draft and active ratios.
  assert.match(helper, /export function calculateAspectDrift/);
  assert.match(helper, /ASPECT_DRIFT_THRESHOLD_PERCENT = 2/);
  assert.match(helper, /Math\.abs\(draftRatio - activeRatio\) \/ activeRatio \* 100/);

  // Modal probes intrinsic dimensions of BOTH images and renders the alert.
  assert.match(modal, /naturalWidth/);
  assert.match(modal, /naturalHeight/);
  assert.match(modal, /calculateAspectDrift\(draftImageDims, activeImageDims\)/);
  assert.match(modal, /role="alert"/);
  assert.match(
    modal,
    /Warning: Draft map aspect ratio differs from active map by \{ratioDrift\.toFixed\(1\)\}%\. Polygon shapes may require repositioning\./,
  );
});
