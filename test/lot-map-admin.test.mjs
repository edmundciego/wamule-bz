import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("lots board tabs separate inventory, bulk ingest preview, and tier catalogue", async () => {
  const page = await read("src/pages/LotsPage.tsx");
  assert.match(page, /BulkIngestPanel/);
  assert.match(page, /TierCatalogManager/);
  assert.match(page, /Inventory Board/);
  assert.match(page, /Bulk Ingest/);
  assert.match(page, /Tier Catalogue/);
  assert.match(page, /role="tablist"/);
});

test("lots board filters isolate the needs-review queue by status and tier", async () => {
  const page = await read("src/pages/LotsPage.tsx");
  assert.match(page, /Needs review only/);
  assert.match(page, /reviewOnly/);
  assert.match(page, /needs_review === true/);
  assert.match(page, /Tier filter/);
  assert.match(page, /Status filter/);
  assert.match(page, /Needs Review/);
  assert.match(page, /tier_label/);
});

test("bulk ingest panel previews lots.json with zero database writes", async () => {
  const panel = await read("src/components/admin/parcels/BulkIngestPanel.tsx");
  assert.match(panel, /lots\.json/);
  assert.match(panel, /Per-tier breakdown/);
  assert.match(panel, /Board diff/);
  assert.match(panel, /stale \(kept\)/);
  assert.match(panel, /map:publish/);
  // Preview-only: no supabase inserts/updates/upserts may exist here.
  assert.doesNotMatch(panel, /\.insert\(/);
  assert.doesNotMatch(panel, /\.update\(/);
  assert.doesNotMatch(panel, /\.upsert\(/);
  assert.doesNotMatch(panel, /from\("supabase-js"\)|@supabase\/supabase-js/);
});

test("tier catalogue manager edits prices, corner premiums, and colours per tenant", async () => {
  const manager = await read("src/components/admin/parcels/TierCatalogManager.tsx");
  assert.match(manager, /from\("lot_tiers"\)/);
  assert.match(manager, /price_cents/);
  assert.match(manager, /corner_premium_cents/);
  assert.match(manager, /color_hex/);
  // Dollars in the UI, cents in the DB.
  assert.match(manager, /Math\.round\(Number\(.*\) \* 100\)/);
  assert.match(manager, /#rrggbb/);
  assert.match(manager, /eq\("tenant_id", tenantId\)/);
  assert.match(manager, /Public embeds pick up the new price immediately/);
});

test("parcel canvas highlights the review queue without changing draw/edit flows", async () => {
  const canvas = await read("src/components/admin/parcels/ParcelMapCanvas.tsx");
  assert.match(canvas, /reviewMode/);
  assert.match(canvas, /needs_review/);
  assert.match(canvas, /#c026d3/);
  assert.match(canvas, /strokeDasharray/);
  assert.match(canvas, /Needs review/);
  // Existing contracts intact.
  assert.match(canvas, /mode === "draw"/);
  assert.match(canvas, /Save polygon/);
});

test("parcel drawer edits tier, corner, override, and review state", async () => {
  const drawer = await read("src/components/admin/parcels/ParcelDrawer.tsx");
  assert.match(drawer, /tier_key/);
  assert.match(drawer, /is_corner/);
  assert.match(drawer, /price_override_cents/);
  assert.match(drawer, /needs_review/);
  assert.match(drawer, /from\("lot_tiers"\)/);
  assert.match(drawer, /confidence/);
  assert.match(drawer, /geometry_source/);
});

test("public embed adds tier view, chips, search, zoom, and lot deep-links", async () => {
  const [page, map] = await Promise.all([
    read("src/pages/public/EmbeddableMapPage.tsx"),
    read("src/components/public/PublicLotMap.tsx"),
  ]);
  // Wrapper preserves the iframe URL contracts (?filter=, ?view=, ?lot=).
  assert.match(page, /searchParams\.get\("filter"\)/);
  assert.match(page, /searchParams\.get\("view"\)/);
  assert.match(page, /searchParams\.get\("lot"\)/);
  assert.match(page, /params\.lot = parcel\.lot_number/);
  assert.match(map, /Tier colours/);
  assert.match(map, /Status colours/);
  assert.match(map, /tier_color_hex/);
  assert.match(map, /Search lots/);
  assert.match(map, /Zoom in/);
  assert.match(map, /Reset zoom/);
  assert.match(map, /initialLotNumber/);
  // Existing contracts intact.
  assert.match(map, /viewBox=\{viewBox\}/);
  assert.match(map, /All Lots/);
  assert.match(map, /Available Only/);
  assert.match(map, /Inquire About Lot/);
  assert.match(map, /get-public-lots\?tenant=/);
});

test("publish writes ingest columns, stamps the active version, and degrades pre-migration", async () => {
  const script = await read("scripts/publish-lots.mjs");
  assert.match(script, /ingestPayload/);
  assert.match(script, /geometry_source/);
  assert.match(script, /masterplan_version_id/);
  assert.match(script, /from\("masterplan_versions"\)/);
  assert.match(script, /eq\("is_active", true\)/);
  assert.match(script, /legacy payload mode/);
  assert.match(script, /tierChanged/);
  // Status/dimensions on existing rows stay untouched: the .update() payload
  // covers price, geometry, and ingest columns only.
  const updateMatch = script.match(/\.update\(\{([\s\S]*?)\}\)\s*\.eq\("id"/);
  assert.ok(updateMatch, "publish must update existing rows by id.");
  assert.ok(updateMatch[1].includes("base_price"), "updates carry base_price.");
  assert.ok(updateMatch[1].includes("map_polygon"), "updates carry map_polygon.");
  assert.ok(!updateMatch[1].includes("status"), "updates must not touch status.");
  assert.ok(!updateMatch[1].includes("dimensions"), "updates must not touch dimensions.");
});

test("dealer playbook documents the per-tenant lot mapping runbook", async () => {
  const playbook = await read("docs/DEALER_PLAYBOOK.md");
  assert.match(playbook, /Bulk lot import/);
  assert.match(playbook, /map:publish --dry-run/);
  assert.match(playbook, /Needs review only/);
  assert.match(playbook, /Tier Catalogue/);
  assert.match(playbook, /corner premium/);
  assert.match(playbook, /\?lot=L-142/);
  assert.match(playbook, /Tier colours/);
});
