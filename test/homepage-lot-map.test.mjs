import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("shared lot map supports pick mode alongside inquiry mode", async () => {
  const [map, modal] = await Promise.all([
    read("src/components/public/PublicLotMap.tsx"),
    read("src/components/public/PublicInquiryModal.tsx"),
  ]);
  assert.match(map, /onToggleLot\?: \(parcel: PublicLotParcel\) => void/);
  assert.match(map, /selectedIds\?: number\[\]/);
  assert.match(map, /enableInquiry/);
  assert.match(map, /showPrices/);
  assert.match(map, /onParcelsLoaded\?: \(parcels: PublicLotParcel\[\]\) => void/);
  // Local preview mode loads static build artifacts instead of the edge fn.
  assert.match(map, /demoDataUrl\?: string/);
  assert.match(map, /\/lots\.json/);
  assert.match(map, /masterplan_background\.webp/);
  assert.match(map, /Preview data/);
  // Native master with a mobile-capped preview rendition; printed areas
  // render dual-unit when the OCR stage supplies them.
  assert.match(map, /masterplan_preview_url/);
  assert.match(map, /area_sqm/);
  assert.match(map, /formatAreaDualUnit/);
  // Pick mode toggles Available lots; selection never opens the inquiry
  // modal (it opens solely from the card's Inquire button).
  assert.match(map, /pickMode/);
  assert.match(map, /if \(pickMode && parcel\.status === "Available"\) onToggleLot\(parcel\)/);
  assert.doesNotMatch(map, /setTimeout\(\(\) => setInquiryLot/);
  // Reserved lots offer a waitlist action; Sold lots offer no inquiry action.
  // (Button copy comes from the card theme config, not literals.)
  assert.match(map, /waitlistText/);
  assert.match(modal, /Join the Waitlist for Lot/);
  assert.match(modal, /waitlist\?: boolean/);
  assert.match(map, /Remove Lot/);
  assert.match(map, /PublicInquiryModal/);
});

test("application preferred-lot step embeds the visual map picker", async () => {
  const page = await read("src/pages/ApplicationPage.tsx");
  assert.match(page, /PublicLotMap/);
  assert.match(page, /lot_map_tenant_slug/);
  assert.match(page, /onToggleLot=\{toggleMapLot\}/);
  assert.match(page, /selectedIds=\{selectedLotIds\.map\(Number\)\}/);
  assert.match(page, /onParcelsLoaded=\{handleMapParcelsLoaded\}/);
  assert.match(page, /h-\[560px\] overflow-hidden rounded-xl border border-border lg:h-\[640px\]/);
  // Dev preview renders local build artifacts until a slug is configured;
  // production stays cards-only with an empty slug (back-compat).
  assert.match(page, /demoDataUrl/);
  assert.match(page, /"\/demo-map"/);
  assert.match(page, /import\.meta\.env\.DEV/);
  // Legacy checkbox cards stay as the always-on fallback list.
  assert.match(page, /type="checkbox" value=\{parcel\.id\}/);
});

test("map-picked lots resolve in review and summary like card-picked lots", async () => {
  const page = await read("src/pages/ApplicationPage.tsx");
  assert.match(page, /mapParcels/);
  assert.match(page, /allParcelOptions/);
  assert.match(page, /parcels=\{allParcelOptions\}/);
  // Form validation still requires at least one preferred lot.
  const schemas = await read("src/lib/schemas.ts");
  assert.match(schemas, /preferred_parcel_ids: z\.array\(z\.coerce\.number\(\)\)\.min\(1/);
});

test("application settings expose the homepage map tenant slug", async () => {
  const [settings, page] = await Promise.all([
    read("src/pages/SettingsPage.tsx"),
    read("src/pages/ApplicationPage.tsx"),
  ]);
  assert.match(settings, /lot_map_tenant_slug: string/);
  assert.match(settings, /lot_map_tenant_slug: ""/);
  assert.match(settings, /Homepage lot map tenant slug/);
  assert.match(settings, /placeholder="hopkins-grove"/);
  // Map renders when a slug is configured, or as a local preview in dev.
  assert.match(page, /applicationSettings\.lot_map_tenant_slug \|\| import\.meta\.env\.DEV/);
});
