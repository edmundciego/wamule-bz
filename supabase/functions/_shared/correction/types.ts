/**
 * Slice 1.5 correction-workspace domain types.
 *
 * Core invariant: lots are keyed by stable internal `id`. `lot_number` is a
 * mutable display field — publish matching joins draft lots to parcels on
 * `id`, so renumbers never break linkage. Every mutation is a logged edit
 * (actor, time, before, after); confirmed/locked values survive re-runs.
 */

export type LotStatus = "suggested" | "confirmed" | "locked";

export interface MapPoint {
  x: number;
  y: number;
}

export type ConfirmMethod = "manual" | "bulk-sample";

/** Two-signal confirmation marker: detection signal + human signal. */
export interface ConfirmedBy {
  actor: string;
  time: string;
  method: ConfirmMethod;
  /** Always exactly ["detection", "human"] when confirmed. */
  signals: ["detection", "human"];
  /** Bulk-accept only: reviewed sample lot ids backing this confirmation. */
  sampleOf?: string[];
}

export interface LotSlot {
  /** Stable internal id. Never changes; publish joins on this. */
  id: string;
  /** Mutable printed number. Renumber edits this field only. */
  lot_number: string;
  status: LotStatus;
  number: string | null;
  /**
   * Slice 1.7: the mutable working-copy area in sqm, seeded from the
   * OCR-measured area at ingest and editable by reviewers. It is NOT a
   * measurement — the polygon geometry is the measurement. The immutable
   * ingest snapshot is ocr_area; signal 3 compares the printed figure
   * against the polygon at the independently measured scale.
   */
  area: number | null;
  tier_key: string | null;
  suspect: string[];
  polygon: MapPoint[];
  hasUnit: boolean;
  confirmed_by: ConfirmedBy | null;
  /** Immutable OCR snapshot at ingest (never edited): printed number as read. */
  ocr_number?: string | null;
  /** Immutable OCR snapshot at ingest (never edited): measured area in sqm. */
  ocr_area?: number | null;
}

export interface TierDef {
  label: string;
  color: string;
  price: number;
  sellable: boolean;
}

export interface EditEntry {
  seq: number;
  batchId: string;
  actor: string;
  time: string;
  /** Lot id, or "—" for catalogue-level entries. */
  lot: string;
  field: string;
  before: unknown;
  after: unknown;
}

export type WaiverScopeType = "lot" | "gate" | "duplicate" | "gap" | "overlap";

export interface Waiver {
  id: string;
  scope: WaiverScopeType;
  /** Lot id, gate id, duplicate value, gap number, or overlap pair "a<->b". */
  target: string;
  /** Required: empty reasons are rejected. */
  reason: string;
  actor: string;
  time: string;
}

export type OnboardingStage =
  | "intake"
  | "classify"
  | "legend"
  | "read"
  | "correct"
  | "validate"
  | "preview"
  | "sign-off"
  | "live"
  | "operate";

export interface GateFailure {
  /** Machine key, e.g. "uncertain-lots", "duplicates", "overlap". */
  code: string;
  detail: string;
  /** Waiver scope that can excuse this failure, if any. */
  waivableAs?: { scope: WaiverScopeType; target: string };
}

export interface GateResult {
  stage: OnboardingStage;
  pass: boolean;
  failures: GateFailure[];
  /** Failures covered by valid waivers. */
  waived: GateFailure[];
  /** Failures with no waiver — these block. */
  blocking: GateFailure[];
}

export interface CorrectionState {
  tenant: string;
  project: string;
  /** Single local actor in slice 1/1.5 tooling; server calls bind the session actor. */
  actor: string;
  lots: Record<string, LotSlot>;
  tiers: Record<string, TierDef>;
  log: EditEntry[];
  /** Applied prefix length of log; undo moves it back. */
  pointer: number;
  waivers: Waiver[];
  stage: OnboardingStage;
  publishedAt: string | null;
}

export interface DraftDoc {
  tenant: string;
  project: string;
  rev: number;
  state: CorrectionState;
  updated_by: string;
  updated_at: string;
}

export interface DetectionUnit {
  number: string | null;
  area_sqm: number | null;
  suspect?: string[];
}

export interface PublishConflict {
  draftId: string;
  existingId: string;
  kind: "overlap";
}

export interface PublishPlan {
  matched: Array<{ id: string; changes: string[] }>;
  created: string[];
  conflicts: PublishConflict[];
  /** True when conflicts is empty. */
  ok: boolean;
}
