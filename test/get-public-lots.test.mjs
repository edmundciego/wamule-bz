import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("get-public-lots is an unauthenticated tenant-scoped public API", async () => {
  const source = await read("supabase/functions/get-public-lots/index.ts");
  assert.match(source, /tenant/);
  assert.match(source, /from\("organizations"\)/);
  assert.match(source, /eq\("slug", tenantParam\)/);
  assert.match(source, /eq\("is_active", true\)/);
  assert.match(source, /inbound_alias/);
  assert.match(source, /404/);
  // No caller auth required: no Bearer token gate.
  assert.doesNotMatch(source, /Missing authorization token/);
});

test("get-public-lots returns the public availability schema with CORS", async () => {
  const source = await read("supabase/functions/get-public-lots/index.ts");
  assert.match(source, /Access-Control-Allow-Origin/);
  assert.match(source, /\*.*WordPress|WordPress|external fetches/i);
  assert.match(source, /masterplan_image_url/);
  assert.match(source, /from\("parcels"\)/);
  assert.match(source, /map_polygon/);
  assert.match(source, /lot_number/);
  assert.match(source, /price/);
  assert.match(source, /sanitizePolygon/);
  // Only public-safe parcel fields leave the function.
  assert.doesNotMatch(source, /auth_user_id/);
  assert.doesNotMatch(source, /gemini_api_key/);
});

test("get-public-lots joins the tier catalogue and computes the effective price", async () => {
  const source = await read("supabase/functions/get-public-lots/index.ts");

  // Tier catalogue read is display-safe only: no tenant_id, no audit columns.
  assert.match(source, /\.select\("tier_key, label, price_cents, corner_premium_cents, color_hex"\)/);
  assert.match(source, /from\("lot_tiers"\)/);
  assert.match(source, /eq\("is_active", true\)/);

  // Effective-price precedence mirrors SQL parcel_effective_price_cents:
  // override wins, then tier (+ corner premium), then legacy base_price.
  assert.match(source, /function computeEffectivePriceCents/);
  assert.match(source, /priceOverrideCents/);
  assert.match(source, /tierCornerPremiumCents/);
  assert.match(source, /isCorner/);
  assert.match(source, /Number\(input\.basePrice \?\? 0\) \* 100/);

  // Legacy `price` key (dollars) now carries the effective price so catalogue
  // edits flow to embeds without re-ingest.
  assert.match(source, /effective_price_cents/);
  assert.match(source, /\(effectiveCents \/ 100\)\.toFixed\(2\)/);
});

test("get-public-lots scopes rows to the active masterplan version without hiding legacy lots", async () => {
  const source = await read("supabase/functions/get-public-lots/index.ts");

  // Active version lookup is tenant-scoped and id-only.
  assert.match(source, /from\("masterplan_versions"\)/);
  assert.match(source, /eq\("is_active", true\)/);
  // Versioned rows must match the active version; NULL (legacy/unversioned)
  // rows stay visible so existing maps never blank on deploy.
  assert.match(source, /masterplan_version_id == null/);
  assert.match(source, /masterplan_version_id === activeVersionId/);
});

test("get-public-lots exposes tier display fields while keeping QA columns server-side", async () => {
  const source = await read("supabase/functions/get-public-lots/index.ts");

  for (const field of ["tier_key", "tier_label", "tier_color_hex", "is_corner", "effective_price_cents"]) {
    assert.ok(source.includes(field), `Public payload must include ${field}.`);
  }
  const allowlistMatch = source.match(/const PUBLIC_PARCEL_FIELDS = \[([^\]]+)\]/s);
  assert.ok(allowlistMatch, "PUBLIC_PARCEL_FIELDS allowlist must be declared.");
  for (const field of ["tier_key", "tier_label", "tier_color_hex", "is_corner", "effective_price_cents"]) {
    assert.ok(allowlistMatch[1].includes(`"${field}"`), `Allowlist must contain ${field}.`);
  }
  // QA/ops inputs may be read server-side for the price math, but must never
  // appear in the allowlist or the serialized output.
  for (const hidden of ["price_override_cents", "confidence", "needs_review", "geometry_source", "masterplan_version_id"]) {
    assert.ok(!allowlistMatch[1].includes(`"${hidden}"`), `Allowlist must not contain ${hidden}.`);
  }
});
