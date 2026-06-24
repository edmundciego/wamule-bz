# Deployment Runbook: Sales, Post-Sales, Smart Assistance, and AI

This runbook prepares the current Wamule release for manual deployment and review. It is a deployment guide only; it does not replace the release-readiness audit in `docs/release-readiness-sales-post-sales-ai.md`.

Do not apply migrations, deploy Edge Functions, deploy the frontend, or modify production data until the deployment target, credentials, and release window are confirmed.

## 1. Pre-Deployment Checks

Before starting deployment:

- Confirm the worktree is clean or intentionally staged for the planned release commits.
- Confirm the latest local validation passes:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
- Confirm the required migrations exist in `supabase/migrations`.
- Confirm the required Edge Functions exist in `supabase/functions`.
- Confirm the intended Supabase project target before running any Supabase commands.
- Confirm the intended Netlify project/site target before deploying the frontend.
- Confirm admin or staff test credentials are available for protected-route QA.
- Confirm required production secrets are available and set in the correct environment.

## 2. Commit Plan

Preserve the current worktree in two reviewable commits. Do not include unrelated files in either commit.

### Commit 1: Phase 4D-2 Post-Sales Smart Summary

Suggested commit message:

```text
Add post-sales smart summary
```

Files:

- `src/pages/CustomerDetailPage.tsx`
- `src/types/database.ts`
- `docs/phase-4d-2-post-sales-smart-summary.md`
- `supabase/functions/generate-post-sales-summary/index.ts`
- `supabase/migrations/20260623000200_post_sales_ai_summaries_phase_4d_2.sql`

### Commit 2: Release Readiness Documentation

Suggested commit message:

```text
Add sales and AI release readiness audit
```

Files:

- `docs/release-readiness-sales-post-sales-ai.md`
- `docs/deployment-runbook-sales-post-sales-ai.md`
- Optionally `docs/phase-4d-1-lead-smart-summary.md` if its current change is only a documentation stabilization note.

## 3. Migration Order

Apply migrations in chronological order, and apply only migrations that have not already been applied to the target Supabase project.

1. `20260618000100_sales_foundation_phase_1.sql`
2. `20260619000100_reservation_deposit_workflow_phase_2.sql`
3. `20260620000100_post_sales_automation_phase_3.sql`
4. `20260623000100_lead_ai_summaries_phase_4d_1.sql`
5. `20260623000200_post_sales_ai_summaries_phase_4d_2.sql`

After migration, confirm the expected tables, indexes, triggers, and RLS policies exist before continuing with feature smoke tests.

## 4. Supabase Edge Functions to Deploy

Deploy the updated and new Edge Functions for this release:

- `generate-daily-brief`
- `generate-lead-summary`
- `generate-post-sales-summary`

Release context:

- `generate-daily-brief` was changed in Phase 4B to support expanded Daily Operations Brief sections and deterministic recommended priorities.
- `generate-lead-summary` was added in Phase 4D-1 for staff-triggered Lead Smart Summary generation.
- `generate-post-sales-summary` was added in Phase 4D-2 for staff-triggered Post-Sales Smart Summary generation.

Do not test AI summary UI against production until the relevant Edge Function deploy succeeds.

## 5. Required Environment Secrets

Confirm the AI provider secret is available in the Supabase Edge Function environment:

- `GEMINI_API_KEY` or `GOOGLE_API_KEY`

AI features with deterministic fallback should remain usable when AI is disabled or the Gemini key is missing, where fallback behavior has been implemented. Gemini-generated summaries require a configured secret and enabled provider settings.

After deployment, confirm AI settings inside the app:

- Provider is configured as expected.
- AI features are enabled or disabled according to the release plan.
- Lead Smart Summary and Post-Sales Smart Summary fallback behavior is acceptable when provider access is unavailable.

Do not hardcode secrets in source code, docs, frontend configuration, or command history.

## 6. Frontend Deployment

Deploy the frontend through the existing Netlify setup.

General steps:

1. Confirm the intended branch and commit are ready for deployment.
2. Confirm `npm run build` passes locally or in CI.
3. Deploy through the existing Netlify pipeline, dashboard, or approved CLI workflow.
4. Do not invent or hardcode Netlify project IDs, Supabase project IDs, or secrets.
5. After deployment, open the deployed URL and complete the smoke test checklist.

## 7. Smoke Test Checklist

Run these checks with an admin or staff account:

- Login succeeds.
- Dashboard loads.
- Leads page loads.
- Lead Smart Summary generate/regenerate works.
- Customer Detail loads.
- Post-Sales tab loads.
- Post-Sales Smart Summary generate/regenerate works.
- Daily Brief generates and renders expanded sections.
- Previous Daily Briefs remain readable.
- Daily Brief copy behavior works.
- Reports page loads.
- Reports CSV exports work.
- Applications page loads.
- Collections page loads.
- No public route regressions are observed.

## 8. Protected Route Browser QA

Authenticated browser and mobile QA is required once valid admin credentials are available. Do not bypass auth or create credentials only for QA.

Viewport checks:

- `360`
- `390` / `430`
- `768`
- `1280`

Routes and features to verify:

- Dashboard
- Leads
- Applications
- Customers
- Customer Detail
- Lots
- Payments
- Collections
- Daily Briefs
- Reports
- Settings
- Modals
- Forms
- Uploads
- Lead Smart Summary
- Post-Sales Smart Summary
- Daily Brief generation and copy
- Reports tabs and CSV exports

## 9. Rollback / Mitigation Notes

- If a migration fails, stop deployment and inspect the Supabase error before retrying or applying later migrations.
- If an Edge Function deploy fails, do not test or demo the related AI summary UI until the function is fixed and redeployed.
- If the Gemini secret is missing, deterministic fallback should still work where implemented, but Gemini-generated summaries should not be expected.
- If the frontend deploy fails, revert or roll back the deploy through Netlify.
- If Reports or Daily Brief rendering fails, avoid demoing those pages until fixed.
- Do not manually alter production data to force demos.
- Do not disable RLS, weaken permissions, or edit production records as a workaround.

## 10. Known Limitations

- Protected-route browser/mobile QA is pending until valid credentials are available.
- Deno is unavailable locally, so Edge Function checks may require Supabase deployment or another environment with Deno installed.
- Real-data AI prompt quality review is still recommended.
- There is no public application auto-lead creation.
- There is no duplicate lead phone/email matching yet.
- There are no auto-expiry jobs for reservations.
- Parcel status is not automated.
- There is no payment gateway or deposit payment flow.
- There is no email, WhatsApp, or calendar automation.
- There is no PDF report export.
- There is no stale-summary indicator yet.
