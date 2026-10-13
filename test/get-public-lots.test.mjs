import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import {
  applyActiveVersionProjectScope,
  applyProjectAndVersionScope,
  chooseResolvedProject,
  normalizeActiveMapLookup,
  projectAllowsTenantFallback,
} from "../supabase/functions/get-public-lots/project-scope.mjs";

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
  assert.match(source, /const tierFields = "tier_key, label, price_cents, corner_premium_cents, color_hex"/);
  assert.match(source, /from\("project_lot_tiers"\)/);
  assert.match(source, /from\("lot_tiers"\)/);
  assert.match(source, /projectAllowsTenantFallback\(project\)/);
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

test("get-public-lots scopes map, settings, tiers, and parcels to a selected project", async () => {
  const source = await read("supabase/functions/get-public-lots/index.ts");
  const scope = await read("supabase/functions/get-public-lots/project-scope.mjs");

  // Active map and optional mobile rendition come from the same version.
  assert.match(source, /from\("masterplan_versions"\)/);
  assert.match(source, /select\("id, image_url, preview_url"\)/);
  assert.match(source, /from\("project_settings"\)/);
  assert.match(source, /buildTheme\(publicSettings, organization\.id, project\)/);
  assert.match(source, /unsupported or unsafe project theme CSS URL/);
  // Both project and version boundaries are applied in the database query.
  assert.match(source, /applyProjectAndVersionScope\([\s\S]*?project,[\s\S]*?activeVersion\?\.id/);
  assert.match(scope, /masterplan_version_id\.is\.null,masterplan_version_id\.eq\./);
  assert.match(scope, /scoped\.eq\("project_id", project\.id\)/);
});

test("get-public-lots normalizes is_default before legacy project rows are filtered", async () => {
  const source = await read("supabase/functions/get-public-lots/index.ts");
  assert.match(source, /applyProjectAndVersionScope,[\s\S]*?chooseResolvedProject,[\s\S]*?from "\.\/project-scope\.mjs"/);
  assert.match(source, /project: chooseResolvedProject\(rows, slug\)/);

  const rows = [
    { id: "default-id", slug: "main", name: "Main", is_default: true },
    { id: "phase-id", slug: "phase-two", name: "Phase Two", is_default: false },
  ];

  assert.deepEqual(chooseResolvedProject(rows, null), {
    id: "default-id",
    slug: "main",
    name: "Main",
    isDefault: true,
  });
  assert.deepEqual(chooseResolvedProject(rows, "phase-two"), {
    id: "phase-id",
    slug: "phase-two",
    name: "Phase Two",
    isDefault: false,
  });
  assert.equal(chooseResolvedProject(rows, "missing"), null);
  assert.equal(chooseResolvedProject([], null), null);
  assert.equal(chooseResolvedProject([{ id: "phase-id", slug: "phase-two", name: "Phase Two", is_default: false }], null), null);
  assert.equal(projectAllowsTenantFallback(null), true);
  assert.equal(projectAllowsTenantFallback({ isDefault: true }), true);
  assert.equal(projectAllowsTenantFallback({ isDefault: false }), false);
});

test("public parcel query is scoped to one project and the active map version", () => {
  const makeQuery = () => {
    const calls = [];
    const query = { calls };
    for (const method of ["eq", "is", "or"]) {
      query[method] = (...args) => {
        calls.push([method, ...args]);
        return query;
      };
    }
    return query;
  };

  const defaultProjectQuery = makeQuery();
  applyProjectAndVersionScope(defaultProjectQuery, {
    id: "default-id",
    slug: "main",
    name: "Main",
    isDefault: true,
  }, "version-id");
  assert.deepEqual(defaultProjectQuery.calls, [
    ["eq", "project_id", "default-id"],
    ["or", "masterplan_version_id.is.null,masterplan_version_id.eq.version-id"],
  ]);

  const phaseQuery = makeQuery();
  applyProjectAndVersionScope(phaseQuery, {
    id: "phase-id",
    slug: "phase-two",
    name: "Phase Two",
    isDefault: false,
  }, "version-id");
  assert.deepEqual(phaseQuery.calls, [
    ["eq", "project_id", "phase-id"],
    ["or", "masterplan_version_id.is.null,masterplan_version_id.eq.version-id"],
  ]);

  const legacyQuery = makeQuery();
  applyProjectAndVersionScope(legacyQuery, null, null);
  assert.deepEqual(legacyQuery.calls, [
    ["is", "project_id", null],
    ["is", "masterplan_version_id", null],
  ]);
});

test("active map lookup distinguishes errors and returns the selected version URLs", () => {
  assert.deepEqual(normalizeActiveMapLookup({
    id: "version-id",
    image_url: "https://assets.test/main.webp",
    preview_url: "https://assets.test/preview.webp",
  }, null), {
    ok: true,
    version: {
      id: "version-id",
      imageUrl: "https://assets.test/main.webp",
      previewUrl: "https://assets.test/preview.webp",
    },
  });
  assert.deepEqual(normalizeActiveMapLookup(null, null), { ok: true, version: null });
  assert.deepEqual(normalizeActiveMapLookup(null, new Error("database unavailable")), { ok: false, version: null });

});

test("active version lookup cannot read another project's map", () => {
  const calls = [];
  const query = { calls };
  for (const method of ["eq", "is"]) query[method] = (...args) => { calls.push([method, ...args]); return query; };
  applyActiveVersionProjectScope(query, "tenant-id", "phase-id");
  assert.deepEqual(calls, [
    ["eq", "tenant_id", "tenant-id"],
    ["eq", "is_active", true],
    ["eq", "project_id", "phase-id"],
  ]);
});

test("Supabase serializes project and version boundaries as server-side filters", async () => {
  const requests = [];
  const client = createClient("https://example.supabase.co", "test-key", {
    global: {
      fetch: async (input) => {
        requests.push(new URL(String(input)));
        return new Response("[]", {
          headers: { "Content-Type": "application/json", "Content-Range": "0-0/0" },
        });
      },
    },
  });

  await applyProjectAndVersionScope(
    client.from("parcels").select("id").eq("tenant_id", "tenant-id"),
    { id: "default-id", slug: "main", name: "Main", isDefault: true },
    "version-id",
  ).order("lot_number", { ascending: true });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get("tenant_id"), "eq.tenant-id");
  assert.equal(requests[0].searchParams.get("project_id"), "eq.default-id");
  assert.deepEqual(requests[0].searchParams.getAll("or"), [
    "(masterplan_version_id.is.null,masterplan_version_id.eq.version-id)",
  ]);
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
  assert.ok(allowlistMatch[1].includes('"public_ref"'), "Allowlist must provide the project-scoped public reference.");
  assert.ok(!allowlistMatch[1].includes('"id"'), "Internal parcel ids must never leave the public endpoint.");
  assert.match(source, /\.select\("lot_number, status/);
});
