import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = process.cwd();
const dataDir = resolve(root, process.env.WAMULE_HOPKINS_MAP_DIR ?? "out/hopkins-ocr");
const manifestPath = resolve(process.argv[2] ?? "artifacts/hopkins-five-plot-approval-20261014/local-corrections.approved.json");
const lotsBytes = readFileSync(resolve(dataDir, "lots.json"));
const imageBytes = readFileSync(resolve(dataDir, "masterplan_background.webp"));
const lots = JSON.parse(lotsBytes.toString("utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function transpile(source, imports = []) {
  let javascript = ts.transpile(source, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 });
  for (const [from, to] of imports) javascript = javascript.replace(from, to);
  return `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
}

const splitUrl = transpile(readFileSync(resolve(root, "src/lib/mapPolygonSplit.ts"), "utf8"));
const previewUrl = transpile(readFileSync(resolve(root, "src/lib/localMapPreview.ts"), "utf8"), [
  ['from "./mapGeometry"', ""],
  ['from "./mapApprovalFlow"', ""],
]);
const approvalUrl = transpile(readFileSync(resolve(root, "src/lib/mapApprovalFlow.ts"), "utf8"), [
  ['from "./mapPolygonSplit"', `from "${splitUrl}"`],
]);
const hopkinsUrl = transpile(readFileSync(resolve(root, "src/lib/hopkinsDemoCorrections.ts"), "utf8"), [
  ['from "./mapPolygonSplit"', `from "${splitUrl}"`],
  ['from "./localMapPreview"', `from "${previewUrl}"`],
]);
const { parseHopkinsDemoCorrectionManifest, applyHopkinsDemoCorrectionManifest } = await import(hopkinsUrl);

const scope = { tenantSlug: "hopkins-grove", projectSlug: "map-review", phaseSlug: "default" };
const parcels = lots.map((lot, index) => ({
  local_key: index + 1,
  public_ref: null,
  lot_number: lot.lot_number,
  status: lot.status ?? "Review pending",
  price: Number(lot.price ?? 0),
  dimensions: null,
  area_sqm: lot.area_sqm ?? null,
  map_polygon: lot.polygon_pct,
  tier_key: lot.tier_key ?? null,
  tier_label: lot.tier_key ?? null,
  tier_color_hex: "#b0aaa0",
  is_corner: false,
  effective_price_cents: 0,
}));
const parsed = parseHopkinsDemoCorrectionManifest(manifest, {
  scope,
  sourceImageSha256: sha256(imageBytes),
  sourceImageWidth: 5700,
  sourceImageHeight: 4800,
  detectionSourceSha256: sha256(lotsBytes),
  sourceParcels: parcels,
});
const result = applyHopkinsDemoCorrectionManifest(parcels, parsed, scope, null);
const expectedCount = lots.length - manifest.approved_splits.length
  + manifest.approved_splits.reduce((total, split) => total + split.children.length, 0)
  - (manifest.superseded_detections?.length ?? 0);
assert.equal(result.parcels.length, expectedCount);
assert.equal(expectedCount, 775);
assert.equal(manifest.approved_splits.length, 22);
assert.equal(manifest.approved_splits.reduce((total, split) => total + split.children.length, 0), 80);
assert.deepEqual(result.warnings, []);
for (const id of manifest.approved_splits.map((split) => split.parent_detection_id)) {
  assert.equal(result.parcels.some((parcel) => parcel.lot_number === id), false, `replaced parent ${id} remained visible`);
}
for (const entry of manifest.superseded_detections ?? []) {
  assert.equal(result.parcels.some((parcel) => parcel.lot_number === entry.detection_id), false, `superseded source ${entry.detection_id} remained visible`);
}
const children = result.parcels.filter((parcel) => parcel.local_preview);
assert.equal(children.length, 80);
assert.equal(new Set(children.map((parcel) => parcel.local_preview.childId)).size, 80);
assert.equal(children.every((parcel) => parcel.lot_number === "" && parcel.public_ref === null
  && parcel.price === 0 && parcel.status === "Review pending" && parcel.tier_key === null), true);
for (const id of ["L-050", "L-137", "L-156", "L-300"]) {
  if (!["L-137", "L-156"].includes(id)) assert.equal(result.parcels.some((parcel) => parcel.lot_number === id), true, `unrelated lot ${id} was not preserved`);
}
console.log(JSON.stringify({
  manifestPath,
  manifestRevision: manifest.revision,
  sourceLots: lots.length,
  appliedParents: manifest.approved_splits.length,
  activeChildOutlines: children.length,
  supersededSourceOutlines: manifest.superseded_detections?.map((entry) => entry.detection_id) ?? [],
  visibleOutlines: result.parcels.length,
  pendingUnverifiedLabels: children.every((parcel) => parcel.local_preview.labelStatus === "pending"),
  warnings: result.warnings,
}, null, 2));
