import { validatePolygonSplit } from "./mapPolygonSplit";
import {
  applyApprovedPreviewSplits,
  emptyLocalMapPreviewStore,
  type LocalMapPreviewScope,
  type LocalMapPreviewStore,
  type LocalPreviewParcelLike,
} from "./localMapPreview";
import type { ApprovedPreviewSnapshot } from "./mapApprovalFlow";
import type { MapCoordinate } from "./mapGeometry";

export interface HopkinsDemoCorrectionSnapshot extends ApprovedPreviewSnapshot {
  approval_basis: "owner-authorized-demo-use";
  source_proposal_path: string;
  geometry_exceptions: string[];
  geometry_evidence: {
    parent_coverage_percent: number;
    unassigned_parent_area_percent: number;
    outside_parent_area_percent: number;
    child_boundary_alignment_within_4px_percent: number[];
    existing_detection_overlaps: Array<{ detection_id: string; child_index: number; intersection_px2: number }>;
  };
  geometry_history?: Array<{
    action: "retired-child-fragment" | "child-geometry-refined" | "snapshot-revised";
    child_id?: string;
    before_polygon_pct?: MapCoordinate[];
    after_polygon_pct?: MapCoordinate[];
    source_detection_id?: string;
    source_proposal_path?: string;
    source_proposal_fingerprint?: string;
    reason: string;
    approved_by: string;
    approved_at: string;
  }>;
}

export interface HopkinsSupersededDetection {
  detection_id: string;
  source_polygon_pct: MapCoordinate[];
  replaced_by_parent_detection_id: string;
  replacement_child_id: string;
  source_image_sha256: string;
  reason: string;
  approved_by: string;
  approved_at: string;
}

export interface HopkinsDemoCorrectionManifest {
  manifest_kind: "wamule-hopkins-demo-correction-manifest";
  schema_version: 1;
  scope: LocalMapPreviewScope;
  revision: number;
  created_at: string;
  source_image: { sha256: string; width: number; height: number };
  detection_source_sha256: string;
  owner_authorization: {
    basis: "explicit-owner-instruction";
    approved_at: string;
    note: string;
  };
  inaccessible_manual_session: {
    status: "pending-not-imported";
    detection_id: null;
    note: string;
  };
  approved_splits: HopkinsDemoCorrectionSnapshot[];
  superseded_detections?: HopkinsSupersededDetection[];
}

export interface HopkinsManifestContext {
  scope: LocalMapPreviewScope;
  sourceImageSha256: string;
  sourceImageWidth: number;
  sourceImageHeight: number;
  detectionSourceSha256: string;
  sourceParcels: readonly LocalPreviewParcelLike[];
}

export function parseHopkinsDemoCorrectionManifest(
  raw: unknown,
  context: HopkinsManifestContext,
): HopkinsDemoCorrectionManifest {
  if (!isRecord(raw) || raw.manifest_kind !== "wamule-hopkins-demo-correction-manifest" || raw.schema_version !== 1) {
    throw new Error("The Hopkins demo correction manifest has an unsupported format; source detections were left unchanged.");
  }
  if (!sameScope(raw.scope, context.scope)) throw new Error("The Hopkins correction manifest belongs to another project or phase; source detections were left unchanged.");
  if (!isRecord(raw.source_image) || raw.source_image.sha256 !== context.sourceImageSha256
    || raw.source_image.width !== context.sourceImageWidth || raw.source_image.height !== context.sourceImageHeight) {
    throw new Error("The Hopkins correction manifest source-image fingerprint does not match this map; source detections were left unchanged.");
  }
  if (raw.detection_source_sha256 !== context.detectionSourceSha256) {
    throw new Error("The Hopkins correction manifest detection fingerprint does not match this lots.json; source detections were left unchanged.");
  }
  if (!isRecord(raw.owner_authorization) || raw.owner_authorization.basis !== "explicit-owner-instruction"
    || typeof raw.owner_authorization.note !== "string" || !raw.owner_authorization.note.trim()) {
    throw new Error("The Hopkins correction manifest has no recorded owner authorization; source detections were left unchanged.");
  }
  if (!Array.isArray(raw.approved_splits) || raw.approved_splits.length === 0) {
    throw new Error("The Hopkins correction manifest contains no approved demo geometry.");
  }

  const parents = new Set<string>();
  const childIds = new Set<string>();
  const snapshotsByParent = new Map<string, HopkinsDemoCorrectionSnapshot>();
  for (const rawSnapshot of raw.approved_splits) {
    if (!isSnapshot(rawSnapshot)) throw new Error("A Hopkins correction entry is malformed; no manifest corrections were applied.");
    const snapshot = rawSnapshot;
    if (snapshot.approval_basis !== "owner-authorized-demo-use" || !snapshot.reasoned_waiver?.trim()
      || !snapshot.correction_note?.trim() || !snapshot.approved_by?.trim()) {
      throw new Error(`The Hopkins correction for ${snapshot.parent_detection_id} lacks its required owner-demo reasoned waiver.`);
    }
    if (parents.has(snapshot.parent_detection_id)) throw new Error(`The manifest has more than one active split for ${snapshot.parent_detection_id}.`);
    parents.add(snapshot.parent_detection_id);
    snapshotsByParent.set(snapshot.parent_detection_id, snapshot);
    if (snapshot.source_image_sha256 !== context.sourceImageSha256) throw new Error(`The correction for ${snapshot.parent_detection_id} has a different source-image fingerprint.`);
    const parentMatches = context.sourceParcels.filter((parcel) =>
      (parcel.correction_key === snapshot.parent_detection_id
        || parcel.lot_number === snapshot.parent_detection_id
        || parcel.lot_number === snapshot.parent_map_reference)
      && samePolygon(parcel.map_polygon, snapshot.parent_polygon_pct));
    if (parentMatches.length !== 1) throw new Error(`The original ${snapshot.parent_detection_id} detection is missing or ambiguous in the loaded source map.`);
    if (snapshot.children.length < 2 || snapshot.children.some((child) => child.parent_detection_id !== snapshot.parent_detection_id
      || child.label_status !== "pending" || child.printed_number !== "" || child.polygon_pct.length < 3)) {
      throw new Error(`The ${snapshot.parent_detection_id} correction has missing child geometry or a non-pending identity; it was not applied.`);
    }
    for (const child of snapshot.children) {
      if (childIds.has(child.id)) throw new Error(`The manifest repeats child draft ID ${child.id}.`);
      childIds.add(child.id);
    }
    const validation = validatePolygonSplit(snapshot.parent_polygon_pct, snapshot.children.map((child) => child.polygon_pct));
    if (!validation.valid) throw new Error(`The ${snapshot.parent_detection_id} correction contains invalid geometry: ${validation.errors.join(" ")}`);
    if ((validation.warnings.length || snapshot.geometry_exceptions.length) && !snapshot.reasoned_waiver.trim()) {
      throw new Error(`The ${snapshot.parent_detection_id} correction has geometry exceptions without a reasoned waiver.`);
    }
    if (!Array.isArray(snapshot.geometry_exceptions) || !isRecord(snapshot.geometry_evidence)) {
      throw new Error(`The ${snapshot.parent_detection_id} correction is missing its geometry-exception evidence.`);
    }
  }
  const supersededIds = new Set<string>();
  if (raw.superseded_detections !== undefined && !Array.isArray(raw.superseded_detections)) {
    throw new Error("The Hopkins manifest's superseded-detection list is malformed; no corrections were applied.");
  }
  const supersededDetections = Array.isArray(raw.superseded_detections) ? raw.superseded_detections : [];
  for (const entry of supersededDetections) {
    if (!isRecord(entry) || typeof entry.detection_id !== "string"
      || typeof entry.replaced_by_parent_detection_id !== "string"
      || typeof entry.replacement_child_id !== "string"
      || typeof entry.source_image_sha256 !== "string" || entry.source_image_sha256 !== context.sourceImageSha256
      || typeof entry.reason !== "string" || !entry.reason.trim()
      || typeof entry.approved_by !== "string" || !entry.approved_by.trim()
      || typeof entry.approved_at !== "string" || !Array.isArray(entry.source_polygon_pct)) {
      throw new Error("A superseded Hopkins detection is missing its source-bound approval evidence; no manifest corrections were applied.");
    }
    if (supersededIds.has(entry.detection_id)) throw new Error(`The manifest repeats superseded detection ${entry.detection_id}.`);
    supersededIds.add(entry.detection_id);
    const snapshot = snapshotsByParent.get(entry.replaced_by_parent_detection_id);
    if (!snapshot || !snapshot.children.some((child) => child.id === entry.replacement_child_id)) {
      throw new Error(`Superseded detection ${entry.detection_id} has no active replacement child in ${entry.replaced_by_parent_detection_id}.`);
    }
    const sourceMatches = context.sourceParcels.filter((parcel) =>
      (parcel.correction_key === entry.detection_id || parcel.lot_number === entry.detection_id)
      && samePolygon(parcel.map_polygon, entry.source_polygon_pct as MapCoordinate[]));
    if (sourceMatches.length !== 1) throw new Error(`Superseded detection ${entry.detection_id} is missing or ambiguous in the loaded source map.`);
  }
  return raw as unknown as HopkinsDemoCorrectionManifest;
}

/** Apply current browser-local corrections first; a same-parent local correction always wins. */
export function applyHopkinsDemoCorrectionManifest<T extends LocalPreviewParcelLike>(
  parcels: readonly T[],
  manifest: HopkinsDemoCorrectionManifest,
  scope: LocalMapPreviewScope,
  localStore: LocalMapPreviewStore | null,
): { parcels: T[]; warnings: string[] } {
  const manualResult = localStore
    ? applyApprovedPreviewSplits(parcels, localStore)
    : { parcels: [...parcels], warnings: [] as string[] };
  const locallyCorrectedParents = new Set((localStore?.approved_splits ?? []).map((split) => split.parent_detection_id));
  const withheld = manifest.approved_splits.filter((split) => locallyCorrectedParents.has(split.parent_detection_id));
  const remaining = manifest.approved_splits.filter((split) => !locallyCorrectedParents.has(split.parent_detection_id));
  const activeParentIds = new Set(remaining.map((split) => split.parent_detection_id));
  const activeSupersessions = (manifest.superseded_detections ?? [])
    .filter((entry) => activeParentIds.has(entry.replaced_by_parent_detection_id));
  const sourceWithoutSuperseded = manualResult.parcels.filter((parcel) =>
    !activeSupersessions.some((entry) => (parcel.correction_key === entry.detection_id || parcel.lot_number === entry.detection_id)
      && samePolygon(parcel.map_polygon, entry.source_polygon_pct)));
  const demoStore: LocalMapPreviewStore = {
    ...emptyLocalMapPreviewStore(scope),
    revision: remaining.length,
    updated_at: manifest.created_at,
    approved_splits: remaining,
  };
  const demoResult = applyApprovedPreviewSplits(sourceWithoutSuperseded, demoStore);
  const warnings = [
    ...manualResult.warnings,
    ...withheld.map((split) => `The file-based demo proposal for ${split.parent_detection_id} was withheld because an existing local correction takes precedence.`),
    ...demoResult.warnings,
  ];
  return { parcels: demoResult.parcels as T[], warnings };
}

function isSnapshot(value: unknown): value is HopkinsDemoCorrectionSnapshot {
  return isRecord(value)
    && typeof value.snapshot_id === "string"
    && typeof value.draft_id === "string"
    && typeof value.parent_detection_id === "string"
    && typeof value.parent_map_reference === "string"
    && typeof value.source_image_sha256 === "string"
    && typeof value.proposal_fingerprint === "string"
    && Array.isArray(value.parent_polygon_pct)
    && Array.isArray(value.children)
    && value.children.every((child) => isRecord(child) && typeof child.id === "string"
      && child.label_status === "pending" && child.printed_number === "" && Array.isArray(child.polygon_pct))
    && typeof value.reasoned_waiver === "string"
    && Array.isArray(value.geometry_exceptions);
}

function samePolygon(first: unknown, second: readonly MapCoordinate[]): boolean {
  if (!Array.isArray(first) || first.length !== second.length) return false;
  return first.every((point, index) => isRecord(point)
    && Number(point.x).toFixed(6) === Number(second[index].x).toFixed(6)
    && Number(point.y).toFixed(6) === Number(second[index].y).toFixed(6));
}

function sameScope(value: unknown, expected: LocalMapPreviewScope): boolean {
  return isRecord(value)
    && value.tenantSlug === expected.tenantSlug
    && value.projectSlug === expected.projectSlug
    && value.phaseSlug === expected.phaseSlug;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
