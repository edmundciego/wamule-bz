# Audit, Contract Void, and Reservation Release Plan

This is a planning document only. It does not implement schema, workflow, contract, payment, reservation, audit, auth, role, permission, or business logic changes.

## 1. Current System Summary

### Contracts

Contracts currently live in `public.contracts`. The archived foundation migration defines:

- `customer_id`
- `parcel_id`
- `final_purchase_price`
- `initial_deposit`
- `term_months`
- generated `monthly_payment`
- `start_date`
- `payment_due_day`
- `signed_contract_file_path`
- `is_active`
- timestamps

There is no contract status field beyond `is_active`, and there are no void/cancel metadata fields.

Contract creation currently happens through `ContractForm`. It inserts a new active contract and optionally uploads a signed contract file. Existing database triggers validate contract writes and mark the parcel as `Sold` after active contract creation.

Customer Detail shows contracts in the Contract tab and uses active contracts for account summary, balances, statement, payments, and collections context.

### Payments / Collections Linked To Contracts

Transactions link to contracts through `transactions.contract_id`, with `on delete restrict`. Land payment transaction types require a contract. The transaction write trigger validates that a selected contract belongs to the same customer.

Payment requests link to contracts through `payment_requests.contract_id`, with `on delete set null`.

Payment documents link to transactions, not directly to contracts.

Collections and reports compute balances from active contract values plus linked transactions. Because payments are tied to contract IDs, contract hard deletion would risk breaking ledger history and should not be the normal workflow.

### Reservations

Reservations live in `public.lot_reservations` and can link to:

- lead
- application
- customer
- parcel
- transaction payment
- converted application
- converted contract
- assigned staff

Reservation statuses are:

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

Active reservation statuses for duplicate lot hold prevention are:

- `draft`
- `reserved`
- `deposit_pending`
- `deposit_submitted`
- `deposit_confirmed`

The database currently prevents more than one active reservation per `parcel_id`, but it does not prevent one buyer from having active reservations for several different lots.

### Deposit Readiness

Deposit readiness is tracked on reservations through:

- expected deposit amount
- deposit due date
- deposit paid/confirmed date
- deposit status
- optional link to an existing transaction

Deposit readiness is a sales/readiness status only. It does not create payments, change balances, confirm proof, or replace the payment ledger.

### Lead / Application / Customer Linking

Leads can link to applications, customers, parcels, reservations, follow-ups, site visits, and activities.

Applications can create/link sales leads and create draft reservations when a lot is selected. Application approval behavior remains separate and is still the authority for approval/customer creation flow.

Customer Detail shows directly linked leads and reservations when available. Current known limitation: reservations linked only through a lead may not appear on Customer Detail unless `customer_id` is also populated.

### Existing Activity Logs

The system has scoped activity tables:

- `lead_activities`
- `reservation_activities`
- `post_sales_activities`

These are useful local timelines, but they are not a global audit trail. They do not consistently cover contracts, payments, settings, AI summary generation, deletes/voids, or cross-entity events.

## 2. Gap Analysis

Current missing capabilities:

- No safe contract void/cancel workflow.
- No clear correction path when a contract is created by mistake.
- No normal hard-delete alternative that preserves financial and operational history.
- No global audit log across entities.
- No unified audit viewer for admins.
- No consistent audit trail for settings changes, contract creation, contract voiding, payment proof uploads, AI summary generation, or destructive/void/release actions.
- No staff-confirmed flow to release alternate reservations after one lot is selected, deposit-confirmed, or contract-started.
- No reservation settings controlling release prompts/defaults.
- No explicit process for deciding whether reports include or exclude voided contracts.

## 3. Contract Void / Cancel Plan

### Recommendation

Do not make hard delete the normal contract correction workflow.

Recommended actions:

- `Void Contract`: use when the contract was created by mistake or should be treated as never valid operationally.
- `Cancel Contract`: use when the contract was valid but later cancelled by business decision.
- `Archive Contract`: optional later display-level label for old inactive/closed/voided/cancelled contracts.

### Data Model

Current `contracts` only has `is_active`. A future migration should add explicit contract lifecycle fields rather than overloading `is_active`:

- `status text not null default 'active'`
- `void_reason text`
- `voided_by uuid references auth.users(id)`
- `voided_at timestamptz`
- `cancel_reason text`
- `cancelled_by uuid references auth.users(id)`
- `cancelled_at timestamptz`

Suggested statuses:

- `active`
- `closed`
- `voided`
- `cancelled`

Keep `is_active` for compatibility in the first implementation, but define clear mapping:

- `status = active` means `is_active = true`
- `status in ('closed', 'voided', 'cancelled')` means `is_active = false`

### Permissions

Recommended:

- Staff/Admin can create contracts if current behavior allows it.
- Admin/Super Admin can void or cancel contracts.
- Super Admin only can hard delete, if hard delete is supported at all.

Hard delete should be discouraged and hidden behind confirmation. If allowed, it should only be used when no ledger records, payment requests, post-sales records, or documents depend on the contract.

### UX Placement

Add a Contract Actions section:

- Customer Detail → Contract tab
- Contract card action menu
- Optional Contracts page action menu

Void/cancel should require:

- confirmation modal
- reason field
- warning that payments and collections are not changed automatically
- clear summary of linked payments/payment requests/post-sales records
- final confirmation button labeled `Void Contract` or `Cancel Contract`

### Customer Detail Impact

Customer Detail should:

- keep voided/cancelled contracts visible in history
- visually distinguish active, closed, voided, and cancelled contracts
- exclude voided contracts from “active contract” summary by default
- show void/cancel reason and actor/date
- link to audit events when available

### Reports Impact

Reports should:

- show contract status
- include filters for active/closed/voided/cancelled
- make it clear whether balances include only active contracts
- default financial/collections calculations to active contracts unless the user explicitly chooses historical/voided records

### Payments / Collections Impact

Voiding a contract should not automatically:

- delete transactions
- delete payment documents
- change payment amounts
- change receipt numbers
- change collections calculations without explicit reporting rules
- remove payment requests
- create refunds or credits

If a voided contract has linked transactions, the UI should warn staff and keep the records visible. A later accounting workflow may be needed for refunds, reallocations, or corrections.

### Parcel Status Impact

Because contract creation currently marks a parcel as `Sold`, voiding/cancelling a contract raises parcel status questions.

MVP recommendation:

- Do not automatically change parcel status on void/cancel.
- Show a staff prompt: “Review parcel status separately.”
- Add audit event that contract was voided/cancelled.

Later option:

- Add a setting or explicit staff-confirmed action to return parcel status to `Available` or `Reserved`.

## 4. Audit Trail Plan

### Recommended Table

Add a global `audit_events` table in a future migration:

- `id uuid primary key default gen_random_uuid()`
- `entity_type text not null`
- `entity_id text not null`
- `action text not null`
- `summary text not null`
- `before_data jsonb`
- `after_data jsonb`
- `metadata jsonb`
- `actor_user_id uuid references auth.users(id) on delete set null`
- `actor_name text`
- `actor_email text`
- `created_at timestamptz not null default now()`

Use text `entity_id` so audit events can point to bigint IDs, UUIDs, and future composite/external IDs without awkward casting in the UI.

### RLS

Recommended policies:

- Internal/read-only users can read audit events.
- Staff/Admin/Super Admin can insert audit events for supported app workflows.
- Admin/Super Admin can view all audit event details.
- No normal user role should update audit events.
- Delete should be disabled or Super Admin only for retention/legal cleanup.

Consider making audit events append-only. If corrections are needed, write a new audit event.

### Indexes

Recommended indexes:

- `(entity_type, entity_id, created_at desc)`
- `(actor_user_id, created_at desc)`
- `(action, created_at desc)`
- `(created_at desc)`
- Optional GIN index on `metadata` only if real filtering needs it.

### Entity Types

Initial entity types:

- `lead`
- `follow_up_task`
- `site_visit`
- `reservation`
- `application`
- `customer`
- `contract`
- `transaction`
- `payment_document`
- `payment_request`
- `post_sales_checklist`
- `post_sales_task`
- `ai_summary`
- `daily_brief`
- `business_setting`
- `ai_setting`
- `admin_profile`

### Actions

Initial actions:

- `create`
- `update`
- `delete`
- `void`
- `cancel`
- `release`
- `status_change`
- `assignment_change`
- `ai_summary_generated`
- `settings_changed`
- `payment_proof_uploaded`
- `payment_proof_reviewed`
- `contract_created`
- `contract_voided`
- `reservation_created`
- `reservation_released`
- `reservation_confirmed`
- `reservation_cancelled`
- `post_sales_task_changed`

### Trigger vs Application-Level Logging

#### Option 1: Database Triggers

Pros:

- Captures writes regardless of frontend path.
- Harder for app code to forget.
- Good for simple create/update/delete audit coverage.

Cons:

- Hard to produce human-friendly summaries.
- Actor attribution can be inconsistent in service-role Edge Functions unless actor is explicitly passed.
- Before/after payloads can over-log sensitive data.
- More complex to selectively redact fields.

#### Option 2: Application-Level Explicit Inserts

Pros:

- Best human-readable summaries.
- Can include workflow-specific context such as “Released alternate reservation after deposit confirmation.”
- Easier to redact sensitive fields.
- Easier to attach actor name/email resolved from current session.

Cons:

- Easy to miss unless enforced by helper patterns and review.
- If an audit insert fails after the main write, the workflow has partial observability.
- Does not automatically catch all direct table changes.

#### Option 3: Edge Function Wrappers

Pros:

- Good for sensitive workflows that should be transactional and permission-checked.
- Can perform main write and audit insert together.
- Avoids exposing complex write logic to browser code.

Cons:

- More Edge Functions to maintain.
- Can overcentralize simple CRUD.
- Still must pass actor context for service-role writes.

#### Option 4: Hybrid

Recommended approach.

Use:

- App-level explicit audit helper for normal UI workflows.
- Edge Function wrappers for sensitive workflows such as contract void/cancel and bulk reservation release.
- Minimal database triggers later for broad coverage of critical tables, with redaction and actor metadata strategy.

MVP should start with explicit audit events for new void/release flows and a small helper, then expand coverage.

### UI Placement

Recommended UI:

- New Admin `Audit Trail` page under Settings or main nav.
- Customer Detail `Audit` tab.
- Lead Detail activity/audit section.
- Contract audit history inside Contract tab.
- Reservation audit history alongside reservation timeline.
- Settings audit history for configuration changes.

The global audit page should support filters:

- date range
- actor
- entity type
- action
- entity ID
- keyword search

## 5. Reservation Release Plan

### Active Reservation Definition

Use the existing active statuses:

- `draft`
- `reserved`
- `deposit_pending`
- `deposit_submitted`
- `deposit_confirmed`

Do not treat `expired`, `cancelled`, `released`, `converted_to_application`, or `converted_to_contract` as active alternates.

### Confirmed Lot Definition

For MVP, a lot can be treated as confirmed for alternate-release prompting when one of these occurs:

- reservation status becomes `deposit_confirmed`
- reservation deposit status becomes `confirmed`
- reservation status becomes `converted_to_contract`
- contract is created for the same buyer/lot

The prompt should be staff-confirmed, not automatic.

### Finding Alternate Reservations

When one reservation becomes confirmed or converted, find other active reservations where any buyer link matches:

- same `lead_id`
- same `application_id`
- same `customer_id`

Exclude:

- the selected/confirmed reservation
- reservations already `expired`, `cancelled`, `released`, `converted_to_application`, or `converted_to_contract`
- reservations for the same parcel as the confirmed reservation

If the buyer has lead-only reservations and customer-only reservations that are not linked, the MVP may miss them. Later duplicate matching by phone/email can improve this.

### Staff-Confirmed Release Action

Show a prompt/action:

> Release other unconfirmed reservations?

UI should show:

- reservation code
- lot number
- status
- deposit status
- expiry
- selected checkbox
- warning that payments/contracts/parcel status are not changed

Staff can select which reservations to release.

When confirmed:

- update selected reservations to `status = released`
- set `released_at = now()`
- if deposit status is not confirmed, optionally set `deposit_status = cancelled`
- write `reservation_activities`
- write `audit_events`

Do not:

- mutate payments
- mutate contracts
- confirm deposits
- delete reservations
- auto-change parcel status
- create tasks automatically

### UI Placement

Recommended placements:

- Leads page reservation card after deposit confirmation or converted status.
- Applications page reservation/deposit readiness section when an application has linked reservations.
- Customer Detail reservation/deposit readiness panel.
- Later: dedicated reservation detail page if volume grows.

### Edge Cases

- Same buyer interested in multiple lots: allow multiple active buyer reservations until staff confirms release.
- Family decision not final: do not prompt release unless one reservation is confirmed/converted.
- Deposit pending on one lot: do not auto-release alternates.
- Deposit confirmed on one lot: prompt staff to release alternates.
- Contract started on one lot: prompt staff to release alternates if active reservations remain.
- Application selected unavailable lot: show application insight and do not release automatically.
- Reservation already expired/cancelled/released: exclude from prompt.
- Deposit proof submitted on alternate lot: include in prompt but warn staff to review before release.
- Alternate reservation has linked payment: do not auto-release; require explicit staff review.

## 6. Reservation Settings Plan

Future settings:

### MVP Settings

- Default reservation expiry days.
- Default deposit due days.
- Require expiry date.
- Require expected deposit amount.
- Allow multiple active reservations per buyer.
- Prompt to release alternates after deposit confirmed.

### Later Settings

- Default expected deposit amount.
- Default reservation status.
- Default deposit status.
- Prompt to release alternates after contract start.
- Auto-release alternates after confirmation.
- Auto-change parcel status.

### Existing Database Behavior

The database already blocks multiple active reservations for the same lot/parcel. Keep this as the default behavior.

### Recommendation

For MVP:

- Add settings as CRM workflow defaults only.
- Keep release alternates staff-confirmed.
- Do not add auto-release jobs.
- Do not add parcel status automation.

Later automation should require explicit settings, audit events, and staff-visible history.

## 7. Recommended MVP

Smallest safe implementation:

1. Add `audit_events` table.
2. Add audit helper/types for explicit UI/Edge Function audit writes.
3. Add basic Audit Trail page or Customer Detail audit panel.
4. Add Contract Void action.
5. Add Reservation Release Alternates action.
6. Write audit events for contract void and reservation release.
7. Write reservation activity events for released alternates.
8. Keep all actions manual and staff-confirmed.
9. Do not add auto-release jobs.
10. Do not add parcel status automation.
11. Do not change payment, contract, or collections calculations.

MVP should not attempt to audit every existing table immediately. Start with the new sensitive workflows, then expand coverage.

## 8. Implementation Phases

### Phase A: Audit Foundation

Likely files:

- new migration for `audit_events`
- `src/types/database.ts`
- `src/lib/auditEvents.ts`
- new Audit Trail page or Customer Detail audit panel
- Admin navigation if using a global page
- docs update

Work:

- Add `audit_events` table.
- Add RLS.
- Add indexes.
- Add insert helper.
- Add read/query helper.
- Add basic audit viewer with filters.
- Add no-op-safe handling if audit insert fails after display-only actions.

### Phase B: Contract Void / Cancel

Likely files:

- migration adding contract lifecycle fields
- `src/types/database.ts`
- `src/pages/CustomerDetailPage.tsx`
- `src/pages/ContractsPage.tsx`
- `src/pages/ReportsPage.tsx`
- `src/lib/auditEvents.ts`

Work:

- Add contract status/void fields if needed.
- Add void/cancel modal.
- Require reason.
- Restrict action to Admin/Super Admin.
- Set contract inactive and status voided/cancelled.
- Write audit event.
- Keep payments/documents visible.
- Update display/report labels.
- Do not change payment or collections calculations except where reports explicitly filter active contracts.

### Phase C: Reservation Release Alternates

Likely files:

- `src/pages/LeadsPage.tsx`
- `src/pages/ApplicationsPage.tsx`
- `src/pages/CustomerDetailPage.tsx`
- `src/lib/smartInsights.ts`
- `src/lib/auditEvents.ts`
- docs update

Work:

- Detect alternates for same lead/application/customer.
- Show staff-confirmed release prompt/action.
- Let staff select reservations.
- Update selected reservations to released.
- Set `released_at`.
- Write `reservation_activities`.
- Write audit events.
- Do not mutate payments/contracts/parcels.

### Phase D: Reservation Settings

Likely files:

- migration extending `business_settings` usage or adding reservation settings seed
- `src/types/database.ts`
- `src/pages/SettingsPage.tsx`
- reservation form defaults in Leads/Applications
- docs update

Work:

- Add workflow defaults.
- Add prompt behavior settings.
- Keep all actions manual/staff-confirmed.
- Do not add automation in this phase.

## 9. Risks

- Accidentally deleting financial or contract history.
- Breaking payment/collections calculations by excluding or mutating linked contracts.
- Voiding a contract while payments or payment requests still reference it.
- Parcel status becoming inconsistent after contract void/cancel.
- Over-logging sensitive buyer/customer data in audit payloads.
- Audit table growing large without retention/index strategy.
- Actor attribution missing when service-role Edge Functions write data.
- Releasing the wrong reservation if buyer links are incomplete.
- Staff confusion between Site Visit and Reservation.
- Staff assuming deposit readiness is payment ledger state.
- Duplicate buyer interest across leads/customers not detected without phone/email matching.

## 10. Open Questions

- Should contract hard delete exist at all?
- Which roles can void contracts: Admin only, or Staff plus Admin?
- Should cancelling and voiding be separate actions in MVP?
- Should voided contracts remain visible by default on Customer Detail?
- Should reports exclude voided contracts by default?
- Should voiding a contract affect payment accounts, payment requests, or post-sales checklists?
- Should voiding a contract ever offer to change parcel status?
- If parcel status can be changed after void, should it become Available or Reserved?
- Should release alternates be prompted after deposit confirmation, contract start, or both?
- Should alternate reservation release set deposit status to cancelled automatically when no payment is linked?
- How much before/after data should audit store?
- Should audit data be redacted field-by-field?
- Should audit events be immutable forever, or should Super Admin deletion be possible for retention/legal cleanup?
