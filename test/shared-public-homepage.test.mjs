import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const temp = await mkdtemp(resolve("node_modules/.tmp/homepage-render-"));
after(() => rm(temp, { recursive: true, force: true }));
async function component(source, name) {
  const outfile = join(temp, `${name}.mjs`);
  await build({
    entryPoints: [source],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    packages: "external",
    define: {
      __BUILD_INFO__: JSON.stringify({
        commit: "test",
        environment: "test",
        hasUncommittedChanges: false,
      }),
    },
    logLevel: "silent",
  });
  return (await import(pathToFileURL(outfile).href))[name];
}
const Homepage = await component(
  "src/components/public/PublicHomepage.tsx",
  "PublicHomepage",
);
const Categories = await component(
  "src/components/public/HopkinsPlotCategories.tsx",
  "HopkinsPlotCategories",
);
const PublishedCategories = await component(
  "src/components/public/PublishedCategoryGuide.tsx",
  "PublishedCategoryGuide",
);
function model(tenant) {
  return {
    templateId: "wamule-classic",
    scope: {
      tenantSlug: tenant,
      projectSlug: `${tenant}-project`,
      phaseSlug: "phase-one",
    },
    modules: { map: true, inquiry: true, application: true, pricing: true },
    header: { companyName: `${tenant} Company`, logoUrl: `/${tenant}.svg` },
    hero: {
      badge: "Applications open",
      title: `${tenant} Project`,
      description: `${tenant} Description`,
      facts: [
        { label: "Starting price", value: `${tenant} Price` },
        { label: "Lot sizes", value: `${tenant} Area` },
        { label: "Phase", value: "phase-one" },
      ],
      preferences: {
        title: "Preferences",
        description: `${tenant} preferences`,
        content: h("p", null, `${tenant} Choices`),
      },
    },
    inquiry: h("p", null, `${tenant} Inquiry`),
    notice: { notice: `${tenant} Notice`, companyName: `${tenant} Company` },
    map: h("p", null, `${tenant} Map`),
    application: h("section", { id: "application" }, `${tenant} Form`),
  };
}
test("tenant content occupies the same rendered frame in the same section order", () => {
  const a = renderToStaticMarkup(h(Homepage, model("Wamule")));
  const b = renderToStaticMarkup(h(Homepage, model("Hopkins")));
  for (const [html, tenant] of [
    [a, "Wamule"],
    [b, "Hopkins"],
  ]) {
    const sections = [
      "Project",
      "Choices",
      "Inquiry",
      "Notice",
      "Map",
      "Form",
    ].map((part) => html.indexOf(`${tenant} ${part}`));
    assert.ok(
      sections.every(
        (position, i) =>
          position >= 0 && (i === 0 || position > sections[i - 1]),
      ),
    );
    assert.match(html, new RegExp(`data-public-tenant="${tenant}"`));
    assert.match(html, /data-public-phase="phase-one"/);
  }
  assert.equal(
    a.replaceAll("Wamule", "Tenant"),
    b.replaceAll("Hopkins", "Tenant"),
  );
  assert.ok(!a.includes("Hopkins") && !b.includes("Wamule"));
});
test("disabled modules remove their rendered sections and application action", () => {
  const value = model("Tenant");
  value.modules = {
    map: false,
    inquiry: false,
    application: false,
    pricing: false,
  };
  const html = renderToStaticMarkup(h(Homepage, value));
  for (const marker of [
    "Tenant Map",
    "Tenant Inquiry",
    "Tenant Form",
    'href="#application"',
  ])
    assert.ok(!html.includes(marker));
  assert.ok(html.includes("Tenant Notice") && html.includes("Tenant Choices"));
});
test("unknown template values fall back without changing tenant or workflow content", () => {
  const value = { ...model("Hopkins"), templateId: "legacy-unknown" };
  const html = renderToStaticMarkup(h(Homepage, value));
  assert.match(html, /data-site-template="wamule-classic"/);
  assert.match(html, /data-public-project="Hopkins-project"/);
  assert.ok(html.includes("Hopkins Form"));
});
test("source category colors remain visible when public prices are disabled", () => {
  const hidden = renderToStaticMarkup(
    h(Categories, { variant: "cards", showPrices: false }),
  );
  const shown = renderToStaticMarkup(
    h(Categories, { variant: "cards", showPrices: true }),
  );
  assert.ok(
    hidden.includes("Standard Interior") &&
      hidden.includes("background-color:"),
  );
  assert.ok(!hidden.includes("25,000") && !hidden.includes("2,500"));
  assert.ok(shown.includes("25,000") && shown.includes("2,500"));
});
test("Admin category prices follow the same public-pricing switch", () => {
  const categories = [
    {
      key: "standard",
      label: "QA Standard",
      color: "#123456",
      price_cents: 450000,
      currency: "USD",
      price_basis: "Per plot",
    },
  ];
  const hidden = renderToStaticMarkup(
    h(PublishedCategories, { categories, cards: true, showPrices: false }),
  );
  const shown = renderToStaticMarkup(
    h(PublishedCategories, { categories, cards: true, showPrices: true }),
  );
  assert.ok(hidden.includes("QA Standard") && hidden.includes("#123456"));
  assert.ok(!hidden.includes("4,500") && !hidden.includes("USD"));
  assert.ok(shown.includes("4,500") && shown.includes("USD"));
});
