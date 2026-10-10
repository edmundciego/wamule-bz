/**
 * Slice 1.5 workspace model: id-keyed lots, logged edits with batch undo,
 * detection merge that preserves confirmed/locked, renumber with integrity,
 * duplicates/gaps, legend, uncertain queue, confident-fill preview.
 *
 * Ported from correction-workspace/correct.js (which stays the local
 * Hopkins tool); this module is the app-grade version with stable ids,
 * confirmed_by markers, and waiver-aware helpers.
 */
import type {
  ConfirmMethod,
  CorrectionState,
  DetectionUnit,
  EditEntry,
  LotSlot,
  LotStatus,
  MapPoint,
  TierDef,
  Waiver,
} from "./types.ts";

export const LOT_STATUS: Record<string, LotStatus> = {
  SUGGESTED: "suggested",
  CONFIRMED: "confirmed",
  LOCKED: "locked",
};

let batchSeq = 0;
let waiverSeq = 0;

export interface LotInput {
  id: string;
  lot_number: string;
  polygon_pct: MapPoint[];
  tier_key: string | null;
}

export function createInitialState(args: {
  lots: LotInput[];
  tiers: Record<string, TierDef>;
  units: Record<string, DetectionUnit>;
  actor?: string;
  tenant?: string;
  project?: string;
}): CorrectionState {
  const { lots, tiers, units, actor = "operator", tenant = "local", project = "default" } = args;
  const state: CorrectionState = {
    tenant,
    project,
    actor,
    lots: {},
    tiers: JSON.parse(JSON.stringify(tiers)) as Record<string, TierDef>,
    log: [],
    pointer: 0,
    waivers: [],
    stage: "correct",
    publishedAt: null,
  };
  for (const lot of lots) {
    const u = units[lot.id] ?? units[lot.lot_number];
    state.lots[lot.id] = {
      id: lot.id,
      lot_number: lot.lot_number,
      status: "suggested",
      number: u?.number ?? null,
      area: u?.area_sqm ?? null,
      tier_key: lot.tier_key,
      suspect: u?.suspect ? [...u.suspect] : [],
      polygon: lot.polygon_pct,
      hasUnit: Boolean(u),
      confirmed_by: null,
      // Immutable OCR snapshot: never mutated by edits (edits write number/
      // area only). Wrong-sample detection compares current values back to
      // these originals.
      ocr_number: u?.number ?? null,
      ocr_area: u?.area_sqm ?? null,
    };
  }
  return state;
}

function pushEntries(state: CorrectionState, entries: Array<Omit<EditEntry, "seq" | "batchId" | "time"> & { time?: string }>): string {
  state.log.length = state.pointer;
  batchSeq += 1;
  const batchId = `b${batchSeq}`;
  const now = new Date().toISOString();
  for (const e of entries) {
    state.log.push({ seq: state.log.length + 1, batchId, time: e.time ?? now, ...e });
  }
  state.pointer = state.log.length;
  return batchId;
}

function requireActor(actor: string): void {
  if (!actor || !actor.trim()) throw new Error("actor is required (server-session actor; anonymous writes rejected)");
}

/** Record one field edit. */
export function applyEdit(
  state: CorrectionState,
  edit: { actor: string; lot: string; field: string; before: unknown; after: unknown },
): EditEntry {
  requireActor(edit.actor);
  if (edit.lot !== "—" && !state.lots[edit.lot]) throw new Error(`unknown lot ${edit.lot}`);
  pushEntries(state, [edit]);
  if (edit.lot !== "—") {
    (state.lots[edit.lot] as unknown as Record<string, unknown>)[edit.field] = edit.after;
  }
  return state.log[state.log.length - 1];
}

/** Record a same-action multi-lot batch (one undo unit). */
export function applyBatch(
  state: CorrectionState,
  batch: { actor: string; edits: Array<{ lot: string; field: string; before: unknown; after: unknown }> },
): string {
  requireActor(batch.actor);
  const batchId = pushEntries(state, batch.edits.map((e) => ({ actor: batch.actor, ...e })));
  for (const e of batch.edits) {
    if (e.lot === "—") continue;
    if (!state.lots[e.lot]) throw new Error(`unknown lot ${e.lot}`);
    (state.lots[e.lot] as unknown as Record<string, unknown>)[e.field] = e.after;
  }
  return batchId;
}

/** Undo the most recent batch. Returns reverted entries (newest first). */
export function undoLast(state: CorrectionState): EditEntry[] {
  if (state.pointer === 0) return [];
  const batchId = state.log[state.pointer - 1].batchId;
  const reverted: EditEntry[] = [];
  while (state.pointer > 0 && state.log[state.pointer - 1].batchId === batchId) {
    const entry = state.log[state.pointer - 1];
    if (entry.lot !== "—" && state.lots[entry.lot]) {
      (state.lots[entry.lot] as unknown as Record<string, unknown>)[entry.field] = entry.before;
    }
    reverted.push(entry);
    state.pointer -= 1;
  }
  return reverted;
}

/**
 * Re-run merge: detection output never overwrites confirmed/locked lots.
 * Returns applied ids + skip list with reasons.
 */
export function applyDetection(
  state: CorrectionState,
  args: { actor: string; detected: Record<string, DetectionUnit> },
): { applied: string[]; skipped: Array<{ lot: string; status: string; reason: string }> } {
  requireActor(args.actor);
  const applied: string[] = [];
  const skipped: Array<{ lot: string; status: string; reason: string }> = [];
  const edits: Array<{ lot: string; field: string; before: unknown; after: unknown }> = [];
  for (const [id, unit] of Object.entries(args.detected)) {
    const slot = state.lots[id];
    if (!slot) {
      skipped.push({ lot: id, status: "unknown-lot", reason: "not in workspace" });
      continue;
    }
    if (slot.status === "confirmed" || slot.status === "locked") {
      skipped.push({ lot: id, status: slot.status, reason: "human value preserved" });
      continue;
    }
    if (unit.number != null && slot.number !== unit.number) {
      edits.push({ lot: id, field: "number", before: slot.number, after: unit.number });
    }
    if (unit.area_sqm != null && slot.area !== unit.area_sqm) {
      edits.push({ lot: id, field: "area", before: slot.area, after: unit.area_sqm });
    }
    applied.push(id);
  }
  if (edits.length) applyBatch(state, { actor: args.actor, edits });
  return { applied, skipped };
}

/**
 * Renumber: changes the display lot_number only — the stable id never moves,
 * so publish linkage is unaffected. Duplicate targets are rejected.
 * Logged like any edit (actor, time, before, after).
 */
export function renumberLot(
  state: CorrectionState,
  args: { actor: string; id: string; newNumber: string },
): EditEntry {
  requireActor(args.actor);
  const slot = state.lots[args.id];
  if (!slot) throw new Error(`unknown lot ${args.id}`);
  const target = args.newNumber.trim();
  if (!target) throw new Error("new lot_number must be non-empty");
  for (const [otherId, other] of Object.entries(state.lots)) {
    if (otherId !== args.id && other.lot_number === target) {
      throw new Error(`lot_number ${target} already used by ${otherId}`);
    }
  }
  return applyEdit(state, { actor: args.actor, lot: args.id, field: "lot_number", before: slot.lot_number, after: target });
}

/** Detection signal for the two-signal rule: unit present, non-suspect. */
export function hasDetectionSignal(slot: LotSlot): boolean {
  return slot.hasUnit && slot.suspect.length === 0;
}

/* ---------------------------------------------------------------------------
 * Slice 1.7 independent signals for bulk accept.
 *
 * What slot.area IS: the mutable working-copy area in sqm, seeded from the
 * OCR-measured area at ingest and editable by reviewers (Numbers tab). The
 * immutable ingest snapshot is slot.ocr_area. (Same split as numbers:
 * slot.number is the working copy, slot.ocr_number the immutable read.)
 *
 * 1. OCR number signal — the working number still equals the OCR-extracted
 *    printed number from ingest (immutable ocr_number).
 *    Computed: slot.ocr_number != null && slot.number === slot.ocr_number
 *    && slot has a unit. A human typo or a misread OCR token breaks it.
 *    (Suspect OCR lots never reach here: hasDetectionSignal already fails.)
 *    OCR-SOURCE DEPENDENCE: fully dependent (compares against OCR output).
 *
 * 2. Street-run contiguity + spatial adjacency — the lot's number sits
 *    inside a consecutive street run within its tier group (same tier_key)
 *    AND the numerical neighbour is also the physical neighbour: the
 *    centroid of the lot holding n-1 or n+1 lies within ~1.5 lot widths.
 *    Computed: parse slot.number as integer n; find same-tier lots with
 *    number n-1/n+1; pass when at least one exists, n is not duplicated,
 *    AND centroid distance <= 1.5 * max(width(slot), width(neighbour)),
 *    where width is the polygon bbox x-extent in plan-% units. A typo that
 *    keeps sequence but lands across the map fails the distance half.
 *    OCR-SOURCE DEPENDENCE: half independent — the numbers compared are
 *    OCR/human-derived, but the adjacency geometry comes from the raster
 *    polygons, never from OCR text.
 *
 * 3. Printed-area-vs-polygon-area at the measured scale — the plan's
 *    printed area figure against the polygon measured in sqm via the
 *    independently measured map scale (road-width reference, never OCR).
 *    Computed: polygonAreaSqm = shoelace(plan-%) * scale.sqmPerPct2;
 *    |polygonAreaSqm - printed| / printed <= tolerance (default 15%).
 *    DISABLED until a scale is provided: with scale == null the verdict is
 *    "unavailable" (shown as such, never gates). Once provided, "fail"
 *    blocks like any other signal.
 *    OCR-SOURCE DEPENDENCE: fully independent of the OCR source — geometry
 *    from raster polygons, scale from the physical road reference, printed
 *    figure from the human-verified label (not the OCR read).
 * ------------------------------------------------------------------------- */

/** 1. OCR number: working number still equals the immutable OCR read. */
export function ocrNumberSignal(slot: LotSlot): boolean {
  const ocr = slot.ocr_number ?? null;
  if (!slot.hasUnit || ocr == null || slot.number == null) return false;
  return slot.number === ocr;
}

/** Spatial block id for stratification (centroid quantized to 25-unit cells). */
export function lotBlockId(slot: LotSlot): string {
  if (!slot.polygon.length) return "no-geo";
  const xs = slot.polygon.map((p) => p.x);
  const ys = slot.polygon.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return `b${Math.floor(cx / 25)}:${Math.floor(cy / 25)}`;
}

/** Stratum key: tier + spatial block (both must be represented in samples). */
export function lotStratum(slot: LotSlot): string {
  return `${slot.tier_key ?? "unassigned"}::${lotBlockId(slot)}`;
}

/** Plan-% centroid of a lot polygon (bbox midpoint). */
export function lotCentroidPct(polygon: MapPoint[]): [number, number] {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

/** Plan-% bbox width of a lot polygon (the "lot width" unit). */
export function lotWidthPct(polygon: MapPoint[]): number {
  if (polygon.length < 3) return 0;
  const xs = polygon.map((p) => p.x);
  return Math.max(...xs) - Math.min(...xs);
}

/**
 * 2. Street-run contiguity + spatial adjacency: n has a ±1 neighbour in the
 * same tier group whose centroid is within ~1.5 lot widths.
 */
export function streetRunSignal(slot: LotSlot, state: CorrectionState): boolean {
  if (slot.number == null || slot.number === "") return false;
  const n = Number(slot.number);
  if (!Number.isInteger(n)) return false;
  const dups = findDuplicates(state);
  if (dups[String(slot.number)]?.length > 1) return false;
  if (slot.polygon.length < 3) return false;
  const tier = slot.tier_key;
  const [cx, cy] = lotCentroidPct(slot.polygon);
  const w0 = lotWidthPct(slot.polygon);
  for (const other of Object.values(state.lots)) {
    if (other.id === slot.id || other.tier_key !== tier) continue;
    if (other.number == null || other.number === "") continue;
    const m = Number(other.number);
    if (!Number.isInteger(m) || (m !== n - 1 && m !== n + 1)) continue;
    if (other.polygon.length < 3) continue;
    const [ox, oy] = lotCentroidPct(other.polygon);
    const limit = 1.5 * Math.max(w0, lotWidthPct(other.polygon));
    if (Math.hypot(ox - cx, oy - cy) <= limit) return true;
  }
  return false;
}

/**
 * Independently measured map scale for signal 3.
 * sqmPerPct2 converts shoelace plan-%² into sqm; it comes from the S3
 * road-width reference (stated ft / measured px), never from OCR text.
 */
export interface ScaleRef {
  sqmPerPct2: number;
  source: string;
}

/** Shoelace area of a polygon in plan-%². */
export function polygonAreaPct2(polygon: MapPoint[]): number {
  let a = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
}

export type AreaScaleVerdict = "pass" | "fail" | "unavailable";

/**
 * 3. Printed area vs polygon area at the measured scale.
 * Returns "unavailable" (shown as such, never gates) until a scale AND a
 * printed figure exist; otherwise "pass"/"fail" at the tolerance.
 */
export function areaScaleSignal(
  slot: LotSlot,
  scale: ScaleRef | null,
  tolerance = 0.15,
): AreaScaleVerdict {
  if (!scale || !(scale.sqmPerPct2 > 0)) return "unavailable";
  const printed = slot.ocr_area ?? slot.area;
  if (printed == null || !(printed > 0)) return "unavailable";
  if (slot.polygon.length < 3) return "fail";
  const measured = polygonAreaPct2(slot.polygon) * scale.sqmPerPct2;
  return Math.abs(measured - printed) / printed <= tolerance ? "pass" : "fail";
}

/** Bulk signals for one lot (plus the dup guard via streetRunSignal). */
export function bulkSignals(
  slot: LotSlot,
  state: CorrectionState,
  scale: ScaleRef | null = null,
): { ocr: boolean; streetRun: boolean; areaScale: AreaScaleVerdict; all: boolean } {
  const ocr = ocrNumberSignal(slot);
  const streetRun = streetRunSignal(slot, state);
  const areaScale = areaScaleSignal(slot, scale);
  return { ocr, streetRun, areaScale, all: ocr && streetRun && areaScale !== "fail" };
}

/**
 * Confirm one lot (manual method): requires the detection signal; the manual
 * review itself is the human signal. Records the confirmed_by marker.
 */
export function confirmLot(
  state: CorrectionState,
  args: { actor: string; id: string; time?: string },
): void {
  requireActor(args.actor);
  const slot = state.lots[args.id];
  if (!slot) throw new Error(`unknown lot ${args.id}`);
  if (!hasDetectionSignal(slot) && !waivedFor(state, "lot", args.id)) {
    throw new Error(`two-signal rule: ${args.id} lacks a detection signal (suspect or no unit) and has no waiver`);
  }
  applyEdit(state, { actor: args.actor, lot: args.id, field: "status", before: slot.status, after: "confirmed" satisfies LotStatus });
  slot.confirmed_by = {
    actor: args.actor,
    time: args.time ?? new Date().toISOString(),
    method: "manual",
    signals: ["detection", "human"],
  };
}

/** Seeded RNG so bulk samples are reproducible in tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bulk-accept proposal (slice 1.7): confident set = suggested lots where
 * the gating signals pass (OCR number + street-run/adjacency, plus the
 * scale-area signal once a scale is provided — "unavailable" never gates)
 * plus not-duplicated. Sample is >= 20 lots (or ALL of the proposal when
 * fewer than 20 exist), stratified by tier/block stratum (lotStratum).
 * The caller confirms each sample lot manually (confirmLot), then
 * bulkConfirmRest() flips the remainder with method bulk-sample.
 *
 * The seed SHOULD be server-generated single-use (DraftStore.issueBulkSeed
 * for local preview; correction_bulk_seeds + consume_correction_bulk_seed()
 * in the database for the server path); this pure function accepts an
 * explicit seed so tests stay deterministic. The optional scale activates
 * signal 3; without it the area verdict is "unavailable" and does not gate.
 */
export const BULK_MIN_SAMPLE = 20;

export function proposeBulkAccept(
  state: CorrectionState,
  seed = 7,
  minSample = BULK_MIN_SAMPLE,
  scale: ScaleRef | null = null,
): { proposal: string[]; sample: string[] } {
  const dups = new Set(Object.values(findDuplicates(state)).flat());
  const proposal = Object.entries(state.lots)
    .filter(([id, s]) => {
      if (s.status !== "suggested" || dups.has(id)) return false;
      if (!hasDetectionSignal(s)) return false;
      return bulkSignals(s, state, scale).all;
    })
    .map(([id]) => id)
    .sort();
  if (!proposal.length) return { proposal: [], sample: [] };
  // All when fewer than minSample.
  if (proposal.length <= minSample) return { proposal: [...proposal], sample: [...proposal] };
  // Stratified: group by tier/block, allocate proportionally (≥1 per stratum).
  const byStratum = new Map<string, string[]>();
  for (const id of proposal) {
    const k = lotStratum(state.lots[id]);
    if (!byStratum.has(k)) byStratum.set(k, []);
    byStratum.get(k)!.push(id);
  }
  for (const ids of byStratum.values()) ids.sort();
  const strata = [...byStratum.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const total = proposal.length;
  const target = Math.min(total, Math.max(minSample, Math.ceil(total * 0.1)));
  const quota = new Map<string, number>();
  let assigned = 0;
  for (const [k, ids] of strata) {
    const q = Math.max(1, Math.floor((ids.length / total) * target));
    quota.set(k, Math.min(q, ids.length));
    assigned += quota.get(k)!;
  }
  // Fill remainder round-robin over strata (largest strata first) so the
  // sample stays proportional when quotas undershoot the target.
  const bySize = [...strata].sort((a, b) => b[1].length - a[1].length);
  let i = 0;
  while (assigned < target) {
    const [k, ids] = bySize[i % bySize.length];
    if (quota.get(k)! < ids.length) {
      quota.set(k, quota.get(k)! + 1);
      assigned += 1;
    }
    i += 1;
    if (i > target * bySize.length + bySize.length) break;
  }
  const rand = mulberry32(seed);
  const sample: string[] = [];
  for (const [k, ids] of strata) {
    const pool = [...ids];
    const want = Math.min(quota.get(k) ?? 0, pool.length);
    for (let n = 0; n < want && pool.length; n++) {
      sample.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    }
  }
  return { proposal: [...proposal].sort(), sample: sample.sort() };
}

/**
 * Verify the reviewed sample BEFORE flipping the rest. Throws (blocking the
 * bulk accept) when ANY sample lot is:
 * - not manually confirmed yet, or
 * - currently failing a gating signal (a wrong review: number edited away
 *   from the OCR read, contiguity/adjacency broken by a typo that collides
 *   or lands across the map, or — once a scale is provided — the printed
 *   area disagreeing with the measured polygon).
 */
export function verifyBulkSample(
  state: CorrectionState,
  args: { proposal: string[]; sample: string[]; scale?: ScaleRef | null },
): void {
  const inProposal = new Set(args.proposal);
  for (const id of args.sample) {
    if (!inProposal.has(id)) throw new Error(`bulk sample ${id} is not in the proposal`);
    const s = state.lots[id];
    if (!s || s.status !== "confirmed" || s.confirmed_by?.method !== "manual") {
      throw new Error(`two-signal rule: sample lot ${id} is not manually confirmed yet`);
    }
    const sig = bulkSignals(s, state, args.scale ?? null);
    if (!sig.all) {
      const bad: string[] = [];
      if (!sig.ocr) bad.push("ocr-number");
      if (!sig.streetRun) bad.push("street-run");
      if (sig.areaScale === "fail") bad.push("area-scale");
      throw new Error(`bulk sample ${id} is wrong (${bad.join(", ")} signal failed); bulk accept blocked`);
    }
  }
}

/** Flip the non-sample remainder after the sample was manually confirmed. */
export function bulkConfirmRest(
  state: CorrectionState,
  args: { actor: string; proposal: string[]; sample: string[]; time?: string; scale?: ScaleRef | null },
): string[] {
  requireActor(args.actor);
  verifyBulkSample(state, { proposal: args.proposal, sample: args.sample, scale: args.scale });
  const rest = args.proposal.filter((id) => !args.sample.includes(id) && state.lots[id]?.status === "suggested");
  const now = args.time ?? new Date().toISOString();
  const edits = rest.map((id) => ({ lot: id, field: "status", before: "suggested" as LotStatus, after: "confirmed" as LotStatus }));
  if (edits.length) applyBatch(state, { actor: args.actor, edits });
  for (const id of rest) {
    state.lots[id].confirmed_by = {
      actor: args.actor,
      time: now,
      method: "bulk-sample" satisfies ConfirmMethod,
      signals: ["detection", "human"],
      sampleOf: [...args.sample],
    };
  }
  return rest;
}

/** Add a waiver. Reason is required; empty reasons are rejected. */
export function addWaiver(
  state: CorrectionState,
  args: { actor: string; scope: Waiver["scope"]; target: string; reason: string; time?: string },
): Waiver {
  requireActor(args.actor);
  if (!args.reason.trim()) throw new Error("waiver reason is required");
  waiverSeq += 1;
  const waiver: Waiver = {
    id: `w${waiverSeq}`,
    scope: args.scope,
    target: args.target,
    reason: args.reason.trim(),
    actor: args.actor,
    time: args.time ?? new Date().toISOString(),
  };
  state.waivers.push(waiver);
  pushEntries(state, [{ actor: args.actor, lot: "—", field: `waiver/${waiver.id}`, before: null, after: `${args.scope}:${args.target}` }]);
  return waiver;
}

export function waivedFor(state: CorrectionState, scope: Waiver["scope"], target: string): boolean {
  return state.waivers.some((w) => w.scope === scope && w.target === target);
}

/** Record a catalogue-level entry (tier add/edit, waiver) sharing the batch sequence. */
export function logCatalogueEdit(
  state: CorrectionState,
  edit: { actor: string; field: string; before: unknown; after: unknown },
): EditEntry {
  requireActor(edit.actor);
  pushEntries(state, [{ lot: "—", ...edit }]);
  return state.log[state.log.length - 1];
}

/** Live duplicates over current numbers: {value: [lotIds]}. */
export function findDuplicates(state: CorrectionState): Record<string, string[]> {
  const byValue = new Map<string, string[]>();
  for (const [id, slot] of Object.entries(state.lots)) {
    if (slot.number == null || slot.number === "") continue;
    const key = String(slot.number);
    if (!byValue.has(key)) byValue.set(key, []);
    byValue.get(key)!.push(id);
  }
  const dups: Record<string, string[]> = {};
  for (const [value, ids] of byValue) {
    if (ids.length > 1) dups[value] = [...ids].sort();
  }
  return dups;
}

/** Gaps over the global min-max printed-number range. Flagged, never filled. */
export function findGaps(state: CorrectionState): number[] {
  const nums = Object.values(state.lots)
    .map((s) => (s.number == null || s.number === "" ? null : Number(s.number)))
    .filter((n): n is number => Number.isInteger(n));
  if (!nums.length) return [];
  const have = new Set(nums);
  const gaps: number[] = [];
  for (let n = Math.min(...nums); n <= Math.max(...nums); n++) {
    if (!have.has(n)) gaps.push(n);
  }
  return gaps;
}

/** Legend rows from the tier catalogue + live counts (embed contract). */
export function buildLegend(state: CorrectionState): {
  rows: Array<{ key: string; label: string; color: string; price: number; sellable: boolean; count: number }>;
  unassigned: number;
  total: number;
} {
  const counts: Record<string, number> = {};
  let unassigned = 0;
  for (const slot of Object.values(state.lots)) {
    if (slot.tier_key == null) unassigned += 1;
    else counts[slot.tier_key] = (counts[slot.tier_key] ?? 0) + 1;
  }
  const rows = Object.entries(state.tiers).map(([key, t]) => ({
    key,
    label: t.label,
    color: t.color,
    price: t.price,
    sellable: t.sellable !== false,
    count: counts[key] ?? 0,
  }));
  return { rows, unassigned, total: Object.keys(state.lots).length };
}

/** Uncertain-first queue: no-unit, suspect/dup/area-only, then the rest. */
export function uncertainQueue(state: CorrectionState): string[] {
  const dups = new Set(Object.values(findDuplicates(state)).flat());
  const scored: Array<[number, string]> = [];
  for (const [id, slot] of Object.entries(state.lots)) {
    let rank = 3;
    if (!slot.hasUnit) rank = 0;
    else if (slot.suspect.length || dups.has(id)) rank = 1;
    else if (slot.number == null) rank = 2;
    if (slot.status !== "suggested") rank += 10;
    scored.push([rank, id]);
  }
  scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return scored.map(([, id]) => id);
}

/** Confident fill preview: suggested + detection signal + not duplicated. No writes. */
export function previewConfidentFill(state: CorrectionState): string[] {
  const dups = new Set(Object.values(findDuplicates(state)).flat());
  return Object.entries(state.lots)
    .filter(([, s]) => s.status === "suggested" && hasDetectionSignal(s) && !dups.has(s.id))
    .map(([id]) => id)
    .sort();
}

export function lotCentroid(polygon: MapPoint[]): [number, number] {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

export function lotBBox(polygon: MapPoint[]): [number, number, number, number] {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
