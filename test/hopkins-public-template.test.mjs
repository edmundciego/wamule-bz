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
  assert.match(hopkins, /<WamuleClassicInfoTile label="Starting price"/);
  assert.match(hopkins, /<WamuleClassicInfoTile label="Lot sizes"/);
  assert.match(hopkins, /<WamuleClassicInfoTile label="Project phase" value=\{page\.phase\.name\}/);
  assert.match(hopkins, /hopkinsTierSource\.source_pricing\.currency_symbol/);
  assert.match(hopkins, /filter\(\(tier\) => tier\.group === "Residential"\)/);
  assert.doesNotMatch(hopkins, /WamuleClassicInfoTile compact|showOrnament=\{false\}/);
  assert.match(hopkins, /title="Plot Categories & Prices"/);
  assert.match(hopkins, /<HopkinsPlotCategories variant="cards"(?: onCatalogLoaded=\{setPublishedCatalog\})?\s*\/>/);
  assert.match(hopkins, /id="hopkins-map-preferences-title"/);
  assert.match(hopkins, /Map references are preferences only\. They are not saleable parcel inventory, do not confirm availability/);
  assert.match(hopkins, /aria-label=\{"Remove map preference " \+ label\}/);
  assert.doesNotMatch(hopkins, /public_availability_display|show_available_lot_count_publicly|65 x 101|75 x 101/);
  const sectionOrder = [
    hopkins.indexOf("<WamuleClassicHero"),
    hopkins.indexOf('title="Plot Categories & Prices"'),
    hopkins.indexOf('id="hopkins-map-preferences-title"'),
    hopkins.indexOf("<PublicInquiryPanel"),
    hopkins.indexOf("<WamuleClassicNotice"),
    hopkins.indexOf('<section id="lots"'),
    hopkins.indexOf("<HopkinsApplicationWizard"),
  ];
  assert.ok(sectionOrder.every((position) => position >= 0), "all shared homepage sections should render");
  assert.ok(sectionOrder.every((position, index) => index === 0 || position > sectionOrder[index - 1]), "homepage order must be hero/preferences, information request, notice, project map, and application");
  assert.match(hopkins, /introPrompt="Not ready to apply yet\?"/);
  assert.match(hopkins, /introDescription=\{\"Have questions about \" \+ page\.project\.name/);
  assert.match(hopkins, /page\.company\.location/);
  assert.match(sharedTemplate, /const compactBrandOnMobile = brandLabel\.length > 10/);
  assert.match(sharedTemplate, /compactBrandOnMobile \? "text-sm sm:text-xl" : "text-xl"/);
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
  assert.match(categories, /Plot Categories &amp; Prices/);
  assert.match(categories, /currency_note/);
  assert.match(categories, /corner_premium/);
  assert.match(categories, /financing_source_note/);
  assert.match(categories, /Plan label: \{tier\.source_label\}/);
  assert.match(hopkins, /<HopkinsPlotCategories variant="cards"(?: onCatalogLoaded=\{setPublishedCatalog\})?\s*\/>/);
  assert.match(map, /<HopkinsPlotCategories\s*\/>/);
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
