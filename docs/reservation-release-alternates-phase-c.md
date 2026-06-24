# Reservation Release Alternates Phase C

## What Release Alternates Does

Phase C adds a staff-confirmed way to release other active buyer-interest holds when one reservation is chosen as the primary direction.

This is for cases where a buyer has interest in multiple lots, but one lot is now the direction for deposit, application, contract, or family decision follow-up.

Releasing an alternate reservation:

- marks the alternate reservation as `released`
- sets `released_at`
- appends the release reason to reservation notes
- writes a reservation activity
- writes an audit event
- keeps the reservation visible in history

## Active / Inactive Reservation Definitions

Active/actionable statuses:

- `draft`
- `reserved`
- `deposit_pending`
- `deposit_submitted`
- `deposit_confirmed`

Inactive/history statuses:

- `converted_to_application`
- `converted_to_contract`
- `expired`
- `cancelled`
- `released`

Only active alternates can be released by this workflow.

## Matching Rules

The release flow starts from a staff-selected primary reservation.

Alternate reservations are eligible only when they:

- are active
- are not the primary reservation
- share at least one buyer context with the primary reservation:
  - same `lead_id`
  - same `application_id`
  - same `customer_id`
- are not on the same parcel as the primary reservation

Reservations without shared lead/application/customer context are skipped.

## Permission Model

The RPC uses the existing `can_write_admin_data()` helper.

- Super Admin/Admin/Staff: can release alternate reservations
- Read Only: can view reservation history but cannot release
- Anonymous/public: no access

No service-role bypass is used from the frontend.

## RPC Behavior

Migration:

- `supabase/migrations/20260624000300_reservation_release_alternates_phase_c.sql`

RPC:

- `public.release_alternate_reservations(p_primary_reservation_id, p_reservation_ids, p_release_reason)`

The RPC:

- requires staff write permission
- validates the primary reservation
- requires a non-empty release reason
- validates selected reservation IDs
- releases only eligible active alternates
- returns released IDs and skipped reservation details
- writes reservation activities and audit events in the same database transaction

## Audit Event Behavior

For each released alternate, the RPC inserts one `audit_events` row:

- `entity_type`: `reservation`
- `entity_id`: released reservation ID as text
- `action`: `released`
- `title`: `Reservation released`
- `summary`: safe high-level release context
- `before_data`: previous status, deposit status, and released timestamp
- `after_data`: released status and released timestamp
- `metadata`: primary reservation ID, release reason, lead/application/customer/parcel IDs
- actor user ID, name, and email where available

Audit payloads do not store secrets, documents, payment proof content, or unnecessary buyer/customer private details.

## Reservation Activity Behavior

For each released alternate, the RPC inserts one `reservation_activities` row:

- `activity_type`: `reservation_released`
- `title`: `Reservation released`
- `description`: release reason and primary reservation reference
- `metadata`: primary reservation ID and release reason
- `created_by`: current authenticated user

The reservation update, activity insert, and audit insert happen together in the RPC transaction.

## UI Behavior

Leads workspace:

- The reservation panel now includes `Release other reservations` on active reservation cards when eligible alternates exist.
- Staff choose a primary reservation to keep.
- Staff select which other active reservations to release.
- Staff must enter a release reason.
- The modal warns that releasing does not change parcel status, payments, deposits, contracts, applications, or customer records.

The Leads reservation list includes reservations tied by selected lead, linked application, or linked customer context so staff can see relevant alternates.

Released reservations remain visible with the existing `Released` badge and released notes/activity history.

## What Release Does Not Change

Release alternates does not:

- change parcel status
- confirm deposits
- create payments
- modify payments
- modify contracts
- modify collections calculations
- modify applications
- modify customers
- modify leads
- modify post-sales records
- delete reservations
- delete reservation activities
- send messages
- create tasks
- run automatically

## Known Limitations

- The MVP UI is in the Leads reservation panel only.
- Customer Detail and Applications can still display reservation state but do not yet launch the release alternates modal.
- The existing single-reservation quick `Release` action remains a manual reservation status update flow.
- There is no reservation settings panel yet.
- There are no auto-release jobs.
- Parcel status is not automatically updated.

## Stabilization QA Note

The stabilization pass verified:

- The RPC requires authenticated staff write permission through `can_write_admin_data()`.
- Invalid primary reservation IDs are rejected.
- Empty selected reservation lists are rejected.
- Blank release reasons are rejected.
- The primary reservation must be active.
- The primary reservation cannot be released by the alternates action.
- Only active alternates can be released.
- Released, cancelled, expired, and converted reservations are skipped.
- Alternates must share `lead_id`, `application_id`, or `customer_id` with the primary reservation.
- Unrelated reservations are skipped.
- Same-lot reservations are skipped so the kept lot is not unexpectedly released.
- The RPC returns released reservation IDs and skipped reservation details.
- Only selected eligible alternate reservations are updated.
- Released alternates get `status = 'released'`, `released_at`, and an appended release reason in notes.
- One `reservation_activities` row is inserted per released alternate.
- One `audit_events` row is inserted per released alternate.
- Reservation update, reservation activity, and audit insert happen inside the same RPC transaction.
- Audit and activity metadata include only safe operational IDs and reason text.
- The Leads modal clearly identifies the reservation being kept and the alternates selected for release.
- The modal requires staff confirmation and a non-empty release reason.
- Warning copy states that parcel status, payments, deposits, contracts, applications, and customer records are not changed.
- Released reservations remain visible in history with a `Released` badge, release date, notes, and timeline activity.
- Active reservation displays continue to use the active status set and do not count released reservations as active.

Existing single-release action:

- The Leads reservation card still has a separate quick `Release` action for a single reservation.
- That existing action remains manual and does not change parcel status, payments, contracts, applications, customers, leads, or post-sales records.
- It is not yet routed through the Phase C alternates RPC and does not currently write a global audit event.
- Auditing the existing single-release action is documented as a future hardening item rather than expanded in this pass.

What release alternates does not change:

- parcel status
- deposits or payment proof
- payments, transactions, receipts, or payment requests
- contracts or collections calculations
- applications, customers, leads, or post-sales records
- documents or AI records
- messages, notifications, or tasks

Readiness:

- Phase C is ready for Reservation Settings planning/implementation.
- Reservation Settings should remain defaults/prompts only unless automation is explicitly approved later.

## Recommended Next Phase

Implement Reservation Settings.

Recommended settings should remain workflow defaults and prompts only:

- default reservation expiry days
- default deposit due days
- require expiry date
- require expected deposit amount
- allow multiple active reservations per buyer
- block multiple active reservations per lot
- prompt to release alternates after deposit confirmed

Automation such as auto-release or parcel status changes should remain deferred until explicitly approved.
