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
  assert.match(map, /selectedLocalKeys\?: number\[\]/);
  assert.match(map, /public_ref: string \| null/);
  assert.doesNotMatch(map, /parcel\.id/);
  assert.match(map, /enableInquiry/);
  assert.match(map, /showPrices/);
  assert.match(map, /onParcelsLoaded\?: \(parcels: PublicLotParcel\[\]\) => void/);
  // Local preview mode loads static build artifacts instead of the edge fn.
  assert.match(map, /demoDataUrl\?: string/);
  assert.match(map, /\/lots\.json/);
  assert.match(map, /masterplan_background\.webp/);
  assert.match(map, /Proof of concept · sample data/);
  assert.match(map, /Traced from the sales plat/);
  assert.match(map, /Lot status, price, dimensions and classifications have not been approved against the sales register\./);
  // Native master with a mobile-capped preview rendition; printed areas
  // render dual-unit when the OCR stage supplies them.
  assert.match(map, /masterplan_preview_url/);
  assert.match(map, /area_sqm/);
  assert.match(map, /formatAreaDualUnit/);
  // Pick mode toggles Available lots; selection never opens the inquiry
  // modal (it opens solely from the card's Inquire button).
  assert.match(map, /pickMode/);
  assert.match(map, /if \(pickMode && parcel\.status === "Available" && parcel\.public_ref\) onToggleLot\(parcel\)/);
  assert.doesNotMatch(map, /setTimeout\(\(\) => setInquiryLot/);
  // Reserved lots offer a waitlist action; Sold lots offer no inquiry action.
  // (Button copy comes from the card theme config, not literals.)
  assert.match(map, /waitlistText/);
  assert.match(modal, /Join the Waitlist for Lot/);
  assert.match(modal, /waitlist\?: boolean/);
  assert.match(map, /Remove Lot/);
  assert.match(map, /PublicInquiryModal/);
});

test("the shared preferred-lot section connects map and list selections", async () => {
  const form = await read("src/components/public/PublicApplicationForm.tsx");
  assert.match(form, /<PublicLotMap/);
  assert.match(form, /onToggleLot=\{projectApplication \? undefined/);
  assert.match(form, /phaseSlug=\{scope\.phaseSlug\}/);
  assert.match(form, /selectedLocalKeys=\{projectApplication \? undefined : selectedLots/);
  assert.match(form, /type="checkbox" checked=\{selected\}/);
  assert.match(form, /setValue\("preferred_lot_refs", refs/);
});

test("purchase lot preferences use scoped public references and remain required", async () => {
  const [form, plots, schemas] = await Promise.all([
    read("src/components/public/PublicApplicationForm.tsx"),
    read("src/lib/publicApplicationPlots.ts"),
    read("src/lib/schemas.ts"),
  ]);
  assert.match(form, /selectedRefs\.includes\(parcel\.public_ref\)/);
  assert.match(form, /parcels=\{parcels\}/);
  assert.match(plots, /get-public-lots/);
  assert.match(plots, /body\.project\?\.slug !== scope\.projectSlug/);
  assert.match(plots, /parcel\.sales_selectable === true/);
  assert.match(schemas, /requireField\("preferred_lot_refs", values\.preferred_lot_refs\.length > 0/);
});
