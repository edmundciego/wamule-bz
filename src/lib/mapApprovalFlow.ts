import { validatePolygonSplit } from "./mapPolygonSplit";
import type { MapCoordinate } from "./mapGeometry";

export type SplitDraftStatus = "proposal-review" | "accepted-draft" | "approved-preview" | "rejected";

export interface SplitDraftChild {
  id: string;
  parent_detection_id: string;
  polygon_pct: MapCoordinate[];
  geometry_source: "opencv-contour" | "human-edited-opencv-contour";
  proposed_printed_number: string | null;
  number_provider: string | null;
  number_model_version: string | null;
  number_confidence_note: string | null;
  review: { status: "draft" | "confirmed" | "ambiguous" | "unreadable"; printed_number: string; reviewer: string; reviewed_at: string | null };
  geometry_validation: { valid: boolean; errors: string[]; warnings: string[] };
  geometry_history: Array<{ edited_by: string; edited_at: string; before: MapCoordinate[]; after: MapCoordinate[] }>;
}

export interface EditableSplitDraft {
  draft_id: string;
  source_kind: "manual" | "plat-digitizer";
  status: "in-progress" | SplitDraftStatus | "confirmed";
  parent_detection_id: string;
  parent_polygon_pct: MapCoordinate[];
  source_image_sha256: string;
  proposal_fingerprint: string | null;
  detection_source_sha256: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  active_points: MapCoordinate[];
  drawing_enabled: boolean;
  children: SplitDraftChild[];
  unassigned_area_percent: number | null;
  proposal_validation: { valid: boolean; errors: string[]; warnings: string[] } | null;
  edit_history: Array<{ action: "accepted" | "rejected" | "confirmed" | "approved"; reviewer: string; timestamp: string; note?: string }>;
  revision?: number;
  approval?: ApprovedPreviewSnapshot;
  rejection_note?: string;
  [key: string]: unknown;
}

export interface ApprovedPreviewSnapshot {
  snapshot_id: string;
  draft_id: string;
  revision_fingerprint: string;
  parent_detection_id: string;
  parent_map_reference: string;
  parent_polygon_pct: MapCoordinate[];
  source_image_sha256: string;
  proposal_fingerprint: string;
  approved_by: string;
  approved_at: string;
  correction_note: string;
  reasoned_waiver: string | null;
  approval_basis?: "owner-authorized-demo-use";
  source_proposal_path?: string;
  geometry_exceptions?: string[];
  geometry_evidence?: {
    parent_coverage_percent: number;
    unassigned_parent_area_percent: number;
    outside_parent_area_percent: number;
    child_boundary_alignment_within_4px_percent: number[];
    existing_detection_overlaps: Array<{ detection_id: string; child_index: number; intersection_px2: number }>;
  };
  children: Array<{ id: string; parent_detection_id: string; polygon_pct: MapCoordinate[]; printed_number: ""; label_status: "pending" }>;
}

export interface SplitDraftStore {
  schema_version: 1;
  benchmark_id: string;
  benchmark_manifest_sha256: string;
  source_image_sha256: string;
  drafts: EditableSplitDraft[];
  approved_snapshots?: ApprovedPreviewSnapshot[];
}

export interface DigitizerProposal {
  artifact_type: "wamule-plat-digitizer-proposal";
  schema_version: number;
  proposal_fingerprint: string;
  source_image: { sha256: string; width: number; height: number };
  detection_source: {
    sha256: string;
    selected_parent_detection_id: string;
    selected_parent_geometry_sha256: string;
    selected_parent_polygon_pct: MapCoordinate[];
    detection_count: number;
  };
  processing?: { geometry_provider?: string; ocr_provider?: string | null; ocr_model_version?: string | null; external_ai_upload_performed?: boolean };
  validation?: { unassigned_parent_area_percent?: number; outside_parent_area_percent?: number; pairwise_child_overlaps?: unknown[]; existing_detection_overlaps?: unknown[] };
  children: Array<{
    draft_id: string;
    parent_detection_id: string;
    polygon_pct: MapCoordinate[];
    proposed_printed_number?: string;
    number_evidence?: { proposed_printed_number?: string; provider?: string; model_version?: string; confidence_note?: string };
  }>;
}

export interface SplitDraftContext {
  benchmark_id: string;
  benchmark_manifest_sha256: string;
  source_image_sha256: string;
}

export function splitDraftStorageKey(benchmarkId: string, manifestSha: string, sourceImageSha: string): string {
  return `wamule-correction-split-drafts-v1:${benchmarkId}:${manifestSha}:${sourceImageSha}`;
}

export function emptySplitDraftStore(context: SplitDraftContext): SplitDraftStore {
  return { schema_version: 1, ...context, drafts: [], approved_snapshots: [] };
}

export function parseSplitDraftStore(raw: string | null, expected: SplitDraftContext): SplitDraftStore {
  if (!raw) return emptySplitDraftStore(expected);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("Saved polygon drafts are not valid JSON. Existing browser data was left untouched."); }
  if (!isRecord(parsed) || parsed.schema_version !== 1 || parsed.benchmark_id !== expected.benchmark_id
    || parsed.benchmark_manifest_sha256 !== expected.benchmark_manifest_sha256
    || parsed.source_image_sha256 !== expected.source_image_sha256 || !Array.isArray(parsed.drafts)) {
    throw new Error("Saved polygon drafts belong to another source revision. Existing browser data was left untouched.");
  }
  if (!parsed.drafts.every(isDraft)) throw new Error("A saved polygon draft is malformed. Existing browser data was left untouched.");
  const snapshots = Array.isArray(parsed.approved_snapshots) ? parsed.approved_snapshots.filter(isApprovedSnapshot) : [];
  return { schema_version: 1, ...expected, drafts: parsed.drafts, approved_snapshots: snapshots };
}

/**
 * Read-modify-write merge. Unrelated drafts and snapshots are retained. A same-ID
 * edit is accepted only when its expected prior revision still matches storage.
 */
export function mergeDraftUpdate(
  store: SplitDraftStore,
  next: EditableSplitDraft,
  expectedRevision: number | null,
): SplitDraftStore {
  const index = store.drafts.findIndex((draft) => draft.draft_id === next.draft_id);
  if (index < 0) {
    if (expectedRevision !== null) throw new Error("This draft was removed from local storage. Nothing was overwritten; reload or export to recover it.");
    return { ...store, drafts: [...store.drafts, { ...next, revision: Math.max(1, next.revision ?? 1) }] };
  }
  const existing = store.drafts[index];
  if (expectedRevision === null) throw new Error("A draft with this stable ID already exists. It was preserved instead of overwritten.");
  const actualRevision = existing.revision ?? 0;
  if (actualRevision !== expectedRevision) throw new Error("This draft changed in another tab. The newer revision was preserved; reload it before continuing.");
  const immutableSourceMatch = existing.parent_detection_id === next.parent_detection_id
    && existing.source_image_sha256 === next.source_image_sha256
    && existing.proposal_fingerprint === next.proposal_fingerprint
    && existing.detection_source_sha256 === next.detection_source_sha256;
  if (!immutableSourceMatch) throw new Error("Draft source identity or fingerprints changed. No existing draft was overwritten.");
  const replacement = { ...next, revision: actualRevision + 1 };
  const drafts = store.drafts.slice();
  drafts[index] = replacement;
  return { ...store, drafts };
}

export async function canonicalSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function draftRevisionFingerprint(draft: EditableSplitDraft): Promise<string> {
  return canonicalSha256({
    draft_id: draft.draft_id,
    parent_detection_id: draft.parent_detection_id,
    parent_polygon_pct: draft.parent_polygon_pct,
    source_image_sha256: draft.source_image_sha256,
    proposal_fingerprint: draft.proposal_fingerprint,
    detection_source_sha256: draft.detection_source_sha256,
    children: draft.children.map((child) => ({
      id: child.id,
      parent_detection_id: child.parent_detection_id,
      polygon_pct: child.polygon_pct,
    })),
  });
}

export async function parseDigitizerProposal(
  raw: unknown,
  context: {
    sourceImage: { sha256: string; width: number; height: number };
    detectionSourceSha256: string;
    parentDetectionId: string;
    parentGeometrySha256: string;
    parentPolygon: MapCoordinate[];
    detectionCount: number;
  },
): Promise<{ proposal: DigitizerProposal; validation: ReturnType<typeof validatePolygonSplit> }> {
  if (!isRecord(raw) || raw.artifact_type !== "wamule-plat-digitizer-proposal" || raw.schema_version !== 1) throw new Error("Choose a version 1 Wamule plat-digitizer proposal JSON file.");
  const proposal = raw as unknown as DigitizerProposal;
  if (proposal.source_image?.sha256 !== context.sourceImage.sha256 || proposal.source_image.width !== context.sourceImage.width || proposal.source_image.height !== context.sourceImage.height) throw new Error("Proposal source-image fingerprint or dimensions do not match this verified map.");
  if (proposal.detection_source?.selected_parent_detection_id !== context.parentDetectionId) throw new Error("Proposal parent detection ID does not match the selected polygon.");
  if (proposal.detection_source.detection_count !== context.detectionCount) throw new Error(`Proposal detection count (${proposal.detection_source.detection_count}) does not match the drawable map count (${context.detectionCount}).`);
  if (proposal.detection_source.sha256 !== context.detectionSourceSha256) throw new Error("Proposal detection-set SHA-256 does not match the currently loaded lots.json bytes.");
  if (proposal.detection_source.selected_parent_geometry_sha256 !== context.parentGeometrySha256 || !samePolygon(proposal.detection_source.selected_parent_polygon_pct, context.parentPolygon)) throw new Error("Proposal parent boundary differs from this detection. Import is blocked to protect existing geometry.");
  if (!proposal.proposal_fingerprint || !Array.isArray(proposal.children) || proposal.children.length < 2) throw new Error("Proposal has no stable fingerprint or fewer than two child contours.");
  const ids = proposal.children.map((child) => child?.draft_id);
  if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) throw new Error("Proposal child IDs are missing or duplicated.");
  if (proposal.children.some((child) => child.parent_detection_id !== context.parentDetectionId)) throw new Error("A proposal child names a different parent detection.");
  if (proposal.processing?.external_ai_upload_performed === true) throw new Error("This proposal records an external AI upload and cannot be opened in this local-only review flow.");
  const validation = validatePolygonSplit(context.parentPolygon, proposal.children.map((child) => child.polygon_pct));
  return { proposal, validation };
}

export function buildApprovedPreviewSnapshot(
  draft: EditableSplitDraft,
  revisionFingerprint: string,
  evidence: { reviewer: string; note: string; waiver: string | null; approvedAt: string; parentMapReference: string },
): ApprovedPreviewSnapshot {
  const snapshotId = `${draft.draft_id}@${revisionFingerprint}`;
  return {
    snapshot_id: snapshotId,
    draft_id: draft.draft_id,
    revision_fingerprint: revisionFingerprint,
    parent_detection_id: draft.parent_detection_id,
    parent_map_reference: evidence.parentMapReference,
    parent_polygon_pct: draft.parent_polygon_pct.map((point) => ({ ...point })),
    source_image_sha256: draft.source_image_sha256,
    proposal_fingerprint: draft.proposal_fingerprint ?? "",
    approved_by: evidence.reviewer,
    approved_at: evidence.approvedAt,
    correction_note: evidence.note,
    reasoned_waiver: evidence.waiver,
    children: draft.children.map((child) => ({
      id: child.id,
      parent_detection_id: child.parent_detection_id,
      polygon_pct: child.polygon_pct.map((point) => ({ ...point })),
      printed_number: "",
      label_status: "pending",
    })),
  };
}

export function persistApprovalSnapshot(
  store: SplitDraftStore,
  draftId: string,
  expectedRevisionFingerprint: string,
  latestDraft: EditableSplitDraft,
  snapshot: ApprovedPreviewSnapshot,
): SplitDraftStore {
  const existing = store.drafts.find((draft) => draft.draft_id === draftId);
  if (!existing) throw new Error("This accepted draft is no longer present in local storage.");
  const existingSnapshot = (store.approved_snapshots ?? []).find((entry) => entry.snapshot_id === snapshot.snapshot_id);
  if (existingSnapshot) return store;
  if (existing.status !== "accepted-draft") throw new Error("Only an accepted editable draft can be approved to the internal preview map.");
  const validation = validatePolygonSplit(existing.parent_polygon_pct, existing.children.map((child) => child.polygon_pct));
  if (!validation.valid) throw new Error(validation.errors[0] ?? "Correct invalid polygon geometry before approval.");
  const knownRevision = existing.revision ?? 0;
  const latestRevision = latestDraft.revision ?? 0;
  if (knownRevision !== latestRevision) throw new Error("This accepted draft changed in another tab. The newer revision was preserved; reload it before approval.");
  if (snapshot.revision_fingerprint !== expectedRevisionFingerprint) throw new Error("The approval snapshot is stale. Reopen the current draft revision.");
  const approvedDraft: EditableSplitDraft = {
    ...existing,
    status: "approved-preview",
    approval: snapshot,
    updated_at: snapshot.approved_at,
    revision: knownRevision + 1,
    edit_history: [...existing.edit_history, { action: "approved", reviewer: snapshot.approved_by, timestamp: snapshot.approved_at, note: snapshot.correction_note }],
  };
  return {
    ...store,
    drafts: store.drafts.map((draft) => draft.draft_id === draftId ? approvedDraft : draft),
    approved_snapshots: [...(store.approved_snapshots ?? []), snapshot],
  };
}

export function samePolygon(first: unknown, second: readonly MapCoordinate[], precision = 6): boolean {
  if (!Array.isArray(first) || first.length !== second.length) return false;
  return first.every((point, index) => isRecord(point)
    && Number(point.x).toFixed(precision) === Number(second[index].x).toFixed(precision)
    && Number(point.y).toFixed(precision) === Number(second[index].y).toFixed(precision));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function isDraft(value: unknown): value is EditableSplitDraft {
  return isRecord(value) && typeof value.draft_id === "string" && typeof value.parent_detection_id === "string"
    && Array.isArray(value.parent_polygon_pct) && Array.isArray(value.children) && Array.isArray(value.edit_history)
    && typeof value.source_image_sha256 === "string" && value.children.every((child) => isRecord(child) && typeof child.id === "string" && Array.isArray(child.polygon_pct));
}

function isApprovedSnapshot(value: unknown): value is ApprovedPreviewSnapshot {
  return isRecord(value) && typeof value.snapshot_id === "string" && typeof value.draft_id === "string"
    && typeof value.revision_fingerprint === "string" && Array.isArray(value.children);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
