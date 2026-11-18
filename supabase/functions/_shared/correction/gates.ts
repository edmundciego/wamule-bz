/**
 * Slice 1.6 stage gates. The enforcing verdict lives in ./publish.ts
 * (enforcePublish, called by both DraftStore.publish and the publish-draft
 * edge function); the UI renders the same evaluation as a preview only —
 * previews never grant a publish.
 */
import type { CorrectionState, GateFailure, GateResult, OnboardingStage } from "./types.ts";
import { findDuplicates, findGaps, uncertainQueue, waivedFor } from "./model.ts";
import { polygonsOverlap } from "./overlap.ts";

export const ONBOARDING_STAGES: OnboardingStage[] = [
  "intake",
  "classify",
  "legend",
  "read",
  "correct",
  "validate",
  "preview",
  "sign-off",
  "live",
  "operate",
];

export const STAGE_GATES: Record<OnboardingStage, { artifacts: string[]; gate: string }> = {
  intake: { artifacts: ["tenant record", "plan raster"], gate: "raster readable, tenant exists" },
  classify: { artifacts: ["tier catalogue draft"], gate: ">=1 tier with label + color" },
  legend: { artifacts: ["legend sign-off"], gate: "swatches match plan fills within tolerance" },
  read: { artifacts: ["detection units file"], gate: "area-anchored run complete, units present" },
  correct: {
    artifacts: ["confirmed lots / waivers"],
    gate: "0 unreviewed uncertain lots or explicit waivers; duplicates resolved or waived; no unresolved within-draft overlaps (or overlap waivers with reason/actor/time)",
  },
  validate: {
    artifacts: ["draft map snapshot (inactive)"],
    gate: "drift gate clean (geometry/tiers/prices within tolerance)",
  },
  preview: { artifacts: ["signed expiring preview link"], gate: "tenant sign-off recorded (actor + time)" },
  "sign-off": { artifacts: ["published snapshot"], gate: "embed URL resolves, legend matches catalogue" },
  live: { artifacts: ["handover + inquiry round-trip"], gate: "first inquiry round-trip OK" },
  operate: { artifacts: ["steady-state drafts"], gate: "edits are drafts until publish" },
};

/** Order-normalized waiver target for an overlapping draft pair. */
export function overlapTarget(a: string, b: string): string {
  return [a, b].sort().join("<->");
}

/**
 * Within-draft strict overlaps (shared edges allowed) over every lot pair,
 * any status. O(n²) with the bbox prefilter inside polygonsOverlap
 * (Hopkins 719 lots ≈ 31ms; the gate only runs at stage correct).
 */
export function findWithinDraftOverlaps(
  state: CorrectionState,
): Array<{ a: string; b: string; target: string }> {
  const ids = Object.keys(state.lots).sort();
  const out: Array<{ a: string; b: string; target: string }> = [];
  for (let i = 0; i < ids.length; i++) {
    const a = state.lots[ids[i]].polygon;
    if (a.length < 3) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const b = state.lots[ids[j]].polygon;
      if (b.length < 3) continue;
      if (polygonsOverlap(a, b)) {
        out.push({ a: ids[i], b: ids[j], target: overlapTarget(ids[i], ids[j]) });
      }
    }
  }
  return out;
}

/**
 * Evaluate the exit gate of the state's current stage. Waivable failures
 * covered by a valid waiver move to `waived`; the rest block.
 */
export function evaluateStageGate(state: CorrectionState): GateResult {
  const failures: GateFailure[] = [];
  if (state.stage === "correct") {
    const uncertain = uncertainQueue(state).filter((id) => state.lots[id].status === "suggested");
    for (const id of uncertain) {
      failures.push({
        code: "uncertain-lots",
        detail: `${id} is unreviewed`,
        waivableAs: { scope: "lot", target: id },
      });
    }
    for (const [value, ids] of Object.entries(findDuplicates(state))) {
      failures.push({
        code: "duplicates",
        detail: `number ${value} on ${ids.join(", ")}`,
        waivableAs: { scope: "duplicate", target: value },
      });
    }
    for (const o of findWithinDraftOverlaps(state)) {
      failures.push({
        code: "within-draft-overlap",
        detail: `${o.a} overlaps ${o.b}`,
        waivableAs: { scope: "overlap", target: o.target },
      });
    }
    const gaps = findGaps(state);
    if (gaps.length) {
      failures.push({
        code: "gaps",
        detail: `${gaps.length} missing numbers in range (${gaps.slice(0, 8).join(", ")}${gaps.length > 8 ? ", …" : ""})`,
        waivableAs: { scope: "gap", target: `${Math.min(...gaps)}-${Math.max(...gaps)}` },
      });
    }
  }
  if (state.stage === "validate") {
    // Drift gate inputs arrive with the snapshot pipeline (slice 1 tooling
    // reports geometry/tiers/prices); without them the gate cannot pass.
    failures.push({ code: "drift-inputs", detail: "no drift report attached (run tenant:build first)" });
  }

  const waived: GateFailure[] = [];
  const blocking: GateFailure[] = [];
  for (const f of failures) {
    if (f.waivableAs && waivedFor(state, f.waivableAs.scope, f.waivableAs.target)) waived.push(f);
    else blocking.push(f);
  }
  return { stage: state.stage, pass: blocking.length === 0, failures, waived, blocking };
}

/** Advance one stage. Refuses blocked gates — this is the bypass guard. */
export function advanceStage(state: CorrectionState, actor: string): OnboardingStage {
  if (!actor.trim()) throw new Error("actor is required");
  const result = evaluateStageGate(state);
  if (!result.pass) {
    throw new Error(
      `gate bypass refused at ${state.stage}: ${result.blocking.map((f) => f.detail).join("; ")}`,
    );
  }
  const idx = ONBOARDING_STAGES.indexOf(state.stage);
  if (idx < 0 || idx >= ONBOARDING_STAGES.length - 1) throw new Error(`cannot advance from ${state.stage}`);
  state.stage = ONBOARDING_STAGES[idx + 1];
  return state.stage;
}
