import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { defaultPublicExperience } from "../src/lib/publicExperience.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("both tenant adapters render the shared homepage frame and preserve distinct forms", async () => {
  const [hopkins, wizard, wamule, frame, route, app] = await Promise.all([
    read("../src/pages/public/HopkinsPublicPage.tsx"),
    read("../src/pages/public/HopkinsApplicationWizard.tsx"),
    read("../src/pages/ApplicationPage.tsx"),
    read("../src/components/public/PublicHomepage.tsx"),
    read("../src/pages/public/PublicExperienceRoute.tsx"),
    read("../src/App.tsx"),
  ]);
  for (const adapter of [hopkins, wamule]) {
    assert.match(adapter, /<PublicHomepage/);
    assert.match(adapter, /templateId=\{templateId\}/);
    assert.doesNotMatch(adapter, /<WamuleClassicHero|<WamuleClassicHeader|<WamuleClassicNotice/);
  }
  assert.match(frame, /templates\[resolvePublicSiteTemplateId\(props.templateId\)\]/);
  assert.match(route, /<HopkinsPublicPage templateId=\{experience.templateId\}/);
  assert.match(route, /<ApplicationPage templateId=\{experience.templateId\}/);
  assert.match(route, /if \(!hasSupabaseConfig\)/);
  assert.match(route, /if \(isError \|\| !data\)/);
  assert.doesNotMatch(route, /defaultPublicExperience\(scope\)/);
  assert.doesNotMatch(app, /element=\{<HopkinsPublicPage/);
  assert.match(hopkins, /Map references are preferences only/);
  assert.match(hopkins, /sideAlignment: "start"/);
  assert.doesNotMatch(hopkins, /65 x 101|75 x 101/);
  assert.match(wamule, /label: "Payment Preference"/);
  assert.match(wizard, /<FormStep title="About You"/);
  assert.match(wizard, /<FormStep title="Review & Acknowledge"/);
  assert.doesNotMatch(wizard, /payment_option|submit-public-application/);
});

test("Hopkins homepage price and lot-size facts use Hopkins source information", async () => {
  const [hopkins, tierSource] = await Promise.all([
    read("../src/pages/public/HopkinsPublicPage.tsx"),
    read("../map-input/hopkins.tiers.json"),
  ]);
  const tiers = JSON.parse(tierSource);
  const residentialStartingPrice = Math.min(
    ...Object.values(tiers.tiers)
      .filter((tier) => tier.group === "Residential")
      .map((tier) => tier.price),
  );
  assert.equal(residentialStartingPrice, 25000);
  assert.match(hopkins, /hopkinsStartingPriceLabel/);
  assert.match(hopkins, /hopkinsHomesiteSizeLabel = "Quarter-acre homesites"/);
  assert.doesNotMatch(hopkins, /payment option|monthly payment|65 x 101|75 x 101/);
});

test("Hopkins homepage and map share every source-backed plot category", async () => {
  const [hopkins, categories, categoryData, map, applicationWizard, tierSource] = await Promise.all([
    read("../src/pages/public/HopkinsPublicPage.tsx"),
    read("../src/components/public/HopkinsPlotCategories.tsx"),
    read("../src/lib/hopkinsPlotCategoryData.ts"),
    read("../src/components/public/PublicLotMap.tsx"),
    read("../src/pages/public/HopkinsApplicationWizard.tsx"),
    read("../map-input/hopkins.tiers.json"),
  ]);
  const source = JSON.parse(tierSource);
  const tierEntries = Object.entries(source.tiers);

  assert.equal(tierEntries.length, 7);
  assert.match(categories, /HOPKINS_TIER_ORDER\.map\(\(key\) => hopkinsTierSource\.tiers\[key\]\)/);
  assert.match(categories, /backgroundColor: tier\.fill/);
  assert.match(categories, /sourcePrice\(tier\.price\)/);
  assert.match(categories, /tier\.price_basis/);
  assert.match(categories, /Plot Categories & Prices/);
  assert.match(categories, /currency_note/);
  assert.match(categories, /corner_premium/);
  assert.match(categories, /financing_source_note/);
  assert.match(categories, /Plan label: \{tier\.source_label\}/);
  assert.match(hopkins, /<HopkinsPlotCategories variant="cards" showPrices=\{modules.pricing\} onCatalogLoaded=\{setPublishedCatalog\}\s*\/>/);
  assert.match(map, /<HopkinsPlotCategories showPrices=\{showPrices\}\s*\/>/);
  assert.match(applicationWizard, /<PublicLotMap/);
  assert.match(map, /tier_color_hex: tier\?\.fill/);

  for (const [key, tier] of tierEntries) {
    assert.match(categoryData, new RegExp(`"${key}"`), `category order should include ${key}`);
    assert.ok(tier.label && tier.fill && tier.price_basis && Number.isFinite(tier.price), `${key} should have source name, map color, price, and size basis`);
  }
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
  assert.match(applicationWizard, /detailsPlacement="below"/);
  assert.match(applicationWizard, /data-testid="map-step-application-summary"/);
  assert.match(applicationWizard, /readPublicWizardStep/);
  assert.match(applicationWizard, /stepIsComplete\(step\.id\)/);
  const publicMap = await read("../src/components/public/PublicLotMap.tsx");
  assert.match(publicMap, /initialFit !== "outlines" \|\| !isHopkinsHostedMap \|\| !payload/);
  assert.match(publicMap, /payload\.parcels[\s\S]*?mapPolygonBounds/);
  assert.match(publicMap, /grid-rows-\[minmax\(20rem,1fr\)_minmax\(7rem,34dvh\)\]/);
  assert.match(publicMap, /right-0 top-full[\s\S]*?w-\[min\(18rem,calc\(100vw-2rem\)\)\]/);
  assert.match(applicationWizard, /onRemoveMapFeature\(ref\)/);
  assert.doesNotMatch(applicationWizard, /preferred_parcel_ids:\s*selectedMapFeatureRefs/);
  assert.match(await read("../src/pages/public/HopkinsPublicPage.tsx"), /publicMapReferenceLabel\(feature\.demo_label\)/);
});

test("template defaults do not change tenant, project, phase, or modules", () => {
  const hopkins = defaultPublicExperience({ tenantSlug: "hopkins-grove", projectSlug: "hopkins-grove", phaseSlug: "initial" });
  const wamule = defaultPublicExperience({ tenantSlug: "wamule", projectSlug: "wamule", phaseSlug: "default" });
  assert.equal(hopkins.templateId, "wamule-classic");
  assert.equal(wamule.templateId, "wamule-classic");
  assert.deepEqual(hopkins.enabledModules, { map: true, inquiry: true, application: true, pricing: true });
  assert.deepEqual(wamule.enabledModules, hopkins.enabledModules);
});
