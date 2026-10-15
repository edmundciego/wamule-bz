import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(root, "out/hopkins-ocr");
const manifestPath = resolve(dataDir, "local-corrections.json");
const lotsPath = resolve(dataDir, "lots.json");
const imagePath = resolve(dataDir, "masterplan_background.webp");
const artifactDir = resolve(root, "artifacts/hopkins-lot-finetune-20261014");
const backupPath = resolve(artifactDir, "local-corrections.before.json");
const candidatePath = resolve(artifactDir, "local-corrections.proposed.json");
const statusPath = resolve(artifactDir, "review-status.json");
const applyIds = ["L-365", "L-338", "L-337", "L-505", "L-504", "L-444", "L-506", "L-020", "L-011"];
const unresolved = [
  { detection_id: "L-258", reason: "The broad-hue CV proposal includes a partial contour over printed plot 896 and does not provide a source-faithful child boundary set; leave the existing map detection active for manual tracing." },
  { detection_id: "L-363", reason: "Its proposal overlaps the already-active L-362 replacement children: candidate children 1 and 4 overlap active L-362 children 2 and 3 by about 40.23% and 89.58% respectively. Keep the current map geometry until the shared boundary is reconciled." },
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalSha = (value) => sha256(Buffer.from(JSON.stringify(value)));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const imageBytes = readFileSync(imagePath);
const lotsBytes = readFileSync(lotsPath);
const manifestBytes = readFileSync(manifestPath);
if (!existsSync(backupPath) || !readFileSync(backupPath).equals(manifestBytes)) {
  throw new Error("The exact current manifest backup is missing or mismatched; no candidate was written.");
}
if (existsSync(candidatePath) || existsSync(statusPath)) throw new Error("Refusing to overwrite existing finetune artifacts.");

const manifest = JSON.parse(manifestBytes.toString("utf8"));
const lots = JSON.parse(lotsBytes.toString("utf8"));
const byParent = new Map(manifest.approved_splits.map((split) => [split.parent_detection_id, split]));
const imageSha = sha256(imageBytes);
const detectionSha = sha256(lotsBytes);
const approvedAt = new Date().toISOString();
const approvedBy = "Project owner (local Hopkins demo geometry authorization)";
const proposalRoot = resolve(root, "out/plat-digitizer/font-finetune-review-20261014");
const status = [];
const additions = [];

function proposalPath(parentId) {
  const hueAllParents = new Set(["L-363", "L-365", "L-338", "L-337"]);
  return resolve(proposalRoot, `${parentId}${hueAllParents.has(parentId) ? "-hue-all" : ""}`, "proposal.json");
}

function readProposal(parentId) {
  const path = proposalPath(parentId);
  const proposal = readJson(path);
  const parent = lots.find((lot) => lot.lot_number === parentId);
  if (!parent || proposal.source_image?.sha256 !== imageSha || proposal.detection_source?.sha256 !== detectionSha
    || proposal.detection_source?.selected_parent_detection_id !== parentId
    || JSON.stringify(parent.polygon_pct) !== JSON.stringify(proposal.detection_source.selected_parent_polygon_pct)) {
    throw new Error(`${parentId} proposal does not match the exact current source fingerprints and polygon.`);
  }
  if (proposal.review?.canonical_identity_assigned || proposal.safety?.canonical_parcel_data_modified
    || proposal.processing?.external_ai_upload_performed) {
    throw new Error(`${parentId} proposal contains an unsafe identity, canonical-data, or external-upload marker.`);
  }
  const validation = proposal.validation ?? {};
  if (validation.all_child_shapes_valid !== true || validation.invalid_child_indices?.length
    || validation.pairwise_child_overlaps?.length || !Array.isArray(proposal.children) || proposal.children.length < 2) {
    throw new Error(`${parentId} proposal has invalid/overlapping child geometry or insufficient children.`);
  }
  if (validation.existing_detection_overlaps?.length) {
    throw new Error(`${parentId} proposal intersects source detections and needs a separate reconciliation before it can be applied.`);
  }
  if (proposal.children.some((child) => child.ocr_candidates?.length || child.proposed_printed_number)) {
    throw new Error(`${parentId} proposal unexpectedly contains OCR suggestions; this pass expects labels to remain blank.`);
  }
  return { parent, proposal, path };
}

for (const parentId of applyIds) {
  if (byParent.has(parentId)) throw new Error(`${parentId} already has a replacement snapshot; refusing to overwrite it.`);
  const { parent, proposal, path } = readProposal(parentId);
  const childIds = new Set();
  const children = proposal.children.map((child) => {
    if (!child.draft_id || childIds.has(child.draft_id)) throw new Error(`${parentId} has missing or duplicate stable draft IDs.`);
    childIds.add(child.draft_id);
    return {
      id: child.draft_id,
      parent_detection_id: parentId,
      polygon_pct: child.polygon_pct,
      printed_number: "",
      label_status: "pending",
    };
  });
  const validation = proposal.validation;
  const alignments = validation.child_boundary_alignment_within_4px_percent ?? [];
  const geometryExceptions = [];
  if (validation.unassigned_parent_area_percent > 0) geometryExceptions.push(`${Number(validation.unassigned_parent_area_percent).toFixed(3)}% of the original ${parentId} detection remains unassigned.`);
  if (validation.outside_parent_area_percent > 0) geometryExceptions.push(`${Number(validation.outside_parent_area_percent).toFixed(3)}% of proposed child union lies outside the original ${parentId} detection.`);
  alignments.forEach((score, index) => {
    if (Number(score) < 90) geometryExceptions.push(`Child ${index + 1} boundary-on-dark-ink heuristic is ${Number(score).toFixed(2)}%; this image metric is not survey accuracy.`);
  });
  const reasonedWaiver = [
    `The owner requested these local demo geometry refinements on 2026-10-14; source-bound CV contours were visually compared against the original plat and accepted for the demo only.`,
    `Coverage is ${Number(validation.parent_coverage_percent).toFixed(3)}%, leaving ${Number(validation.unassigned_parent_area_percent).toFixed(3)}% unassigned; ${Number(validation.outside_parent_area_percent).toFixed(3)}% outside-parent area is recorded.`,
    `Boundary-on-dark-ink heuristics: ${alignments.map((score) => `${Number(score).toFixed(2)}%`).join(", ")}.`,
    `Every printed number remains blank/pending; this does not establish canonical identity, pricing, availability, legal boundary, or hosted publication.`,
  ].join(" ");
  const revisionFingerprint = canonicalSha({ parentId, parentPolygon: parent.polygon_pct, children: children.map(({ id, polygon_pct }) => ({ id, polygon_pct })) });
  const draftId = `OWNER-DEMO-${parentId}-${proposal.proposal_fingerprint.slice(0, 12)}`;
  const snapshot = {
    snapshot_id: `${draftId}@${revisionFingerprint}`,
    draft_id: draftId,
    revision_fingerprint: revisionFingerprint,
    parent_detection_id: parentId,
    parent_map_reference: parent.lot_number,
    parent_polygon_pct: parent.polygon_pct,
    source_image_sha256: imageSha,
    proposal_fingerprint: proposal.proposal_fingerprint,
    approved_by: approvedBy,
    approved_at: approvedAt,
    correction_note: `Owner-authorized local demo replacement of ${parentId} with ${children.length} source-derived child outlines. Printed identities remain pending.`,
    reasoned_waiver: reasonedWaiver,
    approval_basis: "owner-authorized-demo-use",
    source_proposal_path: path.slice(root.length + 1),
    geometry_exceptions: geometryExceptions,
    geometry_evidence: {
      parent_coverage_percent: Number(validation.parent_coverage_percent),
      unassigned_parent_area_percent: Number(validation.unassigned_parent_area_percent),
      outside_parent_area_percent: Number(validation.outside_parent_area_percent),
      child_boundary_alignment_within_4px_percent: alignments.map(Number),
      existing_detection_overlaps: [],
    },
    children,
  };
  additions.push(snapshot);
  status.push({
    detection_id: parentId,
    status: "applied-local-demo-geometry",
    proposal_path: snapshot.source_proposal_path,
    proposal_fingerprint: snapshot.proposal_fingerprint,
    child_count: children.length,
    parent_coverage_percent: validation.parent_coverage_percent,
    unassigned_parent_area_percent: validation.unassigned_parent_area_percent,
    outside_parent_area_percent: validation.outside_parent_area_percent,
    boundary_ink_alignment_percent: alignments,
    printed_number_status: "blank-pending",
    exceptions: geometryExceptions,
  });
}

for (const entry of unresolved) status.push({ ...entry, status: "pending-not-applied" });
manifest.approved_splits.push(...additions);
manifest.revision += additions.length;
manifest.created_at = approvedAt;
manifest.owner_authorization.note += " Owner requested local demo fine-tuning for L-258, L-363, L-365, L-338, L-337, L-505, L-504, L-444, L-506, L-020, and L-011 on 2026-10-14. Nine source-bound contour replacements were applied with blank/pending identities; L-258 and L-363 remain pending due to contour/overlap issues.";
writeFileSync(candidatePath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
writeFileSync(statusPath, `${JSON.stringify({
  scope: manifest.scope,
  source_image_sha256: imageSha,
  detection_source_sha256: detectionSha,
  review_date: approvedAt,
  applied: status.filter((entry) => entry.status === "applied-local-demo-geometry"),
  pending: status.filter((entry) => entry.status === "pending-not-applied"),
}, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({
  backupPath,
  previousManifestSha256: sha256(manifestBytes),
  candidatePath,
  candidateSha256: sha256(readFileSync(candidatePath)),
  revision: manifest.revision,
  appendedParents: additions.map((item) => ({ id: item.parent_detection_id, children: item.children.length })),
  pending: unresolved.map((item) => item.detection_id),
}, null, 2));
