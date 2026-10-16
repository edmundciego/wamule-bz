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

test("Hopkins application rejects other tenants, projects, and phases", () => {
  for (const body of [
    { ...valid, tenant: "wamule" },
    { ...valid, project: "other-project" },
    { ...valid, phase: "other-phase" },
  ]) assert.match(validateHopkinsProjectApplicationPayload(body).error, /Hopkins Grove/);
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

test("application endpoint resolves fixed project scope, active public map identities, and retry references", async () => {
  const endpoint = await readFile(new URL("../supabase/functions/submit-hopkins-project-application/index.ts", import.meta.url), "utf8");
  assert.match(endpoint, /from\("organizations"\)[\s\S]*?eq\("slug", SCOPE\.tenant\)/);
  assert.match(endpoint, /from\("projects"\)[\s\S]*?eq\("tenant_id", tenant\.id\)[\s\S]*?eq\("slug", SCOPE\.project\)/);
  assert.match(endpoint, /from\("development_phases"\)[\s\S]*?eq\("project_id", project\.id\)[\s\S]*?eq\("slug", SCOPE\.phase\)/);
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

test("the Hopkins full application and the existing Wamule purchase application remain separate", async () => {
  const [hopkinsPage, wamulePage, appRoutes, adminPage] = await Promise.all([
    readFile(new URL("../src/pages/public/HopkinsPublicPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/ApplicationPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/ApplicationsPage.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(hopkinsPage, /submit-hopkins-project-application/);
  assert.match(hopkinsPage, /Register your interest/);
  assert.match(hopkinsPage, /Project application/);
  assert.match(hopkinsPage, /preferred_map_feature_refs: selectedMapFeatureRefs/);
  assert.match(hopkinsPage, /No lot selection, payment choice, or purchase availability is required/);
  assert.match(wamulePage, /submit-public-application/);
  assert.match(appRoutes, /path="\/hopkins\/application"/);
  assert.match(adminPage, /Project applications/);
  assert.match(adminPage, /mapFeatureLabels\.find/);
  assert.match(adminPage, /workspace!\.projectId/);
  assert.match(adminPage, /workspace!\.phaseId/);
});
