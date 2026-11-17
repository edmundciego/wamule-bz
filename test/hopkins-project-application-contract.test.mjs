import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildHopkinsProjectApplicationPayload,
  validateHopkinsProjectApplicationPayload,
} from "../supabase/functions/_shared/hopkins-project-application-contract.mjs";

const mapRef = "d0a558f3-822b-47a5-ae1b-b0731ad66b97";
const valid = {
  tenant: "hopkins-grove",
  project: "hopkins-grove",
  phase: "initial",
  hostname: "hopkins.example.test",
  submission_reference: "7db4f4a8-cd45-4a15-b364-16d65fb62a7e",
  applicant_full_name: "Synthetic Hopkins Applicant",
  applicant_address: "1 Test Street, Hopkins Village",
  nationality: "Belizean",
  occupation: "Planner",
  phone: "+501 600 0000",
  email: "synthetic@example.invalid",
  intended_use: "Residential",
  intended_use_other: "",
  preferred_map_feature_refs: [mapRef],
  notes: "Synthetic application for workflow verification.",
  legal_notice_acknowledged: true,
  applicant_acknowledgement_signature: "Synthetic Hopkins Applicant",
};

test("Hopkins application accepts scoped map identity preferences without parcel or payment fields", () => {
  const result = validateHopkinsProjectApplicationPayload(valid);
  assert.equal("error" in result, false);
  assert.deepEqual(result.preferred_map_feature_refs, [mapRef]);
  const payload = buildHopkinsProjectApplicationPayload(valid);
  assert.equal(payload.tenant, "hopkins-grove");
  assert.equal(payload.project, "hopkins-grove");
  assert.equal(payload.phase, "initial");
  assert.equal(payload.hostname, "hopkins.example.test");
  assert.deepEqual(payload.preferred_map_feature_refs, [mapRef]);
  assert.equal("preferred_parcel_ids" in payload, false);
  assert.equal("parcel_id" in payload, false);
  assert.equal("payment_option" in payload, false);
});

test("general project interest needs no map preference and remains unallocated", () => {
  const result = validateHopkinsProjectApplicationPayload({ ...valid, preferred_map_feature_refs: [] });
  assert.equal("error" in result, false);
  assert.deepEqual(result.preferred_map_feature_refs, []);
});

test("project application wire contract accepts only well-formed host and scope selectors", () => {
  for (const body of [
    { ...valid, tenant: "has spaces" },
    { ...valid, project: "bad/project" },
    { ...valid, phase: "" },
    { ...valid, hostname: "not a hostname" },
  ]) assert.ok("error" in validateHopkinsProjectApplicationPayload(body));
});

test("map preferences reject malformed, duplicate, or excessive outline identities", () => {
  assert.match(validateHopkinsProjectApplicationPayload({ ...valid, preferred_map_feature_refs: ["Plot 392"] }).error, /map outlines|references/);
  assert.match(validateHopkinsProjectApplicationPayload({ ...valid, preferred_map_feature_refs: [mapRef, mapRef] }).error, /duplicate/i);
  assert.match(validateHopkinsProjectApplicationPayload({ ...valid, preferred_map_feature_refs: Array.from({ length: 6 }, (_, i) => `d0a558f3-822b-47a5-ae1b-b0731ad66b${String(i).padStart(2, "0")}`) }).error, /no more than 5/);
});

test("Hopkins notice acknowledgement and signature are required", () => {
  assert.match(validateHopkinsProjectApplicationPayload({ ...valid, legal_notice_acknowledged: false }).error, /acknowledge/i);
  assert.match(validateHopkinsProjectApplicationPayload({ ...valid, applicant_acknowledgement_signature: "Someone Else" }).error, /full name/i);
});

test("project application endpoint verifies host scope, active public map identities, and retry references", async () => {
  const endpoint = await readFile(new URL("../supabase/functions/submit-hopkins-project-application/index.ts", import.meta.url), "utf8");
  assert.match(endpoint, /resolve_public_hostname/);
  assert.match(endpoint, /eq\("slug", input\.tenant\)/);
  assert.match(endpoint, /eq\("slug", input\.project\)/);
  assert.match(endpoint, /eq\("slug", input\.phase\)/);
  assert.match(endpoint, /resolvePublicApplicationSettings/);
  assert.match(endpoint, /resolvePublicApplicationSettings\(companySettings\?\.value, settingsRow\.value, phaseId\)/);
  assert.match(endpoint, /from\("map_feature_snapshots"\)[\s\S]*?eq\("is_active", true\)/);
  assert.match(endpoint, /preferred_map_feature_refs/);
  assert.match(endpoint, /submission_reference/);
  assert.match(endpoint, /submission_fingerprint/);
  assert.match(endpoint, /insert\(\{/);
  assert.doesNotMatch(endpoint, /sendConfirmationEmail|email_notifications|submit-public-application/);
});

test("application storage guard keeps the project workflow separate from inventory and purchase terms", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20261016054341_hopkins_project_application_workflow.sql", import.meta.url), "utf8");
  assert.match(migration, /foreign key \(phase_id, project_id, tenant_id\)/);
  assert.match(migration, /public\.user_has_application_scope\(tenant_id, project_id, phase_id\)/);
  assert.match(migration, /parcel_id is null and parcel_count is null/);
  assert.match(migration, /cardinality\(preferred_parcel_ids\)=0/);
  assert.match(migration, /payment_option is null/);
  assert.match(migration, /create_lead_from_project_application/);
  assert.match(migration, /for each row when \(new\.application_kind is distinct from 'project_application'\)/);
});

test("the dedicated page and templates reuse one form with separate scoped submission contracts", async () => {
  const [hopkinsPage, wamulePage, appRoutes, adminPage, form, experience] = await Promise.all([
    readFile(new URL("../src/pages/public/HopkinsPublicPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/ApplicationPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/ApplicationsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/public/PublicApplicationForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/public/PublicExperienceRoute.tsx", import.meta.url), "utf8"),
  ]);
  for (const template of [hopkinsPage, wamulePage]) {
    assert.match(template, /\{application\}/);
    assert.doesNotMatch(template, /submit-hopkins-project-application|submit-public-application/);
  }
  assert.match(hopkinsPage, /Register your interest/);
  assert.match(form, /submit-hopkins-project-application/);
  assert.match(form, /preferred_map_feature_refs: input\.preferred_lot_refs/);
  assert.match(form, /submitPublicFunction\("submit-public-application", buildPublicApplicationPayload/);
  assert.equal(experience.match(/<PublicApplicationForm\b/g)?.length, 1);
  assert.match(experience, /<PublicApplicationPage[\s\S]*?\{application\}<\/PublicApplicationPage>/);
  assert.match(appRoutes, /path="\/apply" element=\{<PublicHostRoute applicationOnly/);
  assert.match(appRoutes, /path="\/hopkins\/application" element=\{<PublicHostRoute applicationOnly/);
  assert.match(appRoutes, /path="\/p\/:tenant_slug\/:project_slug\/apply" element=\{<SharedProjectRoute applicationOnly/);
  assert.match(adminPage, /Project applications/);
  assert.match(adminPage, /mapFeatureLabels\.find/);
  assert.match(adminPage, /workspace!\.projectId/);
  assert.match(adminPage, /workspace!\.phaseId/);
});
