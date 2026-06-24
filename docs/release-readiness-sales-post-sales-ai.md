# Release Readiness: Sales, Post-Sales, Smart Assistance, and Reporting

This audit summarizes the recent Wamule CRM work from Sales Foundation through Phase 4D-2. It is a release-readiness document only. It does not add features, migrations, Edge Functions, AI calls, workflow automation, notifications, messaging, or business-logic changes.

Authenticated protected-route browser/mobile QA remains pending until valid admin credentials are available. This is a known release risk and should be completed before client/demo use.

## Completed Phases

- Phase 1: Sales Foundation
- Phase 2: Reservation + Deposit Workflow
- Phase 3: Post-Sales Automation
- Phase 4A: Rule-Based Smart Insights
- Phase 4B: Daily Brief Expansion
- Phase 4C: Reporting Polish
- Phase 4D-1: Lead Smart Summary
- Phase 4D-2: Post-Sales Checklist Summary

## Worktree Summary

Current uncommitted files at audit time:

- Phase 4D-1:
  - `docs/phase-4d-1-lead-smart-summary.md` contains an existing stabilization note and should not be reverted.
- Phase 4D-2:
  - `docs/phase-4d-2-post-sales-smart-summary.md`
  - `src/pages/CustomerDetailPage.tsx`
  - `src/types/database.ts`
  - `supabase/functions/generate-post-sales-summary/index.ts`
  - `supabase/migrations/20260623000200_post_sales_ai_summaries_phase_4d_2.sql`

No unrelated or unexpected uncommitted files were identified in this audit.

## Migration Inventory

Apply migrations in timestamp order.

### `20260618000100_sales_foundation_phase_1.sql`

Adds:

- `leads`
- `lead_activities`
- `follow_up_tasks`
- `site_visits`

Includes:

- FK links to applications, customers, parcels, leads, and `auth.users`.
- Check constraints for lead email, pipeline stage, budgets, activity types, task status/priority, and site visit status.
- Indexes for pipeline stage, assigned staff, due dates, application/customer/parcel links, lead activity timelines, follow-up status/due date, and site visit status/schedule.
- Partial unique index for one lead per linked application.
- `set_updated_at()` triggers for updateable tables.
- RLS for internal read, staff/admin write, admin delete.

Types:

- `src/types/database.ts` includes sales table and enum types.

### `20260619000100_reservation_deposit_workflow_phase_2.sql`

Adds:

- `lot_reservations`
- `reservation_activities`

Includes:

- FK links to leads, applications, customers, parcels, transactions, contracts, and `auth.users`.
- Check constraints for reservation status, deposit status, non-negative deposit amount, metadata object shape, and linked context.
- Unique reservation code index.
- Partial unique index preventing more than one active reservation per parcel.
- Indexes for linked records, status, deposit status, expiry, deposit due date, assigned staff, and reservation activity timeline.
- `set_updated_at()` trigger for reservations.
- RLS for internal read, staff/admin write, admin delete.

Types:

- `src/types/database.ts` includes reservation and activity types.

### `20260620000100_post_sales_automation_phase_3.sql`

Adds:

- `post_sales_checklists`
- `post_sales_tasks`
- `post_sales_activities`

Includes:

- FK links to customers, applications, contracts, leads, reservations, tasks, checklists, and `auth.users`.
- Check constraints for checklist, agreement, document, handoff, payment setup, task type/status/priority, metadata object shape, and linked context.
- Partial unique index for one active non-cancelled checklist per customer.
- Indexes for linked records, statuses, assigned staff, task due dates, and activity timelines.
- `set_updated_at()` triggers for checklists and tasks.
- RLS for internal read, staff/admin write, admin delete.

Types:

- `src/types/database.ts` includes post-sales checklist/task/activity types.

### `20260623000100_lead_ai_summaries_phase_4d_1.sql`

Adds:

- `lead_ai_summaries`

Includes:

- FK link to `leads`.
- JSON array checks for risks, missing information, and recommended actions.
- Readiness status check constraint.
- Source snapshot object check.
- Indexes for lead, generated date, and readiness status.
- `set_updated_at()` trigger.
- RLS for internal read, staff/admin insert, admin delete.

Types:

- `src/types/database.ts` includes `LeadAiSummary`.

### `20260623000200_post_sales_ai_summaries_phase_4d_2.sql`

Adds:

- `post_sales_ai_summaries`

Includes:

- FK link to `post_sales_checklists`.
- Optional FK links to customers, applications, contracts, leads, and reservations.
- JSON array checks for blockers, missing information, and recommended actions.
- Readiness status check constraint.
- Source snapshot object check.
- Indexes for checklist, customer, generated date, and readiness status.
- `set_updated_at()` trigger.
- RLS for internal read, staff/admin insert, admin delete.

Types:

- `src/types/database.ts` includes `PostSalesAiSummary` and `PostSalesAiReadinessStatus`.

## Edge Function Inventory

### `generate-daily-brief`

Purpose:

- Generates Daily Operations Brief records with deterministic operational sections and optional Gemini narrative support.

Required secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- Optional AI provider key: `GEMINI_API_KEY` or `GOOGLE_API_KEY`

Gemini:

- Used only when `ai_settings.is_enabled`, `ai_settings.daily_brief_enabled`, provider is `Gemini`, and a server-side provider key exists.

Fallback:

- Deterministic fallback exists.

Writes:

- Creates `ai_daily_briefs`.
- Preserves existing carryover action item behavior through `brief_action_items`.

Must not mutate:

- Applications, leads, reservations, payments, contracts, collections, customers, documents, post-sales records, messages, notifications, or auth/roles.

### `generate-lead-summary`

Purpose:

- Generates staff-triggered Lead Smart Summary records for buyer status, readiness, risks, missing information, and recommended staff review notes.

Required secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- Optional AI provider key: `GEMINI_API_KEY` or `GOOGLE_API_KEY`

Gemini:

- Used only when global AI is enabled, provider is `Gemini`, and a server-side provider key exists.

Fallback:

- Deterministic fallback exists for disabled AI, missing key/config, provider failure, timeout, or invalid JSON.

Writes:

- Creates one `lead_ai_summaries` row.

Must not mutate:

- Leads, activities, follow-up tasks, site visits, reservations, applications, customers, payments, contracts, collections, documents, post-sales records, messages, notifications, or auth/roles.

### `generate-post-sales-summary`

Purpose:

- Generates staff-triggered Post-Sales Smart Summary records for checklist readiness, blockers, missing information, recommended staff review notes, and handoff readiness.

Required secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- Optional AI provider key: `GEMINI_API_KEY` or `GOOGLE_API_KEY`

Gemini:

- Used only when global AI is enabled, provider is `Gemini`, and a server-side provider key exists.

Fallback:

- Deterministic fallback exists for disabled AI, missing key/config, provider failure, timeout, or invalid JSON.

Writes:

- Creates one `post_sales_ai_summaries` row.

Must not mutate:

- Post-sales checklists, tasks, activities, customers, applications, contracts, payments, collections, documents, leads, reservations, messages, notifications, or auth/roles.

## Feature Inventory

### Sales Pipeline / Leads

- Internal `/leads` workspace.
- Lead create/edit.
- Pipeline stage tracking.
- Assigned staff tracking.
- Buyer details, contact details, preferred lot, linked application/customer.
- Lead activity timeline.
- Application-to-lead creation from admin Applications page.
- Customer Detail linked lead visibility.

### Follow-Ups

- Follow-up task create/update.
- Status, priority, assigned staff, due date.
- Due today and overdue visibility.
- Dashboard and Reports coverage.

### Site Visits

- Site visit scheduling.
- Visit status updates for scheduled, completed, no-show, cancelled, and rescheduled.
- Dashboard and Reports coverage.

### Reservations

- Lot reservation tracking from Leads and Applications.
- Reservation statuses and activities.
- Active reservation duplicate prevention per parcel.
- Lots page active reservation visibility separate from parcel core status.

### Deposit Readiness

- Expected deposit amount.
- Deposit due/paid dates.
- Deposit statuses.
- Linked payment reference when staff manually links an existing payment.
- Deposit readiness insights and reporting.

### Post-Sales Checklist

- Customer Detail Post-Sales tab.
- Checklist statuses for agreement, documents, payment setup, and collections handoff.
- Post-sales task create/update.
- Post-sales activity timeline.
- Applications and Dashboard visibility.

### Rule-Based Smart Insights

- Shared `src/lib/smartInsights.ts`.
- Shared `src/components/ui/SmartInsightsPanel.tsx`.
- Dashboard Operations Insights.
- Leads Buyer Insights.
- Reservation readiness reviews.
- Application insights.
- Customer Operations Insights.
- Post-Sales Recommended Actions.
- Collections insights.

### Daily Operations Brief

- Expanded Daily Operations Brief sections:
  - Sales Activity
  - Buyer Follow-ups
  - Site Visits
  - Reservation Readiness
  - Deposit Readiness
  - Applications
  - Post-Sales Blockers
  - Collections Handoff
  - Recommended Priorities
- Old/new brief compatibility and copy formatting hardening.

### Reports

- Sales Pipeline report.
- Follow-ups report.
- Site Visits report.
- Reservations and Deposit Readiness report.
- Application report polish.
- Post-Sales report.
- Staff Workload report.
- Project / Lot Demand report.
- CSV export hardening.
- Read-only safety review.

### Lead Smart Summary

- New `lead_ai_summaries` table.
- New `generate-lead-summary` Edge Function.
- Lead Detail panel in Leads workspace.
- Staff-triggered Generate/Regenerate.
- Deterministic fallback and optional Gemini.

### Post-Sales Smart Summary

- New `post_sales_ai_summaries` table.
- New `generate-post-sales-summary` Edge Function.
- Post-Sales Smart Summary panel in Customer Detail Post-Sales tab.
- Staff-triggered Generate/Regenerate.
- Deterministic fallback and optional Gemini.

## Safety Boundaries

The implemented work remains staff-controlled and does not automatically:

- Approve applications.
- Confirm deposits.
- Create payments.
- Modify payment calculations.
- Modify contract calculations.
- Modify collections calculations.
- Mark documents approved.
- Send emails or WhatsApp messages.
- Create tasks automatically.
- Change parcel status automatically.
- Auto-expire reservations.
- Change lead stages automatically.
- Change post-sales statuses automatically.

Reports and insight panels are display-only. AI summaries write only their dedicated summary records.

## Deployment Checklist

- Apply migrations in order:
  - `20260618000100_sales_foundation_phase_1.sql`
  - `20260619000100_reservation_deposit_workflow_phase_2.sql`
  - `20260620000100_post_sales_automation_phase_3.sql`
  - `20260623000100_lead_ai_summaries_phase_4d_1.sql`
  - `20260623000200_post_sales_ai_summaries_phase_4d_2.sql`
- Regenerate Supabase types if deployment workflow depends on CLI-generated types.
- Deploy updated frontend.
- Deploy Edge Functions:
  - `generate-daily-brief`
  - `generate-lead-summary`
  - `generate-post-sales-summary`
- Confirm required Supabase Function secrets:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `GEMINI_API_KEY` or `GOOGLE_API_KEY` if Gemini output is desired.
- Confirm AI settings in app:
  - Global AI enabled status.
  - Daily Brief setting.
  - Provider set to Gemini when AI calls are desired.
  - Model configured.
- Confirm RLS policies for all new sales, reservation, post-sales, and AI summary tables.
- Confirm admin/staff/read-only permissions.
- Confirm Daily Brief generation.
- Confirm Lead Summary generation.
- Confirm Post-Sales Summary generation.
- Confirm Reports render.
- Confirm Dashboard render.
- Complete protected-route browser/mobile QA once credentials are available.

## Manual QA Checklist

Run with valid admin credentials.

- Login.
- Dashboard renders and shows sales, reservation, post-sales, daily operations, and smart insight sections.
- Leads page loads.
- Create and edit a lead.
- Generate and regenerate Lead Smart Summary.
- Create and update follow-up tasks.
- Create and update site visits.
- Create and update reservation.
- Review deposit readiness statuses.
- Applications page linked lead/reservation/post-sales visibility.
- Customer Detail loads.
- Customer Detail Overview shows linked lead/reservation/post-sales context.
- Post-Sales tab loads.
- Start/update post-sales checklist.
- Create/update post-sales tasks.
- Generate and regenerate Post-Sales Smart Summary.
- Collections page renders and insights remain display-only.
- Daily Brief generation works.
- Daily Brief copy behavior includes expanded sections.
- Previous Daily Briefs render.
- Reports tabs render.
- Reports CSV exports work.
- Mobile viewports:
  - 360px
  - 390px / 430px
  - 768px
  - 1280px

## Known Limitations

- Authenticated protected-route browser/mobile QA is pending until valid admin credentials are available.
- Deno is unavailable locally in the current development environment, so local Edge Function `deno check` could not be run.
- Real-data AI prompt quality review is still needed for Lead Smart Summary and Post-Sales Smart Summary.
- Customer reservation insights only use directly linked customer reservations.
- Public application submission does not auto-create leads.
- Duplicate phone/email lead matching is not implemented yet.
- Reservation expiry is manual; there are no auto-expiry jobs.
- Parcel status is not automated from reservations.
- There is no payment gateway or deposit payment flow.
- There is no email, WhatsApp, or calendar automation.
- PDF reporting export is deferred.
- Stale-summary indicators are not implemented yet.
- Summary history can grow over time for lead and post-sales AI summaries.

## Recommended Next Steps

- Complete authenticated protected-route desktop and mobile QA with valid admin credentials before client/demo use.
- Apply the Phase 4D-2 migration and deploy `generate-post-sales-summary`.
- Verify production/staging Supabase secrets and AI settings.
- Run a real-data review for generated Lead and Post-Sales summaries.
- Consider stale-summary indicators after staff confirm the summary workflow.
- Defer Daily Operations Narrative and Reports Executive Summary until users validate the deterministic Daily Brief and Reports workflows.
