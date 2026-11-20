import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import { build } from "esbuild";

const sourceUrl = new URL("../supabase/functions/submit-public-inquiry/index.ts", import.meta.url);
const sourceDirectory = new URL("../supabase/functions/submit-public-inquiry/", import.meta.url).pathname;
const savedGlobals = { Deno: globalThis.Deno, fetch: globalThis.fetch };
const savedCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
let loadNumber = 0;
const digest = (value) => createHash("sha256").update(value).digest("hex");

function payload(overrides = {}) {
  return {
    name: "Synthetic Buyer", email: " Buyer@Example.test ", phone: "+501 555 0100",
    interests: ["Available lots", "A specific lot"], specific_lot_ref: "plr2:project:initial:42",
    tenant: "example", project: "project", phase: "initial",
    client_reference_id: "123e4567-e89b-42d3-a456-426614174000", ...overrides,
  };
}

function state(options = {}) {
  const tenant = "tenant-1", project = "project-1", phase = "phase-1";
  const scope = { tenant_id: tenant, project_id: project, phase_id: phase };
  const db = {
    organizations: [{ id: tenant, slug: "example", inbound_alias: "alias", is_active: true }],
    projects: [{ id: project, tenant_id: tenant, slug: "project", name: "Project", is_default: true, map_experience_mode: options.demo ? "demo" : "sales" }],
    development_phases: [{ id: phase, tenant_id: tenant, project_id: project, slug: "initial", is_default: true, is_active: true }],
    map_feature_snapshots: options.unpublished ? [] : [{ ...scope, id: "snapshot-1", is_active: true }],
    project_map_packages: options.unpublishedPackage ? [] : [{ ...scope, id: "package-1", snapshot_id: "snapshot-1", published_at: "2026-01-01" }],
    map_features: [{ ...scope, snapshot_id: "snapshot-1", identity_id: "feature-1", is_active: true, public_visible: true }],
    project_plot_content: options.hiddenLot ? [] : [{ ...scope, identity_id: "feature-1", parcel_id: 42, public_visible: true }],
    masterplan_versions: [],
    parcels: [{ ...scope, id: 42, lot_number: "42", dimensions: null, base_price: null, status: options.lotStatus ?? "Available", needs_review: false, masterplan_version_id: null }],
    leads: [], project_settings: [], business_settings: [], lead_activities: [],
  };
  const s = {
    env: { SUPABASE_URL: "https://supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-role", RESEND_API_KEY: "synthetic-key", EMAIL_FROM_ADDRESS: "sender@example.test", ...options.env },
    db, calls: [], sends: [], events: [], inquiries: new Map(), quotaError: options.quotaError,
    quotaAllowed: options.quotaAllowed ?? true, provider: options.provider ?? "success", quotaUsed: new Set(),
  };
  class Query {
    constructor(table) { this.table = table; this.rows = db[table] ?? []; this.filters = []; this.inserted = false; }
    select() { return this; }
    eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
    in(key, values) { this.filters.push((row) => values.includes(row[key])); return this; }
    is(key, value) { this.filters.push((row) => (row[key] ?? null) === value); return this; }
    not(key, operator, value) { assert.equal(operator, "is"); this.filters.push((row) => (row[key] ?? null) !== value); return this; }
    or() { return this; }
    order() { return this; }
    insert(row) { this.rows.push(row); this.inserted = true; return this; }
    result() { return { data: this.rows.filter((row) => this.filters.every((filter) => filter(row))), error: null }; }
    limit(n) { const result = this.result(); result.data = result.data.slice(0, n); return Promise.resolve(result); }
    maybeSingle() { const result = this.result(); return Promise.resolve({ data: result.data[0] ?? null, error: null }); }
    then(resolve, reject) { return Promise.resolve(this.inserted ? { data: null, error: null } : this.result()).then(resolve, reject); }
  }
  s.client = {
    from(table) { return new Query(table); },
    async rpc(name, args) {
      s.calls.push({ name, args });
      s.events.push(name);
      if (name === "create_scoped_public_inquiry") {
        // Model only the server RPC contract. Persistence/atomicity of that RPC
        // itself requires staging or database integration coverage.
        const existing = s.inquiries.get(args.p_client_reference_id);
        if (existing) {
          if (existing.p_email !== args.p_email || existing.p_parcel_id !== args.p_parcel_id) return { data: { conflict: true }, error: null };
          return { data: { ok: true, deduplicated: true, lead_id: existing.lead_id }, error: null };
        }
        const record = { ...args, lead_id: `lead-${s.inquiries.size + 1}` };
        s.inquiries.set(args.p_client_reference_id, record);
        return { data: { ok: true, deduplicated: false, lead_id: record.lead_id }, error: null };
      }
      assert.equal(name, "reserve_inquiry_confirmation_quota");
      if (s.quotaError) return { data: null, error: new Error("synthetic quota failure") };
      const allowed = s.quotaAllowed && !s.quotaUsed.has(args.p_recipient_hash);
      if (allowed) s.quotaUsed.add(args.p_recipient_hash);
      return { data: allowed, error: null };
    },
  };
  return s;
}

async function install(s, { trustedIp = false } = {}) {
  let source = await readFile(sourceUrl, "utf8");
  const importLine = 'import { createClient } from "https://esm.sh/@supabase/supabase-js@2";';
  assert.ok(source.includes(importLine));
  source = source.replace(importLine, "const createClient = () => globalThis.__inquiryTestClient;");
  if (trustedIp) {
    const closed = /function trustedRequesterIp\(_request: Request\): string \| null \{\s*return null;\s*\}/;
    assert.match(source, closed, "only replace an explicitly fail-closed gateway implementation in the test copy");
    source = source.replace(closed, "function trustedRequesterIp(_request: Request): string | null { return globalThis.__inquiryTestIp; }");
  }
  const bundled = await build({ stdin: { contents: source, resolveDir: sourceDirectory, loader: "ts" }, bundle: true, write: false, platform: "neutral", format: "esm" });
  globalThis.Deno = { env: { get: (key) => s.env[key] }, serve: (handler) => { s.handler = handler; } };
  if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  globalThis.__inquiryTestClient = s.client;
  globalThis.__inquiryTestIp = "192.0.2.9";
  globalThis.fetch = async (_url, init) => {
    s.events.push("resend");
    s.sends.push(JSON.parse(init.body));
    if (s.provider === "throw") throw new Error("synthetic private provider detail");
    return new Response(s.provider === "failure" ? "synthetic private provider detail" : "{}", { status: s.provider === "failure" ? 503 : 200 });
  };
  await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}#${++loadNumber}`);
}

function cleanup() {
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
  if (savedCryptoDescriptor) Object.defineProperty(globalThis, "crypto", savedCryptoDescriptor);
  else delete globalThis.crypto;
  delete globalThis.__inquiryTestClient;
  delete globalThis.__inquiryTestIp;
}

async function submit(s, data = payload(), headers = {}) {
  const response = await s.handler(new Request("https://edge.invalid/submit-public-inquiry", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://example.test", ...headers }, body: JSON.stringify(data),
  }));
  return { status: response.status, body: await response.json() };
}

test("scoped frontend payload saves once and ignores spoofed IP headers", async (t) => {
  t.after(cleanup);
  const s = state(); await install(s);
  const result = await submit(s, payload(), { "cf-connecting-ip": "192.0.2.9", "x-forwarded-for": "192.0.2.9", "x-real-ip": "192.0.2.9" });
  assert.equal(result.status, 200);
  assert.equal(result.body.leadCreated, true); assert.equal(result.body.followUpCreated, true); assert.equal(result.body.emailSent, false);
  assert.equal(s.inquiries.size, 1); assert.equal(s.sends.length, 0);
  assert.equal(s.calls.filter((call) => call.name === "reserve_inquiry_confirmation_quota").length, 0);
  const saved = [...s.inquiries.values()][0];
  assert.equal(saved.p_tenant_id, "tenant-1"); assert.equal(saved.p_project_id, "project-1"); assert.equal(saved.p_phase_id, "phase-1");
  assert.equal(saved.p_parcel_id, 42); assert.equal(saved.p_email, "buyer@example.test");
  assert.equal(s.db.lead_activities.length, 1);
  assert.equal(s.db.lead_activities[0].metadata.email_sent, false);
  assert.equal(s.db.lead_activities[0].metadata.email_suppressed, true);
});

test("tenant, project, phase, publication, and lot checks run before persistence", async (t) => {
  t.after(cleanup);
  for (const [options, body, status] of [
    [{}, payload({ tenant: "unknown" }), 400],
    [{}, payload({ project: "other" }), 400],
    [{}, payload({ phase: "other" }), 404],
    [{}, payload({ specific_lot_ref: "plr2:project:other:42" }), 400],
    [{ unpublished: true }, payload(), 404],
    [{ unpublishedPackage: true }, payload(), 404],
    [{ hiddenLot: true }, payload(), 400],
    [{ lotStatus: "Sold" }, payload(), 400],
    [{ demo: true }, payload(), 400],
  ]) {
    const s = state(options); await install(s);
    const result = await submit(s, body);
    assert.equal(result.status, status, JSON.stringify({ options, body }));
    assert.equal(s.inquiries.size, 0); assert.equal(s.sends.length, 0);
  }
});

test("same request reference is retry-safe and conflicting reuse is rejected", async (t) => {
  t.after(cleanup);
  const s = state(); await install(s);
  const first = await submit(s); const retry = await submit(s); const conflict = await submit(s, payload({ email: "other@example.test" }));
  assert.equal(first.status, 200); assert.equal(first.body.leadCreated, true);
  assert.equal(retry.status, 200); assert.equal(retry.body.deduplicated, true); assert.equal(retry.body.leadCreated, false);
  assert.equal(conflict.status, 409); assert.equal(s.inquiries.size, 1); assert.equal(s.db.lead_activities.length, 1); assert.equal(s.sends.length, 0);
});

test("synthetic trusted IP reserves quota before sending a neutral plain-address confirmation", async (t) => {
  t.after(cleanup);
  const s = state(); await install(s, { trustedIp: true });
  const result = await submit(s);
  assert.equal(result.status, 200); assert.equal(result.body.emailSent, true);
  assert.deepEqual(s.sends[0].to, ["buyer@example.test"]); assert.match(s.sends[0].text, /^Hello,\n/);
  assert.doesNotMatch(s.sends[0].text, /Synthetic Buyer/);
  const quota = s.calls.find((call) => call.name === "reserve_inquiry_confirmation_quota");
  assert.equal(quota.args.p_recipient_hash, digest("buyer@example.test")); assert.equal(quota.args.p_ip_hash, digest("192.0.2.9"));
  assert.ok(s.events.indexOf("reserve_inquiry_confirmation_quota") < s.events.indexOf("resend"));
  const retry = await submit(s);
  assert.equal(retry.body.deduplicated, true);
  assert.equal(s.sends.length, 1);
  assert.equal(s.calls.filter((call) => call.name === "reserve_inquiry_confirmation_quota").length, 1);
  assert.equal(s.db.lead_activities.length, 1);
});

test("quota denial, missing configuration, and provider failures preserve successful inquiry", async (t) => {
  t.after(cleanup);
  for (const options of [{ quotaAllowed: false }, { quotaError: true }, { env: { SUPPRESS_OUTBOUND_EMAILS: "true" } }, { env: { RESEND_API_KEY: "" } }, { env: { EMAIL_FROM_ADDRESS: "" } }, { provider: "failure" }, { provider: "throw" }]) {
    const s = state(options); await install(s, { trustedIp: true });
    const result = await submit(s);
    assert.equal(result.status, 200); assert.equal(result.body.leadCreated, true); assert.equal(result.body.followUpCreated, true); assert.equal(result.body.emailSent, false);
    assert.equal(s.inquiries.size, 1); assert.equal(s.db.lead_activities.length, 1);
    assert.doesNotMatch(JSON.stringify(s.db.lead_activities), /synthetic private provider detail/);
    if (!options.provider) assert.equal(s.sends.length, 0);
    if (options.provider) {
      assert.equal(s.sends.length, 1);
      const again = await submit(s, payload({ client_reference_id: "123e4567-e89b-42d3-a456-426614174001" }));
      assert.equal(again.status, 200); assert.equal(again.body.emailSent, false); assert.equal(s.sends.length, 1);
    }
  }
});
