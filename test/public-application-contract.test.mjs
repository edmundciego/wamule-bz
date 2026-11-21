import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildPublicApplicationPayload,
  validatePublicApplicationPayload,
} from "../supabase/functions/_shared/public-application-contract.ts";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const validInput = {
  tenant: "wamule",
  project: "main",
  phase: "initial",
  hostname: "wamule.example.test",
  applicant_full_name: "Amara Test",
  applicant_address: "Hopkins, Belize",
  nationality: "Belizean",
  occupation: "Teacher",
  phone: "+501 600 0000",
  email: "amara@example.com",
  intended_use: "Residential",
  intended_use_other: "",
  parcel_count: 1,
  preferred_lot_refs: ["plr1:main:L-001"],
  alternate_lot_preference: "Any available lot",
  payment_option: "Installment Plan",
  legal_notice_acknowledged: true,
  applicant_acknowledgement_signature: "Amara Test",
  notes: "",
  sustainability_terms_verified: true,
};

test("public application builder keeps database identity and staff fields off the wire", () => {
  const body = buildPublicApplicationPayload({
    ...validInput,
    id: 987,
    tenant_id: "sensitive-tenant-id",
    preferred_parcel_ids: [987],
    status: "Approved",
    created_by: "staff-id",
  });
  assert.deepEqual(body, validInput);
  assert.ok(!("tenant_id" in body));
  assert.ok(!("id" in body));
  assert.ok(!("preferred_parcel_ids" in body));
  assert.ok(!("status" in body));
  assert.ok(!("created_by" in body));
});

test("valid public application payload resolves only the opaque lot reference", () => {
  const result = validatePublicApplicationPayload(buildPublicApplicationPayload(validInput));
  assert.ok(!("error" in result));
  assert.equal(result.tenant, "wamule");
  assert.deepEqual(result.preferred_lot_refs, ["plr1:main:L-001"]);
  assert.equal(result.email, "amara@example.com");
  assert.equal(result.submission_reference, null, "legacy clients may omit the optional retry key");
});

test("application client includes its stable submission reference for retries", () => {
  const body = buildPublicApplicationPayload({ ...validInput, submission_reference: "123e4567-e89b-42d3-a456-426614174000" });
  assert.equal(body.submission_reference, "123e4567-e89b-42d3-a456-426614174000");
});

test("application validation rejects raw ids, unknown fields, stale references, and duplicate selections", () => {
  assert.match(validatePublicApplicationPayload({ ...validInput, preferred_parcel_ids: [987] }).error, /Reload/);
  assert.match(validatePublicApplicationPayload({ ...validInput, tenant_id: "x" }).error, /Reload/);
  assert.match(validatePublicApplicationPayload({ ...validInput, id: 987 }).error, /Reload/);
  assert.match(validatePublicApplicationPayload({ ...validInput, preferred_lot_refs: ["plr1:main:%"] }).error, /current public map/);
  assert.match(validatePublicApplicationPayload({ ...validInput, preferred_lot_refs: ["plr1:main:L-001", "plr1:main:L-001"] }).error, /duplicate/);
  assert.match(validatePublicApplicationPayload({ ...validInput, preferred_lot_refs: ["plr1:main:L-001", "plr1:%6dain:L-001"] }).error, /duplicate/);
  assert.match(validatePublicApplicationPayload({ ...validInput, legal_notice_acknowledged: false }).error, /acknowledgement/);
});

test("application browser uses public map and server submission, never the legacy id view or direct insert", async () => {
  const form = await read("src/components/public/PublicApplicationForm.tsx");
  const plots = await read("src/lib/publicApplicationPlots.ts");
  assert.match(form, /submitPublicFunction\("submit-public-application"/);
  assert.match(form, /submission_reference: submissionReference\.current/);
  assert.match(plots, /get-public-lots\?\$\{params\}/);
  assert.match(plots, /phase: scope\.phaseSlug/);
  assert.doesNotMatch(form + plots, /public_parcel_options|\.from\("applications"\)\.insert|preferred_parcel_ids|parcel\.id/);

});

test("application Edge Function resolves lot refs and derives database ids and tenant server-side", async () => {
  const fn = await read("supabase/functions/submit-public-application/index.ts");
  assert.match(fn, /validatePublicApplicationPayload/);
  assert.match(fn, /resolvePublicSubmissionScope\(supabase/);
  assert.match(fn, /const tenantId = applicationScope\.tenantId/);
  assert.match(fn, /eq\("status", "Available"\)/);
  assert.match(fn, /preferred_parcel_ids: parcelIds/);
  assert.match(fn, /!effectiveSettings\.noticesComplete/);
  assert.match(fn, /if \(!effectiveSettings\.applicationsOpen\)/);
  assert.match(fn, /submission_fingerprint: fingerprint/);
  assert.match(fn, /return json\(\{ ok: true, deduplicated: false/);
  assert.doesNotMatch(fn, /select\("id"\)[\s\S]{0,40}return json\(\{[^}]*id:/);
});

test("migration removes anonymous id-view access and direct public application inserts", async () => {
  const migration = await read("supabase/migrations/20261011000000_public_lot_identity_lockdown.sql");
  assert.match(migration, /revoke select on table public\.public_parcel_options from PUBLIC, anon, authenticated/i);
  assert.match(migration, /drop policy if exists "Public can submit applications"/i);
  assert.match(migration, /revoke insert on table public\.applications from anon/i);
  const config = await read("supabase/config.toml");
  assert.match(config, /\[functions\.submit-public-application\]\s+verify_jwt = false/);
});
