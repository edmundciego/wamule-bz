/**
 * Slice 1.6 canonical publish verdict (single implementation).
 *
 * Both the in-memory DraftStore (src/lib/correction/drafts.ts) and the
 * publish-draft edge function (supabase/functions/publish-draft) call
 * enforcePublish() from HERE — no forked duplicate.
 *
 * Enforcement split:
 * - DB (migration 20260925): tenant isolation, append-only log, rev
 *   monotonicity, waiver checks. Gates/overlap are NOT DB constraints.
 * - This module (server): overlap refusal + gate evaluation + advance.
 *
 * Bypass hardening: the foundational `correct`-stage gate (uncertain lots,
 * duplicates, gaps) is evaluated UNCONDITIONALLY, plus the current stage's
 * gate. A caller that relabels state.stage to a gateless stage (e.g. live)
 * still faces the correct gate — direct stage mutation is not a publish.
 * DraftStore.save() additionally rejects stage changes outside publish().
 */
import type { CorrectionState, PublishPlan } from "./types.ts";
import { advanceStage, evaluateStageGate } from "./gates.ts";
import { matchPublish, type DraftLot, type ExistingParcel } from "./overlap.ts";

export class PublishBypassError extends Error {
  constructor(detail: string) {
    super(`publish refused: ${detail}`);
    this.name = "GateBypassError";
  }
}

/** Alias kept for callers expecting GateBypassError. */
export const GateBypassError = PublishBypassError;

export function enforcePublish(args: {
  state: CorrectionState;
  existing: ExistingParcel[];
  actor: string;
}): { plan: PublishPlan; stage: CorrectionState["stage"] } {
  if (!args.actor.trim()) throw new Error("actor is required (server-session actor)");
  const drafts: DraftLot[] = Object.values(args.state.lots).map((s) => ({
    id: s.id,
    lot_number: s.lot_number,
    polygon: s.polygon,
    status: s.status,
  }));
  const plan = matchPublish(args.existing, drafts);
  if (!plan.ok) {
    throw new PublishBypassError(
      `overlap: ${plan.conflicts.map((c) => `${c.draftId} overlaps ${c.existingId}`).join("; ")}`,
    );
  }
  // Foundational gate: always enforced, regardless of the claimed stage label.
  const correctGate = evaluateStageGate({ ...args.state, stage: "correct" });
  if (!correctGate.pass) {
    throw new PublishBypassError(
      `stage correct: ${correctGate.blocking.map((f) => f.detail).join("; ")}`,
    );
  }
  const gate = evaluateStageGate(args.state);
  if (!gate.pass) {
    throw new PublishBypassError(
      `stage ${gate.stage}: ${gate.blocking.map((f) => f.detail).join("; ")}`,
    );
  }
  const stage = advanceStage(args.state, args.actor);
  return { plan, stage };
}
