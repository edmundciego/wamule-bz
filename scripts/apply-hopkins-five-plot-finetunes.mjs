import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mapDir = resolve(root, process.env.WAMULE_HOPKINS_MAP_DIR ?? "out/hopkins-ocr");
const manifestPath = resolve(mapDir, "local-corrections.json");
const detectionsPath = resolve(mapDir, "lots.json");
const imagePath = resolve(mapDir, "masterplan_background.webp");
const proposalDir = resolve(root, "out/plat-digitizer/fine-tune-review-v02-20261014");
const backupPath = resolve(root, "artifacts/hopkins-five-plot-approval-20261014/local-corrections.before.json");
const candidatePath = resolve(root, "artifacts/hopkins-five-plot-approval-20261014/local-corrections.approved.json");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalSha = (value) => sha256(Buffer.from(JSON.stringify(value)));
const imageBytes = readFileSync(imagePath);
const detectionBytes = readFileSync(detectionsPath);
const manifestBytes = readFileSync(manifestPath);
if (!existsSync(backupPath) || !readFileSync(backupPath).equals(manifestBytes)) {
  throw new Error("The current manifest backup is missing or does not match; no correction was written.");
}
if (existsSync(candidatePath)) throw new Error(`Refusing to overwrite ${candidatePath}`);

const imageSha = sha256(imageBytes);
const detectionSha = sha256(detectionBytes);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const detections = JSON.parse(detectionBytes.toString("utf8"));
const lotsById = new Map(detections.map((row) => [row.lot_number, row]));
const approvedBy = "Project owner (explicit local demo approval)";
const approvedAt = new Date().toISOString();
const historyReason = "Owner-approved local Hopkins demo geometry refinement. Source geometry and identity provenance are retained; OCR remains unverified and no sales, price, or canonical identity fields are assigned.";

if (manifest.revision !== 19 || manifest.source_image?.sha256 !== imageSha || manifest.detection_source_sha256 !== detectionSha) {
  throw new Error("The correction manifest/source revision changed since review; nothing was applied.");
}

function readProposal(parentId) {
  const relative = `out/plat-digitizer/fine-tune-review-v02-20261014/${parentId}/proposal.json`;
  const proposal = JSON.parse(readFileSync(resolve(root, relative), "utf8"));
  if (proposal.source_image?.sha256 !== imageSha || proposal.detection_source?.sha256 !== detectionSha
    || proposal.detection_source?.selected_parent_detection_id !== parentId) {
    throw new Error(`${parentId} proposal source binding does not match the current Hopkins files.`);
  }
  const lot = lotsById.get(parentId);
  if (!lot || JSON.stringify(lot.polygon_pct) !== JSON.stringify(proposal.detection_source.selected_parent_polygon_pct)) {
    throw new Error(`${parentId} proposal parent geometry does not match the current source detection.`);
  }
  if (proposal.validation?.all_child_shapes_valid !== true
    || (proposal.validation?.invalid_child_indices ?? []).length
    || (proposal.validation?.pairwise_child_overlaps ?? []).length) {
    throw new Error(`${parentId} has invalid or overlapping proposed children.`);
  }
  return { proposal, relative };
}

function splitFromProposal(parentId) {
  const { proposal, relative } = readProposal(parentId);
  if (proposal.children.length < 2) throw new Error(`${parentId} is not a split proposal.`);
  const source = lotsById.get(parentId);
  const children = proposal.children.map((child) => ({
    id: child.draft_id,
    parent_detection_id: parentId,
    polygon_pct: child.polygon_pct,
    printed_number: "",
    label_status: "pending",
  }));
  const validation = proposal.validation;
  const geometryExceptions = [];
  if (validation.unassigned_parent_area_percent > 0) geometryExceptions.push(`${validation.unassigned_parent_area_percent.toFixed(3)}% of the original ${parentId} detection remains unassigned.`);
  if (validation.outside_parent_area_percent > 0) geometryExceptions.push(`${validation.outside_parent_area_percent.toFixed(3)}% of proposed child area extends outside the original ${parentId} detection.`);
  validation.child_boundary_alignment_within_4px_percent.forEach((score, index) => {
    if (score < 90) geometryExceptions.push(`Child ${index + 1} boundary-on-dark-ink heuristic is ${Number(score).toFixed(2)}%; this raster score is not survey accuracy.`);
  });
  if (validation.existing_detection_overlaps.length) geometryExceptions.push(`Pre-correction detections overlapped ${[...new Set(validation.existing_detection_overlaps.map((entry) => entry.detection_id))].join(", ")}; this snapshot is reviewed against the active replacement outlines and does not publish source OCR.`);
  const reasonedWaiver = [
    `${historyReason} Accepted for the local demo despite the recorded source-raster exceptions.`,
    `Parent coverage is ${validation.parent_coverage_percent.toFixed(3)}%, with ${validation.unassigned_parent_area_percent.toFixed(3)}% unassigned and ${validation.outside_parent_area_percent.toFixed(3)}% outside-parent area by the extraction report.`,
    `Boundary alignment heuristics: ${validation.child_boundary_alignment_within_4px_percent.map((value) => `${Number(value).toFixed(2)}%`).join(", ")}.`,
    "All printed-number suggestions remain blank/pending and are not approved inventory identities.",
  ].join(" ");
  const draftId = `OWNER-DEMO-${parentId}-${proposal.proposal_fingerprint.slice(0, 12)}`;
  const revisionFingerprint = canonicalSha({ parentId, parentPolygon: source.polygon_pct, children: children.map(({ id, polygon_pct }) => ({ id, polygon_pct })) });
  return {
    snapshot_id: `${draftId}@${revisionFingerprint}`,
    draft_id: draftId,
    revision_fingerprint: revisionFingerprint,
    parent_detection_id: parentId,
    parent_map_reference: parentId,
    parent_polygon_pct: source.polygon_pct,
    source_image_sha256: imageSha,
    proposal_fingerprint: proposal.proposal_fingerprint,
    approved_by: approvedBy,
    approved_at: approvedAt,
    correction_note: `Owner-approved local demo replacement of ${parentId} by ${children.length} CV-derived child outlines. Printed numbers remain unverified and pending.`,
    reasoned_waiver: reasonedWaiver,
    approval_basis: "owner-authorized-demo-use",
    source_proposal_path: relative,
    geometry_exceptions: geometryExceptions,
    geometry_evidence: {
      parent_coverage_percent: validation.parent_coverage_percent,
      unassigned_parent_area_percent: validation.unassigned_parent_area_percent,
      outside_parent_area_percent: validation.outside_parent_area_percent,
      child_boundary_alignment_within_4px_percent: validation.child_boundary_alignment_within_4px_percent,
      existing_detection_overlaps: validation.existing_detection_overlaps.map((entry) => ({
        detection_id: entry.detection_id,
        child_index: entry.child_index,
        intersection_px2: entry.intersection_px2,
      })),
    },
    children,
  };
}

function fingerprintSnapshot(snapshot) {
  const revisionFingerprint = canonicalSha({
    parentId: snapshot.parent_detection_id,
    parentPolygon: snapshot.parent_polygon_pct,
    children: snapshot.children.map(({ id, polygon_pct }) => ({ id, polygon_pct })),
  });
  snapshot.revision_fingerprint = revisionFingerprint;
  snapshot.snapshot_id = `${snapshot.draft_id}@${revisionFingerprint}`;
  snapshot.approved_by = approvedBy;
  snapshot.approved_at = approvedAt;
  return snapshot;
}

function archivePriorSnapshot(snapshot, note) {
  snapshot.geometry_history ??= [];
  snapshot.geometry_history.push({
    action: "snapshot-revised",
    reason: note,
    approved_by: approvedBy,
    approved_at: approvedAt,
    prior_snapshot_id: snapshot.snapshot_id,
    prior_revision_fingerprint: snapshot.revision_fingerprint,
    prior_geometry_evidence: snapshot.geometry_evidence,
    prior_geometry_exceptions: snapshot.geometry_exceptions,
    prior_reasoned_waiver: snapshot.reasoned_waiver,
  });
}

const l048 = readProposal("L-048");
const l137 = readProposal("L-137");
const l156 = readProposal("L-156");
const l184 = readProposal("L-184");
const l235 = readProposal("L-235");
const byParent = new Map(manifest.approved_splits.map((snapshot) => [snapshot.parent_detection_id, snapshot]));

// L-058's two small contours are fragments of the two full plots identified by L-048.
const l058 = byParent.get("L-058");
if (!l058 || l058.children.length !== 5) throw new Error("Expected the current five-child L-058 split; no changes were written.");
const oldL058 = l058.children;
archivePriorSnapshot(l058, "The L-058 geometry was revised after owner approval of the source-aligned L-048 two-plot correction.");
l058.geometry_history.push(...oldL058.slice(1, 3).map((child) => ({
  action: "retired-child-fragment",
  child_id: child.id,
  before_polygon_pct: child.polygon_pct,
  source_proposal_path: l048.relative,
  source_proposal_fingerprint: l048.proposal.proposal_fingerprint,
  reason: "Retired from the active map because source comparison showed these partial contours intersect the complete L-048 plot outlines; original geometry is retained here for recovery.",
  approved_by: approvedBy,
  approved_at: approvedAt,
})));
l058.children = [oldL058[0], oldL058[3], oldL058[4]];
l058.geometry_evidence = {
  ...l058.geometry_evidence,
  parent_coverage_percent: 71.143,
  unassigned_parent_area_percent: 28.857,
  outside_parent_area_percent: 0.117,
  child_boundary_alignment_within_4px_percent: [100, 89.37, 78.53],
  existing_detection_overlaps: l058.geometry_evidence.existing_detection_overlaps.filter((entry) => entry.detection_id !== "L-048"),
};
l058.geometry_exceptions = [
  "28.857% of the original L-058 parent extent is no longer represented by its three active children because two fragment contours were retired; the complete L-048 source-derived children now represent the shared printed plots in that region.",
  "0.117% of active child union area lies outside the original detection boundary.",
  "Boundary-on-ink heuristic is below 90% for retained children 2 (89.37%) and 3 (78.53%).",
];
l058.reasoned_waiver = `${historyReason} The owner approved retiring L-058 child fragments 2 and 3 after they were found to intersect full L-048 plots. The 28.857% parent-area gap, 0.117% outside sliver, and retained child alignment scores (100%, 89.37%, 78.53%) are recorded; this is a local demo reconciliation, not survey approval.`;
l058.correction_note = "Owner-approved local demo refinement: retain L-058 children 1, 4, and 5; retire overlapping fragments 2 and 3, now represented by the L-048 child outlines. Original fragment geometry is preserved in geometry_history.";
fingerprintSnapshot(l058);

// Use the existing source-aligned L-137/L-156 detections as the whole-plot boundaries
// for two undersized L-155 fragments, then suppress their duplicate top-level outlines.
const l155 = byParent.get("L-155");
if (!l155 || l155.children.length !== 5) throw new Error("Expected the current five-child L-155 split; no changes were written.");
archivePriorSnapshot(l155, "The L-155 geometry was refined to use the existing full source outlines for the L-137 and L-156 plots.");
const replacedSources = [];
for (const [childIndex, sourceId, support] of [[1, "L-137", l137], [2, "L-156", l156]]) {
  const child = l155.children[childIndex];
  const source = lotsById.get(sourceId);
  if (!source || support.proposal.children.length !== 1) throw new Error(`Missing one-polygon source for ${sourceId}.`);
  const before = child.polygon_pct;
  child.polygon_pct = source.polygon_pct;
  l155.geometry_history.push({
    action: "child-geometry-refined",
    child_id: child.id,
    before_polygon_pct: before,
    after_polygon_pct: source.polygon_pct,
    source_detection_id: sourceId,
    source_proposal_path: support.relative,
    source_proposal_fingerprint: support.proposal.proposal_fingerprint,
    reason: `The previous L-155 child was only a partial contour inside printed plot ${sourceId}; the existing source-aligned ${sourceId} detection boundary is retained as the full child geometry. The source detection is suppressed separately to avoid duplicate map outlines.`,
    approved_by: approvedBy,
    approved_at: approvedAt,
  });
  replacedSources.push({ sourceId, childId: child.id, source, support });
}
l155.geometry_evidence = {
  ...l155.geometry_evidence,
  parent_coverage_percent: 93.823,
  unassigned_parent_area_percent: 6.177,
  outside_parent_area_percent: 15.580,
  child_boundary_alignment_within_4px_percent: [100, 59.75, 80.12, 92.9, 96.1],
  existing_detection_overlaps: l155.geometry_evidence.existing_detection_overlaps
    .filter((entry) => entry.detection_id !== "L-137" && entry.detection_id !== "L-156"),
};
l155.geometry_exceptions = [
  "6.177% of the original L-155 parent area remains unassigned.",
  "15.580% of the updated child-union area extends outside the L-155 detection boundary; the retained L-137/L-156 source outlines extend across that incomplete merged detection.",
  "Boundary-on-ink heuristic is 59.75% for the L-137 replacement child and 80.12% for the L-156 replacement child; both were visually compared against the source plat and remain demo-only geometry.",
];
l155.reasoned_waiver = `${historyReason} L-155 child fragments 2 and 3 were replaced with the existing source-bound L-137 and L-156 whole-plot outlines; duplicate top-level source detections are withheld only while this L-155 snapshot is active. The 6.177% parent gap, 15.580% outward extension, and alignment scores are recorded. No printed identities are approved.`;
l155.correction_note = "Owner-approved local demo refinement: L-155 children 2 and 3 now use the full source-aligned L-137/L-156 plot outlines; original partial fragments and source detections remain recoverable in the manifest/history.";
fingerprintSnapshot(l155);

const additions = ["L-048", "L-184", "L-235"].map(splitFromProposal);
for (const snapshot of additions) {
  if (byParent.has(snapshot.parent_detection_id)) throw new Error(`An active split already exists for ${snapshot.parent_detection_id}.`);
  byParent.set(snapshot.parent_detection_id, snapshot);
  manifest.approved_splits.push(snapshot);
}

manifest.superseded_detections = [
  ...(manifest.superseded_detections ?? []),
  ...replacedSources.map(({ sourceId, childId, source }) => ({
    detection_id: sourceId,
    source_polygon_pct: source.polygon_pct,
    replaced_by_parent_detection_id: "L-155",
    replacement_child_id: childId,
    source_image_sha256: imageSha,
    reason: `The source outline for ${sourceId} is now the active geometry of ${childId}; hide the duplicate top-level source record only when the L-155 approved snapshot is active.`,
    approved_by: approvedBy,
    approved_at: approvedAt,
  })),
];

manifest.revision += 5;
manifest.created_at = approvedAt;
manifest.owner_authorization.note += " Owner additionally approved the local-demo refinements for L-048, L-137, L-156, L-184, and L-235 on 2026-10-14; OCR identities remain pending, and hosted/canonical sales data is unchanged.";
manifest.approved_splits = manifest.approved_splits.map((snapshot) => byParent.get(snapshot.parent_detection_id));

writeFileSync(candidatePath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({
  candidatePath,
  backupPath,
  previousManifestSha256: sha256(manifestBytes),
  candidateManifestSha256: sha256(readFileSync(candidatePath)),
  revision: manifest.revision,
  activeSplitParents: manifest.approved_splits.length,
  children: manifest.approved_splits.reduce((sum, split) => sum + split.children.length, 0),
  supersededDetections: manifest.superseded_detections.length,
  addedSplits: additions.map((snapshot) => ({ parent: snapshot.parent_detection_id, children: snapshot.children.length, labelsPending: snapshot.children.every((child) => child.printed_number === "" && child.label_status === "pending") })),
}, null, 2));
