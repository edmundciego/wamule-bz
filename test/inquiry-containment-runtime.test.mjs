import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cleanupEdgeHandler, createPublicIntakeFixture, installEdgeHandler } from "./helpers/public-intake-fixture.mjs";
import { FIXTURE_IDS } from "./helpers/public-intake-fixture.mjs";

function payload(overrides = {}) {
  return {
    name: "Synthetic Buyer", email: "buyer@example.test", phone: "+501 555 0100",
    interests: ["Available lots", "A specific lot"], specific_lot_ref: "plr2:project:initial:42",
    tenant: "example", project: "project", phase: "initial",
    client_reference_id: "123e4567-e89b-42d3-a456-426614174000", ...overrides,
  };
}

async function submit(s, data = payload()) {
  const suppliedHostname = data.hostname ?? data.host;
  const origin = s.options.requestOrigin ?? `https://${typeof suppliedHostname === "string" && suppliedHostname ? suppliedHostname : "example.test"}`;
  s.requestHostname = new URL(origin).hostname;
  const body = { ...data, turnstile_token: Object.hasOwn(data, "turnstile_token") ? data.turnstile_token : "synthetic-turnstile-token" };
  const response = await s.handler(new Request("https://edge.invalid/submit-public-inquiry", {
    method: "POST", headers: { "content-type": "application/json", origin, "cf-connecting-ip": s.options.requesterIp ?? "203.0.113.10", "x-forwarded-for": "198.51.100.9" }, body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

function legacyApplicationPagePayload(overrides = {}) {
  return {
    name: "Legacy Inquiry Buyer", email: "legacy-buyer@example.test", phone: "+501 555 0181",
    interests: ["A specific lot"], specific_lot_id: 42,
    message: "Please send details about this lot.", page_url: "https://wamuledevelopment.com/apply",
    ...overrides,
  };
}

function sha256(value) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function stagingTestSendEnv(overrides = {}) {
  const recipientHash = sha256("buyer@example.test");
  return {
    SUPABASE_URL: "https://kvocwmrcuhiaezlcgzjf.supabase.co",
    SUPPRESS_OUTBOUND_EMAILS: "true",
    STAGING_PUBLIC_INQUIRY_TEST_SEND_ENABLED: "true",
    STAGING_PUBLIC_INQUIRY_TEST_RECIPIENT_HASH: recipientHash,
    STAGING_PUBLIC_INQUIRY_RECIPIENT_HASHES: recipientHash,
    ...overrides,
  };
}

async function submitLegacy(s, data = legacyApplicationPagePayload()) {
  s.requestHostname = "wamuledevelopment.com";
  const response = await s.handler(new Request("https://edge.invalid/submit-public-inquiry", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://wamuledevelopment.com", "cf-connecting-ip": s.options.requesterIp ?? "203.0.113.10", "x-forwarded-for": "198.51.100.9" },
    body: JSON.stringify(data),
  }));
  return { status: response.status, body: await response.json() };
}

test("legacy ApplicationPage payload resolves configured scope, links a numeric lot and deduplicates retries", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture();
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const first = await submitLegacy(s);
  const retry = await submitLegacy(s, legacyApplicationPagePayload({
    page_url: "https://wamuledevelopment.com/apply?retry=1",
  }));

  assert.equal(first.status, 200);
  assert.equal(first.body.leadCreated, true);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.deduplicated, true);
  assert.equal(s.db.leads.length, 1);
  assert.equal(s.db.leads[0].tenant_id, FIXTURE_IDS.tenant);
  assert.equal(s.db.leads[0].project_id, FIXTURE_IDS.project);
  assert.equal(s.db.leads[0].phase_id, FIXTURE_IDS.phase);
  assert.equal(s.db.leads[0].parcel_id, 42);
  assert.equal(s.db.follow_up_tasks.length, 1);
  assert.equal(s.sends.length, 0);

  const rpcCalls = s.calls.filter((call) => call.name === "create_scoped_public_inquiry");
  assert.equal(rpcCalls.length, 2);
  assert.ok(rpcCalls.every((call) => call.args.p_tenant_id === FIXTURE_IDS.tenant));
  assert.ok(rpcCalls.every((call) => call.args.p_project_id === FIXTURE_IDS.project));
  assert.ok(rpcCalls.every((call) => call.args.p_phase_id === FIXTURE_IDS.phase));
  assert.ok(rpcCalls.every((call) => call.args.p_parcel_id === 42));
  assert.equal(rpcCalls[0].args.p_client_reference_id, rpcCalls[1].args.p_client_reference_id);

  assert.equal(s.logs.length, 2);
  const events = s.logs.map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.event), ["legacy_public_inquiry_adapter", "legacy_public_inquiry_adapter"]);
  assert.deepEqual(events.map((event) => event.outcome.result), ["created", "deduplicated"]);
  assert.ok(events.every((event) => event.scope.tenantId === FIXTURE_IDS.tenant
    && event.scope.projectId === FIXTURE_IDS.project && event.scope.phaseId === FIXTURE_IDS.phase));
  assert.ok(events.every((event) => event.request.method === "POST"
    && event.request.path === "/submit-public-inquiry" && event.request.origin === "https://wamuledevelopment.com"));
  assert.ok(s.logs.every((line) => !/legacy-buyer@example\.test|Legacy Inquiry Buyer|555 0181|Please send details|page_url/i.test(line)));
});

test("legacy ApplicationPage general inquiries accept the historic null lot shape while applications are closed", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({ companyOpen: false, projectOpen: false, unpublished: true });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const result = await submitLegacy(s, legacyApplicationPagePayload({
    interests: ["General project interest"], specific_lot_id: null,
  }));

  assert.equal(result.status, 200);
  assert.equal(s.db.leads.length, 1);
  assert.equal(s.db.leads[0].tenant_id, FIXTURE_IDS.tenant);
  assert.equal(s.db.leads[0].project_id, FIXTURE_IDS.project);
  assert.equal(s.db.leads[0].phase_id, FIXTURE_IDS.phase);
  assert.equal(s.db.leads[0].parcel_id, null);
  assert.equal(s.db.follow_up_tasks.length, 1);
  assert.equal(s.sends.length, 0);
});

test("legacy inquiries save out-of-scope, unpublished, and unavailable numeric lots unlinked", async (t) => {
  t.after(cleanupEdgeHandler);
  const cases = [
    { options: {}, lotId: 84 },
    { options: { unpublished: true }, lotId: 42 },
    { options: { lotStatus: "Sold" }, lotId: 42 },
  ];
  for (const { options, lotId } of cases) {
    const s = createPublicIntakeFixture(options);
    await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

    const result = await submitLegacy(s, legacyApplicationPagePayload({ specific_lot_id: lotId }));

    assert.equal(result.status, 200);
    assert.equal(result.body.message, "We received your inquiry. Our team will follow up with available options.");
    assert.equal(s.calls.filter((call) => call.name === "create_scoped_public_inquiry").length, 1);
    assert.equal(s.db.leads.length, 1);
    assert.equal(s.db.leads[0].tenant_id, FIXTURE_IDS.tenant);
    assert.equal(s.db.leads[0].project_id, FIXTURE_IDS.project);
    assert.equal(s.db.leads[0].phase_id, FIXTURE_IDS.phase);
    assert.equal(s.db.leads[0].parcel_id, null);
    assert.equal(s.db.follow_up_tasks.length, 1);
    assert.match(s.db.leads[0].notes, new RegExp(`Unverified buyer-supplied lot reference: ${lotId} \\(unverified\\)\\.`));
    assert.equal(s.db.lead_activities[0].metadata.unverified_lot_reference, String(lotId));
    assert.doesNotMatch(JSON.stringify(result.body), /84|42|other-project|unverified|inventory|available lot/i);
    assert.equal(s.sends.length, 0);
    const event = JSON.parse(s.logs[0]);
    assert.equal(event.outcome.result, "created_unverified_lot");
    assert.equal(s.logs.length, 1);
    cleanupEdgeHandler();
  }
});

test("current inquiries save unpublished, unavailable, and foreign lot references without a lot link", async (t) => {
  t.after(cleanupEdgeHandler);
  const cases = [
    { options: { unpublished: true }, overrides: {} },
    { options: { lotStatus: "Sold" }, overrides: {} },
    { options: {}, overrides: { hostname: "example.test", specific_lot_ref: "plr2:other-project:other-initial:84" } },
  ];
  for (const { options, overrides } of cases) {
    const s = createPublicIntakeFixture(options);
    await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

    const result = await submit(s, payload(overrides));

    assert.equal(result.status, 200);
    assert.equal(result.body.message, "We received your inquiry. Our team will follow up with available options.");
    assert.equal(s.db.leads.length, 1);
    assert.equal(s.db.leads[0].tenant_id, FIXTURE_IDS.tenant);
    assert.equal(s.db.leads[0].project_id, FIXTURE_IDS.project);
    assert.equal(s.db.leads[0].phase_id, FIXTURE_IDS.phase);
    assert.equal(s.db.leads[0].parcel_id, null);
    assert.equal(s.db.follow_up_tasks.length, 1);
    assert.match(s.db.lead_activities[0].description, /Unverified buyer-supplied lot reference:/);
    assert.equal(s.db.lead_activities[0].metadata.unverified_lot_reference !== null, true);
    assert.doesNotMatch(JSON.stringify(result.body), /other-project|84|Sold|unpublished|unverified/i);
    assert.equal(s.sends.length, 0);
    cleanupEdgeHandler();
  }
});

test("fallback notes sanitize buyer-supplied references and do not expose them in the response", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({ unpublished: true });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const result = await submit(s, payload({ specific_lot_ref: "plr2:project:initial:<script>alert(1)</script>" }));

  assert.equal(result.status, 200);
  assert.equal(result.body.message, "We received your inquiry. Our team will follow up with available options.");
  assert.equal(s.db.leads.length, 1);
  assert.equal(s.db.leads[0].parcel_id, null);
  assert.match(s.db.leads[0].notes, /Unverified buyer-supplied lot reference:/);
  assert.doesNotMatch(s.db.leads[0].notes, /<script>|<|>/i);
  assert.doesNotMatch(JSON.stringify(result.body), /script|plr2|unverified/i);
});

test("availability changes across retries keep one lead and one follow-up with stable scope", async (t) => {
  t.after(cleanupEdgeHandler);
  for (const firstStatus of ["Sold", "Available"]) {
    const s = createPublicIntakeFixture({ lotStatus: firstStatus });
    await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

    const first = await submit(s, payload());
    s.db.parcels.find((row) => row.id === 42).status = firstStatus === "Available" ? "Sold" : "Available";
    const retry = await submit(s, payload());

    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.deduplicated, true);
    assert.equal(s.db.leads.length, 1);
    assert.equal(s.db.follow_up_tasks.length, 1);
    assert.equal(s.inquiries.size, 1);
    assert.equal(s.db.leads[0].parcel_id, firstStatus === "Available" ? 42 : null);
    assert.equal(retry.body.message, "We received your inquiry. Our team will follow up with available options.");
  }
});

test("a lot becoming unavailable during the atomic write is saved unlinked with an internal note", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({ beforeInquiryPersist(_args, db) {
    db.parcels.find((row) => row.id === 42).status = "Sold";
  } });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const result = await submit(s, payload());

  assert.equal(result.status, 200);
  assert.equal(result.body.message, "We received your inquiry. Our team will follow up with available options.");
  assert.equal(s.db.leads.length, 1);
  assert.equal(s.db.leads[0].parcel_id, null);
  assert.match(s.db.leads[0].notes, /Unverified buyer-supplied lot reference: plr2:project:initial:42 \(unverified\)\./);
  assert.equal(s.db.follow_up_tasks.length, 1);
});

test("a lot entering review during the atomic write is saved unlinked", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({ beforeInquiryPersist(_args, db) {
    db.parcels.find((row) => row.id === 42).needs_review = true;
  } });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const result = await submit(s, payload());

  assert.equal(result.status, 200);
  assert.equal(result.body.message, "We received your inquiry. Our team will follow up with available options.");
  assert.equal(s.db.leads.length, 1);
  assert.equal(s.db.leads[0].parcel_id, null);
  assert.match(s.db.leads[0].notes, /Unverified buyer-supplied lot reference: plr2:project:initial:42 \(unverified\)\./);
  assert.equal(s.db.follow_up_tasks.length, 1);
});

test("a supplied verified hostname is rechecked at the write boundary", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({ beforeInquiryPersist(_args, _db, hostBindings) {
    hostBindings["example.test"] = {
      tenant_slug: "other", project_slug: "other-project", phase_slug: "other-initial",
    };
  } });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const result = await submit(s, payload({ hostname: "EXAMPLE.TEST." }));

  assert.equal(result.status, 503);
  assert.equal(s.calls.filter((call) => call.name === "create_scoped_public_inquiry").length, 1);
  assert.equal(s.calls.find((call) => call.name === "create_scoped_public_inquiry").args.p_hostname, "example.test");
  assert.equal(s.db.leads.length, 0);
  assert.equal(s.db.follow_up_tasks.length, 0);
});

test("partially scoped legacy-shaped requests use the strict resolver and are never adapted", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture();
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const result = await submitLegacy(s, legacyApplicationPagePayload({ tenant: "example", turnstile_token: "synthetic-turnstile-token" }));

  assert.equal(result.status, 400);
  assert.ok(s.queries.includes("organizations"));
  assert.ok(s.queries.includes("projects"));
  assert.ok(s.queries.includes("development_phases"));
  assert.equal(s.calls.filter((call) => call.name === "create_scoped_public_inquiry").length, 0);
  assert.equal(s.db.leads.length, 0);
  assert.equal(s.logs.length, 0);
});

test("conflicting explicit scope aliases pass through resolution and are rejected without writes", async (t) => {
  t.after(cleanupEdgeHandler);
  for (const overrides of [
    { tenant_id: FIXTURE_IDS.otherTenant },
    { hostname: "example.test", host: "other.test" },
    { address: "other.test" },
  ]) {
    const s = createPublicIntakeFixture();
    await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

    const result = await submit(s, payload(overrides));

    assert.equal(result.status, 400, JSON.stringify(overrides));
    assert.ok(s.queries.includes("organizations"), JSON.stringify(overrides));
    assert.equal(s.calls.filter((call) => call.name === "create_scoped_public_inquiry").length, 0);
    assert.equal(s.db.leads.length, 0);
    assert.equal(s.db.follow_up_tasks.length, 0);
    cleanupEdgeHandler();
  }
});

test("legacy inquiry fails closed and logs when default deployment scope is missing or inactive", async (t) => {
  t.after(cleanupEdgeHandler);
  for (const [envPatch, expectedOutcome] of [
    [{ WAMULE_LEGACY_INQUIRY_PHASE_SLUG: undefined }, "configuration_missing"],
    [{ WAMULE_LEGACY_INQUIRY_PHASE_SLUG: "inactive" }, "configured_scope_invalid"],
  ]) {
    const s = createPublicIntakeFixture();
    Object.assign(s.env, envPatch);
    await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");
    const result = await submitLegacy(s);
    assert.equal(result.status, 503);
    assert.equal(s.db.leads.length, 0);
    assert.equal(s.sends.length, 0);
    assert.equal(s.logs.length, 1);
    assert.equal(JSON.parse(s.logs[0]).outcome.result, expectedOutcome);
    cleanupEdgeHandler();
  }
});

test("path and verified custom-domain inquiries save with confirmation suppressed", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture(); await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");
  const path = await submit(s);
  const customDomainRetry = await submit(s, payload({ hostname: "other.example.test" }));
  assert.equal(path.status, 200); assert.equal(path.body.leadCreated, true);
  assert.equal(customDomainRetry.status, 200); assert.equal(customDomainRetry.body.deduplicated, true);
  assert.equal(s.db.leads.length, 1); assert.equal(s.db.follow_up_tasks.length, 1);
  assert.equal(s.inquiries.size, 1); assert.equal(s.sends.length, 0);
  assert.equal(customDomainRetry.body.emailSuppressed, true);
  assert.equal(s.calls.find((call) => call.name === "create_scoped_public_inquiry").args.p_tenant_id, FIXTURE_IDS.tenant);
  assert.equal(s.calls.find((call) => call.name === "create_scoped_public_inquiry").args.p_phase_id, FIXTURE_IDS.phase);
});

test("mixed selectors, conflicting hosts, inactive phases, unpublished scopes, and foreign outlines write nothing", async (t) => {
  t.after(cleanupEdgeHandler);
  const cases = [
    { options: {}, body: payload({ tenant: "other", hostname: "example.test" }) },
    { options: {}, body: payload({ phase: "second", hostname: "example.test" }) },
    { options: {}, body: payload({ phase: "inactive", hostname: "" }) },
    { options: { unpublished: true }, body: payload({ specific_lot_ref: undefined, specific_map_feature_ref: FIXTURE_IDS.feature }) },
    { options: {}, body: payload({ specific_lot_ref: undefined, specific_map_feature_ref: FIXTURE_IDS.otherFeature }) },
    { options: { inactiveOutline: true }, body: payload({ specific_lot_ref: undefined, specific_map_feature_ref: FIXTURE_IDS.feature }) },
  ];
  for (const { options, body } of cases) {
    const s = createPublicIntakeFixture(options); await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");
    const result = await submit(s, body);
    assert.ok(result.status >= 400, JSON.stringify({ body, result }));
    assert.equal(s.inquiries.size, 0); assert.equal(s.db.leads.length, 0);
    assert.equal(s.db.follow_up_tasks.length, 0); assert.equal(s.sends.length, 0);
    cleanupEdgeHandler();
  }
});

test("inquiry retries fingerprint semantic content but ignore hostname and page URL", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture(); await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");
  const first = await submit(s, payload({ message: "Please send details", hostname: "example.test", page_url: "https://example.test/one" }));
  const retry = await submit(s, payload({ message: "Please send details", hostname: "other.example.test", page_url: "https://example.test/two" }));
  const changed = await submit(s, payload({ message: "Please send different details", hostname: "example.test" }));
  assert.equal(first.status, 200); assert.equal(retry.status, 200); assert.equal(retry.body.deduplicated, true);
  assert.equal(changed.status, 409); assert.equal(s.inquiries.size, 1);
  assert.equal(s.db.leads.length, 1); assert.equal(s.db.follow_up_tasks.length, 1); assert.equal(s.sends.length, 0);
});

test("concurrent identical inquiry retries create one lead and one follow-up", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture(); await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");
  const [first, second] = await Promise.all([submit(s), submit(s)]);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(s.db.leads.length, 1); assert.equal(s.db.follow_up_tasks.length, 1);
  assert.equal(s.db.lead_activities.filter((activity) => activity.activity_type === "note").length, 1);
  assert.equal(s.sends.length, 0);
});

test("general inquiries remain available when application settings are closed", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({ companyOpen: false, projectOpen: false });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");
  const result = await submit(s, payload({ specific_lot_ref: undefined, interests: ["General project interest"] }));
  assert.equal(result.status, 200); assert.equal(s.db.leads.length, 1); assert.equal(s.sends.length, 0);
});

test("general inquiries do not require a published map", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({ unpublished: true });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");
  const result = await submit(s, payload({ specific_lot_ref: undefined, interests: ["General project interest"] }));
  assert.equal(result.status, 200); assert.equal(s.db.leads.length, 1);
  assert.equal(s.db.follow_up_tasks.length, 1); assert.equal(s.sends.length, 0);
});

test("bot verification fails closed before any inquiry lookup or write", async (t) => {
  t.after(cleanupEdgeHandler);
  for (const options of [
    { turnstileResponse: { success: false, "error-codes": ["invalid-input-response"] } },
    { turnstileResponse: { success: true, hostname: "wrong.example", action: "public_inquiry" } },
    { turnstileResponse: { success: true, hostname: "example.test", action: "signup" } },
    { env: { TURNSTILE_SECRET_KEY: undefined } },
    { turnstileFetchError: true },
  ]) {
    const s = createPublicIntakeFixture(options);
    await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");
    const result = await submit(s);

    assert.ok([403, 503].includes(result.status));
    assert.equal(s.calls.some((call) => call.name === "create_scoped_public_inquiry"), false);
    assert.equal(s.db.leads.length, 0);
    assert.equal(s.db.follow_up_tasks.length, 0);
    cleanupEdgeHandler();
  }

  const originMismatch = createPublicIntakeFixture({ requestOrigin: "https://example.test" });
  await installEdgeHandler(originMismatch, "../../supabase/functions/submit-public-inquiry/index.ts");
  const mismatchedHostname = await submit(originMismatch, payload({ hostname: "another.example" }));
  assert.equal(mismatchedHostname.status, 403);
  assert.equal(originMismatch.botChecks.length, 0);
  assert.equal(originMismatch.db.leads.length, 0);
  cleanupEdgeHandler();

  const missing = createPublicIntakeFixture();
  await installEdgeHandler(missing, "../../supabase/functions/submit-public-inquiry/index.ts");
  const missingToken = await submit(missing, payload({ turnstile_token: "" }));
  assert.equal(missingToken.status, 403);
  assert.equal(missing.botChecks.length, 0);
  assert.equal(missing.db.leads.length, 0);
});

test("an eligible verified inquiry sends one confirmation and a retry sends none", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({ env: { SUPPRESS_OUTBOUND_EMAILS: "false", PUBLIC_INQUIRY_CONFIRMATIONS_ENABLED: "true" } });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const first = await submit(s);
  s.options.leadLimitReached = true;
  const retry = await submit(s, payload({ turnstile_token: "fresh-retry-token", page_url: "https://example.test/retry" }));

  assert.equal(first.status, 200);
  assert.equal(first.body.emailSent, true);
  assert.equal(first.body.leadCreated, true);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.deduplicated, true);
  assert.equal(retry.body.emailSent, false);
  assert.equal(s.db.leads.length, 1);
  assert.equal(s.db.follow_up_tasks.length, 1);
  assert.equal(s.sends.length, 1);
  assert.equal(s.quotaReservations.length, 1);
  assert.equal(s.botChecks.length, 2);
  assert.notEqual(s.botChecks[0].idempotencyKey, s.botChecks[1].idempotencyKey);
  assert.equal(s.sends[0].body.to[0], "buyer@example.test");
  assert.equal(s.quotaReservations[0].p_project_id, FIXTURE_IDS.project);
  assert.equal(s.quotaReservations[0].p_ip_hash, null);
});

test("email provider failure preserves the lead and follow-up and is not retried", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({ env: { SUPPRESS_OUTBOUND_EMAILS: "false", PUBLIC_INQUIRY_CONFIRMATIONS_ENABLED: "true" }, resendResponseStatus: 503 });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const first = await submit(s);
  const retry = await submit(s, payload({ turnstile_token: "fresh-retry-token" }));

  assert.equal(first.status, 200);
  assert.equal(first.body.emailSent, false);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.deduplicated, true);
  assert.equal(s.db.leads.length, 1);
  assert.equal(s.db.follow_up_tasks.length, 1);
  assert.equal(s.db.lead_activities.filter((activity) => activity.activity_type === "email").length, 1);
  assert.equal(s.sends.length, 1);
  assert.equal(s.quotaReservations.length, 1);
});

test("quota denial keeps the saved inquiry and suppresses confirmation", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({ env: { SUPPRESS_OUTBOUND_EMAILS: "false", PUBLIC_INQUIRY_CONFIRMATIONS_ENABLED: "true" }, quotaAllowed: false });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const result = await submit(s);

  assert.equal(result.status, 200);
  assert.equal(result.body.emailSent, false);
  assert.equal(result.body.emailSuppressed, true);
  assert.equal(s.db.leads.length, 1);
  assert.equal(s.db.follow_up_tasks.length, 1);
  assert.equal(s.quotaReservations.length, 1);
  assert.equal(s.sends.length, 0);
});

test("Postgres lead-limit denial returns 429 without saving a lead or follow-up", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({ leadLimitReachedError: true });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const result = await submit(s);

  assert.equal(result.status, 429);
  assert.match(result.body.error, /inquiry limit has been reached/);
  assert.equal(s.db.leads.length, 0);
  assert.equal(s.db.follow_up_tasks.length, 0);
  assert.equal(s.sends.length, 0);
  assert.equal(s.quotaReservations.length, 0);
});

test("an untrusted requester IP skips only the IP quota and remains eligible for delivery", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({ env: { SUPPRESS_OUTBOUND_EMAILS: "false", PUBLIC_INQUIRY_CONFIRMATIONS_ENABLED: "true" }, requesterIp: "203.0.113.77" });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const result = await submit(s);

  assert.equal(result.status, 200);
  assert.equal(result.body.emailSent, true);
  assert.equal(result.body.emailSuppressed, false);
  assert.equal(s.db.leads.length, 1);
  assert.equal(s.db.follow_up_tasks.length, 1);
  assert.equal(s.quotaReservations.length, 1);
  assert.equal(s.quotaReservations[0].p_ip_hash, null);
  assert.equal(s.sends.length, 1);
});

test("a verified gateway IP is hashed for the optional IP quota", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({
    env: { SUPPRESS_OUTBOUND_EMAILS: "false", PUBLIC_INQUIRY_CONFIRMATIONS_ENABLED: "true", SUPABASE_GATEWAY_IP_HEADER_VERIFIED: "true" },
    requesterIp: "203.0.113.10",
  });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const result = await submit(s);

  assert.equal(result.body.emailSent, true);
  assert.equal(s.quotaReservations[0].p_ip_hash, sha256("203.0.113.10"));
});

test("staging allowlist permits the controlled recipient and suppresses other recipients before Resend", async (t) => {
  t.after(cleanupEdgeHandler);
  const stageUrl = "https://kvocwmrcuhiaezlcgzjf.supabase.co";
  const baseEnv = {
    SUPABASE_URL: stageUrl,
    SUPPRESS_OUTBOUND_EMAILS: "false",
    STAGING_PUBLIC_INQUIRY_RECIPIENT_HASHES: sha256("buyer@example.test"),
  };
  const allowed = createPublicIntakeFixture({ env: baseEnv });
  await installEdgeHandler(allowed, "../../supabase/functions/submit-public-inquiry/index.ts");
  const accepted = await submit(allowed);
  assert.equal(accepted.body.emailSent, true);
  assert.equal(allowed.sends.length, 1);
  cleanupEdgeHandler();

  const blocked = createPublicIntakeFixture({ env: baseEnv });
  await installEdgeHandler(blocked, "../../supabase/functions/submit-public-inquiry/index.ts");
  const refused = await submit(blocked, payload({ email: "outside@example.test" }));
  assert.equal(refused.status, 200);
  assert.equal(refused.body.leadCreated, true);
  assert.equal(refused.body.emailSuppressed, true);
  assert.equal(blocked.db.leads.length, 1);
  assert.equal(blocked.db.follow_up_tasks.length, 1);
  assert.equal(blocked.quotaReservations.length, 0);
  assert.equal(blocked.sends.length, 0);
});

test("staging test send override honors global suppression for one configured recipient and one inquiry", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({ env: stagingTestSendEnv() });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const first = await submit(s);
  s.options.leadLimitReached = true;
  const retry = await submit(s, payload({ turnstile_token: "fresh-retry-token", page_url: "https://example.test/retry" }));

  assert.equal(s.env.SUPPRESS_OUTBOUND_EMAILS, "true");
  assert.equal(first.status, 200);
  assert.equal(first.body.emailSent, true);
  assert.equal(first.body.emailSuppressed, false);
  assert.equal(first.body.leadCreated, true);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.deduplicated, true);
  assert.equal(retry.body.emailSent, false);
  assert.equal(s.db.leads.length, 1);
  assert.equal(s.db.follow_up_tasks.length, 1);
  assert.equal(s.db.lead_activities.filter((activity) => activity.activity_type === "email").length, 1);
  assert.equal(s.db.lead_activities.find((activity) => activity.title === "Staging test buyer confirmation email sent")
    ?.metadata.staging_test_send_override, true);
  assert.equal(s.sends.length, 1);
  assert.equal(s.quotaReservations.length, 1);
  assert.equal(s.botChecks.length, 2);
  assert.notEqual(s.botChecks[0].idempotencyKey, s.botChecks[1].idempotencyKey);
  cleanupEdgeHandler();
});

test("staging test send override is off by default and does not bypass the global suppression switch", async (t) => {
  t.after(cleanupEdgeHandler);
  const { STAGING_PUBLIC_INQUIRY_TEST_SEND_ENABLED: _off, ...env } = stagingTestSendEnv();
  const s = createPublicIntakeFixture({ env });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const result = await submit(s);

  assert.equal(s.env.SUPPRESS_OUTBOUND_EMAILS, "true");
  assert.equal(result.status, 200);
  assert.equal(result.body.leadCreated, true);
  assert.equal(result.body.emailSent, false);
  assert.equal(result.body.emailSuppressed, true);
  assert.equal(s.db.leads.length, 1);
  assert.equal(s.db.follow_up_tasks.length, 1);
  assert.equal(s.quotaReservations.length, 0);
  assert.equal(s.sends.length, 0);
  cleanupEdgeHandler();
});

test("staging test send override requires the exact staging project and configured recipient hash", async (t) => {
  t.after(cleanupEdgeHandler);
  const wrongProject = createPublicIntakeFixture({
    env: stagingTestSendEnv({ SUPABASE_URL: "https://otherproject.supabase.co", PUBLIC_INQUIRY_CONFIRMATIONS_ENABLED: "true" }),
  });
  await installEdgeHandler(wrongProject, "../../supabase/functions/submit-public-inquiry/index.ts");
  const projectResult = await submit(wrongProject);
  assert.equal(projectResult.body.emailSuppressed, true);
  assert.equal(wrongProject.quotaReservations.length, 0);
  assert.equal(wrongProject.sends.length, 0);
  cleanupEdgeHandler();

  const wrongRecipient = createPublicIntakeFixture({ env: stagingTestSendEnv() });
  await installEdgeHandler(wrongRecipient, "../../supabase/functions/submit-public-inquiry/index.ts");
  const recipientResult = await submit(wrongRecipient, payload({ email: "outside@example.test" }));
  assert.equal(recipientResult.status, 200);
  assert.equal(recipientResult.body.emailSuppressed, true);
  assert.equal(wrongRecipient.db.leads.length, 1);
  assert.equal(wrongRecipient.db.follow_up_tasks.length, 1);
  assert.equal(wrongRecipient.quotaReservations.length, 0);
  assert.equal(wrongRecipient.sends.length, 0);
  cleanupEdgeHandler();
});

test("staging test send override requires Turnstile and never enables legacy email", async (t) => {
  t.after(cleanupEdgeHandler);
  const invalidToken = createPublicIntakeFixture({
    env: stagingTestSendEnv(),
    turnstileResponse: { success: false, hostname: "example.test", action: "public_inquiry" },
  });
  await installEdgeHandler(invalidToken, "../../supabase/functions/submit-public-inquiry/index.ts");
  const refused = await submit(invalidToken);
  assert.equal(refused.status, 403);
  assert.equal(invalidToken.db.leads.length, 0);
  assert.equal(invalidToken.db.follow_up_tasks.length, 0);
  assert.equal(invalidToken.quotaReservations.length, 0);
  assert.equal(invalidToken.sends.length, 0);
  cleanupEdgeHandler();

  const legacyHash = sha256("legacy-buyer@example.test");
  const legacy = createPublicIntakeFixture({ env: stagingTestSendEnv({
    STAGING_PUBLIC_INQUIRY_TEST_RECIPIENT_HASH: legacyHash,
    STAGING_PUBLIC_INQUIRY_RECIPIENT_HASHES: legacyHash,
    WAMULE_LEGACY_INQUIRY_TENANT_SLUG: "wamule",
    WAMULE_LEGACY_INQUIRY_PROJECT_SLUG: "wamule",
    WAMULE_LEGACY_INQUIRY_PHASE_SLUG: "default",
  }) });
  legacy.db.organizations[0].slug = "wamule";
  legacy.db.projects[0].slug = "wamule";
  legacy.db.development_phases[0].slug = "default";
  await installEdgeHandler(legacy, "../../supabase/functions/submit-public-inquiry/index.ts");
  const savedLegacy = await submitLegacy(legacy);
  assert.equal(savedLegacy.status, 200);
  assert.equal(savedLegacy.body.emailSent, false);
  assert.equal(savedLegacy.body.emailSuppressed, true);
  assert.equal(legacy.db.leads.length, 1);
  assert.equal(legacy.db.follow_up_tasks.length, 1);
  assert.equal(legacy.quotaReservations.length, 0);
  assert.equal(legacy.sends.length, 0);
  cleanupEdgeHandler();
});

test("the exact seven-field legacy payload is temporary, scoped, persisted, and never emailed", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({ env: { SUPPRESS_OUTBOUND_EMAILS: "false", PUBLIC_INQUIRY_CONFIRMATIONS_ENABLED: "true" } });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const accepted = await submitLegacy(s);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.leadCreated, true);
  assert.equal(accepted.body.emailSent, false);
  assert.equal(accepted.body.emailSuppressed, true);
  assert.equal(s.db.leads.length, 1);
  assert.equal(s.db.follow_up_tasks.length, 1);
  assert.equal(s.quotaReservations.length, 0);
  assert.equal(s.sends.length, 0);
  assert.ok(s.logs.every((line) => !/legacy-buyer@example\.test|Legacy Inquiry Buyer|555 0181|Please send details/i.test(line)));
  cleanupEdgeHandler();

  const disabled = createPublicIntakeFixture({ env: { WAMULE_LEGACY_INQUIRY_COMPAT_ENABLED: "false" } });
  await installEdgeHandler(disabled, "../../supabase/functions/submit-public-inquiry/index.ts");
  const refused = await submitLegacy(disabled);
  assert.equal(refused.status, 503);
  assert.equal(disabled.db.leads.length, 0);
  assert.equal(disabled.db.follow_up_tasks.length, 0);
  assert.equal(JSON.parse(disabled.logs[0]).outcome.result, "compatibility_disabled");

  cleanupEdgeHandler();
  const extended = createPublicIntakeFixture();
  await installEdgeHandler(extended, "../../supabase/functions/submit-public-inquiry/index.ts");
  const withExtraField = await submitLegacy(extended, { ...legacyApplicationPagePayload(), turnstile_token: "not-part-of-the-legacy-contract" });
  assert.equal(withExtraField.status, 400);
  assert.equal(extended.db.leads.length, 0);
  assert.equal(extended.logs.length, 0);
});

test("the staging legacy adapter is restricted to the configured Wamule project and phase", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({
    env: {
      SUPABASE_URL: "https://kvocwmrcuhiaezlcgzjf.supabase.co",
      WAMULE_LEGACY_INQUIRY_TENANT_SLUG: "other",
      WAMULE_LEGACY_INQUIRY_PROJECT_SLUG: "other-project",
      WAMULE_LEGACY_INQUIRY_PHASE_SLUG: "other-initial",
    },
  });
  await installEdgeHandler(s, "../../supabase/functions/submit-public-inquiry/index.ts");

  const refused = await submitLegacy(s);

  assert.equal(refused.status, 503);
  assert.equal(s.calls.some((call) => call.name === "create_scoped_public_inquiry"), false);
  assert.equal(s.db.leads.length, 0);
  assert.equal(s.db.follow_up_tasks.length, 0);
  assert.equal(JSON.parse(s.logs[0]).outcome.result, "compatibility_disabled");
});
