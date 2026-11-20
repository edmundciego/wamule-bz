import test from "node:test";
import assert from "node:assert/strict";
import { cleanupEdgeHandler, createPublicIntakeFixture, installEdgeHandler, FIXTURE_IDS } from "./helpers/public-intake-fixture.mjs";

const LAND_REF = "123e4567-e89b-42d3-a456-426614174000";
const PROJECT_REF = "123e4567-e89b-42d3-a456-426614174001";

function landPayload(overrides = {}) {
  return {
    tenant: "example", project: "project", phase: "initial", hostname: "",
    submission_reference: LAND_REF,
    applicant_full_name: "Test Applicant", applicant_address: "1 Test Street", nationality: "Belizean",
    occupation: "Surveyor", phone: "+501 555 0100", email: "applicant@example.test",
    intended_use: "Residential", intended_use_other: "", parcel_count: 1,
    preferred_lot_refs: ["plr2:project:initial:42"], alternate_lot_preference: "Any similar lot",
    payment_option: "Installments", legal_notice_acknowledged: true,
    applicant_acknowledgement_signature: "Test Applicant", notes: "", sustainability_terms_verified: true,
    ...overrides,
  };
}

function projectPayload(overrides = {}) {
  return {
    tenant: "example", project: "project", phase: "initial", hostname: "",
    submission_reference: PROJECT_REF,
    applicant_full_name: "Test Applicant", applicant_address: "1 Test Street", nationality: "Belizean",
    occupation: "Surveyor", phone: "+501 555 0100", email: "applicant@example.test",
    intended_use: "Residential", intended_use_other: "", preferred_map_feature_refs: [],
    notes: "Project inquiry", legal_notice_acknowledged: true,
    applicant_acknowledgement_signature: "Test Applicant", ...overrides,
  };
}

async function submit(s, endpoint, body) {
  const response = await s.handler(new Request(`https://edge.invalid/${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

test("land applications accept shared paths and deduplicate across verified hosts", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture(); await installEdgeHandler(s, "../../supabase/functions/submit-public-application/index.ts");
  const path = await submit(s, "submit-public-application", landPayload());
  const customRetry = await submit(s, "submit-public-application", landPayload({ hostname: "other.example.test" }));
  assert.equal(path.status, 201); assert.equal(path.body.deduplicated, false);
  assert.equal(customRetry.status, 200); assert.equal(customRetry.body.deduplicated, true);
  assert.equal(s.db.applications.length, 1); assert.equal(s.writes.filter((write) => write.table === "applications").length, 1);
});

test("project applications accept shared paths and verified custom domains", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({ applicationType: "project_application" });
  await installEdgeHandler(s, "../../supabase/functions/submit-hopkins-project-application/index.ts");
  const path = await submit(s, "submit-hopkins-project-application", projectPayload());
  const retry = await submit(s, "submit-hopkins-project-application", projectPayload({ hostname: "other.example.test" }));
  assert.equal(path.status, 201); assert.equal(path.body.deduplicated, false);
  assert.equal(retry.status, 200); assert.equal(retry.body.deduplicated, true);
  const changed = await submit(s, "submit-hopkins-project-application", projectPayload({ hostname: "example.test", notes: "Different note" }));
  assert.equal(changed.status, 409);
  assert.equal(s.db.applications.length, 1);
});

test("concurrent project applications with one reference create one application", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture({ applicationType: "project_application" });
  await installEdgeHandler(s, "../../supabase/functions/submit-hopkins-project-application/index.ts");
  const [first, second] = await Promise.all([
    submit(s, "submit-hopkins-project-application", projectPayload()),
    submit(s, "submit-hopkins-project-application", projectPayload()),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  assert.equal(s.db.applications.length, 1);
});

test("land application retries conflict on changed semantic content and collapse concurrent sends", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture(); await installEdgeHandler(s, "../../supabase/functions/submit-public-application/index.ts");
  const [first, concurrent] = await Promise.all([
    submit(s, "submit-public-application", landPayload()),
    submit(s, "submit-public-application", landPayload()),
  ]);
  const changed = await submit(s, "submit-public-application", landPayload({ notes: "Changed content" }));
  assert.deepEqual([first.status, concurrent.status].sort(), [200, 201]);
  assert.equal(changed.status, 409); assert.equal(s.db.applications.length, 1);
});

test("mixed scopes, conflicting hosts, foreign lots/outlines and inactive or unpublished phases reject before writes", async (t) => {
  t.after(cleanupEdgeHandler);
  const cases = [
    { type: "land", options: {}, body: landPayload({ tenant: "other", hostname: "example.test" }) },
    { type: "land", options: {}, body: landPayload({ hostname: "other.test" }) },
    { type: "land", options: {}, body: landPayload({ preferred_lot_refs: ["plr2:other-project:other-initial:84"] }) },
    { type: "land", options: { unpublished: true }, body: landPayload() },
    { type: "land", options: {}, body: landPayload({ phase: "inactive" }) },
    { type: "project", options: { applicationType: "project_application" }, body: projectPayload({ hostname: "other.test" }) },
    { type: "project", options: { applicationType: "project_application" }, body: projectPayload({ phase: "inactive" }) },
    { type: "project", options: { applicationType: "project_application", disallowedPhase: true }, body: projectPayload({ phase: "second" }) },
    { type: "project", options: { applicationType: "project_application" }, body: projectPayload({ preferred_map_feature_refs: [FIXTURE_IDS.otherFeature] }) },
    { type: "project", options: { applicationType: "project_application", inactiveOutline: true }, body: projectPayload({ preferred_map_feature_refs: [FIXTURE_IDS.feature] }) },
    { type: "project", options: { applicationType: "project_application", unpublishedPackage: true }, body: projectPayload() },
  ];
  for (const item of cases) {
    const s = createPublicIntakeFixture(item.options);
    const file = item.type === "land" ? "../../supabase/functions/submit-public-application/index.ts" : "../../supabase/functions/submit-hopkins-project-application/index.ts";
    const endpoint = item.type === "land" ? "submit-public-application" : "submit-hopkins-project-application";
    await installEdgeHandler(s, file);
    const result = await submit(s, endpoint, item.body);
    assert.ok(result.status >= 400, JSON.stringify({ item, result }));
    assert.equal(s.db.applications.length, 0, JSON.stringify(item));
    cleanupEdgeHandler();
  }
});

test("company closure, project closure, notices and phase allowlists are enforced", async (t) => {
  t.after(cleanupEdgeHandler);
  for (const [options, body, expectedStatus] of [
    [{ companyOpen: false }, landPayload(), 403],
    [{ projectOpen: false }, landPayload(), 403],
    [{ missingNotice: true }, landPayload(), 503],
    [{ disallowedPhase: true }, landPayload({ phase: "second", preferred_lot_refs: ["plr2:project:second:43"] }), 403],
  ]) {
    const s = createPublicIntakeFixture(options); await installEdgeHandler(s, "../../supabase/functions/submit-public-application/index.ts");
    const result = await submit(s, "submit-public-application", body);
    assert.equal(result.status, expectedStatus); assert.equal(s.db.applications.length, 0);
    cleanupEdgeHandler();
  }
  const project = createPublicIntakeFixture({ applicationType: "project_application", missingNotice: true });
  await installEdgeHandler(project, "../../supabase/functions/submit-hopkins-project-application/index.ts");
  const incompleteNotice = await submit(project, "submit-hopkins-project-application", projectPayload());
  assert.equal(incompleteNotice.status, 503); assert.equal(project.db.applications.length, 0);
  cleanupEdgeHandler();
  for (const options of [{ companyOpen: false }, { projectOpen: false }]) {
    const closed = createPublicIntakeFixture({ applicationType: "project_application", ...options });
    await installEdgeHandler(closed, "../../supabase/functions/submit-hopkins-project-application/index.ts");
    const result = await submit(closed, "submit-hopkins-project-application", projectPayload());
    assert.equal(result.status, 403); assert.equal(closed.db.applications.length, 0);
    cleanupEdgeHandler();
  }
});

test("a second tenant and a second active phase resolve to their own application rows", async (t) => {
  t.after(cleanupEdgeHandler);
  const s = createPublicIntakeFixture(); await installEdgeHandler(s, "../../supabase/functions/submit-public-application/index.ts");
  const first = await submit(s, "submit-public-application", landPayload());
  const secondTenant = await submit(s, "submit-public-application", landPayload({
    tenant: "other", project: "other-project", phase: "other-initial", hostname: "other.test",
    submission_reference: "123e4567-e89b-42d3-a456-426614174002", preferred_lot_refs: ["plr2:other-project:other-initial:84"],
  }));
  const secondPhase = await submit(s, "submit-public-application", landPayload({
    phase: "second", submission_reference: "123e4567-e89b-42d3-a456-426614174003",
    preferred_lot_refs: ["plr2:project:second:43"],
  }));
  assert.equal(first.status, 201); assert.equal(secondTenant.status, 201); assert.equal(secondPhase.status, 201);
  assert.deepEqual(s.db.applications.map(({ tenant_id, phase_id }) => [tenant_id, phase_id]), [
    [FIXTURE_IDS.tenant, FIXTURE_IDS.phase],
    [FIXTURE_IDS.otherTenant, FIXTURE_IDS.otherPhase],
    [FIXTURE_IDS.tenant, FIXTURE_IDS.secondPhase],
  ]);
});
