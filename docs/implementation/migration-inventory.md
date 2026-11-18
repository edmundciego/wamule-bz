# Environment & Migration Inventory (M0)

**Date:** 11 October 2026. Local-only: nothing here was applied anywhere.

## Environments

| Env | Frontend | Backend | Evidence |
|---|---|---|---|
| Local dev | `vite` (`npm run dev`), dev-only `/correct/` + `/demo-map` mounts (never built) | Embedded pgserver harnesses (`scripts/slice1*-db-harness.py`) + stub `auth.uid()` | `vite.config.ts`, `scripts/` |
| Staging (linked) | Netlify (per removed submodule note; verify provider before M7) | Supabase project `kvocwmrcuhiaezlcgzjf` ("Wamule Development Staging", see `supabase/.temp/linked-project.json`, `config.toml`) | `.env.staging` (local, gitignored) |
| Production | TBD (M7): confirm provider before any change | No prod project inventoried yet | Open — release-plan M7 |

Secrets live in gitignored `.env` / `.env.staging`; `.env.example` is the canonical key list. The project-local Supabase CLI is available at `node_modules/.bin/supabase` (v2.105.0); no global CLI or Deno binary is on PATH. `supabase status` cannot reach the Docker daemon, so local Edge Runtime and full migration-rehearsal checks are currently unavailable.

## Migration track (what exists)

- `supabase/migrations/`: **42 files in the current local tree**, `20260610…` → `20261012020651_project_scoped_public_maps`. Includes the local public-identity lockdown and project-scoped map/configuration migration; neither has been applied remotely.
- `supabase/migrations_archive/20260610_wamuale_foundation.sql`: pre-track foundation (admin_profiles, `app_role`, early RLS helpers).
- `wamuale_supabase_foundation_migration.sql` (root, 48KB): separate legacy full-schema candidate; it is not in the tracked migration directory and recommends a historical path that is no longer present.
- `scripts/slice17-db-hardening.sql`: explicitly **not** a migration — local harness only, never under `migrations/`, never run against staging/prod.

The tracked set is not currently a self-contained bootstrap: its first file, `20260610000100_fix_lots_public_options.sql`, alters and queries `public.parcels`, `public.applications`, and `public.contracts` without creating that foundation. The archive/root files are therefore not optional duplicates that can be picked interchangeably; a baseline source and migration-history strategy still have to be reconciled before a clean reset or any hosted migration work.

The legacy lot-seed history is also material to data safety. The archive seeds `01`–`24`; the root SQL seeds `LOT-01`–`LOT-24`; the first tracked migration merges these formats and inserts `01`–`24`; the next migration sets a legacy dimension string and `base_price = 25000` on every two-digit lot number. These are historical application fixtures, not evidence of Hopkins identity or current register values, and replaying them against existing records could rewrite or relink business data.

### Local bootstrap and function inventory

- `scripts/slice16-bootstrap.sql` is a harness fixture, not a clean install of all 41 tracked migrations. `scripts/slice16-db-harness.py` applies that fixture plus only `20260925000000_correction_slice15.sql` under embedded pgserver.
- `scripts/slice17-db-harness.py` uses the same fixture and migration, then adds `scripts/slice17-db-hardening.sql` for local authorization checks. These harnesses are useful regression evidence, but neither proves the tracked migration chain can bootstrap a fresh Supabase database.
- `supabase/functions/` contains 16 endpoint directories plus `_shared/`. `supabase/config.toml` explicitly sets `verify_jwt = false` for `get-public-lots`, `submit-public-inquiry`, and `submit-public-application`; the public application function resolves lot references and writes through the service role. Local migration `20261011000000_public_lot_identity_lockdown.sql` revokes the legacy anon-readable view and direct anon application insert. This is source/config evidence only: no migration or function was applied remotely, and actual hosted deployment/enabled-function state remains unknown.
- The root file (1,244 lines) and archive (357 lines) are not interchangeable. Their `admin_profiles` primary-key layouts differ, as do the `receipt_job_status` enum values. Neither is safe to replay or declare authoritative without semantic reconciliation.

Git provenance narrows, but does not settle, their roles: the archive appears in
`fbc79e0` (12 June 2026) and has no later file-history commit; the root SQL is
also present in `fbc79e0`, then is revised in `8aeedd1` (13 June 2026) alongside
the manual-receipt, payment-request and business-settings migrations. This
shows the root candidate was maintained later, but commit chronology does not
prove it was applied, deployed, or intended to replace the tracked baseline.

### Disposable empty-Postgres probe (11 October 2026)

`python3 scripts/probe-migration-bootstrap.py` created and removed a temporary
embedded PostgreSQL cluster, then tried the 42 tracked migrations in order. It
blocked before applying the first migration:
`20260610000100_fix_lots_public_options.sql` requires the absent
`public.parcel_status` type (line 10). This confirms the timestamped migration
directory has no app-schema baseline ahead of its first migration. This remains
the default no-baseline result. The current probe installs only small Auth and
Storage compatibility stubs; it is not the supported `supabase db reset` and
does not emulate the Supabase-managed services. The official local reset
remains unverified because this workstation has no Docker executable. No
persistent or hosted database was changed.

### Legacy foundation candidate comparison (11 October 2026)

The probe now has explicit `--baseline archive` and `--baseline root` modes.
Each applies one named legacy foundation candidate, then all 42 tracked
migrations, inside its own temporary embedded-PostgreSQL cluster. Both
candidates completed all 42 migrations with the probe's minimal Auth/Storage
compatibility stubs. This is useful schema-chain evidence, not an official
Supabase reset: it does not reproduce managed Auth/Storage, extension
installation, hosted roles/grants, or Edge Runtime behavior.

The bundled PostgreSQL lacks the optional `pgcrypto` extension package. The
probe skips only `CREATE EXTENSION pgcrypto` when the server confirms the
PostgreSQL 13+ core `gen_random_uuid()` function is available; repository SQL
uses that UUID function and no other `pgcrypto` API. The [PostgreSQL UUID
reference](https://www.postgresql.org/docs/17/functions-uuid.html) documents
the core function. Extension installation itself remains unverified.

The candidates do **not** converge after the tracked migrations:

| Post-chain marker | Archived foundation | Root SQL candidate |
|---|---|---|
| `admin_profiles` primary key | `id` (with unique `user_id`) | `user_id` |
| `receipt_job_status` labels | `Pending`, `Processing`, `Completed`, `Failed` | `Queued`, `Processing`, `Completed`, `Failed` |
| Legacy parcel rows | 24 numeric IDs | 24 numeric IDs |

The probe also compares normalized `pg_dump --schema-only --schema=public
--no-owner` output (object ownership excluded; ACLs retained). The archived
candidate produces 324,097 bytes (SHA-256
`20242307789830779de0fc5d9b579c6bcdb70404c8f103fd3f672aab9b042cc7`); the root
candidate produces 338,034 bytes (SHA-256
`99a4b456be41252dda27e737bb67b4272354fb8eae1adc1d1c2ed0c5d3220e24`). The
comparison finds **21 archive-only objects, 60 root-only objects, and 16
changed objects**, with 168 versus 632 one-sided DDL lines. Counts compare each
named pg_dump object body, not just its heading.

Examples are substantive:
the archive-only `approve_application(bigint)` function versus the
root-only `handle_application_approval()` trigger function; different
application/customer uniqueness constraints; different `applications` RLS
policies; root-only table/sequence ACLs and operational views; and a changed
`customer_balance_view`. The common-object differences also include the
`admin_profiles` table/primary key, `transactions` row-security state,
`receipt_job_status`, and parcel-sale trigger behavior. These are behavior and
access-contract differences, not cosmetic baseline drift.
`--compare-candidates` emits the catalog-object summary and a bounded unified
diff; rerun with `--diff-lines` for more context.

Both temporary databases contain synthetic legacy parcel data; neither result
is Hopkins identity or register evidence. A clean start with no app baseline
still stops at the first tracked migration because `public.parcel_status` is
missing. The exact baseline remains unreconciled; a successful candidate replay
is not authority to select one, and the required official local rehearsal is
still open. `test/migration-bootstrap-probe.test.mjs` protects both candidate
replays, their known divergences, the schema diff and the no-baseline refusal
against drift.

## M3 project-scope schema note

Local migration `20261012020651_project_scoped_public_maps.sql` adds project-local lot-number uniqueness and composite tenant/project constraints for parcels, map versions, project settings and tier rows. Active map versions, numbering, theme/profile settings and tier catalogues are project-scoped; the default project alone mirrors/falls back to legacy tenant settings. `get-public-lots`, `tenant-publish` and `publish-lots` now use that scope. A disposable embedded-Postgres harness verifies same lot numbers across projects, rejection within a project, parent consistency, independent map activation/version numbering and service-only table grants (`test/project-scoped-public-maps-db.test.mjs`). This is local evidence only. The older admin map gallery is still tenant-oriented, and project selector/editor wiring belongs to later authenticated-admin work; do not infer that the migration is safe to apply or that the hosted path has been verified.

## Gaps found (must close before any hosted apply)

1. Three schema sources (archive, root SQL, migration track) with no documented precedence or complete reconciliation; the legacy foundation files demonstrably diverge, and the tracked set begins with a migration that assumes the foundation already exists.
2. No full Supabase fresh-bootstrap rehearsal: the tracked set is not self-contained; both legacy candidates pass all 42 tracked migrations only under an embedded PG probe with minimal Auth/Storage stubs, and their resulting schemas still differ. The no-baseline probe stops at the missing `public.parcel_status` type. Docker is unavailable here. Supabase's new native local runtime is public alpha and supports Linux and Apple silicon, not this Intel (`x86_64`) Mac ([native runtime requirements](https://supabase.com/features/native-local-runtime)).
3. `supabase/.temp/` pins CLI/service versions; the project-local CLI is present (2.105.0), but this machine has neither Docker nor a supported native-stack runtime for a clean rehearsal.

## M0 migration strategy decision — 11 October 2026

**Use a reconciled fresh-bootstrap track for new local/sandbox databases; use incremental upgrades only for any existing Wamule environment.** This separates reproducibility from preservation of existing business data:

1. Before calling the bootstrap reproducible, reconcile the archive and root SQL into one reviewed canonical baseline/track. Do not replay either legacy lot seed as Hopkins identity or current register data.
2. Rehearse the complete track with the official CLI's explicit `db reset --local` against a separate disposable local project, record pass/fail per migration, and verify schema/security invariants. Supabase documents that local reset recreates the local database and applies migrations in order; it is not a hosted operation ([local development workflow](https://supabase.com/docs/guides/local-development/cli-workflows)).
3. For an existing Wamule environment, first inspect its actual schema and applied migration history; then use an incremental-only, reviewed plan with separate database and Storage backups plus a dry run. Never reset a linked Wamule project or apply development seed data.

The strategy is selected; the baseline reconciliation and clean rehearsal are still incomplete. The linked staging project's actual migration history and applied schema remain unknown, and no migration has been applied remotely.

Until then: no hosted migration applies; slice-1.5 staging apply remains the explicit banner condition.

### Regression recheck — 12 October 2026

`node --test test/migration-bootstrap-probe.test.mjs` passed both isolated
cases against the current tree. The archive and root candidates still replay
the 42 tracked migrations under the probe's minimal Auth/Storage stubs while
retaining the asserted schema divergences; the no-baseline case still stops at
the first migration because `public.parcel_status` is absent. This is
regression evidence for the diagnostic boundary, not a canonical-baseline
choice or an official Supabase reset. No persistent or hosted database was
changed, and the clean official rehearsal remains open.
