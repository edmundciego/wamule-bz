# Release Quality and Data Management

## Canonical brand decision

The official product/client name is **Wamule Development**. The approved short name is **Wamule**. `src/lib/brand.ts` provides those canonical fallbacks. The existing Company Profile remains the runtime source where a configurable company name is already safe and supported, particularly the public application and buyer-confirmation paths.

## Incorrect-name audit and corrections

The following user-facing/runtime locations were corrected:

- `index.html`: browser title and new application metadata now say `Wamule Development`.
- `public/favicon/site.webmanifest`: install name is `Wamule Development`; short name is `Wamule`.
- `src/pages/ApplicationPage.tsx`: Company Profile fallback, notice, acknowledgement, review activity, availability, and staff-review copy.
- `src/pages/SettingsPage.tsx`: Company Profile and public-application defaults.
- `src/pages/LoginPage.tsx`: logo alt text, visual wordmark, staff sign-in copy, and placeholder email.
- `src/components/layout/AdminLayout.tsx`: sidebar logo alt text and visual wordmark.
- `src/pages/DocumentPage.tsx`: document logo alt text, heading, and footer.
- `supabase/functions/generate-receipts/index.ts`: generated receipt heading.
- `supabase/functions/submit-developer-feedback/index.ts`: notification subject/body.
- `package.json` and lockfile: package identifier was corrected to `wamule-development`.

The full repository search also found legacy `Wamuale` wording in `epic.md`, `Codex_implementation_prompt.md`, `developerplan.md`, `wamuale_supabase_foundation_migration.sql`, and `supabase/migrations_archive/20260610_wamuale_foundation.sql`, plus historical migration policy/comment text. These are technical/historical source material, not runtime-facing UI. They are intentionally retained to avoid rewriting historical migrations. The new migration corrects live `business_settings` values that were seeded with the legacy spelling.

`Wamule Development Platform` was found in the old browser title, package identifier, developer-feedback email copy, and historical planning documents. `Wamule Development CRM` and `Womola` were not found in user-facing code.

## Brand regression check

Run:

```bash
npm run check:brand
```

`scripts/check-brand.mjs` scans user-facing runtime surfaces (`src`, `public`, metadata, package metadata, and Edge Functions) and fails on `Wamuale`, `Womola`, `Wamule Development Platform`, or `Wamule Development CRM`. Historical technical documentation and archived migrations are deliberately outside the scan scope.

## Quality review and focused improvements

The approved V2 visual system was preserved. The remaining incomplete feeling was primarily consistency and operational safety rather than a missing redesign: visible legacy branding, no clear controlled path for removing training/error data, and state feedback that did not fully announce errors and loading activity to assistive technology.

Focused improvements made:

- Added a Super Admin-only informational Data Management tab rather than exposing destructive work from normal record pages.
- Added ordinary-record guidance explaining that purge is disabled and exceptional maintenance requires a separately approved process.
- Improved loading/error announcements with `role=status`, `aria-live=polite`, `role=alert`, and safe long-message wrapping.
- Standardized date display through `America/Belize` for shared formatted dates and dashboard header dates.
- Preserved responsive, wrapping controls in the new search, preview, and confirmation flow; record IDs remain visible in result choices and long identifiers/messages wrap safely.

## First-use and onboarding assessment

The existing Settings organization and CRM Workflow Guide support the required launch order: Company Profile, users/roles, payment methods and installment plans, lot sizes/fee types, lots, notifications, public inquiries/applications, customers/contracts, payments, then Dashboard/Daily Brief. No new onboarding backend dependency was added. A client launch review should use that sequence before entering live buyer data.

## Data Management / Danger Zone

`Settings → Data Management` is rendered only for a signed-in Super Admin, but it is currently informational-only. It does not search for records, preview dependencies, call `purge-contact-record`, or expose a destructive control. The panel explicitly states that permanent purge is disabled until an approved database foundation exists.

Normal records should continue to use the approved close, void, cancel, archive, deactivate, or anonymize workflows.

## Historical purge implementation audit

Commit `00941e7` contained a preliminary purge implementation. It called `purge_contact_preview` and `purge_contact_record`, and updated `purge_storage_cleanup_tasks`. The current repository intentionally retired that implementation in the release-quality migration and disabled the application panel.

The current migration chain does not define those RPCs or the cleanup table. No equivalent functions exist under another name. The current Edge Function is now a disabled 503 endpoint and contains no service-role client, database RPC call, storage operation, or auth deletion path.

## Resolution: disable incomplete purge support

Path B was chosen because the existing schema cannot safely support the historical purge design:

- Batch 1 makes transaction history immutable and blocks direct transaction deletion.
- The historical purge function deletes transactions and other financial records, which conflicts with that protection.
- The old implementation had not been runtime-verified against the current foreign keys, role policies, storage behavior, or recovery requirements.
- Optional linked-auth deletion and last-Super-Admin protection existed only in the historical implementation, not in the current deployable code.

The historical implementation remains available in git history for review only. It is not a deployable feature. The current UI and Edge Function cannot remove records, call missing RPCs, delete storage objects, delete auth users, or write purge audit records.

## Current authorization and data boundaries

The informational panel is shown only to the Super Admin role by the existing Settings route logic, but this is not treated as security enforcement because no destructive action is available. The disabled Edge Function returns HTTP 503 for every non-OPTIONS request. Staff, Admin, Read Only, anonymous, and Super Admin callers cannot trigger a purge through the current application code.

There is no active purge preview, so there is no financial-history confirmation flow. Financial records remain protected by the current immutable payment correction model.

There is no active storage cleanup task table or storage deletion path. Existing `audit_events` is a real append-only audit table used by other workflows, but no purge audit event can be written because purge execution is disabled.

No linked auth account can be deleted through the current application. The historical code is not a security boundary and must not be deployed as-is.

No relational transaction, post-purge verification, storage cleanup result, or retained purge audit record is currently active.

## Validation and known limitations

Automated checks for this branch include the brand guard, TypeScript typecheck, lint, production build, existing tests, and `test/release-quality-data-management.test.mjs`. The focused tests assert that the retired migration remains a no-op, the UI remains informational-only, the Edge Function is a disabled 503 endpoint, and no unresolved RPC dependency is callable from it.

No real customer data was used. No destructive integration scenario was run against a Supabase project from this checkout because production credentials, a linked local database, and a dedicated disposable test environment are not present. Any future purge replacement must receive its own isolated database, role, storage, auth, transaction, rollback, and post-purge verification plan before it is considered for deployment.

## Netlify production readiness

There is no `netlify.toml` or checked-in `.netlify` configuration. The SPA redirect is present in `public/_redirects` as `/* /index.html 200`; Vite's build output is `dist`; `main` remains the required production branch. The codebase expects `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the frontend environment and service-role secrets only in Edge Functions.

Manual Netlify production verification is still required:

1. Confirm production branch is `main`, not this feature branch.
2. Confirm the latest deployed commit and build command (`npm run build`).
3. Confirm publish directory is `dist`.
4. Confirm required `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` values are present without exposing service-role keys.
5. Confirm custom domain assignment, SSL, and the SPA redirect on a deep protected/public route.
6. Do not deploy `purge-contact-record`. Any future replacement requires an approved migration, isolated database rehearsal, role tests, storage cleanup tests, auth safeguards, and recovery evidence before deployment is considered.
7. Run the protected and public browser smoke checks using real authorized test accounts.

## Safe database rehearsal status — 2026-07-23

**Status: blocked before SQL execution. Production was not used.**

The repository was inspected on branch `main` at HEAD `15ab0cf` (`Build the private Information Centre workflow`). The application verification command also included the current local release-hardening changes, which remain uncommitted in the worktree.

No eligible non-production database was available:

- The connected Supabase organization contains the Wamule production project and one unrelated project. No dedicated Wamule staging project exists.
- Wamule has only its `main` branch; no preview branch is available.
- The checkout has no `supabase/config.toml`, no `supabase/seed.sql`, and no sanitized backup or dump.
- Docker is unavailable, so a local Supabase database cannot be started or reset.
- `WAMULE_DB_URL` and `SUPABASE_ACCESS_TOKEN` are not available in the secure process environment.
- The local Supabase npm CLI package is present, but its CLI startup attempts to write telemetry under the restricted user home and exits before running migration commands.

The migration chain was inspected statically:

- 29 timestamped migration files are present and have unique migration timestamps.
- The two retired release-quality/payment-removal timestamps are documented no-ops.
- The Batch 1 migration is present under `20260714223959_20260714210447_critical_correctness_batch_1.sql`; its `customer_balance_view` uses unconstrained `numeric` output columns, and the repository regression test protects that compatibility requirement.
- The release-quality migration does not create purge functions. The historical purge implementation referenced `purge_contact_preview`, `purge_contact_record`, `purge_storage_cleanup_tasks`, and the legacy `receipt_jobs` table, but those dependencies are not supplied by the current migration chain. The current `purge-contact-record` file is a disabled stub and makes no database calls.

Not performed because no safe environment existed:

- `supabase migration list` against a database
- `supabase db reset`
- migration application or schema diff
- backup restore and before/after row-count or financial comparison
- function/view/RLS compilation checks
- purge foundation database checks
- rollback or recovery test

### Required setup before the rehearsal can continue

1. Provision an approved disposable Wamule staging project or an eligible Supabase preview branch. Do not use the linked production project.
2. Alternatively, install and start Docker Desktop, initialize a local Supabase config, and provide a realistic sanitized backup or deterministic fixture set.
3. Record the isolated project/branch reference and migration history before applying anything.
4. Restore the sanitized backup, or reset the local database from the complete migration chain.
5. Run `supabase migration list` and `supabase db reset`/the approved staging migration workflow.
6. Capture baseline and post-migration row counts and financial totals for customers, applications, leads, contracts, transactions, balances, payment requests, reservations, post-sales records, and audit events.
7. Verify `customer_balance_view` column types, canonical financial totals, all required functions/views/RLS policies, Edge Function dependencies, and the master-delete database foundation.
8. Document recovery options and any rollback limitations before considering production approval.

Until these checks are completed in an isolated environment, the database migration chain is **not certified safe for production application**.
