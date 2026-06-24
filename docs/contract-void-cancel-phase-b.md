# Contract Void/Cancel Phase B

## What Was Added

Phase B adds a safe contract correction path for contracts created by mistake.

The implemented normal correction path is:

- Void Contract

Hard delete was not added as a normal workflow.

## Data Fields Added

Migration:

- `supabase/migrations/20260624000200_contract_void_cancel_phase_b.sql`

Added to `public.contracts`:

- `status text not null default 'active'`
- `void_reason text`
- `voided_at timestamptz`
- `voided_by uuid`
- `cancel_reason text`
- `cancelled_at timestamptz`
- `cancelled_by uuid`

Allowed statuses:

- `active`
- `voided`
- `cancelled`
- `archived`

Existing `is_active` remains in place for compatibility with current balance, parcel board, collections, and active contract views.

On void:

- `status` becomes `voided`
- `is_active` becomes `false`
- `void_reason` is required
- `voided_at` is set
- `voided_by` is set

## Permission Model

Voiding is Admin/Super Admin only.

This is enforced server-side by the `public.void_contract(p_contract_id, p_void_reason)` RPC using `public.is_admin_user()`.

Existing contract RLS was not broadly redesigned in this phase. Staff contract creation behavior remains unchanged.

## Void Flow

The Customer Detail Contract tab shows contract history and an Admin/Super Admin-only `Void Contract` action for active contracts.

The void modal requires:

- confirmation through an explicit button
- a non-empty void reason
- review of warning text before submission

After voiding:

- the contract remains visible in history
- the contract is clearly labeled `Voided`
- the void reason and date are shown
- customer/contract data is refreshed
- an audit event is recorded

## Audit Event Behavior

The RPC inserts an `audit_events` row with:

- `entity_type`: `contract`
- `entity_id`: contract ID as text
- `action`: `voided`
- `title`: `Contract voided`
- `summary`: safe high-level contract context
- `before_data`: previous status, active flag, and void timestamp
- `after_data`: new status, active flag, void timestamp, and void reason
- `metadata`: customer and parcel IDs
- actor user ID, name, and email when available

The audit event does not store secrets, full documents, payment proof contents, or unnecessary customer private data.

## UI Behavior

Customer Detail:

- Contract tab is labeled as contract history.
- Active, voided, cancelled, and archived contracts display distinct badges.
- Voided contracts remain visible.
- Voided contracts do not appear as the active contract.
- The void modal warns that lot status should be reviewed manually if needed.

Contracts page:

- Contract status badges now show `Voided`, `Cancelled`, or `Archived` instead of treating all inactive contracts as generic closed records.

## What Voiding Does

Voiding:

- marks the contract inactive
- marks the contract status as `voided`
- stores the void reason
- stores the actor and timestamp
- records an audit event
- keeps the contract in history

## What Voiding Does Not Do

Voiding does not:

- hard delete the contract
- delete transactions
- delete payments
- delete payment requests
- delete documents
- delete customer payment accounts
- reverse or recalculate balances
- change collections calculations
- change parcel/lot status
- release reservations
- change applications
- change customers
- change leads
- change post-sales checklists or tasks
- send messages
- create tasks

## Known Limitations

- Cancel Contract UI was not implemented yet.
- Hard delete is intentionally not available as a normal workflow.
- Voiding does not automatically return a sold lot to available.
- Voiding does not automatically release alternate reservations.
- Reports and financial calculations still follow existing active-contract behavior through `is_active`.
- Staff can still create contracts according to existing permissions; only voiding is Admin/Super Admin-only.

## Stabilization QA Note

The stabilization pass verified:

- Existing contracts are backfilled to `active` when `is_active = true` and `archived` when `is_active = false`.
- Contract lifecycle statuses are constrained to `active`, `voided`, `cancelled`, and `archived`.
- `status` and `is_active` must remain consistent.
- Contract lifecycle changes, including `status`, `is_active`, void metadata, and cancel metadata, are blocked for non-admin users by the contract validation trigger.
- `public.void_contract` requires Admin/Super Admin permission through `public.is_admin_user()`.
- Invalid contract IDs are rejected with `Contract not found.`
- Already voided contracts are rejected.
- Cancelled contracts are rejected by the void workflow.
- A successful void updates only the contract lifecycle fields and inserts one audit event.
- Audit event payloads include minimal status/active/void context plus related customer and parcel IDs.
- Audit event payloads do not include secrets, full documents, payment proof contents, or unnecessary buyer/customer private data.
- Customer Detail shows active, voided, cancelled, and archived contracts safely in Contract History.
- The Void Contract action is only shown to Admin/Super Admin users.
- The void modal requires a non-empty reason and explains that payments, receipts, documents, collections records, and lot status are not changed automatically.
- Long void reasons wrap in the contract history display.

Voiding was confirmed to not:

- hard delete contracts
- delete or update transactions
- delete or update payments
- delete or update payment requests
- delete or update documents
- modify collections calculations
- reverse balances
- change parcel/lot status
- release reservations
- change applications, customers, leads, post-sales records, or AI behavior
- send messages or create tasks

Readiness:

- Phase B is ready to support Reservation Release Alternates as the next manual, staff-confirmed workflow.
- The next phase should use the existing audit foundation and should not automate parcel status changes or payment changes.

## Recommended Next Phase

Implement Reservation Release Alternates.

That phase should:

- detect other active reservations for the same buyer/application/customer
- ask staff to confirm which alternates to release
- update only selected reservation records
- write reservation activity and audit events
- avoid payment, contract, parcel status, and application automation
