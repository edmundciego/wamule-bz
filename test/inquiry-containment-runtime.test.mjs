import test from "node:test";
import assert from "node:assert/strict";
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
  const response = await s.handler(new Request("https://edge.invalid/submit-public-inquiry", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://example.test" }, body: JSON.stringify(data),
  }));
  return { status: response.status, body: await response.json() };
}

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

test("mixed selectors, conflicting hosts, inactive phases, unpublished scopes, foreign lots and outlines write nothing", async (t) => {
  t.after(cleanupEdgeHandler);
  const cases = [
    { options: {}, body: payload({ tenant: "other", hostname: "example.test" }) },
    { options: {}, body: payload({ phase: "second", hostname: "example.test" }) },
    { options: {}, body: payload({ phase: "inactive", hostname: "" }) },
    { options: { unpublished: true }, body: payload({ specific_lot_ref: "plr2:project:initial:42" }) },
    { options: { unpublished: true }, body: payload({ specific_lot_ref: undefined, specific_map_feature_ref: FIXTURE_IDS.feature }) },
    { options: {}, body: payload({ specific_lot_ref: "plr2:other-project:other-initial:84" }) },
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
