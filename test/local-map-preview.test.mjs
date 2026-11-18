import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/localMapPreview.ts", import.meta.url), "utf8");
const javascript = ts.transpile(source, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 });
const preview = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

const scope = { tenantSlug: "hopkins-grove", projectSlug: "map-review", phaseSlug: "phase-a" };
const parentPolygon = [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }];
const children = [
  [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 30 }, { x: 10, y: 30 }],
  [{ x: 20, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 20, y: 30 }],
];
const snapshot = {
  snapshot_id: "draft-parent@revision-1",
  draft_id: "draft-parent",
  revision_fingerprint: "revision-1",
  parent_detection_id: "PARENT-1",
  parent_map_reference: "MAP-LOT-7",
  parent_polygon_pct: parentPolygon,
  source_image_sha256: "source-sha",
  proposal_fingerprint: "proposal-sha",
  approved_by: "Local reviewer",
  approved_at: "2026-10-14T10:00:00.000Z",
  correction_note: "Internal preview only.",
  reasoned_waiver: null,
  children: children.map((polygon_pct, index) => ({
    id: `child-${index + 1}`,
    parent_detection_id: "PARENT-1",
    polygon_pct,
    printed_number: "",
    label_status: "pending",
  })),
};

function parcel({ key, correctionKey, lot, polygon, price = 0, status = "Review pending" }) {
  return {
    local_key: key,
    public_ref: `public-${key}`,
    lot_number: lot,
    status,
    price,
    dimensions: "20 × 20",
    area_sqm: 400,
    map_polygon: polygon,
    tier_key: "tier-a",
    tier_label: "Tier A",
    tier_color_hex: "#123456",
    is_corner: false,
    effective_price_cents: price * 100,
    ...(correctionKey ? { correction_key: correctionKey } : {}),
  };
}

test("local preview storage is strictly isolated by tenant, project, and phase", () => {
  const key = preview.localMapPreviewStorageKey(scope);
  assert.equal(key, "wamule-local-map-preview-v1:hopkins-grove:map-review:phase-a");
  assert.notEqual(key, preview.localMapPreviewStorageKey({ ...scope, phaseSlug: "phase-b" }));
  assert.notEqual(key, preview.localMapPreviewStorageKey({ ...scope, projectSlug: "other-project" }));
  assert.throws(() => preview.parseLocalMapPreviewStore(JSON.stringify({ ...preview.emptyLocalMapPreviewStore(scope), scope: { ...scope, phaseSlug: "phase-b" } }), scope), /different project or phase/);
});

test("approved snapshot insertion is idempotent and preserves unrelated approved splits", () => {
  const store = preview.emptyLocalMapPreviewStore(scope);
  const once = preview.addApprovedPreviewSnapshot(store, snapshot);
  const twice = preview.addApprovedPreviewSnapshot(once, snapshot);
  assert.equal(once.revision, 1);
  assert.equal(twice.approved_splits.length, 1);
  assert.throws(() => preview.addApprovedPreviewSnapshot(once, { ...snapshot, snapshot_id: "new-revision" }), /already has an approved local split/);
  assert.equal(once.approved_splits[0].snapshot_id, snapshot.snapshot_id);
});

test("approved split replaces only the exact parent and strips draft OCR and sales fields", () => {
  const parent = parcel({ key: 7, correctionKey: "PARENT-1", lot: "MAP-LOT-7", polygon: parentPolygon, price: 100000, status: "Available" });
  const unrelated = parcel({ key: 8, correctionKey: "OTHER-1", lot: "MAP-LOT-8", polygon: [{ x: 40, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 20 }, { x: 40, y: 20 }], price: 200000, status: "Reserved" });
  const result = preview.applyApprovedPreviewSplits([parent, unrelated], preview.addApprovedPreviewSnapshot(preview.emptyLocalMapPreviewStore(scope), snapshot));
  assert.deepEqual(result.warnings, []);
  assert.equal(result.parcels.length, 3);
  assert.deepEqual(result.parcels[0].map_polygon, children[0]);
  assert.deepEqual(result.parcels[1].map_polygon, children[1]);
  for (const child of result.parcels.slice(0, 2)) {
    assert.equal(child.lot_number, "");
    assert.equal(child.public_ref, null);
    assert.equal(child.price, 0);
    assert.equal(child.status, "Review pending");
    assert.equal(child.tier_key, null);
    assert.equal(child.effective_price_cents, 0);
    assert.equal(child.local_preview.labelStatus, "pending");
  }
  assert.deepEqual(result.parcels[2], unrelated);
});

test("fallback identity disambiguates duplicate displayed numbers by source geometry", () => {
  const wrong = parcel({ key: 1, lot: "MAP-LOT-7", polygon: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }] });
  const match = parcel({ key: 2, lot: "MAP-LOT-7", polygon: parentPolygon });
  const store = preview.addApprovedPreviewSnapshot(preview.emptyLocalMapPreviewStore(scope), snapshot);
  const result = preview.applyApprovedPreviewSplits([wrong, match], store);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.parcels.length, 3);
  assert.deepEqual(result.parcels[0], wrong);
  assert.equal(result.parcels[1].local_preview.childId, "child-1");
});

test("source-geometry mismatch leaves every lot untouched and reports a warning", () => {
  const changedParent = parcel({ key: 7, correctionKey: "PARENT-1", lot: "MAP-LOT-7", polygon: [{ x: 10, y: 10 }, { x: 31, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }] });
  const store = preview.addApprovedPreviewSnapshot(preview.emptyLocalMapPreviewStore(scope), snapshot);
  const result = preview.applyApprovedPreviewSplits([changedParent], store);
  assert.equal(result.parcels.length, 1);
  assert.deepEqual(result.parcels[0], changedParent);
  assert.match(result.warnings.join(" "), /source mismatch/);
});
