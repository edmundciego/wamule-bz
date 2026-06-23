# Reservation + Deposit Workflow Phase 2

Phase 2 adds internal reservation and deposit readiness tracking for Wamule. It does not change parcel availability rules, application approval behavior, customer creation, contract calculations, payment calculations, payment ledger behavior, collections logic, auth behavior, Edge Functions, or public payment flows.

## Tables Added

Migration: `supabase/migrations/20260619000100_reservation_deposit_workflow_phase_2.sql`

New tables:

- `lot_reservations`
- `reservation_activities`

The tables use UUID primary keys, existing timestamp conventions, `set_updated_at()` on reservations, and references to existing `leads`, `applications`, `customers`, `parcels`, `transactions`, `contracts`, and `auth.users` where applicable.

## Status Definitions

Reservation statuses:

- `draft`
- `reserved`
- `deposit_pending`
- `deposit_submitted`
- `deposit_confirmed`
- `converted_to_application`
- `converted_to_contract`
- `expired`
- `cancelled`
- `released`

Deposit statuses:

- `not_requested`
- `pending`
- `proof_submitted`
- `confirmed`
- `overdue`
- `waived`
- `cancelled`

Active reservation statuses for duplicate hold prevention:

- `draft`
- `reserved`
- `deposit_pending`
- `deposit_submitted`
- `deposit_confirmed`

The migration prevents more than one active reservation for the same `parcel_id` through a partial unique index. Historical cancelled, released, expired, or converted reservations are not blocked.

## RLS / Permissions

Reservation tables are private to authenticated internal users.

- Internal users can read reservations and reservation activities through `public.is_internal_user()`.
- Super Admin/Admin/Staff can create and update reservations through `public.can_write_admin_data()`.
- Super Admin/Admin can delete reservation records through `public.is_admin_user()`.
- Anonymous/public users have no direct access.

## Deposit Tracking Behavior

Phase 2 tracks deposit readiness only:

- Expected deposit amount
- Deposit due date
- Deposit paid/confirmed date
- Deposit status
- Optional link to an existing `transactions` payment record

It does not create payments, mark payments paid, alter balances, generate receipts, confirm proof automatically, or change contract/payment calculations.

## Reservation Linking

Reservations can link to:

- A lead through `lead_id`
- An application through `application_id`
- A customer through `customer_id`
- A lot through `parcel_id`
- An existing payment through `payment_id`
- Converted application/contract references when useful later

Current UI support:

- Leads page: create and manage reservations from Lead Detail.
- Applications page: create a draft reservation from an application when a lot is linked or selected.
- Lots page: display active reservations separately from parcel core status.
- Customer Detail: show linked reservation/deposit readiness when a customer reservation exists.
- Dashboard: show active reservations, expiring reservations, deposit pending, overdue deposits, and deposit-confirmed readiness.

## Activity Timeline

`reservation_activities` records reservation-level events:

- `reservation_created`
- `status_change`
- `deposit_status_change`
- `reservation_released`
- `expiration_updated`
- `application_linked`
- `contract_linked`
- `payment_linked`
- `note`

The Leads workspace displays these events inside each reservation card.

## What Is Intentionally Not Changed

- Existing `parcels.status` is not automatically updated by Phase 2 reservations.
- Existing `approve_application` remains the authority for application approval and parcel reservation during approval.
- Existing payment recording remains the only ledger path.
- Contract creation and calculations are unchanged.
- Public application submission is unchanged.
- No payment gateway, WhatsApp, email, calendar, background expiry job, or AI Edge Function was added.

## Known Limitations

- Reservations do not auto-expire; staff must mark expired/released/cancelled manually.
- Deposit proof is tracked by status only unless staff links an existing payment record later.
- Applications can create a draft reservation when a lot is already linked to the application record or selected in the admin application review card.
- Customer Detail currently shows reservations directly linked by `customer_id`; reservations linked only through a lead are managed in the Leads workspace.
- Authenticated protected-route browser/mobile QA is still pending until valid admin credentials are available.

## Phase 2 QA Note

Stabilization review verified:

- Reservation tables follow the existing private-internal RLS pattern.
- Anonymous/public users do not receive reservation table access.
- Read-only internal users can read reservation records but cannot create, update, or delete them.
- Super Admin/Admin/Staff write access uses the existing `can_write_admin_data()` helper.
- Delete access is restricted to `is_admin_user()`.
- Nullable links to leads, applications, customers, parcels, payments, and contracts use `on delete set null` where appropriate.
- Active duplicate prevention is limited to active parcel holds and does not block historical released, cancelled, expired, or converted reservations.
- Lead-created reservations do not update parcel status, payment records, contract records, application approval, or customer creation.
- Application-created reservations are admin/staff initiated and do not change public submission or approval behavior.
- Customer Detail hides the reservation panel when no linked reservation exists.
- Lots page displays active reservation tracking separately from core parcel status.
- Dashboard reservation/deposit widgets handle empty reservation data and count active reservation statuses only.
- Reservation and deposit status badges cover all Phase 2 statuses.
- Deposit due/overdue logic is display-only and does not mutate payment data.
- Release/cancel actions update reservation tracking only and do not alter parcel status or payments.
- Reservation activity writes are non-blocking: if a timeline note fails after the reservation save, the reservation remains saved and the UI refreshes the source of truth.

Deposit tracking boundaries:

- Phase 2 can track expected deposit amount, due date, paid/confirmed date, deposit status, and an optional existing payment link.
- Phase 2 does not create payment records, alter balances, generate receipts, confirm proof automatically, or replace the payment ledger.

Required manual setup:

- Apply `20260618000100_sales_foundation_phase_1.sql` before Phase 2.
- Apply `20260619000100_reservation_deposit_workflow_phase_2.sql`.
- Regenerate remote Supabase types after applying migrations if the team uses CLI-generated types in deployment.
- Complete authenticated protected-route browser/mobile QA once valid admin credentials are available.

Remaining risks before Phase 3:

- Reservation release/cancel is manual and depends on staff process discipline.
- Customer Detail only shows reservations directly linked to `customer_id`; lead-only reservations remain in the Leads workspace.
- There is no duplicate buyer matching by phone/email yet.
- There is no automated handoff from confirmed deposit to application, contract, or collections workflows.

## Phase 3 Recommendations

- Decide whether reservation creation should optionally set `parcels.status = Reserved` under strict rules.
- Add a staff-facing reservation detail or follow-up center if volume grows.
- Add document checklist automation for agreement readiness.
- Add safe sales-to-contract and sales-to-collections handoff tasks.
- Add reservation reporting after real usage patterns are clear.
- Consider a scheduled expiry review only after operational rules are confirmed.
