import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(root, process.env.WAMULE_HOPKINS_MAP_DIR ?? "out/hopkins-ocr");
const sourceImagePath = resolve(dataDir, "masterplan_background.webp");
const detectionsPath = resolve(dataDir, "lots.json");
const outputPath = resolve(dataDir, "local-corrections.json");
const queueDir = resolve(root, "out/plat-digitizer/separation-queue-20261014-v02");
const requestedQueueIds = ["L-155", "L-086", "L-058", "L-028", "L-362", "L-416", "L-541", "L-622", "L-650", "L-651", "L-652", "L-653", "L-677", "L-678", "L-679", "L-681", "L-683", "L-719"];
const proposalPaths = [
  ...requestedQueueIds.map((id) => resolve(queueDir, id, "proposal.json")),
  resolve(root, "out/plat-digitizer/L-049-cv01/proposal.json"),
];

if (existsSync(outputPath)) throw new Error(`Refusing to overwrite existing correction manifest: ${outputPath}`);
for (const path of [sourceImagePath, detectionsPath, ...proposalPaths]) {
  if (!existsSync(path)) throw new Error(`Required source/proposal file is missing: ${path}`);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const imageBytes = readFileSync(sourceImagePath);
const detectionBytes = readFileSync(detectionsPath);
const sourceImageSha = sha256(imageBytes);
const detectionSha = sha256(detectionBytes);
const lots = JSON.parse(detectionBytes.toString("utf8"));
const proposalDate = new Date().toISOString();
const scope = { tenantSlug: "hopkins-grove", projectSlug: "map-review", phaseSlug: "default" };

function samePolygon(first, second) {
  return Array.isArray(first) && Array.isArray(second) && first.length === second.length
    && first.every((point, index) => Number(point.x).toFixed(6) === Number(second[index].x).toFixed(6)
      && Number(point.y).toFixed(6) === Number(second[index].y).toFixed(6));
}

function exceptionNotes(proposal) {
  const validation = proposal.validation ?? {};
  const notes = [];
  const gap = Number(validation.unassigned_parent_area_percent ?? 0);
  const outside = Number(validation.outside_parent_area_percent ?? 0);
  if (gap > 0) notes.push(`${gap.toFixed(3)}% of the original detected area remains unassigned.`);
  if (outside > 0) notes.push(`${outside.toFixed(3)}% of proposed child area extends outside the original detection (possible sliver/alignment exception).`);
  const alignments = Array.isArray(validation.child_boundary_alignment_within_4px_percent)
    ? validation.child_boundary_alignment_within_4px_percent : [];
  const low = alignments.map((score, index) => ({ score: Number(score), index: index + 1 })).filter(({ score }) => score < 90);
  if (low.length) notes.push(`Boundary-on-dark-ink heuristic is below 90% for child${low.length === 1 ? "" : "ren"} ${low.map(({ index, score }) => `${index} (${score.toFixed(2)}%)`).join(", ")}; the score is a raster heuristic, not survey accuracy.`);
  const overlaps = Array.isArray(validation.existing_detection_overlaps) ? validation.existing_detection_overlaps : [];
  if (overlaps.length) notes.push(`Proposed child boundaries intersect existing neighboring detection${overlaps.length === 1 ? "" : "s"}: ${[...new Set(overlaps.map((entry) => entry.detection_id))].join(", ")}.`);
  return { notes, alignments, overlaps };
}

const snapshots = [];
const seenParents = new Set();
const seenChildren = new Set();
for (const proposalPath of proposalPaths) {
  const proposal = JSON.parse(readFileSync(proposalPath, "utf8"));
  const parentId = proposal.detection_source?.selected_parent_detection_id;
  if (!parentId || seenParents.has(parentId)) throw new Error(`Missing or duplicate parent detection in ${proposalPath}`);
  seenParents.add(parentId);
  if (proposal.source_image?.sha256 !== sourceImageSha || proposal.detection_source?.sha256 !== detectionSha) {
    throw new Error(`${parentId} proposal source fingerprints do not match current Hopkins map files.`);
  }
  const sourceParent = lots.find((lot) => lot.lot_number === parentId);
  const parentPolygon = proposal.detection_source.selected_parent_polygon_pct;
  if (!sourceParent || !samePolygon(sourceParent.polygon_pct, parentPolygon)) {
    throw new Error(`${parentId} parent geometry does not exactly match the current lots.json source.`);
  }
  if (proposal.review?.canonical_identity_assigned || proposal.safety?.canonical_parcel_data_modified) {
    throw new Error(`${parentId} proposal indicates an unsafe identity or canonical-data mutation.`);
  }
  if (proposal.validation?.all_child_shapes_valid !== true
    || (proposal.validation?.invalid_child_indices ?? []).length > 0
    || (proposal.validation?.pairwise_child_overlaps ?? []).length > 0) {
    throw new Error(`${parentId} proposal contains invalid or overlapping child geometry.`);
  }
  const childIds = proposal.children.map((child) => child.draft_id);
  if (childIds.length < 2 || childIds.some((id) => !id || seenChildren.has(id))) throw new Error(`${parentId} has too few or duplicate stable child IDs.`);
  childIds.forEach((id) => seenChildren.add(id));

  const { notes, alignments, overlaps } = exceptionNotes(proposal);
  const ownerNote = `The project owner explicitly authorized this proposal's geometry for the local Hopkins demo on ${proposalDate}. This is not source-survey acceptance, approved parcel identity, pricing, availability, or publication.`;
  const reasonedWaiver = [ownerNote, `Known geometry exceptions for ${parentId}:`, ...(notes.length ? notes : ["No proposal-level exception was reported; geometry remains demo-only and unverified against a legal register."]), "OCR/printed identities were intentionally omitted and remain pending human review."].join(" ");
  const children = proposal.children.map((child) => ({
    id: child.draft_id,
    parent_detection_id: parentId,
    polygon_pct: child.polygon_pct,
    printed_number: "",
    label_status: "pending",
  }));
  const revisionPayload = JSON.stringify({ parentId, parentPolygon, children: children.map(({ id, polygon_pct }) => ({ id, polygon_pct })) });
  const revisionFingerprint = sha256(Buffer.from(revisionPayload));
  const draftId = `OWNER-DEMO-${parentId}-${proposal.proposal_fingerprint.slice(0, 12)}`;
  snapshots.push({
    snapshot_id: `${draftId}@${revisionFingerprint}`,
    draft_id: draftId,
    revision_fingerprint: revisionFingerprint,
    parent_detection_id: parentId,
    parent_map_reference: sourceParent.lot_number,
    parent_polygon_pct: parentPolygon,
    source_image_sha256: sourceImageSha,
    proposal_fingerprint: proposal.proposal_fingerprint,
    approved_by: "Project owner (explicit demo-use authorization)",
    approved_at: proposalDate,
    correction_note: `Owner-authorized local demo replacement of ${parentId} by ${children.length} source-derived child contours. Children are individually selectable; labels remain pending.`,
    reasoned_waiver: reasonedWaiver,
    approval_basis: "owner-authorized-demo-use",
    source_proposal_path: proposalPath.slice(root.length + 1),
    geometry_exceptions: notes,
    geometry_evidence: {
      parent_coverage_percent: Number(proposal.validation.parent_coverage_percent ?? 0),
      unassigned_parent_area_percent: Number(proposal.validation.unassigned_parent_area_percent ?? 0),
      outside_parent_area_percent: Number(proposal.validation.outside_parent_area_percent ?? 0),
      child_boundary_alignment_within_4px_percent: alignments,
      existing_detection_overlaps: overlaps.map((entry) => ({
        detection_id: entry.detection_id,
        child_index: entry.child_index,
        intersection_px2: entry.intersection_px2,
      })),
    },
    children,
  });
}

if (snapshots.length !== 19 || seenParents.size !== 19) throw new Error(`Expected 19 distinct approved demo replacements; found ${snapshots.length}.`);
const manifest = {
  manifest_kind: "wamule-hopkins-demo-correction-manifest",
  schema_version: 1,
  scope,
  revision: snapshots.length,
  created_at: proposalDate,
  source_image: { sha256: sourceImageSha, width: 5700, height: 4800 },
  detection_source_sha256: detectionSha,
  owner_authorization: {
    basis: "explicit-owner-instruction",
    approved_at: proposalDate,
    note: "Owner authorized all accessible listed proposals for local Hopkins Grove demo use. This does not authorize a hosted release, canonical sales record, printed identity, price, availability, or publication.",
  },
  benchmark_exposure: [{
    case_id: "S015",
    detection_id: "L-028",
    status: "exposed-not-independent-blind-ground-truth",
    note: "L-028 source/proposal inspection was previously recorded as an exposure. The original benchmark manifest and label evidence were not modified.",
  }],
  inaccessible_manual_session: {
    status: "pending-not-imported",
    detection_id: null,
    note: "The owner's unsaved six-child browser session was inaccessible to this local manifest build and was not guessed, imported, replaced, or marked complete.",
  },
  approved_splits: snapshots,
};
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(`Wrote ${snapshots.length} owner-authorized demo replacements (${snapshots.reduce((sum, item) => sum + item.children.length, 0)} child polygons) to ${outputPath}`);
console.log(`Source raster ${sourceImageSha}; detection set ${detectionSha}`);
