import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

function dataModule(source, replacements = []) {
  let javascript = ts.transpile(source, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 });
  for (const [from, to] of replacements) javascript = javascript.replace(from, to);
  return `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function buildHopkinsFeatureSnapshot({ manifestPath, lotsPath, imagePath }) {
  const root = process.cwd();
  const manifestBytes = readFileSync(resolve(manifestPath));
  const lotsBytes = readFileSync(resolve(lotsPath));
  const imageBytes = readFileSync(resolve(imagePath));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const lots = JSON.parse(lotsBytes.toString("utf8"));
  const tiersBytes = readFileSync(resolve(root, "map-input/hopkins.tiers.json"));
  const tierCatalogue = JSON.parse(tiersBytes.toString("utf8"));
  const sourceDetectionById = new Map(lots.map((lot) => [lot.lot_number, lot]));
  const tierByKey = tierCatalogue.tiers ?? {};
  const detectionSha = sha256(lotsBytes);
  const imageSha = sha256(imageBytes);
  const manifestSha = sha256(manifestBytes);
  const tierSha = sha256(tiersBytes);

  const splitUrl = dataModule(readFileSync(resolve(root, "src/lib/mapPolygonSplit.ts"), "utf8"));
  const previewUrl = dataModule(readFileSync(resolve(root, "src/lib/localMapPreview.ts"), "utf8"), [
    ['from "./mapGeometry"', ""], ['from "./mapApprovalFlow"', ""],
  ]);
  const approvalUrl = dataModule(readFileSync(resolve(root, "src/lib/mapApprovalFlow.ts"), "utf8"), [
    ['from "./mapPolygonSplit"', `from "${splitUrl}"`],
  ]);
  const correctionsUrl = dataModule(readFileSync(resolve(root, "src/lib/hopkinsDemoCorrections.ts"), "utf8"), [
    ['from "./mapPolygonSplit"', `from "${splitUrl}"`],
    ['from "./localMapPreview"', `from "${previewUrl}"`],
  ]);
  const { parseHopkinsDemoCorrectionManifest, applyHopkinsDemoCorrectionManifest } = await import(correctionsUrl);
  const sourceParcels = lots.map((lot, index) => ({
    local_key: index + 1, public_ref: null, correction_key: lot.id ?? lot.lot_number,
    lot_number: lot.lot_number, status: "Review pending", price: 0, dimensions: null,
    area_sqm: null, map_polygon: lot.polygon_pct, tier_key: null, tier_label: null,
    tier_color_hex: null, is_corner: false, effective_price_cents: 0,
  }));
  const sourceImage = manifest.source_image;
  if (sourceImage?.width !== 5700 || sourceImage?.height !== 4800 || imageSha !== sourceImage?.sha256) {
    throw new Error("The local display image does not match the recorded 5700×4800 Hopkins source fingerprint.");
  }
  if (detectionSha !== manifest.detection_source_sha256) throw new Error("The detections file does not match the correction manifest fingerprint.");
  const parsed = parseHopkinsDemoCorrectionManifest(manifest, {
    scope: manifest.scope, sourceImageSha256: imageSha, sourceImageWidth: 5700, sourceImageHeight: 4800,
    detectionSourceSha256: detectionSha, sourceParcels,
  });
  const applied = applyHopkinsDemoCorrectionManifest(sourceParcels, parsed, manifest.scope, null);
  if (applied.warnings.length) throw new Error(`Correction snapshot validation warnings: ${applied.warnings.join(" ")}`);
  if (applied.parcels.length !== 775) throw new Error(`Expected the approved revision-24 775-outline snapshot; found ${applied.parcels.length}.`);
  const usedKeys = new Set();
  const features = applied.parcels.map((parcel, index) => {
    const featureKey = parcel.local_preview?.childId ?? `detection:${parcel.correction_key ?? parcel.lot_number}`;
    if (usedKeys.has(featureKey)) throw new Error(`Duplicate stable feature key ${featureKey}.`);
    usedKeys.add(featureKey);
    const polygon = parcel.map_polygon;
    if (!Array.isArray(polygon) || polygon.length < 3 || polygon.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      throw new Error(`Feature ${featureKey} has no valid source-aligned polygon.`);
    }
    const parentId = parcel.local_preview?.parentDetectionId ?? parcel.correction_key ?? parcel.lot_number;
    const sourceDetection = sourceDetectionById.get(parentId);
    const sourceTier = sourceDetection && tierByKey[sourceDetection.tier_key];
    if (!sourceDetection || !sourceTier) {
      throw new Error(`Feature ${featureKey} has no source detection/tier match for ${parentId}.`);
    }
    const split = parsed.approved_splits.find((item) => item.parent_detection_id === parentId);
    const printedNumberCandidate = !parcel.local_preview
      && sourceDetection.match_status === "matched"
      && typeof sourceDetection.printed_lot_number === "string"
      ? sourceDetection.printed_lot_number
      : null;
    const printedNumberStatus = parcel.local_preview
      ? "split-child-pending-human-review"
      : printedNumberCandidate
        ? "ocr-match-pending-human-review"
        : sourceDetection.match_status === "duplicate"
          ? "duplicate-ocr-token-pending-human-review"
          : "no-unique-source-match";
    const provenance = {
      source_image_sha256: imageSha,
      detection_source_sha256: detectionSha,
      correction_manifest_sha256: manifestSha,
      tier_catalogue_sha256: tierSha,
      correction_manifest_revision: manifest.revision,
      source_detection_id: parcel.local_preview ? null : parentId,
      parent_detection_id: parcel.local_preview ? parentId : null,
      source_tier_key: sourceDetection.tier_key,
      source_printed_lot_number_candidate: printedNumberCandidate,
      source_printed_lot_number_status: printedNumberStatus,
      proposal_fingerprint: split?.proposal_fingerprint ?? null,
      geometry_exceptions: split?.geometry_exceptions ?? [],
      reasoned_waiver: split?.reasoned_waiver ?? null,
      label_status: "pending-unverified-demo-label",
      original_detection_geometry_preserved_in_source_manifest: true,
    };
    return {
      feature_key: featureKey,
      demo_label: `Plot ${String(index + 1).padStart(3, "0")}`,
      feature_kind: "demo_plot",
      parent_feature_key: parcel.local_preview ? `detection:${parentId}` : null,
      source_detection_id: parentId,
      map_polygon: polygon.map(({ x, y }) => ({ x, y })),
      provenance,
    };
  });
  const content = {
    schema_version: 1, manifest_revision: manifest.revision,
    source_image_sha256: imageSha, detection_source_sha256: detectionSha,
    correction_manifest_sha256: manifestSha, tier_catalogue_sha256: tierSha,
    source_annotation_version: "hopkins-pdf-tier-and-ocr-crosswalk-v1",
    features: features.map(({ feature_key, demo_label, parent_feature_key, source_detection_id, map_polygon, provenance }) =>
      ({ feature_key, demo_label, parent_feature_key, source_detection_id, map_polygon,
        source_tier_key: provenance.source_tier_key,
        source_printed_lot_number_candidate: provenance.source_printed_lot_number_candidate,
        source_printed_lot_number_status: provenance.source_printed_lot_number_status })),
  };
  return {
    manifest, imageBytes, imageSha, detectionSha, manifestSha, tierSha, tierCatalogue, features,
    snapshotFingerprint: sha256(Buffer.from(JSON.stringify(content))),
  };
}
