import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = process.cwd();
const dataDir = resolve(root, process.env.WAMULE_HOPKINS_MAP_DIR ?? "out/hopkins-ocr");
const manifestPath = resolve(process.argv[2] ?? "artifacts/hopkins-lot-finetune-20261014/local-corrections.proposed.json");
const lotsBytes = readFileSync(resolve(dataDir, "lots.json"));
const imageBytes = readFileSync(resolve(dataDir, "masterplan_background.webp"));
const lots = JSON.parse(lotsBytes.toString("utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function transpile(source, imports = []) {
  let js = ts.transpile(source, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 });
  for (const [from, to] of imports) js = js.replace(from, to);
  return `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
}

const splitUrl = transpile(readFileSync(resolve(root, "src/lib/mapPolygonSplit.ts"), "utf8"));
const previewUrl = transpile(readFileSync(resolve(root, "src/lib/localMapPreview.ts"), "utf8"), [
  ['from "./mapGeometry"', ""], ['from "./mapApprovalFlow"', ""],
]);
const hopkinsUrl = transpile(readFileSync(resolve(root, "src/lib/hopkinsDemoCorrections.ts"), "utf8"), [
  ['from "./mapPolygonSplit"', `from "${splitUrl}"`],
  ['from "./localMapPreview"', `from "${previewUrl}"`],
]);
const { parseHopkinsDemoCorrectionManifest, applyHopkinsDemoCorrectionManifest } = await import(hopkinsUrl);
const scope = { tenantSlug: "hopkins-grove", projectSlug: "map-review", phaseSlug: "default" };
const parcels = lots.map((lot, index) => ({
  local_key: index + 1, public_ref: null, lot_number: lot.lot_number,
  status: lot.status ?? "Review pending", price: Number(lot.price ?? 0), dimensions: null,
  area_sqm: lot.area_sqm ?? null, map_polygon: lot.polygon_pct, tier_key: lot.tier_key ?? null,
  tier_label: lot.tier_key ?? null, tier_color_hex: "#b0aaa0", is_corner: false, effective_price_cents: 0,
}));
const parsed = parseHopkinsDemoCorrectionManifest(manifest, {
  scope, sourceImageSha256: sha256(imageBytes), sourceImageWidth: 5700, sourceImageHeight: 4800,
  detectionSourceSha256: sha256(lotsBytes), sourceParcels: parcels,
});
const result = applyHopkinsDemoCorrectionManifest(parcels, parsed, scope, null);
const childCount = manifest.approved_splits.reduce((sum, split) => sum + split.children.length, 0);
const visibleCount = lots.length - manifest.approved_splits.length + childCount - (manifest.superseded_detections?.length ?? 0);
assert.equal(manifest.revision, 33);
assert.equal(manifest.approved_splits.length, 31);
assert.equal(childCount, 117);
assert.equal(visibleCount, 803);
assert.equal(result.parcels.length, visibleCount);
assert.deepEqual(result.warnings, []);
assert.equal(manifest.approved_splits.every((split) => split.children.every((child) => child.printed_number === "" && child.label_status === "pending")), true);
for (const id of ["L-258", "L-363"]) assert.equal(result.parcels.some((parcel) => parcel.lot_number === id), true, `${id} should remain unchanged and selectable`);
for (const id of ["L-365", "L-338", "L-337", "L-505", "L-504", "L-444", "L-506", "L-020", "L-011"]) {
  assert.equal(result.parcels.some((parcel) => parcel.lot_number === id), false, `${id} parent should be replaced`);
}
const children = result.parcels.filter((parcel) => parcel.local_preview);
assert.equal(children.length, childCount);
assert.equal(children.every((parcel) => parcel.lot_number === "" && parcel.public_ref === null
  && parcel.price === 0 && parcel.status === "Review pending" && parcel.tier_key === null), true);
console.log(JSON.stringify({ manifestPath, revision: manifest.revision, sourceDetections: lots.length,
  appliedParents: manifest.approved_splits.length, childOutlines: childCount,
  supersededSourceOutlines: manifest.superseded_detections?.map((entry) => entry.detection_id) ?? [],
  visibleOutlines: result.parcels.length, labelsPending: true, warnings: result.warnings }, null, 2));
