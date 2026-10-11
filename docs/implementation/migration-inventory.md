# Environment & Migration Inventory (M0)

**Date:** 11 October 2026. Local-only: nothing here was applied anywhere.

## Environments

| Env | Frontend | Backend | Evidence |
|---|---|---|---|
| Local dev | `vite` (`npm run dev`), dev-only `/correct/` + `/demo-map` mounts (never built) | Embedded pgserver harnesses (`scripts/slice1*-db-harness.py`) + stub `auth.uid()` | `vite.config.ts`, `scripts/` |
| Staging (linked) | Netlify (per removed submodule note; verify provider before M7) | Supabase project `kvocwmrcuhiaezlcgzjf` ("Wamule Development Staging", see `supabase/.temp/linked-project.json`, `config.toml`) | `.env.staging` (local, gitignored) |
| Production | TBD (M7): confirm provider before any change | No prod project inventoried yet | Open — release-plan M7 |

Secrets live in gitignored `.env` / `.env.staging`; `.env.example` is the canonical key list. No CLI on this box (`supabase`, `deno` both absent) — migration rehearsal must use real Postgres + official CLI from Supabase docs when authorized.

## Migration track (what exists)

- `supabase/migrations/`: **40 files**, `20260610…` → `20260925_correction_slice15`. Covers parcels/applications/customers/contracts/transactions, multi-tenant foundation (20260915), tenant defaulting, masterplan storage/versioning, lot tiers, inquiry idempotency, correction slice-1.5 tables+RLS.
- `supabase/migrations_archive/20260610_wamuale_foundation.sql`: pre-track foundation (admin_profiles, `app_role`, early RLS helpers).
- `wamuale_supabase_foundation_migration.sql` (root, 48KB): unexamined root SQL — must be reconciled against the two above before any bootstrap.
- `scripts/slice17-db-hardening.sql`: explicitly **not** a migration — local harness only, never under `migrations/`, never run against staging/prod.

## Gaps found (must close before any hosted apply)

1. Three schema sources (archive, root SQL, migration track) with no documented precedence or reconciliation.
2. No fresh-bootstrap rehearsal evidence: the track has never been shown to build a clean database end-to-end (embedded harnesses apply only bootstrap + slice-1.5 + hardening).
3. `supabase/.temp/` pins CLI/service versions but no CLI is installed here to rehearse with.

## Bootstrap recommendation

**Reproducible fresh bootstrap rehearsal first, then decide.** Steps when authorized:
1. Reconcile archive + root SQL into or against `supabase/migrations/` (one track, no duplicates).
2. Empty local Postgres (real build with `pgcrypto`, not pgserver) → apply full track via the official CLI migration workflow → record pass/fail per file.
3. Only then choose incremental-upgrade (staging already has history) with a backup + dry run.
4. Keep business records protected: back up Storage bytes separately from DB metadata (release-plan M7 runbook).

Until then: no hosted migration applies; slice-1.5 staging apply remains the explicit banner condition.
