import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifyParcelProvenance,
  isAvailableForSalesSelection,
  isEligibleForPublicInquiry,
  isExistingInventoryRecord,
  isRasterDetection,
} from "../supabase/functions/_shared/parcel-provenance.mjs";

test("raster detections never become selectable from status, price, or a clear review flag", () => {
  const detection = {
    geometry_source: "raster-auto",
    status: "Available",
    base_price: 25000,
    price_override_cents: 2500000,
    needs_review: false,
  };

  assert.equal(classifyParcelProvenance(detection), "raster_detection");
  assert.equal(isRasterDetection(detection), true);
  assert.equal(isExistingInventoryRecord(detection), false);
  assert.equal(isAvailableForSalesSelection(detection), false);
  assert.equal(isEligibleForPublicInquiry(detection), false);
});

test("manual records remain inventory and require an available status plus a clear review flag for selection", () => {
  const manual = { geometry_source: "manual", status: "Available", needs_review: false };
  assert.equal(isExistingInventoryRecord(manual), true);
  assert.equal(isAvailableForSalesSelection(manual), true);
  assert.equal(isAvailableForSalesSelection({ ...manual, status: "Reserved" }), false);
  assert.equal(isAvailableForSalesSelection({ ...manual, needs_review: true }), false);
  assert.equal(isAvailableForSalesSelection({ ...manual, needs_review: null }), false);
  assert.equal(isEligibleForPublicInquiry({ ...manual, status: "Reserved" }), true);
});

test("sales selectors and public payload use provenance-derived eligibility", async () => {
  const [applications, publicApplication, edgeFunction, dashboard, lots, publicMap] = await Promise.all([
    readFile(new URL("../src/pages/ApplicationsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/ApplicationPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../supabase/functions/get-public-lots/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/DashboardPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/LotsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/public/PublicLotMap.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(applications, /\.filter\(isAvailableForSalesSelection\)/);
  assert.match(publicApplication, /parcel\.sales_selectable === true/);
  assert.match(edgeFunction, /sales_selectable/);
  assert.match(edgeFunction, /isAvailableForSalesSelection/);
  assert.match(dashboard, /isExistingInventoryRecord/);
  assert.match(lots, /isRasterDetection/);
  assert.match(publicMap, /parcel\.is_map_detection === true\)\.length/);
  assert.match(publicMap, /map outlines · review\/display only/);
  assert.match(publicMap, /not buyer-selection options/);
  assert.match(publicMap, /not offered for sale/);
});
