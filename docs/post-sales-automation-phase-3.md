# Post-Sales Automation Phase 3

Phase 3 adds internal post-sales checklist and task tracking for Wamule. It does not change application approval, customer creation, lot availability, contract calculations, payment calculations, collections calculations, document upload behavior, auth behavior, Edge Functions, or public workflows.

## Tables Added

Migration: `supabase/migrations/20260620000100_post_sales_automation_phase_3.sql`

New tables:

- `post_sales_checklists`
- `post_sales_tasks`
- `post_sales_activities`

The tables use UUID primary keys, existing timestamp conventions, `set_updated_at()` on updateable tables, and references to existing `customers`, `applications`, `contracts`, `leads`, `lot_reservations`, and `auth.users` where applicable.

## Status Definitions

Checklist statuses:

- `not_started`
- `in_progress`
- `blocked`
- `completed`
- `cancelled`

Agreement statuses:

- `not_started`
- `drafting`
- `ready_for_review`
- `sent_for_signature`
- `signed`
- `blocked`

Document statuses:

- `not_started`
- `missing_documents`
- `pending_review`
- `complete`
- `blocked`

Collections handoff statuses:

- `not_started`
- `ready`
- `handed_off`
- `blocked`

Payment setup statuses:

- `not_started`
- `pending`
- `ready`
- `active`
- `blocked`

Task statuses:

- `open`
- `in_progress`
- `completed`
- `cancelled`
- `blocked`

Task types:

- `document`
- `agreement`
- `payment_setup`
- `customer_contact`
- `collections_handoff`
- `internal_review`
- `general`

## RLS / Permissions

Post-sales tables are private to authenticated internal users.

- Internal users can read through `public.is_internal_user()`.
- Super Admin/Admin/Staff can create and update through `public.can_write_admin_data()`.
- Super Admin/Admin can delete through `public.is_admin_user()`.
- Anonymous/public users have no direct access.

## Linking

Post-sales checklists and tasks can link to:

- Customer
- Application
- Contract
- Lead
- Reservation

Customer Detail starts a checklist using the current customer, source application, active contract if present, latest linked lead, and latest linked reservation when available. These links are references only and do not mutate the linked records.

## UI Added

Customer Detail:

- New `Post-Sales` tab.
- Start post-sales checklist action.
- Agreement readiness status.
- Document readiness status.
- Payment setup status.
- Collections handoff status.
- Assigned staff and notes.
- Post-sales task creation.
- Task status updates for complete, blocked, and cancelled.
- Post-sales activity timeline.
- Rule-based recommended actions.

Applications:

- Approved applications show post-sales checklist status when a checklist exists.
- If no checklist exists, staff are directed to start it from Customer Detail.
- Application approval behavior is unchanged.

Dashboard:

- Open post-sales tasks.
- Overdue post-sales tasks.
- Blocked post-sales customers.
- Agreements ready for review/signature.
- Documents missing or pending review.
- Collections handoff ready.
- Payment setup pending.

## Rule-Based Recommended Actions

Phase 3 adds deterministic guidance only:

- Request missing documents.
- Review agreement before sending.
- Follow up on signed agreement.
- Hand off to collections.
- Confirm payment setup details.
- Review overdue post-sales tasks.
- Review blockers before proceeding.

No AI Edge Functions were added.

## What Is Intentionally Not Automated

- No automatic contracts.
- No payment records.
- No payment schedule changes.
- No contract calculation changes.
- No collections calculation changes.
- No document approval automation.
- No receipt/invoice generation.
- No application approval changes.
- No customer creation changes.
- No email, WhatsApp, calendar, or public-facing automation.

## Known Limitations

- Checklist creation is manual from Customer Detail.
- Reports do not yet include full post-sales exports.
- Checklist uniqueness is scoped to one active non-cancelled checklist per customer.
- Post-sales handoff status does not change collections behavior; it only tracks readiness.
- Authenticated protected-route browser/mobile QA is still pending until valid admin credentials are available.

## Phase 3 QA Note

Stabilization review verified:

- Post-sales tables follow the existing private-internal RLS pattern.
- Anonymous/public users do not receive post-sales table access.
- Read-only internal users can read post-sales records but cannot create, update, or delete them.
- Super Admin/Admin/Staff write access uses the existing `can_write_admin_data()` helper.
- Delete access is restricted to `is_admin_user()`.
- Nullable customer, application, contract, lead, and reservation links are reference-only and do not mutate linked records.
- Customer Detail safely shows an empty state when no checklist exists.
- Starting a checklist from Customer Detail is staff/admin initiated and uses the current customer, source application, active contract, latest linked lead, and latest directly linked reservation when available.
- The checklist uniqueness index prevents duplicate non-cancelled customer checklists.
- Checklist status updates only update `post_sales_checklists`.
- Post-sales task actions only update `post_sales_tasks`.
- Activity timeline writes are non-blocking; if an activity insert fails after a checklist/task save, the primary record remains saved.
- Applications Page post-sales visibility is display-only and does not change approval behavior.
- Dashboard post-sales widgets handle empty post-sales data and count only open/in-progress/blocked tasks and readiness statuses.
- Badge mappings cover the supported Phase 3 statuses.
- Rule-based recommended actions are display-only.
- Post-sales task due-date input now validates before writing a task.

Readiness tracking boundaries:

- Phase 3 tracks agreement readiness, document readiness, payment setup readiness, collections handoff readiness, tasks, and activity notes.
- Phase 3 does not change customer, application, contract, payment, collections, document, lead, reservation, or lot records automatically.

Required manual setup:

- Apply Phase 1 and Phase 2 migrations before applying `20260620000100_post_sales_automation_phase_3.sql`.
- Regenerate remote Supabase types after applying migrations if the deployment workflow depends on generated types.
- Complete authenticated protected-route browser/mobile QA once valid admin credentials are available.

Remaining risks before Phase 4:

- Staff must manually start and maintain checklist state.
- Multiple contracts, leads, or reservations are summarized by the active contract and latest linked lead/reservation in Customer Detail.
- There is no automated document checklist template yet.
- Collections handoff is an operational status only until collections business rules are confirmed.

## Phase 4 Recommendations

- Add post-sales reporting and CSV export once real checklist data exists.
- Add document checklist templates for IDs, agreements, proof of funds, and signed forms.
- Add safer transition helpers from signed agreement to active collections only after business rules are confirmed.
- Add AI assistance for buyer timeline summaries and recommended actions only after deterministic workflows are stable.
