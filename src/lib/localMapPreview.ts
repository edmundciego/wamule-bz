import type { MapCoordinate } from "./mapGeometry";
import type { ApprovedPreviewSnapshot } from "./mapApprovalFlow";

export interface LocalMapPreviewScope {
  tenantSlug: string;
  projectSlug: string;
  phaseSlug: string;
}

export interface LocalMapPreviewStore {
  schema_version: 1;
  scope: LocalMapPreviewScope;
  revision: number;
  updated_at: string | null;
  approved_splits: ApprovedPreviewSnapshot[];
}

export interface LocalPreviewParcelMarker {
  snapshotId: string;
  childId: string;
  parentDetectionId: string;
  childNumber: number;
  labelStatus: "pending";
  approvalBasis?: "owner-authorized-demo-use";
  geometryExceptions?: string[];
  reasonedWaiver?: string | null;
  sourceProposalFingerprint?: string;
}

export interface LocalPreviewParcelLike {
  local_key: number;
  public_ref: string | null;
  lot_number: string;
  status: string;
  price: number;
  dimensions: string | null;
  area_sqm: number | null;
  map_polygon: MapCoordinate[] | null;
  tier_key: string | null;
  tier_label: string | null;
  tier_color_hex: string | null;
  is_corner: boolean;
  effective_price_cents: number;
  correction_key?: string;
  local_preview?: LocalPreviewParcelMarker;
}

export const LOCAL_MAP_PREVIEW_UPDATED = "wamule:local-map-preview-updated";
const STORAGE_PREFIX = "wamule-local-map-preview-v1";
const CHANNEL_NAME = "wamule-local-map-preview-v1";

export function localMapPreviewStorageKey(scope: LocalMapPreviewScope): string {
  return `${STORAGE_PREFIX}:${scopePart(scope.tenantSlug)}:${scopePart(scope.projectSlug)}:${scopePart(scope.phaseSlug)}`;
}

export function emptyLocalMapPreviewStore(scope: LocalMapPreviewScope): LocalMapPreviewStore {
  return { schema_version: 1, scope: normalizedScope(scope), revision: 0, updated_at: null, approved_splits: [] };
}

export function parseLocalMapPreviewStore(raw: string | null, expected: LocalMapPreviewScope): LocalMapPreviewStore {
  const scope = normalizedScope(expected);
  if (!raw) return emptyLocalMapPreviewStore(scope);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("Local preview data is not valid JSON; it was left untouched."); }
  if (!isRecord(parsed) || parsed.schema_version !== 1 || !sameScope(parsed.scope, scope)
    || !Number.isInteger(parsed.revision) || !Array.isArray(parsed.approved_splits)) {
    throw new Error("Local preview data belongs to a different project or phase, or has an unsupported version; it was left untouched.");
  }
  if (!parsed.approved_splits.every(isApprovedSplit)) {
    throw new Error("Local preview contains a malformed approved snapshot; no preview geometry was applied.");
  }
  return parsed as unknown as LocalMapPreviewStore;
}

export function addApprovedPreviewSnapshot(
  store: LocalMapPreviewStore,
  snapshot: ApprovedPreviewSnapshot,
): LocalMapPreviewStore {
  const existingSnapshot = store.approved_splits.find((entry) => entry.snapshot_id === snapshot.snapshot_id);
  if (existingSnapshot) return store;
  if (store.approved_splits.some((entry) => entry.parent_detection_id === snapshot.parent_detection_id)) {
    throw new Error("This project/phase already has an approved local split for the parent detection. Existing preview geometry was preserved.");
  }
  const childIds = new Set(store.approved_splits.flatMap((entry) => entry.children.map((child) => child.id)));
  if (snapshot.children.some((child) => childIds.has(child.id))) {
    throw new Error("A child stable ID already exists in this project/phase preview. Existing preview data was preserved.");
  }
  return {
    ...store,
    revision: store.revision + 1,
    updated_at: snapshot.approved_at,
    approved_splits: [...store.approved_splits, snapshot],
  };
}

export function applyApprovedPreviewSplits<T extends LocalPreviewParcelLike>(
  parcels: readonly T[],
  store: LocalMapPreviewStore,
): { parcels: Array<T>; warnings: string[] } {
  let current = [...parcels];
  const warnings: string[] = [];
  const usedKeys = new Set(current.map((parcel) => parcel.local_key));

  for (const split of store.approved_splits) {
    // Prefer the stable correction/detection reference. Published map payloads
    // may not carry that field, so fall back only to a lot reference AND the
    // exact source geometry; lot numbers alone are not guaranteed unique.
    const correctionIndex = current.findIndex((parcel) => parcel.correction_key === split.parent_detection_id);
    const parentIndex = correctionIndex >= 0
      ? correctionIndex
      : current.findIndex((parcel) => (parcel.lot_number === split.parent_map_reference || parcel.lot_number === split.parent_detection_id)
        && samePolygon(parcel.map_polygon, split.parent_polygon_pct));
    if (parentIndex < 0) {
      warnings.push(`Approved preview for ${split.parent_detection_id} does not match a lot in this map revision; it was not applied.`);
      continue;
    }
    const parent = current[parentIndex];
    if (!samePolygon(parent.map_polygon, split.parent_polygon_pct) || split.children.length < 2
      || split.children.some((child) => child.label_status !== "pending" || child.printed_number !== "" || child.polygon_pct.length < 3)) {
      warnings.push(`Approved preview for ${split.parent_detection_id} has a parent/source mismatch or unsafe child data; it was not applied.`);
      continue;
    }

    const children = split.children.map((child, index) => {
      const localKey = stableLocalKey(child.id, usedKeys);
      usedKeys.add(localKey);
      return {
        ...parent,
        local_key: localKey,
        public_ref: null,
        lot_number: "",
        status: "Review pending",
        price: 0,
        dimensions: null,
        area_sqm: null,
        map_polygon: child.polygon_pct.map((point) => ({ ...point })),
        tier_key: null,
        tier_label: null,
        tier_color_hex: null,
        is_corner: false,
        effective_price_cents: 0,
        correction_key: child.id,
        local_preview: {
          snapshotId: split.snapshot_id,
          childId: child.id,
          parentDetectionId: split.parent_detection_id,
          childNumber: index + 1,
          labelStatus: "pending" as const,
          ...(split.approval_basis ? { approvalBasis: split.approval_basis } : {}),
          ...(split.geometry_exceptions ? { geometryExceptions: split.geometry_exceptions } : {}),
          ...(split.reasoned_waiver ? { reasonedWaiver: split.reasoned_waiver } : {}),
          ...(split.proposal_fingerprint ? { sourceProposalFingerprint: split.proposal_fingerprint } : {}),
        },
      };
    });
    current = [...current.slice(0, parentIndex), ...children, ...current.slice(parentIndex + 1)];
  }
  return { parcels: current, warnings };
}

export function notifyLocalMapPreviewUpdated(key: string, revision: number): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(LOCAL_MAP_PREVIEW_UPDATED, { detail: { key, revision } }));
  }
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ key, revision });
    channel.close();
  }
}

export const localMapPreviewChannelName = CHANNEL_NAME;

function samePolygon(first: unknown, second: readonly MapCoordinate[]): boolean {
  if (!Array.isArray(first) || first.length !== second.length) return false;
  return first.every((point, index) => isRecord(point)
    && Number(point.x).toFixed(6) === Number(second[index].x).toFixed(6)
    && Number(point.y).toFixed(6) === Number(second[index].y).toFixed(6));
}

function stableLocalKey(id: string, used: ReadonlySet<number>): number {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  let key = 1_000_000_000 + (hash >>> 0);
  while (used.has(key)) key += 1;
  return key;
}

function scopePart(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(normalized)) throw new Error("Local preview scope values must be lowercase project slugs.");
  return normalized;
}

function normalizedScope(scope: LocalMapPreviewScope): LocalMapPreviewScope {
  return {
    tenantSlug: scopePart(scope.tenantSlug),
    projectSlug: scopePart(scope.projectSlug),
    phaseSlug: scopePart(scope.phaseSlug),
  };
}

function sameScope(value: unknown, expected: LocalMapPreviewScope): boolean {
  return isRecord(value)
    && value.tenantSlug === expected.tenantSlug
    && value.projectSlug === expected.projectSlug
    && value.phaseSlug === expected.phaseSlug;
}

function isApprovedSplit(value: unknown): value is ApprovedPreviewSnapshot {
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
      && child.label_status === "pending" && child.printed_number === "" && Array.isArray(child.polygon_pct));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
