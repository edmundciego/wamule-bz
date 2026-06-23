# Phase 4D-1: Lead Smart Summary

Phase 4D-1 adds a staff-controlled Lead Smart Summary. It is advisory only and does not automate sales, reservation, deposit, application, customer, payment, contract, document, collections, post-sales, messaging, notification, auth, role, or permission workflows.

## Table Added

Migration:

- `supabase/migrations/20260623000100_lead_ai_summaries_phase_4d_1.sql`

Table:

- `lead_ai_summaries`

The table stores generated lead guidance history with:

- Lead link
- Summary text
- Readiness status
- Key risks
- Missing information
- Recommended actions
- Next best action
- Confidence notes
- Source snapshot
- Provider/model metadata
- Generated user/date metadata

History is preserved. The migration does not enforce one summary per lead.

## RLS / Permissions

- Anonymous/public users have no access.
- Internal users can read lead summaries.
- Staff/Admin/Super Admin users can create summaries.
- Admin/Super Admin users can delete summaries.

The table uses existing helper patterns:

- `is_internal_user()`
- `can_write_admin_data()`
- `is_admin_user()`

## Edge Function Added

Edge Function:

- `supabase/functions/generate-lead-summary/index.ts`

The function:

- Requires an authenticated user.
- Allows Super Admin, Admin, and Staff generation.
- Accepts `lead_id`.
- Loads lead context safely.
- Builds deterministic fallback first.
- Calls Gemini only when AI is enabled, provider is Gemini, and a server-side key exists.
- Stores one generated summary row in `lead_ai_summaries`.

## Data Sources Used

The summary uses existing Wamule data:

- `leads`
- `lead_activities`
- `follow_up_tasks`
- `site_visits`
- `lot_reservations`
- linked `applications`
- linked `application_ai_reviews`
- linked `customers`
- linked `customer_ai_summaries`
- linked `parcels`
- `ai_settings`

## UI Added

`src/pages/LeadsPage.tsx` now includes a `Lead Smart Summary` panel in the selected lead detail area.

The panel shows:

- Latest summary
- Readiness status badge
- Risk flags
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

- Missing assigned staff
- Missing contact methods
- Missing next action
- Overdue next action
- Open and overdue follow-up tasks
- Site visit stage without upcoming site visit
- Active reservation presence
- Deposit pending, overdue, proof submitted, or confirmed status
- Linked application/customer presence
- Existing application review status
- Closed/won and lost/inactive lead stages

Fallback output uses the same structured shape as AI output.

## AI / Provider Gating

The Edge Function uses existing AI settings:

- `ai_settings.is_enabled`
- `ai_settings.provider`
- `ai_settings.model`
- server-side `GEMINI_API_KEY` or `GOOGLE_API_KEY`

There is no new AI settings toggle in Phase 4D-1. If AI is disabled or unavailable, the function stores deterministic fallback output.

## Privacy / Permission Notes

Lead summaries may include buyer contact details, notes, activities, reservations, application context, and customer links in the provider prompt when Gemini is enabled. Provider keys remain server-side.

The UI labels the summary as a staff review aid:

> This summary is generated from Wamule CRM data to support staff review. Staff should verify details before making decisions.

## Not Automated

Phase 4D-1 does not:

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
- Change lead pipeline stage automatically.
- Change reservation status automatically.
- Create public-facing summaries.

The only allowed write is creating a `lead_ai_summaries` record.

## Known Limitations

- Authenticated protected-route browser/mobile QA remains pending until valid admin credentials are available.
- No dedicated AI settings toggle exists for Lead Smart Summary yet.
- Summary staleness is visible through generated/source snapshot metadata, but no stale warning is shown yet.
- Summaries depend on staff keeping lead activities, tasks, visits, and reservations current.
- Deno Edge Function checking depends on local Deno availability.

## Stabilization QA Note

The Phase 4D-1 stabilization pass verified that the new table, policies, Edge Function, and Lead Detail panel remain advisory and staff-controlled.

- RLS keeps `lead_ai_summaries` unavailable to anonymous/public users, readable to internal users, insertable by Staff/Admin/Super Admin through existing write helpers, and deletable only by Admin/Super Admin.
- The Edge Function requires an authenticated user, verifies an allowed internal role before generation, validates `lead_id`, handles missing lead/context data safely, and writes only one `lead_ai_summaries` row.
- Gemini remains gated by existing `ai_settings`, provider selection, and server-side key availability. Provider failures, timeouts, missing keys, disabled AI, and invalid JSON fall back to deterministic output.
- AI output is sanitized before storage: text is trimmed, arrays remain arrays, and unknown readiness values fall back to a known status.
- The source snapshot stores CRM source metadata and related-record counts only; it does not include provider keys or AI configuration.
- The Lead Detail panel handles missing, old, or malformed summary fields defensively, including null provider/model metadata and invalid generated dates.
- The summary is a staff review aid only. It does not approve, confirm, convert, create tasks, change pipeline stages, send messages, or mutate operational records.

Manual setup still requires applying the migration and deploying the `generate-lead-summary` Edge Function with the same environment variables used by existing AI functions. Authenticated protected-route browser/mobile QA remains pending until valid admin credentials are available and should be completed before broad staff rollout.

Remaining risks before Phase 4D-2:

- Prompt quality should be reviewed with real lead records once staff credentials and representative CRM data are available.
- Summary history can grow over time because Phase 4D-1 intentionally preserves prior generations.
- A stale-summary indicator may be useful if staff regenerate summaries frequently after lead updates.

## Recommended Next Steps For Phase 4D-2

- Stabilize Lead Smart Summary with real staff workflows.
- Add stale-summary indicators if staff need them.
- Consider a separate AI settings toggle for lead summaries.
- Implement Post-Sales Checklist Summary only after Lead Smart Summary is validated.
