/**
 * Slice 1.7 publish enforcement — single implementation.
 *
 * This module holds NO verdict logic: it re-exports enforcePublish() and
 * GateBypassError from the canonical module at
 * supabase/functions/_shared/correction/publish.ts (inside the deploy
 * packager root, so `supabase functions serve/deploy` includes it — see
 * scripts/slice17-bundle-check.mjs). The app reaches the same code via
 * src/lib/correction/* re-export shims. One code path, no fork to drift.
 *
 * Enforcement split: DB owns invariants (RLS, append-only log, rev
 * monotonicity, waiver checks, stage-write revocation, activation gate,
 * seed nonces); enforcePublish() owns overlap + gates.
 */
export { enforcePublish, GateBypassError, PublishBypassError } from "../_shared/correction/publish.ts";
