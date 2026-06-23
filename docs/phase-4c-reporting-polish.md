# Phase 4C: Reporting Polish

Phase 4C expands the existing Reports page. It does not add a new reporting system, migrations, Edge Functions, AI calls, automations, notifications, or operational workflow changes.

## What Was Added Or Improved

The existing Reports page now includes additional read-only operational report tabs:

- Sales Pipeline
- Follow-ups
- Site Visits
- Reservations and Deposit Readiness
- Applications polish
- Post-Sales
- Staff Workload
- Project / Lot Demand
- Collections / Payment Readiness additions in Missing Items

Existing Payments, Balances, Applications, Lots, Missing Items, summary cards, report tables, and CSV patterns were preserved.

## Data Sources Used

Existing tables/views only:

- `transactions`
- `contracts`
- `payment_requests`
- `customers`
- `applications`
- `parcels`
- `parcel_board_view`
- `leads`
- `follow_up_tasks`
- `site_visits`
- `lot_reservations`
- `post_sales_checklists`
- `post_sales_tasks`
- `admin_profiles`

No schema changes were required.

## Filters Added

Phase 4C adds practical report filters where the data is available:

- Date range filters across sales, follow-ups, site visits, reservations, applications, and post-sales sections.
- Sales filters for pipeline stage, source, and assigned staff.
- Follow-up filters for status, priority, and assigned staff.
- Site visit filters for status and assigned staff.
- Reservation filters for status and assigned staff.
- Post-sales filters for checklist status, task priority, and assigned staff.

The filters only affect the displayed report rows and CSV export rows.

## CSV Exports

CSV exports were added or extended for:

- Sales pipeline report
- Follow-ups report
- Site visits report
- Reservations / deposit readiness report
- Applications report
- Post-sales report
- Staff workload report
- Project / lot demand report

Existing CSV exports for payments, balances, applications, and lots remain in place. PDF export is deferred.

## Read-Only Boundaries

Reports are display-only. Phase 4C does not:

- Approve applications.
- Confirm deposits.
- Create, update, or release reservations.
- Create or update leads.
- Create or update post-sales checklists or tasks.
- Modify payments.
- Modify contracts.
- Modify collections calculations.
- Create customers.
- Send email, WhatsApp, or calendar messages.
- Create notifications.
- Change auth, roles, or permissions.

Deposit readiness totals are operational readiness context only and are not accounting totals.

## Known Limitations

- Authenticated protected-route browser/mobile QA remains pending until valid admin credentials are available.
- Staff workload names depend on `admin_profiles`; otherwise the assigned user ID is shown.
- Several reports link data by existing IDs only and do not infer missing relationships.
- Project / lot demand is based on available lead parcel links, application preferred parcel IDs, reservations, and site visits.
- Reservation expiry and deposit readiness remain manual operational processes; reports only surface current statuses.
- Collections/payment readiness uses existing payment, contract, payment request, and post-sales handoff data without changing calculations.

## Stabilization QA Note

The Phase 4C stabilization pass verified that the expanded Reports page remains read-only. `ReportsPage` performs only Supabase `select` queries and CSV downloads; it does not insert, update, upsert, delete, invoke Edge Functions, send messages, create notifications, or trigger workflow automation.

Report tabs were reviewed for empty data, partial linked records, missing staff profiles, missing parcel links, and missing date fields. Filters use empty values as "all" selections, and date range filtering now uses guarded date parsing consistently, including the existing Payments report.

CSV exports use the existing CSV helper, which quotes values and safely handles commas, quotes, null values, and empty datasets. Report-level date formatting now uses a local safe formatter so malformed stored dates display or export as `Date not recorded` instead of crashing the page. Balance due-date display also guards malformed due-day values.

Read-only boundaries remain unchanged. Application report additions do not affect approval behavior. Reservation and deposit readiness reporting is status/readiness context only and is not accounting. Collections/payment readiness reporting does not alter payment, contract, or collections calculations.

Remaining risks before Phase 4D are authenticated protected-route browser/mobile QA, real-data review of the wider tab set, and deciding whether high-volume reports need pagination, dedicated detail routes, or more focused exports before any AI summaries are layered on top.

## Phase 4D Recommendations

- Keep Phase 4D AI summaries focused on narrative synthesis only after these deterministic reports are validated with real staff workflows.
- Consider AI summaries for long buyer/customer timelines, not for approvals, deposits, collections calculations, or workflow automation.
- If reporting volume grows, consider dedicated detail routes for reservations, follow-up tasks, and post-sales tasks before adding richer exports.
