import test from "node:test";
import assert from "node:assert/strict";
import { resolvePublicApplicationAccess } from "../src/lib/public-application-access.mjs";

test("valid shared-path land application is submittable without a hostname", () => {
  const data = {
    siteExperience: { applicationType: "land_purchase", enabledModules: { application: true } },
    publicApplication: { applications_open: true, notices_complete: true },
  };
  assert.deepEqual(resolvePublicApplicationAccess(data), { accepting: true, canSubmit: true });
});

test("closed, incomplete, or disabled applications remain unavailable", () => {
  const base = {
    siteExperience: { applicationType: "land_purchase", enabledModules: { application: true } },
    publicApplication: { applications_open: true, notices_complete: true },
  };
  assert.equal(resolvePublicApplicationAccess({ ...base, publicApplication: { ...base.publicApplication, applications_open: false } }).canSubmit, false);
  assert.equal(resolvePublicApplicationAccess({ ...base, publicApplication: { ...base.publicApplication, notices_complete: false } }).canSubmit, false);
  assert.equal(resolvePublicApplicationAccess({ ...base, siteExperience: { ...base.siteExperience, enabledModules: { application: false } } }).canSubmit, false);
  assert.equal(resolvePublicApplicationAccess({ ...base, siteExperience: { applicationType: "project_application", enabledModules: { application: true } } }).canSubmit, false);
});
