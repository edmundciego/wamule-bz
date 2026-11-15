import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Hopkins public application retains scoped stable outline IDs across route navigation", () => {
  const page = read("../src/pages/public/HopkinsPublicPage.tsx");
  const map = read("../src/components/public/PublicLotMap.tsx");
  assert.match(page, /wamule:hopkins-application-outlines:/);
  assert.match(page, /sessionStorage\.setItem/);
  assert.match(page, /preferred_map_feature_refs:\s*selectedMapFeatureRefs/);
  assert.match(page, /feature\.map_feature_ref/);
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
