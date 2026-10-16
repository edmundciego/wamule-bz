import test from "node:test";
import assert from "node:assert/strict";
import { defaultPublicExperience, normalizePublicExperience, publicExperienceSetting } from "../src/lib/publicExperience.mjs";

const wamule = { tenantSlug: "wamule", projectSlug: "wamule", phaseSlug: "default" };
const hopkins = { tenantSlug: "hopkins-grove", projectSlug: "hopkins-grove", phaseSlug: "initial" };

test("tenant/project scopes retain their existing public template defaults", () => {
  assert.deepEqual(defaultPublicExperience(wamule), {
    templateId: "wamule-classic",
    enabledModules: { map: true, inquiry: true, application: true, pricing: true },
  });
  assert.deepEqual(defaultPublicExperience(hopkins), {
    templateId: "hopkins-project",
    enabledModules: { map: true, inquiry: true, application: true, pricing: true },
  });
});

test("invalid template values fall back by scope and never alter application settings", () => {
  const config = normalizePublicExperience(hopkins, {
    templateId: "unknown",
    enabledModules: { map: false, application: "off", admin: true },
    applicationSettings: { applicationsOpen: false },
  });
  assert.deepEqual(config, {
    templateId: "hopkins-project",
    enabledModules: { map: false, inquiry: true, application: true, pricing: true },
  });
  assert.equal("applicationSettings" in config, false);
});

test("presentation values read only the nested site experience key", () => {
  assert.deepEqual(publicExperienceSetting({ tokens: { primary: "#173f2d" }, site_experience: { templateId: "hopkins-project" } }), {
    templateId: "hopkins-project",
  });
  assert.deepEqual(publicExperienceSetting({ company_name: "Wamule" }), {});
});
