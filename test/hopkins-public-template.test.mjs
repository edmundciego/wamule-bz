import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { defaultPublicExperience } from "../src/lib/publicExperience.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Hopkins always renders the shared Wamule homepage composition", async () => {
  const [hopkins, applicationWizard, wamule, sharedTemplate, route] = await Promise.all([
    read("../src/pages/public/HopkinsPublicPage.tsx"),
    read("../src/pages/public/HopkinsApplicationWizard.tsx"),
    read("../src/pages/ApplicationPage.tsx"),
    read("../src/components/public/WamuleClassicTemplate.tsx"),
    read("../src/pages/public/PublicExperienceRoute.tsx"),
  ]);

  assert.doesNotMatch(hopkins, /templateId|hopkins-project/);
  assert.match(hopkins, /<HopkinsWamuleClassicPage/);
  for (const component of ["WamuleClassicHeader", "WamuleClassicHero", "WamuleClassicInfoTile", "WamuleClassicNotice", "WamuleClassicPanel"]) {
    assert.match(hopkins, new RegExp("<" + component));
    assert.match(wamule, new RegExp(component));
    assert.match(sharedTemplate, new RegExp("export function " + component));
  }
  assert.match(route, /scopeName: keyof typeof scopes/);
  assert.match(route, /<HopkinsPublicPage enabledModules=\{experience\.enabledModules\}/);
  assert.match(hopkins, /data-site-template="wamule-classic"/);
  assert.match(hopkins, /data-public-tenant="hopkins-grove"/);
  assert.match(hopkins, /tenantSlug=\{HOPKINS_SCOPE\.tenant\}/);
  assert.match(hopkins, /projectSlug=\{HOPKINS_SCOPE\.project\}/);
  assert.match(hopkins, /phaseSlug=\{HOPKINS_SCOPE\.phase\}/);
  assert.match(applicationWizard, /<FormStep title="About You"/);
  assert.match(applicationWizard, /<FormStep title="Review & Acknowledge"/);
  assert.match(applicationWizard, /Submit application/);
  assert.doesNotMatch(applicationWizard, /Submit project application|payment_option|submit-public-application/);
});

test("Hopkins homepage and application flow each contain the scoped interactive map", async () => {
  const [source, applicationWizard] = await Promise.all([
    read("../src/pages/public/HopkinsPublicPage.tsx"),
    read("../src/pages/public/HopkinsApplicationWizard.tsx"),
  ]);
  const mapScopes = [source, applicationWizard].flatMap((file) => file.match(/tenantSlug=\{HOPKINS_SCOPE\.tenant\}[\s\S]{0,180}projectSlug=\{HOPKINS_SCOPE\.project\}[\s\S]{0,180}phaseSlug=\{HOPKINS_SCOPE\.phase\}/g) ?? []);
  assert.ok(mapScopes.length >= 2, "homepage and application map should each be fixed to Hopkins project/phase");
  assert.match(applicationWizard, /selectedMapFeatureRefs=\{selectedMapFeatureRefs\}/);
  assert.match(applicationWizard, /onToggleMapFeature=\{onToggleMapFeature\}/);
  assert.match(applicationWizard, /preferred_map_feature_refs: selectedMapFeatureRefs/);
  assert.match(applicationWizard, /Selected map references/);
  assert.match(applicationWizard, /onRemoveMapFeature\(ref\)/);
  assert.doesNotMatch(applicationWizard, /preferred_parcel_ids:\s*selectedMapFeatureRefs/);
});

test("template defaults do not change tenant, project, phase, or modules", () => {
  const hopkins = defaultPublicExperience({ tenantSlug: "hopkins-grove", projectSlug: "hopkins-grove", phaseSlug: "initial" });
  const wamule = defaultPublicExperience({ tenantSlug: "wamule", projectSlug: "wamule", phaseSlug: "default" });
  assert.equal(hopkins.templateId, "wamule-classic");
  assert.equal(wamule.templateId, "wamule-classic");
  assert.deepEqual(hopkins.enabledModules, { map: true, inquiry: true, application: true, pricing: true });
  assert.deepEqual(wamule.enabledModules, hopkins.enabledModules);
});
