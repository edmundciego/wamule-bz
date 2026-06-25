# Protected Pages Visual QA Polish

## Scope

This follow-up pass focused only on authenticated visual/layout QA after the workflow explanation, audit trail, contract void, reservation release, and reservation settings work.

No feature, schema, workflow, auth, payment, contract, collections, application approval, customer creation, reservation, post-sales, AI, Edge Function, RPC, or RLS behavior was changed.

## Credentials

Temporary QA credentials were available through the approved local handoff method.

Credentials were not printed, committed, or stored in repo files.

## Viewports Tested

- 360px
- 430px
- 768px
- 1280px
- 1440px
- 1920px

## Pages Tested

- Dashboard
- Leads
- Lots
- Applications
- Customers list
- Customer Detail (`/customers/3` in the QA data)
- Contracts
- Payments
- Collections
- Daily Briefs
- Reports
- Emails / Notifications
- Settings
- Audit Trail

## Screens / Sections Reviewed

- Leads Sales Pipeline filters and table
- Lead detail side panel behavior around desktop breakpoints
- Lots list/grid layout
- Application cards and linked lead/reservation panels
- Customer list and Customer Detail tabs/panels
- Contract history and contract list layout
- Payment cards, payment editor, document upload panels
- Collections insights and list layout
- Daily Brief current/previous briefs sections
- Reports tabs, filters, summary cards, CSV buttons, and dense report tables
- Email Center queue and preview layout
- Settings tabs, CRM Workflow Guide, Reservation Settings
- Audit Trail filters and table

## Issues Found

- Leads Sales Pipeline filter labels could visually overlap at desktop widths because the page used a two-column layout while the filter row also switched to a four-column layout inside the narrower left card.
- The same desktop breakpoint made the Lead detail side panel appear earlier than the available content width supported cleanly.
- Automated checks flagged wide Daily Brief and Reports tables at mobile/tablet widths. These remained inside horizontal scroll containers and did not cause page-level overflow.
- Automated checks flagged repeated Payments editor labels as overlaps. Manual/code review showed these were repeated labels in multiple payment cards rather than one visible form collision.

## Issues Fixed

- Delayed the Leads page two-column workspace from `xl` to `2xl` so the Sales Pipeline card keeps enough width at 1280px and 1440px.
- Changed the Sales Pipeline filter grid to stack cleanly on mobile, use two columns at normal tablet/desktop widths, and only use the four-column filter row at `2xl`.
- Added safer filter grid sizing with `min-w-0` and `minmax(220px, 1fr)` for the Search field.

## Follow-Up QA Result

- Leads Sales Pipeline labels did not overlap at 360, 430, 768, 1280, 1440, or 1920px.
- All protected pages tested had `0` page-level horizontal overflow at all tested viewports.
- Daily Briefs and Reports dense tables remain intentionally horizontally scrollable inside their table wrappers.
- No visible route errors were detected during the browser sweep.

## Pages Not Tested

All requested protected pages were tested.

Public routes were not part of this focused protected-page visual pass.

## Data Safety Confirmation

No records were created, updated, deleted, approved, voided, released, confirmed, sent, uploaded, or otherwise mutated during this pass.

Only layout classes and documentation were changed.

## Remaining Known Visual Limitations

- Dense report and Daily Brief history tables intentionally require horizontal scrolling on small screens.
- The automated visual script detects table internals that extend beyond the viewport even when contained by an intentional scroll wrapper.
- The automated label-overlap detector can flag repeated labels in separate repeated cards when those cards share similar offscreen coordinates.
