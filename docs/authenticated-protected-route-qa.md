# Authenticated Protected Route QA

## Status

Authenticated protected-route QA was completed through the normal login UI using temporary QA credentials from the approved local handoff method.

No credentials are written in this document. No credentials were printed, committed, or stored in repo files. No auth bypass was attempted. No admin users were created. No browser passwords, service-role UI bypass, or production data shortcuts were used.

## Credentials Availability

- Credentials available to this session: Yes
- Credential source: approved local `.env` handoff variables
- Credentials printed or stored in repo files: No

## Viewports Tested

The authenticated route sweep was run at:

- 360px mobile
- 430px mobile
- 768px tablet
- 1280px desktop

## Pages Tested

Protected routes tested after login:

- Dashboard
- Leads / Sales Pipeline
- Lots
- Applications
- Customers
- Customer Detail (`/customers/1`)
- Payments
- Collections
- Daily Briefs
- Reports
- Emails / Notifications
- Settings

## Feature Areas Checked

- Dashboard widgets and Operations Insights render.
- Leads list, Buyer Insights, reservations, follow-ups, site visits, and Lead Smart Summary panel render.
- Lots active reservation badges and status display render.
- Applications cards, linked lead/reservation/post-sales sections, and insight panels render.
- Customers list and Customer Detail render.
- Customer Operations Insights, reservation/deposit readiness, payments/contracts sections, post-sales tab, and Post-Sales Smart Summary panel render.
- Payments tables/cards, proof areas, receipt fields, and upload controls render.
- Collections page and Operations Insights render.
- Daily Brief expanded sections, carryover action items, previous briefs, and copy/generate controls render.
- Reports tabs, filters, CSV button, and dense report tables render.
- Emails / Notifications page renders.
- Settings, AI settings, user management layout, and CRM Workflow Guide render.

## Issues Found

Initial authenticated browser sweep found layout-only issues:

- Payments had mobile document-level horizontal overflow at 360px caused by intrinsic form/card widths.
- Daily Briefs had mobile/tablet document-level horizontal overflow from the custom brief form, action rows, and previous briefs table.
- Reports had mobile/tablet/desktop document-level horizontal overflow from tab/export/table layout.
- Settings tabs overflowed on mobile.
- Customer Detail tabs overflowed on mobile.

No console errors were observed during the sweep.

## Issues Fixed

Safe UI/responsive fixes were applied:

- Added `min-w-0` and `max-w-full` constraints to shared Field/Input/Select/Textarea controls.
- Updated shared Button styling to allow wrapping and avoid forcing narrow mobile overflow.
- Added `min-w-0` to shared Card, CardHeader, and CardContent wrappers.
- Updated CRM tabs to wrap instead of forcing offscreen tab buttons.
- Added `overflow-x-hidden` and `min-w-0` constraints to the admin layout content shell.
- Adjusted Payments page grid columns to use `minmax(0, ...)`.
- Adjusted Daily Briefs custom brief form and action rows for mobile/tablet.
- Reduced previous-brief table minimum width on mobile while preserving horizontal scroll.
- Adjusted Reports summary/export layout so CSV buttons fit mobile widths.
- Kept dense report and previous-brief tables horizontally scrollable where needed.

Second authenticated sweep result:

- Dashboard: passed all tested viewports.
- Leads: passed all tested viewports.
- Lots: passed all tested viewports.
- Applications: passed all tested viewports.
- Customers: passed all tested viewports.
- Payments: passed all tested viewports.
- Collections: passed all tested viewports.
- Emails / Notifications: passed all tested viewports.
- Settings: passed all tested viewports.
- Customer Detail: passed all tested viewports.
- Daily Briefs: no document-level horizontal overflow remained; previous briefs table remains intentionally horizontally scrollable on small screens.
- Reports: no document-level horizontal overflow remained; dense report tables remain intentionally horizontally scrollable on small screens.

## Routes / Workflows Not Tested

The following mutating or external-output actions were not executed during this pass:

- Lead Smart Summary generate/regenerate.
- Post-Sales Smart Summary generate/regenerate.
- Daily Brief generation.
- Creating/editing leads, follow-ups, site visits, reservations, applications, payments, post-sales tasks, users, or settings.
- Uploading payment proof or document files.
- Sending emails or notifications.
- CSV download file contents beyond confirming report tabs and CSV controls render.

These were intentionally avoided to preserve production data and avoid workflow mutations. The pass focused on authenticated rendering, responsive layout, empty/loading/error state visibility, summary panel rendering, tab behavior, and table/card usability.

## Known Limitations

- Browser QA was automated and screenshot-assisted, not a full manual exploratory QA session.
- Public-route regression was not the focus of this pass.
- Dense reports and previous Daily Brief tables intentionally use horizontal scroll on small screens.
- Real-data AI prompt quality review remains recommended.

## Data Safety Confirmation

No business logic or calculations were changed.

This pass did not alter:

- Payments
- Contracts
- Collections calculations
- Application approval
- Customer creation
- Lead workflows
- Reservations or deposits
- Post-sales workflows
- Documents
- Auth, roles, or permissions
- AI behavior

No production records were created, updated, deleted, approved, confirmed, or otherwise mutated.

## Validation

Validation was run after the responsive fixes:

- `npm run typecheck`: passed
- `npm run lint`: passed with the existing `src/components/ui/Badge.tsx` Fast Refresh warning
- `npm run build`: passed with the existing Vite chunk-size warning

## Demo / Client Review Readiness

The protected CRM routes covered in this pass are ready for demo/client review from a responsive rendering standpoint.

Before a production demo, avoid exercising mutating actions unless the demo data has been approved for test changes.
