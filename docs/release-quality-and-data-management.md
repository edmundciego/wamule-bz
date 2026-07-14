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

- Added a Super Admin-only Data Management tab rather than exposing destructive work from normal record pages.
- Added an explicit Danger Zone with ordinary-record guidance before the purge tool.
- Improved loading/error announcements with `role=status`, `aria-live=polite`, `role=alert`, and safe long-message wrapping.
- Standardized date display through `America/Belize` for shared formatted dates and dashboard header dates.
- Preserved responsive, wrapping controls in the new search, preview, and confirmation flow; record IDs remain visible in result choices and long identifiers/messages wrap safely.

## First-use and onboarding assessment

The existing Settings organization and CRM Workflow Guide support the required launch order: Company Profile, users/roles, payment methods and installment plans, lot sizes/fee types, lots, notifications, public inquiries/applications, customers/contracts, payments, then Dashboard/Daily Brief. No new onboarding backend dependency was added. A client launch review should use that sequence before entering live buyer data.

## Data Management / Danger Zone

`Settings → Data Management` is rendered only for a signed-in Super Admin. The server independently verifies that role; hiding the tab is not authorization. The page calls `purge-contact-record` only after the operator selects one concrete lead, application, or customer result.

The tool is named **Purge Test or Incorrect Record** and explains that real records should normally be closed, voided, cancelled, archived, deactivated, or anonymized.

## Selection, preview, and identity handling

Search accepts name, email, or phone but never purges based on a text match alone. Each result supplies a root type and ID. The preview resolves direct relationships first through IDs (`lead_id`, `application_id`, `customer_id`, `contract_id`, and `reservation_id`). Email/phone matches are returned separately as **Possible related records requiring confirmation** and are not included automatically.

The server preview reports counts for leads, lead activities, follow-up tasks, site visits, applications, application AI reviews, customers, contracts, payments, payment documents, payment requests, reservations, reservation activities, post-sales checklists/tasks/activities, AI summaries, notifications, and related audit events.

## Purge architecture and authorization

The migration creates two non-public `SECURITY DEFINER` functions, revoked from `PUBLIC`, `anon`, and `authenticated`:

- `purge_contact_preview`: resolves the connected operational network and produces the count preview.
- `purge_contact_record`: re-resolves the network and deletes it in one PostgreSQL function call, so a database error rolls the relational operation back.

The Edge Function authenticates the bearer token, confirms the acting `admin_profiles` role is `Super Admin`, requires the reason and typed confirmations, calls the database function using a service-role client, then performs controlled Storage and optional auth cleanup. It rejects Staff and Admin callers, anonymous callers, a purge of the current Super Admin login, and removal of the last remaining Super Admin.

Deletion order covers dependent post-sales/AI/activity records first, then reservation activities/reservations, financial documents/requests/receipt jobs/transactions/contracts, sales work, related notifications/audit events, customers/leads, and applications. The function restores a touched lot to `Available` only when no active contract or live reservation remains.

## Financial, storage, auth, audit, and verification behavior

When contracts, payments, payment documents, or payment requests are present, the interface shows a stronger warning and requires `PURGE FINANCIAL HISTORY` in addition to the reason, test-data checkbox, exact display name, and `PURGE`.

Connected contract, receipt, and payment-document paths are collected before deletion. The database transaction creates private `purge_storage_cleanup_tasks`; after the committed database purge, the Edge Function removes bucket objects and records each success/failure. Partial storage failures are returned as a warning rather than reported as complete success, leaving a non-PII retry inventory.

If the selected customer has a linked auth user, the preview shows a separate option to remove it. It is never automatic, cannot target the signed-in Super Admin, and is protected against deleting the last Super Admin. A failed auth deletion is reported separately.

The database writes one minimal `system/deleted` audit event after the relational purge. It records the acting Super Admin, timestamp, reason, root type/ID, purge reference, category counts, requested auth action, and final storage/auth outcome. The purge event is inserted after old linked audit events are removed, so it is retained. The preview is safe to run again after success: because root IDs no longer exist, it returns a not-found result rather than creating data.

## Validation and known limitations

Automated checks for this branch include the brand guard, TypeScript typecheck, lint, production build, existing tests, and `test/release-quality-data-management.test.mjs`. The focused test asserts the client metadata, brand guard, server-only authorization/transaction/storage/auth controls, and the Danger Zone confirmation language.

No real customer data was used. No destructive integration scenario was run against a Supabase project from this checkout because production credentials, a linked local database, and a dedicated disposable test environment are not present. Before production approval, run the 21 requested destructive scenarios against a newly created test person, including unauthorized Staff/Admin calls, shared contact data, financial history, storage failure, auth guards, rollback, and a second post-purge preview.

## Netlify production readiness

There is no `netlify.toml` or checked-in `.netlify` configuration. The SPA redirect is present in `public/_redirects` as `/* /index.html 200`; Vite's build output is `dist`; `main` remains the required production branch. The codebase expects `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the frontend environment and service-role secrets only in Edge Functions.

Manual Netlify production verification is still required:

1. Confirm production branch is `main`, not this feature branch.
2. Confirm the latest deployed commit and build command (`npm run build`).
3. Confirm publish directory is `dist`.
4. Confirm required `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` values are present without exposing service-role keys.
5. Confirm custom domain assignment, SSL, and the SPA redirect on a deep protected/public route.
6. Deploy the new `purge-contact-record` Edge Function and the database migration through the approved Supabase release path; confirm its service-role secret is configured.
7. Run the protected and public browser smoke checks using real authorized test accounts.
