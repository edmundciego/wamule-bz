# Phase 4D-2: Post-Sales Smart Summary

Phase 4D-2 adds a staff-controlled Post-Sales Smart Summary for checklist readiness review. It is advisory only and does not automate post-sales, document, contract, payment, collections, customer, lead, reservation, messaging, notification, auth, role, or permission workflows.

## Table Added

Migration:

- `supabase/migrations/20260623000200_post_sales_ai_summaries_phase_4d_2.sql`

Table:

- `post_sales_ai_summaries`

The table stores generated post-sales checklist guidance history with:

- Checklist link
- Customer/application/contract/lead/reservation links when available
- Summary text
- Readiness status
- Key blockers
- Missing information
- Recommended actions
- Next best action
- Confidence notes
- Source snapshot
- Provider/model metadata
- Generated user/date metadata

History is preserved. The migration does not enforce one summary per checklist.

## RLS / Permissions

- Anonymous/public users have no access.
- Internal users can read post-sales summaries.
- Staff/Admin/Super Admin users can create summaries.
- Admin/Super Admin users can delete summaries.

The table uses existing helper patterns:

- `is_internal_user()`
- `can_write_admin_data()`
- `is_admin_user()`

## Edge Function Added

Edge Function:

- `supabase/functions/generate-post-sales-summary/index.ts`

The function:

- Requires an authenticated user.
- Allows Super Admin, Admin, and Staff generation.
- Accepts `checklist_id`.
- Validates `checklist_id` as a UUID.
- Loads post-sales checklist context safely.
- Builds deterministic fallback first.
- Calls Gemini only when AI is enabled, provider is Gemini, and a server-side key exists.
- Stores one generated summary row in `post_sales_ai_summaries`.

## Data Sources Used

The summary uses existing Wamule data:

- `post_sales_checklists`
- `post_sales_tasks`
- `post_sales_activities`
- linked `customers`
- linked `applications`
- linked `contracts`
- linked `leads`
- linked `lot_reservations`
- linked customer payment documents, payment requests, and payment count metadata
- `ai_settings`

The source snapshot stores related record IDs/counts and does not include provider secrets or AI configuration.

## UI Added

`src/pages/CustomerDetailPage.tsx` now includes a `Post-Sales Smart Summary` panel inside the existing Post-Sales tab when a checklist exists.

The panel shows:

- Latest summary for the checklist
- Readiness status badge
- Blockers
- Missing information
- Recommended actions
- Next best action
- Confidence notes
- Generated date
- Provider/model
- Generate / Regenerate button for staff users

Generation is staff-triggered only. Summaries are not generated automatically on page load.

## Deterministic Fallback

The fallback summary checks:

- Checklist blocked status
- Missing or pending-review documents
- Agreement ready for review, sent for signature, signed, or blocked status
- Payment setup pending, ready, active, or blocked status
- Collections handoff ready, handed off, or blocked status
- Open and overdue post-sales tasks
- Missing customer/application/contract links
- Confirmed reservation deposit with remaining handoff steps
- Missing assigned staff

Fallback output uses the same structured shape as AI output.

## AI / Provider Gating

The Edge Function uses existing AI settings:

- `ai_settings.is_enabled`
- `ai_settings.provider`
- `ai_settings.model`
- server-side `GEMINI_API_KEY` or `GOOGLE_API_KEY`

There is no new AI settings toggle in Phase 4D-2. If AI is disabled, unavailable, times out, or returns invalid JSON, the function stores deterministic fallback output.

## Privacy / Permission Notes

Post-sales summaries may include customer contact details, checklist notes, task descriptions, activity history, reservation/deposit context, contract metadata, and payment readiness counts in the provider prompt when Gemini is enabled. Provider keys remain server-side.

The UI labels the summary as a staff review aid:

> This summary is generated from Wamule CRM data to support staff review. Staff should verify details before making decisions.

## Not Automated

Phase 4D-2 does not:

- Approve applications.
- Confirm deposits.
- Modify payments.
- Modify contracts.
- Modify collections.
- Mark documents approved.
- Change post-sales status.
- Create customers.
- Create tasks automatically.
- Send emails or WhatsApp messages.
- Change checklist status automatically.
- Change reservation status automatically.
- Create public-facing summaries.

The only allowed write from the new function is creating a `post_sales_ai_summaries` record.

## Known Limitations

- Authenticated protected-route browser/mobile QA remains pending until valid admin credentials are available.
- No dedicated AI settings toggle exists for Post-Sales Smart Summary yet.
- Summary staleness is visible through generated/source snapshot metadata, but no stale warning is shown yet.
- Summaries depend on staff keeping checklist statuses, tasks, activities, and linked records current.
- The function uses payment/readiness metadata only; it does not recalculate accounting or collections balances.
- Deno Edge Function checking depends on local Deno availability.

## Stabilization QA Note

The Phase 4D-2 stabilization pass verified that the new table, policies, Edge Function, and Customer Detail Post-Sales panel remain advisory and staff-controlled.

- RLS keeps `post_sales_ai_summaries` unavailable to anonymous/public users, readable to internal users, insertable by Staff/Admin/Super Admin through existing write helpers, and deletable only by Admin/Super Admin.
- The Edge Function requires an authenticated user, verifies an allowed internal role before generation, validates `checklist_id`, handles missing checklist/context data safely, and writes only one `post_sales_ai_summaries` row.
- Gemini remains gated by existing `ai_settings`, provider selection, and server-side key availability. Provider failures, timeouts, missing keys, disabled AI, and invalid JSON fall back to deterministic output.
- AI output is sanitized before storage: text is trimmed, arrays remain arrays, and unknown readiness values fall back to a known status.
- The source snapshot stores CRM source metadata and related-record counts only; it does not include provider keys or AI configuration.
- The Customer Detail Post-Sales panel handles missing, old, or malformed summary fields defensively, including null provider/model metadata and invalid generated dates.
- The summary is a staff review aid only. It does not approve, confirm, convert, create tasks, change checklist status, change reservation status, send messages, or mutate operational records.

Manual setup still requires applying the migration and deploying the `generate-post-sales-summary` Edge Function with the same environment variables used by existing AI functions. Authenticated protected-route browser/mobile QA remains pending until valid admin credentials are available and should be completed before broad staff rollout.

Remaining risks before future AI phases:

- Prompt quality should be reviewed with real post-sales records once staff credentials and representative CRM data are available.
- Summary history can grow over time because Phase 4D-2 intentionally preserves prior generations.
- A stale-summary indicator may be useful if staff regenerate summaries after checklist, task, or handoff updates.

## Recommended Next Steps For Future AI Phases

- Stabilize Post-Sales Smart Summary with real staff workflows.
- Add stale-summary indicators if staff need them.
- Consider a separate AI settings toggle for post-sales summaries.
- Defer Daily Operations Narrative until Daily Brief users confirm narrative needs.
- Defer Reports Executive Summary until management trend and baseline requirements are clear.
