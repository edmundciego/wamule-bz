/**
 * Slice 1.6 server-side draft store (local-only working copy).
 *
 * Concurrency: optimistic locking on `rev` — a save carrying a stale
 * baseRev is rejected (409-style), the winner stays visible, the loser
 * reloads and retries. Actor binding: every save requires a non-empty
 * server-session actor; anonymous writes are rejected and the actor is
 * recorded on the draft and on every log entry the save carries.
 * Tenancy: store is keyed (tenant, project); cross-tenant reads and writes
 * are rejected. Publish runs the shared enforcePublish() verdict (overlap
 * refusal + gates, see ./publish.ts) before accepting — the same verdict
 * the publish-draft edge function calls. UI previews only render the
 * evaluation; they never grant a publish.
 */
import type { CorrectionState, DraftDoc, PublishPlan } from "./types.ts";
import { enforcePublish, GateBypassError } from "./publish.ts";
import { bulkConfirmRest, proposeBulkAccept } from "./model.ts";
import type { ExistingParcel } from "./overlap.ts";

export { GateBypassError };

export interface BulkSeed {
  seedId: string;
  seed: number;
  proposal: string[];
  sample: string[];
  used: boolean;
}

export class StaleRevisionError extends Error {
  readonly currentRev: number;
  constructor(currentRev: number) {
    super(`stale revision: draft is at rev ${currentRev}, reload and retry`);
    this.name = "StaleRevisionError";
    this.currentRev = currentRev;
  }
}

export class TenantIsolationError extends Error {
  constructor() {
    super("cross-tenant access rejected");
    this.name = "TenantIsolationError";
  }
}

function key(tenant: string, project: string): string {
  return `${tenant}::${project}`;
}

export class DraftStore {
  private docs = new Map<string, DraftDoc>();
  private bulkSeeds = new Map<string, BulkSeed & { tenant: string; project: string }>();

  /** Create the first revision. Re-creating an existing draft is rejected. */
  create(args: { tenant: string; project: string; state: CorrectionState; actor: string }): DraftDoc {
    if (!args.actor.trim()) throw new Error("actor is required (server-session actor)");
    const k = key(args.tenant, args.project);
    if (this.docs.has(k)) throw new Error(`draft already exists for ${args.tenant}/${args.project}`);
    const now = new Date().toISOString();
    const doc: DraftDoc = {
      tenant: args.tenant,
      project: args.project,
      rev: 0,
      state: structuredClone(args.state),
      updated_by: args.actor,
      updated_at: now,
    };
    this.docs.set(k, doc);
    return structuredClone(doc);
  }

  load(tenant: string, project: string, requesterTenant: string): DraftDoc {
    if (tenant !== requesterTenant) throw new TenantIsolationError();
    const doc = this.docs.get(key(tenant, project));
    if (!doc) throw new Error(`no draft for ${tenant}/${project}`);
    return structuredClone(doc);
  }

  /**
   * Save a new revision. Requires baseRev === current rev (optimistic
   * locking) and a server-session actor. Stage changes are rejected here:
   * stages advance only via publish() (shared enforcePublish verdict), so
   * a save that relabels the stage is a bypass attempt. Returns the stored
   * revision.
   */
  save(args: {
    tenant: string;
    project: string;
    requesterTenant: string;
    baseRev: number;
    state: CorrectionState;
    actor: string;
  }): DraftDoc {
    if (args.tenant !== args.requesterTenant) throw new TenantIsolationError();
    if (!args.actor.trim()) throw new Error("actor is required (server-session actor)");
    const k = key(args.tenant, args.project);
    const current = this.docs.get(k);
    if (!current) throw new Error(`no draft for ${args.tenant}/${args.project}`);
    if (args.baseRev !== current.rev) throw new StaleRevisionError(current.rev);
    if (args.state.stage !== current.state.stage) {
      throw new GateBypassError("stage changes only via publish (save cannot relabel stage)");
    }
    const now = new Date().toISOString();
    const next: DraftDoc = {
      tenant: args.tenant,
      project: args.project,
      rev: current.rev + 1,
      state: structuredClone(args.state),
      updated_by: args.actor,
      updated_at: now,
    };
    this.docs.set(k, next);
    return structuredClone(next);
  }

  /**
   * Gated publish: delegates to the shared enforcePublish() verdict (same
   * function the publish-draft edge function calls), then bumps rev and
   * stamps publishedAt. Any overlap/gate failure refuses.
   */
  publish(args: {
    tenant: string;
    project: string;
    requesterTenant: string;
    actor: string;
    existing: ExistingParcel[];
  }): { plan: PublishPlan; stage: CorrectionState["stage"]; rev: number } {
    if (args.tenant !== args.requesterTenant) throw new TenantIsolationError();
    if (!args.actor.trim()) throw new Error("actor is required (server-session actor)");
    const doc = this.docs.get(key(args.tenant, args.project));
    if (!doc) throw new Error(`no draft for ${args.tenant}/${args.project}`);
    const { plan, stage } = enforcePublish({ state: doc.state, existing: args.existing, actor: args.actor });
    doc.rev += 1;
    doc.updated_by = args.actor;
    doc.updated_at = new Date().toISOString();
    doc.state.publishedAt = doc.updated_at;
    return { plan, stage, rev: doc.rev };
  }

  /**
   * Server-generated single-use bulk seed. The server draws a cryptographic
   * seed, derives the stratified proposal+sample via the shared
   * proposeBulkAccept(), stores the triple under a random seedId, and
   * returns it. Clients MUST use this seedId for bulkConfirm — passing
   * their own seed is a preview only and never authorizes a bulk confirm.
   *
   * Slice 1.7: this in-memory map is the LOCAL preview mirror. The server
   * authority is public.correction_bulk_seeds +
   * consume_correction_bulk_seed() in the database (atomic single-use);
   * the edge-function path must issue/consume there, never here.
   */
  issueBulkSeed(args: {
    tenant: string;
    project: string;
    requesterTenant: string;
    actor: string;
  }): { seedId: string; seed: number; proposal: string[]; sample: string[] } {
    if (args.tenant !== args.requesterTenant) throw new TenantIsolationError();
    if (!args.actor.trim()) throw new Error("actor is required (server-session actor)");
    const doc = this.docs.get(key(args.tenant, args.project));
    if (!doc) throw new Error(`no draft for ${args.tenant}/${args.project}`);
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    const seed = (buf[0] * 0x100000000 + buf[1]) % 0x7fffffff;
    const seedId = crypto.randomUUID();
    const { proposal, sample } = proposeBulkAccept(doc.state, seed);
    this.bulkSeeds.set(seedId, { seedId, seed, proposal, sample, used: false, tenant: args.tenant, project: args.project });
    return { seedId, seed, proposal: [...proposal], sample: [...sample] };
  }

  /**
   * Bulk-confirm the non-sample remainder for a server-issued seedId.
   * Single-use: a seedId that is unknown, already consumed, or bound to a
   * different draft is rejected. A wrong sample (unconfirmed or failing any
   * of the three independent signals) blocks via verifyBulkSample — the
   * seed stays valid for retry after the sample is fixed; on success the
   * seed is marked used and cannot be replayed.
   */
  bulkConfirmWithSeed(args: {
    tenant: string;
    project: string;
    requesterTenant: string;
    actor: string;
    seedId: string;
  }): string[] {
    if (args.tenant !== args.requesterTenant) throw new TenantIsolationError();
    if (!args.actor.trim()) throw new Error("actor is required (server-session actor)");
    const entry = this.bulkSeeds.get(args.seedId);
    if (!entry || entry.tenant !== args.tenant || entry.project !== args.project) {
      throw new GateBypassError("unknown or cross-tenant bulk seed");
    }
    if (entry.used) throw new GateBypassError("bulk seed already used (single-use)");
    const doc = this.docs.get(key(args.tenant, args.project));
    if (!doc) throw new Error(`no draft for ${args.tenant}/${args.project}`);
    const rest = bulkConfirmRest(doc.state, { actor: args.actor, proposal: entry.proposal, sample: entry.sample });
    entry.used = true;
    doc.rev += 1;
    doc.updated_by = args.actor;
    doc.updated_at = new Date().toISOString();
    return rest;
  }
}
