import assert from "node:assert/strict";
import test from "node:test";
import { isLocalOnlySubmissionForScope } from "../src/lib/publicSubmissionScope.mjs";

test("local development never writes hosted public submissions", () => {
  assert.equal(isLocalOnlySubmissionForScope({
    isDev: true,
    demoMode: "false",
    tenantSlug: "map-studio-workflow-test",
    projectSlug: "map-studio-import-qa",
    stagingSubmissionScopes: ["map-studio-workflow-test/map-studio-import-qa"],
  }), true);
});

test("staging demo submissions remain local unless exact tenant and project are allowlisted", () => {
  const stagingSubmissionScopes = ["map-studio-workflow-test/map-studio-import-qa"];
  const options = { isDev: false, demoMode: "true", stagingSubmissionScopes };
  assert.equal(isLocalOnlySubmissionForScope({ ...options, tenantSlug: "map-studio-workflow-test", projectSlug: "map-studio-import-qa" }), false);
  assert.equal(isLocalOnlySubmissionForScope({ ...options, tenantSlug: "map-studio-workflow-test", projectSlug: "other-project" }), true);
  assert.equal(isLocalOnlySubmissionForScope({ ...options, tenantSlug: "hopkins-grove", projectSlug: "hopkins-grove" }), true);
  assert.equal(isLocalOnlySubmissionForScope({ ...options, tenantSlug: "wamule-development", projectSlug: "wamule" }), true);
});
