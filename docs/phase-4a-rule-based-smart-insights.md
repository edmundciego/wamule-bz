# Phase 4A: Rule-Based Smart Insights

Phase 4A adds deterministic smart insight panels across the CRM. These panels are computed live from existing data and are display-only.

## What Was Added

- Shared rule helpers in `src/lib/smartInsights.ts`.
- Shared UI rendering in `src/components/ui/SmartInsightsPanel.tsx`.
- Calm, consistent insight categories:
  - `info`
  - `warning`
  - `danger`
  - `success`
  - `action`

Each insight includes a title, description, tone, and optional metadata/action label. No insight writes records or triggers automation.

## Where Insights Appear

- Dashboard:
  - `Operations Insights`
  - Summarizes overdue follow-ups, site visits, expiring reservations, overdue deposits, overdue post-sales tasks, documents pending review, and collections handoff readiness.

- Leads:
  - `Buyer Insights`
  - Uses lead assignment, next action, due date, pipeline stage, contact methods, follow-up tasks, site visits, and active reservations.

- Lead reservations:
  - `Readiness Review`
  - Uses reservation expiry, deposit status, deposit due date, expected deposit amount, and open follow-up presence.

- Applications:
  - `Missing Information`
  - Uses selected lot availability, missing buyer/application fields, linked lead next action, approval status, and post-sales checklist presence.

- Customer Detail:
  - `Operations Insights`
  - Uses active contract signed upload, payment proof presence, overdue expected/requested payments, linked leads, reservations, and post-sales tasks.
  - Reservation sections also show live readiness review.
  - Post-Sales tab shows shared `Recommended Actions`.

- Collections:
  - `Operations Insights`
  - Uses overdue customers, missing signed contracts, missing receipt numbers, and missing online transfer proof.

## Rule Categories

- Lead rules:
  - Unassigned lead.
  - Missing next action.
  - Overdue next action.
  - Family decision support.
  - Payment plan clarification.
  - Site visit stage without upcoming visit.
  - Deposit pending without active reservation.
  - Missing phone, WhatsApp, and email.
  - No open follow-up task.

- Reservation/deposit rules:
  - Active reservation expires within 3 days.
  - Active reservation is past expiry.
  - Pending deposit is overdue.
  - Proof submitted needs review.
  - Confirmed deposit is ready for next step.
  - Active reservation has no open follow-up.
  - Deposit tracking has no expected amount.

- Customer/collections rules:
  - Active contract missing signed upload.
  - Online transfer missing linked proof.
  - Overdue expected/requested payment.
  - New customer without linked lead.
  - Open post-sales tasks.
  - Deposit confirmed without post-sales checklist.

- Post-sales rules:
  - Missing documents.
  - Documents pending review.
  - Agreement ready for review.
  - Agreement sent for signature.
  - Collections handoff ready.
  - Payment setup pending.
  - Checklist blocked.
  - Open post-sales task overdue.

- Application rules:
  - Selected lot may not be available.
  - Missing buyer/application details.
  - Linked lead has no next action.
  - Approved application has no post-sales checklist.
  - No linked lead.

## Guardrails

Phase 4A does not:

- Add AI calls.
- Add Edge Functions.
- Add migrations.
- Send emails or WhatsApp messages.
- Create notifications.
- Approve applications.
- Confirm deposits.
- Modify payment, contract, collections, customer, application, reservation, or document records.
- Auto-create tasks, leads, reservations, customers, or post-sales checklists.

Existing manual buttons and workflows remain unchanged.

## Display-Only Behavior

All insights are calculated in the browser from data already loaded by the relevant page. Panels only render guidance, badges, and metadata. Any operational changes still require existing staff-owned controls.

## Deferred

- Phase 4B Daily Brief expansion:
  - No changes were made to Daily Brief data generation, carryover action generation, or Edge Functions.

- Phase 4C reporting polish:
  - No new report tabs, exports, or report schemas were added.

- Phase 4D AI summaries:
  - No new AI prompts, AI settings, provider changes, or AI-generated summaries were added.

## Known Limitations

- Insight accuracy depends on staff keeping source records current.
- Reservation expiry is still manual; insights do not expire or release holds.
- Customer Detail only uses reservations directly linked to the customer for customer-level reservation insights.
- Application post-sales readiness depends on an existing checklist link.
- Authenticated protected-route browser/mobile QA remains pending until valid admin credentials are available.

## Phase 4A Stabilization QA Note

Verified during stabilization:

- Shared insight helpers remain pure and display-only.
- Insight helpers do not call Supabase, invoke Edge Functions, send messages, create records, update records, approve applications, confirm deposits, or modify payments, contracts, collections, reservations, post-sales, documents, auth, or permissions.
- Missing arrays, missing linked records, missing dates, malformed dates, and invalid dashboard counts are handled without throwing.
- Closed/won and lost/inactive leads no longer receive active sales follow-up recommendations.
- Reservation deposit proof, overdue deposit, confirmed deposit, follow-up, and expected-amount guidance is only actionable for active reservation statuses.
- Smart insight panels render a calm fallback when an empty insight list is passed.
- Long insight titles and descriptions wrap within the panel layout.
- Dashboard operations insights remain capped and prioritized toward overdue/blocking work first.

Data assumptions:

- Date values are expected to be ISO strings from Supabase; malformed dates are ignored by rule checks.
- Count-based dashboard and collections insights treat non-finite or negative counts as zero.
- Customer-level reservation insights depend on reservations directly linked to the customer.
- Payment proof checks depend on `transactions.payment_documents` being loaded with the transaction.

Remaining risks before Phase 4B:

- Authenticated protected-route browser/mobile QA is still pending until valid admin credentials are available.
- Staff process discipline remains important because insights do not auto-expire reservations, auto-complete tasks, or reconcile stale records.
- Daily Brief expansion still needs separate Phase 4B planning against sales, reservation, deposit readiness, and post-sales data.
