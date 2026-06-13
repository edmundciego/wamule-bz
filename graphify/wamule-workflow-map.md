# Wamule Workflow Map

## Core Workflows

1. **Public Intake:** User submits `/apply` -> Creates record in `applications`.
2. **Admin Review:** Admin views `/applications` (Kanban).
3. **Approval/Customer Creation:** Admin approves -> Creates `customer` record -> Reserves `lot` (via `parcels`).
4. **Contract Creation:** Admin creates `contract` (enforces max 60-month term).
5. **Payment Logging:** Admin logs payment -> Creates `transaction`.
6. **Receipt Processing:**
   - Admin logs payment -> Creates job in `receipt_jobs`.
   - Edge Function `generate-receipts` executes.
   - Transaction updated with `receipt_path`.
7. **Reports:** System queries `transactions` and `contracts` for revenue/delinquency.
