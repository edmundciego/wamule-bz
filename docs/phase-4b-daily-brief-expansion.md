# Phase 4B: Daily Brief Expansion

Phase 4B expands the existing Daily Brief system. It does not create a new Daily Brief workflow, add migrations, add Edge Functions, add providers, send messages, create tasks, or change operational records.

## What Was Added

The existing `generate-daily-brief` Edge Function now includes Phase 1-3 operational data in the generated brief:

- Sales Activity
- Buyer Follow-ups
- Site Visits
- Reservation Readiness
- Deposit Readiness
- Post-Sales Blockers
- Collections Handoff

The existing Daily Brief page now renders these as a `Daily Operations Brief` section when present. The existing Applications, Lots, Payments, Contracts, Collections, Alerts, Previous Briefs, Copy Brief, and carryover item behavior remain in place.

## Data Sources Used

Existing tables only:

- `applications`
- `application_ai_reviews`
- `parcels`
- `transactions`
- `contracts`
- `payment_requests`
- `leads`
- `follow_up_tasks`
- `site_visits`
- `lot_reservations`
- `post_sales_checklists`
- `post_sales_tasks`
- `ai_settings`
- `ai_daily_briefs`
- `brief_action_items`

No schema changes were required. Expanded sections are stored in the existing `alerts` JSON array with `kind: "section"` so the UI can render them separately from operational alerts.

## Recommended Priorities

Recommended priorities are generated deterministically from existing records. Examples include:

- Follow up on overdue lead tasks.
- Review high-priority buyer follow-ups.
- Review reservations expiring soon.
- Review expired active reservations.
- Review overdue deposit readiness.
- Review deposit proof submissions.
- Review overdue post-sales tasks.
- Request or review post-sales documents.
- Hand off ready customers to collections.
- Review overdue payment requests.
- Start post-sales checklist when ready for approved applications.

These priorities are display-only recommendations. Existing carryover action item behavior is preserved by syncing recommendations into `brief_action_items`, as the Daily Brief system already did before Phase 4B.

## Deterministic / Rule-Based Coverage

The deterministic fallback now counts and summarizes:

- New leads in the selected period.
- Leads by pipeline stage.
- Assigned and unassigned active leads.
- Overdue lead next actions.
- Family decision, payment plan review, and deposit pending leads.
- Follow-ups due today, overdue, completed in period, and high/urgent priority.
- Site visits today, upcoming in the next 7 days, completed, cancelled, or no-show.
- Active reservations, new reservations, reservations expiring soon, expired active reservations, and released/cancelled reservations.
- Deposit pending, overdue, proof submitted, confirmed, and ready-next-step reservations.
- Pending, incomplete, AI-flagged, lot-conflict, and approved-without-post-sales-checklist applications.
- Open and overdue post-sales tasks.
- Blocked post-sales checklists.
- Agreements ready for review/signature.
- Documents missing or pending review.
- Payment setup pending.
- Collections handoff ready.
- Existing payment, contract, and collections alert categories.

## Existing AI / Fallback Behavior

The existing Daily Brief AI provider gating is preserved:

- Uses deterministic fallback when Daily Brief AI is disabled or provider secrets are unavailable.
- Uses the existing Gemini Daily Brief call only when current AI settings and secrets allow it.
- No new AI call path, model provider, or Edge Function was added.
- Gemini is instructed to preserve the deterministic `kind: "section"` objects; the function merges missing deterministic sections back into the saved brief if needed.

## Display-Only Boundaries

The expanded brief does not:

- Approve applications.
- Create customers.
- Create or update leads.
- Create or update reservations.
- Confirm deposits.
- Modify payments.
- Modify contracts.
- Modify collections calculations.
- Modify documents.
- Create or update post-sales checklists or tasks.
- Send email, WhatsApp, or calendar messages.
- Create notifications.
- Change auth, roles, or permissions.

Daily Brief recommendations and carryover items are staff review aids only.

## Guardrails

- No migrations were added.
- No new Edge Functions were added.
- No new AI providers were added.
- No new workflow automation was added.
- Existing date range generation and Belize display behavior in the UI were preserved.
- Existing previous brief display and copy behavior were preserved.

## Known Limitations

- Authenticated protected-route browser/mobile QA remains pending until valid admin credentials are available.
- Expanded section accuracy depends on staff keeping source records current.
- Reservation expiry remains manual; the brief only flags expiring or expired active reservations.
- Deposit readiness is operational tracking only and does not reconcile or alter payment records.
- Post-sales readiness is based on checklist and task statuses already entered by staff.
- Some carryover priorities link to workspace-level pages rather than a specific record detail view when no dedicated detail route exists.

## Stabilization QA Note

The Phase 4B stabilization pass verified that old Daily Brief records, expanded records, mixed `alerts` JSON shapes, `kind: "section"` alert objects, unknown alert kinds, and missing or malformed `alerts` / `recommended_actions` arrays render without crashing. The Daily Brief page now normalizes these JSON fields before comparison, section rendering, alert rendering, recommended priority rendering, and clipboard copy formatting.

The UI also handles malformed stored date values with display fallbacks instead of throwing during Previous Briefs, Latest Brief, and period comparison rendering. Existing date range inputs, Belize timezone display logic for valid stored dates, previous brief selection, copy brief behavior, AI provider gating, deterministic fallback behavior, and carryover action item behavior were preserved.

The Edge Function was reviewed for missing or empty sales, reservation, post-sales, payment, and collections data. It continues to default query results to empty arrays and uses guarded date helpers for period, overdue, today, and upcoming comparisons. Malformed source dates are ignored by rule checks rather than treated as actionable.

Display-only boundaries remain unchanged. The expansion does not alter operational records, send messages, create tasks, approve applications, confirm deposits, or modify payments, contracts, reservations, collections, documents, leads, customers, or post-sales records. The only writes remain existing Daily Brief record creation and existing brief action item carryover sync.

Remaining risks before Phase 4C are authenticated browser/mobile QA without valid admin credentials, operational accuracy when source records are stale, and the use of `alerts` JSON section objects as the compatibility layer until a future reporting phase decides whether a formal section schema is warranted.

## Phase 4C / 4D Recommendations

- Phase 4C can add formal report tabs/CSV exports for sales, reservations, deposit readiness, post-sales tasks, collections handoff, and staff workload.
- Phase 4D can evaluate AI summaries for long buyer/customer timelines after deterministic workflows are stable.
- A future reporting phase can add dedicated detail routes for reservation, follow-up task, and post-sales task records if operational volume grows.
