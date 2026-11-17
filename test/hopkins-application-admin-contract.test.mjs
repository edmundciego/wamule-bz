import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Hopkins public application retains scoped stable outline IDs across route navigation", () => {
  const form = read("../src/components/public/PublicApplicationForm.tsx");
  const plots = read("../src/lib/publicApplicationPlots.ts");
  const map = read("../src/components/public/PublicLotMap.tsx");
  assert.match(form, /wamule:hopkins-application-outlines:/);
  assert.match(form, /sessionStorage\.setItem/);
  assert.match(form, /if \(unverifiedSelection\)/);
  assert.match(form, /preferred_map_feature_refs:\s*input\.preferred_lot_refs/);
  assert.match(plots, /feature\.map_feature_ref/);
  assert.match(plots, /body\.phase\?\.slug !== scope\.phaseSlug/);
  assert.match(map, /map_feature_ref:\s*feature\.map_feature_ref/);
});

test("admin applications show scoped stable outline links and verified plan-number language", () => {
  const applications = read("../src/pages/ApplicationsPage.tsx");
  const mapPage = read("../src/pages/public/EmbeddableMapPage.tsx");
  assert.match(applications, /preferred_map_feature_refs\.map/);
  assert.match(applications, /feature=\$\{encodeURIComponent\(ref\)\}/);
  assert.match(applications, /Verified printed plan number/);
  assert.match(applications, /Reference price:/);
  assert.match(mapPage, /initialFeatureRef=\{initialFeatureRef\}/);
  assert.match(mapPage, /params\.feature = parcel\.map_feature_ref/);
});

test("Maps admin navigation is admin-only and tier pricing opens on its existing Lots route", () => {
  const app = read("../src/App.tsx");
  const layout = read("../src/components/layout/AdminLayout.tsx");
  const maps = read("../src/pages/MapsPage.tsx");
  const lots = read("../src/pages/LotsPage.tsx");
  assert.match(app, /path="\/maps" element=\{<MapsPage \/>\}/);
  assert.match(layout, /href: "\/maps", label: "Maps", icon: Map, adminOnly: true/);
  assert.match(maps, /canManage=\{canManage\}/);
  assert.match(maps, /to="\/lots\?tab=tiers"/);
  assert.match(lots, /searchParams\.get\("tab"\)/);
});
