# Critical Correctness Repair — Batch 1

## Scope and status

This repair implements only Batch 1 from `internal-quality-correctness-audit.md`:

1. Contract-to-lot authorization
2. Contract void resolution
3. Immutable payment correction
4. Canonical active-contract and financial definitions

The connected Wamule Supabase migration history was reconciled on 2026-07-14. The production-recorded versions are preserved by the matching local filenames below; the three no-op/Batch 1 migrations are not to be re-applied.

## Migrations

- `20260714220603_20260714074603_release_quality_data_management.sql`
  - Retired before production use and replaced with a timestamp-preserving
    documented no-op. Its destructive purge workflow is not part of Batch 1
    and cannot run through `supabase db push`.

- `20260714223959_20260714210447_critical_correctness_batch_1.sql`
  - Supersedes the unsafe hard-delete payment design. If an environment previously ran it, the later migration drops `remove_payment_record`.
  - Adds transaction lifecycle fields: `posted`, `voided`, and `reversed`; void metadata; correction linkage; and `updated_at`.
  - Removes the direct transaction delete RLS policy.
  - Adds controlled `void_payment_record` RPC, `contract_void_resolutions`, `resolve_contract_void_resolution`, corrected contract validation, and canonical financial views.

**Migration-chain decision:** `20260714220603_20260714074603_release_quality_data_management.sql` and `20260714220611_20260714203000_controlled_payment_removal.sql` are documented no-ops aligned to the production migration history. Neither creates a function, policy, data purge, or hard-delete behavior. `20260714223959_20260714210447_critical_correctness_batch_1.sql` is already recorded remotely and must not be re-applied.

Batch 1 also adds a database-level transaction-delete trigger. This prevents the
legacy Super Admin test-data purge workflow from deleting a financial record;
if a purge reaches a transaction, the entire purge transaction fails and rolls
back. This is intentional: test-data cleanup cannot override financial-history
preservation.

## Approved definitions implemented in source

### Active contract

A contract is current only when both conditions are true:

```text
is_active = true
status = active
```

### Counted land payment

A payment contributes to a current land-account total only when it:

- has `status = posted`;
- is `Down Payment` or `Land Installment`;
- links to the exact contract being summarized.

Community fees, payment requests, voided/reversed transactions, and payments tied to another or voided contract do not count toward a current land balance.

### Contract lot authorization

For a new active contract, the database authorizes the parcel in this order:

1. Customer active reservation lot (`reserved`, `deposit_pending`, `deposit_submitted`, or `deposit_confirmed`); otherwise
2. The lot on the customer's **Approved** application.

Draft, converted, expired, cancelled, and released reservations are not active authorizations. No alternate-lot workflow is introduced in this batch.

## Payment correction model

Payments are immutable after posting. There is no ordinary delete or edit path.

1. Admin/Super Admin selects **Void payment**.
2. The confirmation shows customer, date, amount, method, and reference, and requires a reason.
3. `void_payment_record` locks the payment, changes only its status to `voided`, preserves documents and identifiers, and creates a complete Audit Trail event.
4. The payment remains in history but is excluded from current financial totals.
5. When a correction is needed, staff records a replacement payment linked through `reversal_of_transaction_id`.

No refund processing is included.

## Contract void resolution model

Voiding a contract does not release the parcel or alter payments/documents automatically. It creates a pending `contract_void_resolutions` record and an audit event.

While pending, another active contract cannot use that parcel. Admin/Super Admin must choose one explicit resolution:

- **Release lot:** only if no active contract or active reservation requires it.
- **Return to reservation:** only if a valid active reservation for the same customer and parcel exists.
- **Retain sold:** requires a reason.

Customer Detail now displays **Contract Voided — Resolution Required** while a pending record exists.

## Canonical consumers updated

- Customer Detail
- Customers list
- Contracts
- Payments (void/correction UI)
- Collections
- Reports
- Printable customer documents/statements
- Dashboard financial snapshot
- Daily Brief generation
- Customer Smart Summary generation

Client helpers are in `src/lib/financial.ts`. Equivalent Edge Function helpers are in `supabase/functions/_shared/financial.ts`. The database migration adds `contract_financial_summary` and corrects `customer_balance_view` for persisted server-side totals.

## Existing-data inspection queries

Run these only in a safe environment after the migration is applied. They are diagnostic and do not change data.

### Read-only baseline observed before this migration

On 2026-07-14, a read-only aggregate check against the connected Wamule database found:

- `0` active-contract/authorized-lot mismatches under the new authorization rule;
- `2` voided contracts whose parcels remain `Sold` and require explicit review after migration;
- `0` land payments without a contract link.

No records were changed. Re-run the queries below after applying the migration; do not auto-correct returned rows.

During migration, each legacy voided-contract/Sold-parcel case with no existing
resolution receives a pending `contract_void_resolutions` record. This is a
visibility-only backfill: it does not alter the contract, parcel, reservation,
payment, document, or customer record. The two internal contract IDs are
recorded only in the restricted staging-verification log; they must not appear
in client-facing documentation.

```sql
-- Active contracts whose lot is not authorized by an active reservation or approved application.
select c.id as contract_id, c.customer_id, c.parcel_id, c.status, c.is_active
from public.contracts c
join public.customers cu on cu.id = c.customer_id
left join public.applications a on a.id = cu.application_id
where c.is_active = true and c.status = 'active'
  and not exists (
    select 1 from public.lot_reservations r
    where r.customer_id = c.customer_id
      and r.parcel_id = c.parcel_id
      and r.status in ('reserved', 'deposit_pending', 'deposit_submitted', 'deposit_confirmed')
  )
  and not (a.status = 'Approved' and a.parcel_id = c.parcel_id);

-- Voided contracts still on sold parcels that need an explicit resolution record.
select c.id as contract_id, c.customer_id, c.parcel_id, p.status as parcel_status
from public.contracts c
join public.parcels p on p.id = c.parcel_id
left join public.contract_void_resolutions r on r.contract_id = c.id and r.status = 'pending'
where c.status = 'voided' and p.status = 'Sold' and r.id is null;

-- Historical land payments that lack a contract link. New writes are blocked;
-- rows returned require manual finance review.
select id, customer_id, amount, transaction_type, status, created_at
from public.transactions
where transaction_type in ('Down Payment', 'Land Installment')
  and contract_id is null;
```

## Deployment order and containment

1. Back up and review migration history; verify the unsafe removal migration is not applied.
2. Apply only the separately approved pending migration after confirming the three reconciled versions are already recorded remotely.
3. Run the inspection queries; do not auto-correct returned records.
4. Execute role-based RPC/RLS tests and focused workflow tests.
5. Deploy the matching application build only after migration checks pass.

Containment if an issue is found: stop client deployment, keep the database migration in place to preserve no-delete protection, and use the Audit Trail plus diagnostic queries to assess records. Do not roll back by deleting payment or contract history.

## Verification still required

- Migration execution against a safe database.
- RLS tests for Super Admin, Admin, Staff, Read Only, and anonymous users.
- RPC tests for payment void and contract resolution decisions.
- Browser checks of the Payment, Contract, Customer Detail, Lots, and Contracts surfaces.
- Review of any existing inconsistent financial/lot records identified by the queries above.
