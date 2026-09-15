import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

// Live staging config: explicit env first, local .env.staging fallback.
// Absent in CI -> live tests skip instead of failing.
function loadStagingConfig() {
  const fromEnv = {
    url: process.env.STAGING_SUPABASE_URL,
    anonKey: process.env.STAGING_ANON_KEY,
    dbPassword: process.env.STAGING_DB_PASSWORD,
    site: process.env.STAGING_SITE_URL,
  };
  const stagingFile = new URL(".env.staging", root);
  let fileVars = {};
  if (existsSync(stagingFile)) {
    fileVars = Object.fromEntries(
      readFileSync(stagingFile, "utf8")
        .split("\n")
        .map((line) => line.split(/=(.*)/s))
        .filter(([key, value]) => key && value !== undefined && !key.startsWith("#"))
        .map(([key, value]) => [key.trim(), value.trim()]),
    );
  }
  const poolerFile = new URL("supabase/.temp/pooler-url", root);
  const poolerUrl = existsSync(poolerFile) ? readFileSync(poolerFile, "utf8").trim() : null;
  const config = {
    url: fromEnv.url ?? fileVars.VITE_SUPABASE_URL,
    anonKey: fromEnv.anonKey ?? fileVars.VITE_SUPABASE_ANON_KEY,
    dbPassword: fromEnv.dbPassword ?? fileVars.SUPABASE_DB_PASSWORD,
    poolerUrl,
    site: fromEnv.site ?? "https://wamule-staging.netlify.app",
    tenantSlug: "wamule",
    expectedTenantId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  };
  if (!config.url || !config.anonKey || !config.dbPassword || !config.poolerUrl) return null;
  try {
    execFileSync("python3", ["-c", "import psycopg"], { stdio: "ignore" });
  } catch {
    return null;
  }
  return config;
}

const staging = loadStagingConfig();
const LIVE = Boolean(staging);
const skipReason = "live staging env (URL, anon key, DB password, psycopg) not available";

function functionsUrl(path) {
  return `${staging.url.replace(/\/$/, "")}/functions/v1/${path}`;
}

function anonHeaders() {
  return { apikey: staging.anonKey, Authorization: `Bearer ${staging.anonKey}` };
}

/** Direct-DB read via pooler (staging only). Never logs credentials. */
function dbRows(sql, params = []) {
  const script = [
    "import json, sys, psycopg",
    "pooler = sys.argv[1]",
    "pw = sys.argv[2]",
    "sql = sys.argv[3]",
    "params = json.loads(sys.argv[4])",
    "user, _, host = pooler.replace('postgresql://', '').partition('@')",
    "with psycopg.connect(f'postgresql://{user}:{pw}@{host}?sslmode=require', autocommit=True) as conn:",
    "    with conn.cursor() as cur:",
    "        cur.execute(sql, params)",
    "        rows = cur.fetchall() if cur.description else []",
    "    print(json.dumps(rows, default=str))",
  ].join("\n");
  const output = execFileSync(
    "python3",
    ["-c", script, staging.poolerUrl, staging.dbPassword, sql, JSON.stringify(params)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(output);
}

test("e2e payload contract matches the inquiry function", async () => {
  // Guards spec-vs-API drift: the function requires these exact keys.
  const source = read("supabase/functions/submit-public-inquiry/index.ts");
  for (const key of ["name?: unknown", "specific_lot_id?: unknown", "tenant?: unknown"]) {
    assert.ok(source.includes(key), `InquiryBody must declare ${key}`);
  }
});

test("public lots endpoint returns tenant availability with open CORS", { skip: !LIVE && skipReason }, async () => {
  const response = await fetch(`${functionsUrl("get-public-lots")}?tenant=${staging.tenantSlug}`, {
    headers: anonHeaders(),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const body = await response.json();
  assert.ok(body.tenant?.name, "tenant.name present");
  assert.ok("masterplan_image_url" in body, "masterplan_image_url key present");
  assert.ok(Array.isArray(body.parcels) && body.parcels.length > 0, "parcels array non-empty");
  for (const parcel of body.parcels) {
    assert.ok(Array.isArray(parcel.map_polygon), `parcel ${parcel.lot_number} map_polygon is an array`);
    assert.ok(typeof parcel.price === "number", "price is numeric");
  }
});

test("embed page serves without auth redirects", { skip: !LIVE && skipReason }, async () => {
  const response = await fetch(`${staging.site.replace(/\/$/, "")}/embed/${staging.tenantSlug}`, {
    redirect: "manual",
  });
  assert.ok([200].includes(response.status), `embed page HTTP ${response.status}`);
  const html = await response.text();
  assert.ok(html.includes('id="root"'), "SPA mount point served (no login redirect)");
});

test("live inquiry roundtrip lands in the tenant pipeline", { skip: !LIVE && skipReason }, async () => {
  const email = "test-buyer@streetside.local";
  // Idempotency: clear leftovers from any prior run.
  dbRows("delete from public.leads where email = %s", [email]);

  const lotsResponse = await fetch(`${functionsUrl("get-public-lots")}?tenant=${staging.tenantSlug}`, {
    headers: anonHeaders(),
  });
  assert.equal(lotsResponse.status, 200);
  const lots = await lotsResponse.json();
  const available = lots.parcels.find((parcel) => parcel.status === "Available");
  assert.ok(available, "staging has an Available lot to inquire about");

  const submit = await fetch(functionsUrl("submit-public-inquiry"), {
    method: "POST",
    headers: { ...anonHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Integration Tester",
      email,
      phone: "+501-600-0000",
      interests: ["Available lots", "A specific lot"],
      specific_lot_id: available.id,
      message: "Testing public map inquiry submission.",
      page_url: `${staging.site}/embed/${staging.tenantSlug}`,
      tenant: staging.tenantSlug,
    }),
  });
  assert.equal(submit.status, 200);
  const result = await submit.json();
  assert.equal(result.ok, true);
  assert.equal(result.leadCreated, true);

  const leads = dbRows("select id, tenant_id, email from public.leads where email = %s", [email]);
  assert.equal(leads.length, 1, "exactly one lead row for the test buyer");
  assert.equal(leads[0][1], staging.expectedTenantId, "lead tenant_id set to the embed tenant");
  const activities = dbRows("select id from public.lead_activities where lead_id = %s", [leads[0][0]]);
  assert.ok(activities.length >= 1, "lead activity recorded for the inquiry");

  // Cleanup: keep staging free of test data (cascades activities + tasks).
  dbRows("delete from public.leads where email = %s", [email]);
});
