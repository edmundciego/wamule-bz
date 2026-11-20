import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import { transform } from "esbuild";

const sourceUrl = new URL("../supabase/functions/submit-public-inquiry/index.ts", import.meta.url);
const realFetch = globalThis.fetch;
const realDeno = globalThis.Deno;
const realCrypto = globalThis.crypto;
let loadNumber = 0;

function payload(overrides = {}) {
  return {
    name: "Synthetic Buyer",
    email: " Buyer@Example.test ",
    phone: "+501 555 0100",
    interests: ["Available lots", "A specific lot"],
    specific_lot_id: 42,
    message: "Please send details.",
    page_url: "https://example.test/application",
    ...overrides,
  };
}

function createState(options = {}) {
  const state = {
    env: { SUPABASE_URL: "https://supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "test-role", RESEND_API_KEY: "test-key", EMAIL_FROM_ADDRESS: "sender@example.test", ...options.env },
    inserts: { leads: [], lead_activities: [], follow_up_tasks: [] },
    rpcCalls: [], sends: [], recipients: new Set(), ips: new Map(),
    quotaError: options.quotaError,
    provider: options.provider ?? "success",
  };
  class Query {
    constructor(table) { this.table = table; this.inserted = null; this.key = null; }
    select() { return this; }
    eq(column, value) { if (column === "key") this.key = value; return this; }
    limit() { return Promise.resolve({ data: [], error: null }); }
    insert(value) { this.inserted = value; state.inserts[this.table].push(value); return this; }
    single() { return Promise.resolve({ data: { id: `lead-${state.inserts.leads.length}` }, error: null }); }
    maybeSingle() {
      const data = this.table === "public_parcel_options"
        ? { id: 42, lot_number: "42", dimensions: null, base_price: null, status: "Available" }
        : this.key === "company_profile" ? { value: { company_name: "Example Development" } } : null;
      return Promise.resolve({ data, error: null });
    }
    then(resolve, reject) { return Promise.resolve({ data: null, error: null }).then(resolve, reject); }
  }
  state.client = {
    from: (table) => new Query(table),
    async rpc(name, args) {
      state.rpcCalls.push({ name, args });
      if (state.quotaError) return { data: null, error: new Error("synthetic database failure") };
      // This stub models denial and atomic reservations to exercise the handler.
      // It is not a test of the actual Postgres implementation.
      const count = state.ips.get(args.p_ip_hash) ?? 0;
      if (state.recipients.has(args.p_recipient_hash) || count >= 2) return { data: false, error: null };
      state.recipients.add(args.p_recipient_hash);
      state.ips.set(args.p_ip_hash, count + 1);
      return { data: true, error: null };
    },
  };
  return state;
}

async function install(state, { injectedIp = false } = {}) {
  let source = await readFile(sourceUrl, "utf8");
  const importLine = 'import { createClient } from "https://esm.sh/@supabase/supabase-js@2";';
  assert.ok(source.includes(importLine), "expected deployed-source Supabase import");
  source = source.replace(importLine, "const createClient = () => globalThis.__inquiryTestClient;");
  if (injectedIp) {
    const implementation = /function trustedRequesterIp\(_request: Request\): string \| null \{\s*return null;\s*\}/;
    assert.match(source, implementation, "inject only into the fail-closed test copy");
    source = source.replace(implementation, "function trustedRequesterIp(_request: Request): string | null { return globalThis.__inquiryTestIp; }");
  }
  const output = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
  globalThis.Deno = { env: { get: (key) => state.env[key] }, serve: (handler) => { state.handler = handler; } };
  globalThis.crypto = webcrypto;
  globalThis.__inquiryTestClient = state.client;
  globalThis.__inquiryTestIp = "192.0.2.9";
  globalThis.fetch = async (_url, init) => {
    state.sends.push(JSON.parse(init.body));
    if (state.provider === "throw") throw new Error("synthetic provider body with private detail");
    return new Response(state.provider === "failure" ? "synthetic private provider detail" : "{}", { status: state.provider === "failure" ? 503 : 200 });
  };
  await import(`data:text/javascript;base64,${Buffer.from(output.code).toString("base64")}#${++loadNumber}`);
  assert.equal(typeof state.handler, "function");
}

function cleanup() {
  globalThis.fetch = realFetch;
  if (realDeno === undefined) delete globalThis.Deno; else globalThis.Deno = realDeno;
  if (realCrypto === undefined) delete globalThis.crypto; else globalThis.crypto = realCrypto;
  delete globalThis.__inquiryTestClient;
  delete globalThis.__inquiryTestIp;
}

async function submit(state, data = payload(), headers = {}) {
  const response = await state.handler(new Request("https://edge.invalid/submit-public-inquiry", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://example.test", ...headers }, body: JSON.stringify(data),
  }));
  return { status: response.status, body: await response.json() };
}

function saved(state, count) {
  assert.equal(state.inserts.leads.length, count);
  assert.equal(state.inserts.follow_up_tasks.length, count);
}

test("deployed frontend payload persists despite missing trusted gateway IP", async (t) => {
  t.after(cleanup);
  const state = createState();
  await install(state);
  const result = await submit(state, payload(), { "cf-connecting-ip": "192.0.2.9", "x-forwarded-for": "192.0.2.9" });
  assert.equal(result.status, 200);
  assert.deepEqual({ ok: result.body.ok, leadCreated: result.body.leadCreated, followUpCreated: result.body.followUpCreated, emailSent: result.body.emailSent },
    { ok: true, leadCreated: true, followUpCreated: true, emailSent: false });
  assert.equal(state.inserts.leads[0].email, "buyer@example.test");
  assert.equal(state.inserts.leads[0].parcel_id, 42);
  saved(state, 1);
  assert.equal(state.rpcCalls.length, 0);
  assert.equal(state.sends.length, 0);
});

test("synthetic trusted IP: fixed greeting, plain recipient, and normalized quota key", async (t) => {
  t.after(cleanup);
  const state = createState();
  await install(state, { injectedIp: true });
  const result = await submit(state);
  assert.equal(result.status, 200);
  assert.equal(result.body.emailSent, true);
  assert.equal(state.sends.length, 1);
  assert.deepEqual(state.sends[0].to, ["buyer@example.test"]);
  assert.match(state.sends[0].text, /^Hello,\n/);
  assert.doesNotMatch(state.sends[0].text, /Synthetic Buyer/);
  assert.equal(state.rpcCalls[0].name, "reserve_inquiry_confirmation_quota");
  assert.equal(state.rpcCalls[0].args.p_recipient_hash, createHash("sha256").update("buyer@example.test").digest("hex"));
  assert.equal(state.rpcCalls[0].args.p_ip_hash, createHash("sha256").update("192.0.2.9").digest("hex"));
  saved(state, 1);
});

test("quota denial and concurrent duplicate requests save each inquiry without extra sends", async (t) => {
  t.after(cleanup);
  const state = createState();
  await install(state, { injectedIp: true });
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => submit(state, payload({ email: i % 2 ? "BUYER@example.test" : "buyer@example.test" }))));
  assert.ok(results.every((result) => result.status === 200 && result.body.leadCreated && result.body.followUpCreated));
  assert.equal(results.filter((result) => result.body.emailSent).length, 1);
  assert.equal(state.sends.length, 1);
  saved(state, 5);
  const second = await submit(state, payload({ email: "other@example.test" }));
  const third = await submit(state, payload({ email: "third@example.test" }));
  assert.equal(second.body.emailSent, true);
  assert.equal(third.body.emailSent, false);
  saved(state, 7);
});

test("concurrent requests for different recipients obey a denied IP quota result", async (t) => {
  t.after(cleanup);
  const state = createState();
  await install(state, { injectedIp: true });
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => submit(state, payload({ email: `buyer${i}@example.test` }))));
  assert.ok(results.every((result) => result.status === 200 && result.body.leadCreated && result.body.followUpCreated));
  assert.equal(results.filter((result) => result.body.emailSent).length, 2);
  assert.equal(state.sends.length, 2);
  saved(state, 5);
});

test("missing configuration, quota errors, and provider failures preserve the lead and follow-up", async (t) => {
  t.after(cleanup);
  for (const options of [
    { env: { RESEND_API_KEY: "" } }, { env: { EMAIL_FROM_ADDRESS: "" } },
    { quotaError: true }, { provider: "failure" }, { provider: "throw" },
  ]) {
    const state = createState(options);
    await install(state, { injectedIp: true });
    const result = await submit(state);
    assert.equal(result.status, 200);
    assert.equal(result.body.emailSent, false);
    saved(state, 1);
    if (options.env) assert.equal(state.rpcCalls.length, 0);
    if (options.env || options.quotaError) assert.equal(state.sends.length, 0);
    const activity = state.inserts.lead_activities.find((entry) => entry.activity_type === "email");
    assert.ok(activity);
    assert.doesNotMatch(JSON.stringify(activity), /synthetic private provider detail|synthetic provider body/);
    if (options.provider) {
      const retry = await submit(state);
      assert.equal(retry.body.emailSent, false);
      assert.equal(state.sends.length, 1, "a failed provider attempt consumes its reservation");
      saved(state, 2);
    }
  }
});
