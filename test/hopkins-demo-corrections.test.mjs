import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const splitSource = await readFile(new URL("../src/lib/mapPolygonSplit.ts", import.meta.url), "utf8");
const splitJavascript = ts.transpile(splitSource, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 });
const splitUrl = `data:text/javascript;base64,${Buffer.from(splitJavascript).toString("base64")}`;
const previewSource = await readFile(new URL("../src/lib/localMapPreview.ts", import.meta.url), "utf8");
const previewJavascript = ts.transpile(previewSource, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 })
  .replace('from "./mapGeometry"', "")
  .replace(`from "./mapApprovalFlow"`, "");
const previewModule = await import(`data:text/javascript;base64,${Buffer.from(previewJavascript).toString("base64")}`);
const approvalSource = await readFile(new URL("../src/lib/mapApprovalFlow.ts", import.meta.url), "utf8");
const approvalJavascript = ts.transpile(approvalSource, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 })
  .replace('from "./mapPolygonSplit"', `from "${splitUrl}"`);
const approvalUrl = `data:text/javascript;base64,${Buffer.from(approvalJavascript).toString("base64")}`;
const hopkinsSource = await readFile(new URL("../src/lib/hopkinsDemoCorrections.ts", import.meta.url), "utf8");
const hopkinsJavascript = ts.transpile(hopkinsSource, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 })
  .replace('from "./mapPolygonSplit"', `from "${splitUrl}"`)
  .replace('from "./localMapPreview"', `from "data:text/javascript;base64,${Buffer.from(previewJavascript.replace('from "./mapApprovalFlow"', `from "${approvalUrl}"`)).toString("base64")}"`);
const hopkins = await import(`data:text/javascript;base64,${Buffer.from(hopkinsJavascript).toString("base64")}`);

const scope = { tenantSlug: "hopkins-grove", projectSlug: "map-review", phaseSlug: "default" };
const parent = [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 20 }, { x: 10, y: 20 }];
const childPolygons = [
  [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }],
  [{ x: 20, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 20 }, { x: 20, y: 20 }],
];
const snapshot = (parentId = "L-100", ids = ["cv-child-1", "cv-child-2"]) => ({
  snapshot_id: `${parentId}@demo-revision`,
  draft_id: `OWNER-DEMO-${parentId}`,
  revision_fingerprint: "demo-revision",
  parent_detection_id: parentId,
  parent_map_reference: parentId,
  parent_polygon_pct: parent,
  source_image_sha256: "source-sha",
  proposal_fingerprint: "proposal-sha",
  approved_by: "Project owner (explicit demo-use authorization)",
  approved_at: "2026-10-14T12:00:00.000Z",
  correction_note: "Owner-authorized local demo geometry; labels pending.",
  reasoned_waiver: "Owner-authorized demo waiver: parent coverage gap recorded.",
  approval_basis: "owner-authorized-demo-use",
  source_proposal_path: "out/plat-digitizer/L-100/proposal.json",
  geometry_exceptions: ["10% of the detected area remains unassigned."],
  geometry_evidence: {
    parent_coverage_percent: 90,
    unassigned_parent_area_percent: 10,
    outside_parent_area_percent: 0,
    child_boundary_alignment_within_4px_percent: [95, 92],
    existing_detection_overlaps: [],
  },
  children: childPolygons.map((polygon_pct, index) => ({
    id: ids[index], parent_detection_id: parentId, polygon_pct,
    printed_number: "", label_status: "pending",
  })),
});
const manifest = (split = snapshot()) => ({
  manifest_kind: "wamule-hopkins-demo-correction-manifest",
  schema_version: 1,
  scope,
  revision: 1,
  created_at: "2026-10-14T12:00:00.000Z",
  source_image: { sha256: "source-sha", width: 5700, height: 4800 },
  detection_source_sha256: "detections-sha",
  owner_authorization: { basis: "explicit-owner-instruction", approved_at: "2026-10-14T12:00:00.000Z", note: "Local demo only." },
  inaccessible_manual_session: { status: "pending-not-imported", detection_id: null, note: "Not imported." },
  approved_splits: [split],
});
function parcel(id, lot, polygon) {
  return {
    local_key: id === "L-100" ? 1 : 2,
    public_ref: `ref-${id}`,
    lot_number: lot,
    status: "Available",
    price: 1000,
    dimensions: "20 x 20",
    area_sqm: 400,
    map_polygon: polygon,
    tier_key: "tier",
    tier_label: "Tier",
    tier_color_hex: "#123456",
    is_corner: false,
    effective_price_cents: 100000,
    correction_key: id,
  };
}
const sourceParcels = [parcel("L-100", "L-100", parent), parcel("L-101", "L-101", [{ x: 40, y: 10 }, { x: 45, y: 10 }, { x: 45, y: 15 }, { x: 40, y: 15 }])];
const context = { scope, sourceImageSha256: "source-sha", sourceImageWidth: 5700, sourceImageHeight: 4800, detectionSourceSha256: "detections-sha", sourceParcels };

test("owner-authorized demo manifest replaces its exact parent and leaves identities/sales fields pending", () => {
  const parsed = hopkins.parseHopkinsDemoCorrectionManifest(manifest(), context);
  const result = hopkins.applyHopkinsDemoCorrectionManifest(sourceParcels, parsed, scope, null);
  assert.equal(result.parcels.length, 3);
  assert.deepEqual(result.parcels.map((item) => item.correction_key), ["cv-child-1", "cv-child-2", "L-101"]);
  assert.equal(result.parcels.some((item) => item.lot_number === "L-100"), false);
  assert.equal(result.parcels[0].local_preview.labelStatus, "pending");
  assert.deepEqual(result.parcels[0].local_preview.geometryExceptions, snapshot().geometry_exceptions);
  for (const child of result.parcels.slice(0, 2)) {
    assert.equal(child.lot_number, "");
    assert.equal(child.public_ref, null);
    assert.equal(child.price, 0);
    assert.equal(child.status, "Review pending");
    assert.equal(child.tier_key, null);
  }
});

test("existing same-parent local correction wins over file-based proposal without duplicate children", () => {
  const automated = snapshot("L-100", ["cv-child-1", "cv-child-2"]);
  const manual = { ...automated, snapshot_id: "manual-six-parent", draft_id: "manual-six", children: automated.children.map((child, index) => ({ ...child, id: `manual-child-${index + 1}` })) };
  const store = { ...previewModule.emptyLocalMapPreviewStore(scope), approved_splits: [manual] };
  const result = hopkins.applyHopkinsDemoCorrectionManifest(sourceParcels, manifest(automated), scope, store);
  assert.equal(result.parcels.length, 3);
  assert.deepEqual(result.parcels.slice(0, 2).map((item) => item.correction_key), ["manual-child-1", "manual-child-2"]);
  assert.equal(result.parcels.some((item) => item.correction_key === "cv-child-1"), false);
  assert.match(result.warnings.join(" "), /existing local correction takes precedence/);
});

test("source or detection fingerprint mismatch refuses every file correction", () => {
  assert.throws(() => hopkins.parseHopkinsDemoCorrectionManifest(manifest(), { ...context, sourceImageSha256: "different" }), /source-image fingerprint/);
  assert.throws(() => hopkins.parseHopkinsDemoCorrectionManifest(manifest(), { ...context, detectionSourceSha256: "different" }), /detection fingerprint/);
});

test("owner-approved source replacement suppresses only its exact duplicate while the matching split is active", () => {
  const duplicate = { ...parcel("L-102", "L-102", parent), local_key: 3 };
  const source = [...sourceParcels, duplicate];
  const correctedManifest = manifest();
  correctedManifest.superseded_detections = [{
    detection_id: "L-102",
    source_polygon_pct: parent,
    replaced_by_parent_detection_id: "L-100",
    replacement_child_id: "cv-child-1",
    source_image_sha256: "source-sha",
    reason: "The same source outline is represented by the approved child.",
    approved_by: "Project owner",
    approved_at: "2026-10-14T12:00:00.000Z",
  }];
  const parsed = hopkins.parseHopkinsDemoCorrectionManifest(correctedManifest, { ...context, sourceParcels: source });
  const result = hopkins.applyHopkinsDemoCorrectionManifest(source, parsed, scope, null);
  assert.equal(result.parcels.length, 3);
  assert.equal(result.parcels.some((item) => item.correction_key === "L-102"), false);

  const localSnapshot = snapshot("L-100", ["manual-child-1", "manual-child-2"]);
  const localStore = { ...previewModule.emptyLocalMapPreviewStore(scope), approved_splits: [localSnapshot] };
  const localResult = hopkins.applyHopkinsDemoCorrectionManifest(source, parsed, scope, localStore);
  assert.equal(localResult.parcels.some((item) => item.correction_key === "L-102"), true);
  assert.equal(localResult.parcels.some((item) => item.correction_key === "cv-child-1"), false);
});

test("invalid child geometry remains blocked even with an owner demo waiver", () => {
  const invalid = snapshot("L-100");
  invalid.children[1].polygon_pct = [{ x: 15, y: 10 }, { x: 25, y: 10 }, { x: 25, y: 20 }, { x: 15, y: 20 }];
  assert.throws(() => hopkins.parseHopkinsDemoCorrectionManifest(manifest(invalid), context), /overlap or cross/);
});
