import test from "node:test";
import assert from "node:assert/strict";
import { defaultPublicExperience, normalizePublicExperience, publicExperienceSetting, PUBLIC_SITE_TEMPLATES } from "../src/lib/publicExperience.mjs";

const wamule = { tenantSlug: "wamule", projectSlug: "wamule", phaseSlug: "default" };
const hopkins = { tenantSlug: "hopkins-grove", projectSlug: "hopkins-grove", phaseSlug: "initial" };

test("public template defaults are independent of tenant and project scope", () => {
  assert.deepEqual(defaultPublicExperience(wamule), {
    templateId: "wamule-classic",
    uiRestrictedAccess: false,
    enabledModules: { map: true, inquiry: true, application: true, pricing: true },
  });
  assert.deepEqual(defaultPublicExperience(hopkins), {
    templateId: "wamule-classic",
    uiRestrictedAccess: false,
    enabledModules: { map: true, inquiry: true, application: true, pricing: true },
  });
});

test("invalid template values fall back globally and never alter application settings", () => {
  const config = normalizePublicExperience(hopkins, {
    templateId: "unknown",
    enabledModules: { map: false, application: "off", admin: true },
    applicationSettings: { applicationsOpen: false },
  });
  assert.deepEqual(config, {
    templateId: "wamule-classic",
    uiRestrictedAccess: false,
    enabledModules: { map: false, inquiry: true, application: true, pricing: true },
  });
  assert.equal("applicationSettings" in config, false);
});

test("legacy alternate template values normalize to the single shared template", () => {
  const config = normalizePublicExperience(hopkins, {
    templateId: "hopkins-project",
    enabledModules: { map: true, inquiry: false, application: true, pricing: true },
  });
  assert.equal(PUBLIC_SITE_TEMPLATES.length, 1);
  assert.equal(config.templateId, "wamule-classic");
  assert.deepEqual(config.enabledModules, { map: true, inquiry: false, application: true, pricing: true });
});

test("presentation values read only the nested site experience key", () => {
  assert.deepEqual(publicExperienceSetting({ tokens: { primary: "#173f2d" }, site_experience: { templateId: "hopkins-project" } }), {
    templateId: "hopkins-project",
  });
  assert.deepEqual(publicExperienceSetting({ company_name: "Wamule" }), {});
});
