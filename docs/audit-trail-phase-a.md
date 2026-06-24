# Audit Trail Phase A

## What Was Added

Phase A adds the global audit foundation for future sensitive workflows.

- New table: `audit_events`
- New migration: `supabase/migrations/20260624000100_audit_events_phase_a.sql`
- New helper: `src/lib/audit.ts`
- New protected page: `/audit-trail`
- New sidebar navigation item: `Audit Trail`
- Updated generated/local database types in `src/types/database.ts`

## Audit Events Table

`audit_events` stores append-oriented history records with:

- Entity type
- Entity ID
- Action
- Title and optional summary
- Optional before/after/metadata JSON
- Actor user ID, name, and email
- Created date/time

`entity_id` is stored as text so the same table can reference Wamule records that use either UUID identifiers, such as leads and reservations, or bigint identifiers, such as customers, contracts, payments, parcels, and applications.

## RLS Behavior

The table is not public.

- Anonymous/public users: no access
- Internal users: can read audit events
- Staff/Admin/Super Admin users: can insert audit events through `can_write_admin_data()`
- Updates: not allowed by policy
- Deletes: not allowed by policy

The table is intentionally append-only for Phase A.

## Audit Helper

`src/lib/audit.ts` adds:

- `auditEntityTypes`
- `auditActions`
- `auditEntityLabels`
- `auditActionLabels`
- `formatAuditActor`
- `createAuditEvent`

The helper is available for future workflow phases, but Phase A does not wire it into existing workflows.

## Audit Trail Page

The `/audit-trail` page is read-only and shows:

- Created date/time
- Entity type
- Action
- Title and summary
- Actor
- Entity ID
- Expandable before/after/metadata details

Filters include:

- Date range
- Entity type
- Action
- Search text

The page uses existing Wamule cards, badges, fields, loading/error states, and CRM table styling.

## What This Phase Does Not Audit

Phase A does not automatically log:

- Lead changes
- Application changes
- Contract changes
- Payment or collection changes
- Reservation changes
- Post-sales task/checklist changes
- AI summary generation
- Settings changes

Future workflow phases should create audit events explicitly for sensitive actions.

## Data Safety Rules

Audit events should not store:

- API keys or provider secrets
- Full payment proof files or document bodies
- Full buyer/customer private records when a minimal summary is enough
- Sensitive data not needed to understand the event

Use concise titles, summaries, and minimal before/after fields.

## Future Contract Void Usage

The future contract void flow should write an audit event such as:

- `entity_type`: `contract`
- `action`: `voided`
- `title`: `Contract voided`
- `summary`: staff-visible reason summary
- `before_data`: minimal contract status/context
- `after_data`: void status, void reason, voided date
- `metadata`: related customer, parcel, and workflow context

Voiding should remain manual and staff-confirmed.

## Future Reservation Release Usage

The future release alternates flow should write audit events such as:

- `entity_type`: `reservation`
- `action`: `released`
- `title`: `Reservation released`
- `summary`: staff-visible release reason
- `before_data`: prior reservation status
- `after_data`: released status and released date
- `metadata`: confirmed reservation/lot that prompted the release

Releasing alternate reservations should remain manual and staff-confirmed for the MVP.

## Known Limitations

- Existing workflows are not yet writing audit events.
- The Audit Trail page shows the most recent 250 loaded entries.
- Friendly entity labels are limited to stored title/summary/entity ID until future workflows write richer metadata.
- Actor name/email are stored at event creation time when provided by the caller.
- No database triggers were added.
- No export or retention policy was added in Phase A.

## Stabilization QA Note

The stabilization pass verified:

- `audit_events` is not exposed to anonymous/public users.
- Internal users can read audit events through `is_internal_user()`.
- Staff/Admin/Super Admin users can insert audit events through `can_write_admin_data()`.
- No update or delete policy exists, keeping the table append-oriented.
- `entity_id` is consistently treated as text in the migration, types, helper, and UI.
- The Audit Trail page is read-only and exposes no edit/delete actions.
- Date range, entity type, action, and search filters are display-only.
- Empty, loading, and error states render through existing Wamule UI states.
- Long text and dense details use wrapping or local scrolling instead of page-level overflow.
- Unknown future entity/action values render with safe fallback labels.
- JSON details handle null, empty objects, arrays, primitive values, and unexpected structures safely.
- The helper is not wired into existing workflows yet.
- The helper redacts common secret/content keys before writing future audit payloads.

Data safety remains unchanged:

- No database triggers were added.
- No existing workflow logging was added.
- No contract, payment, collections, application, customer, reservation, lead, post-sales, AI, auth, role, or permission behavior was changed.
- Audit events should continue using minimal before/after/metadata payloads and should not store secrets, full documents, or unnecessary private buyer/customer details.

Readiness:

- Phase A is ready to support a future Contract Void/Cancel implementation.
- The next phase should add explicit audit inserts only for the new staff-confirmed contract void/cancel flow.

## Recommended Next Phase

Implement Contract Void/Cancel after this foundation is deployed and verified.

That phase should:

- Add the minimal contract status/void metadata needed for safe history.
- Add a staff-confirmed void action.
- Write an `audit_events` record.
- Keep payments, collections, parcel status, and contract calculations unchanged unless a later approved plan changes reporting behavior.
