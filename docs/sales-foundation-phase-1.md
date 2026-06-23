# Sales Foundation Phase 1 Implementation Note

Phase 1 adds a lightweight internal sales layer for Wamule. It does not change application approval, customer creation, lot availability rules, reservation expiry, payment ledger behavior, contract calculations, collections logic, auth behavior, or Edge Functions.

## Tables Added

Migration: `supabase/migrations/20260618000100_sales_foundation_phase_1.sql`

New tables:

- `leads`
- `lead_activities`
- `follow_up_tasks`
- `site_visits`

The tables use UUID primary keys, existing timestamp conventions, `set_updated_at()` where updates are supported, and references to existing `applications`, `customers`, `parcels`, and `auth.users` where applicable.

## RLS / Permissions

Sales tables are private to authenticated internal users.

- Internal users can read sales records through `public.is_internal_user()`.
- Super Admin/Admin/Staff can create and update operational sales records through `public.can_write_admin_data()`.
- Admin-level users can delete records through `public.is_admin_user()`.
- Anonymous/public users have no direct access to sales tables.

## UI Added

New protected route:

- `/leads`

Navigation:

- Sidebar now includes `Leads`.

The Leads workspace includes:

- Lead list/table
- Search
- Pipeline stage filter
- Assigned staff filter
- Follow-up due/overdue filter
- Create lead
- Edit lead
- Lead detail panel
- Pipeline stage badge
- Buyer/contact details
- Interested lot
- Linked application/customer
- Buyer Insights
- Follow-up task creation and completion/cancellation
- Site visit scheduling and status updates
- Manual activity timeline notes

## Dashboard Additions

The dashboard now includes sales visibility widgets:

- Open follow-ups
- Overdue and due-today follow-up counts
- Upcoming site visits
- Deposit pending leads
- Family decision leads
- Leads by pipeline stage

Existing dashboard operating cards remain unchanged.

## Application / Customer Linking

Applications:

- The Applications page shows a small Sales Pipeline panel on each application card.
- Staff/Admin users can create a lead from an application when no lead is already linked.
- This creates a `leads` record linked by `application_id` and a `lead_activities` record noting the application link.
- Public application submission is not changed and does not auto-create leads yet.
- Application approval behavior is unchanged.

Customers:

- Customer Detail reads leads linked by `customer_id`.
- If a linked lead exists, the Overview tab shows sales stage, next action, due date, buyer journey, and a link to the Leads workspace.
- Customer creation logic is unchanged. Leads can be linked manually from the Leads form.

## Known Limitations

- No reservation expiry workflow.
- No deposit ledger changes.
- No automatic customer creation from leads.
- No automatic lead creation from public application submission.
- No Google Calendar integration.
- No WhatsApp/email automation.
- No new AI Edge Functions.
- No full sales reporting yet.
- Authenticated protected-route browser/mobile QA is still pending until valid admin credentials are available.

## Phase 1 QA Note

Stabilization review verified:

- Sales tables follow the existing private-internal RLS pattern.
- Anonymous/public users do not receive sales table access.
- Read-only internal users can read sales records but cannot create, update, or delete them.
- Super Admin/Admin/Staff write access uses the existing `can_write_admin_data()` helper.
- Delete access is restricted to `is_admin_user()`.
- Application lead creation remains staff/admin initiated and does not change public application submission or approval behavior.
- Customer Detail safely hides the sales panel when no linked lead exists.
- Dashboard sales widgets handle empty lead, follow-up, and site visit data.
- Leads UI includes empty, loading, and error states.
- Lead, follow-up, site visit, and activity forms now guard against blank required labels before writing records.
- The application-to-lead bridge enforces one lead per linked application through a partial unique index.

Required manual setup:

- Apply `20260618000100_sales_foundation_phase_1.sql` before using `/leads`.
- Regenerate remote Supabase types after applying the migration if the team uses CLI-generated types in deployment.
- Complete authenticated protected-route browser/mobile QA once valid admin credentials are available.

Remaining risks before Phase 2:

- Public applications do not auto-create leads yet, so staff must create/link leads from Applications or the Leads page.
- Duplicate matching by phone/email is intentionally deferred.
- Customer linking is manual from the Leads form and does not alter customer creation.
- If existing data somehow contains multiple leads for one customer, Customer Detail shows the most recently updated linked lead.

## Phase 2 Follow-Up

Recommended next work:

- Confirm pipeline stages with the Wamule team.
- Decide whether public applications should auto-create leads.
- Add duplicate matching by phone/email before creating leads from applications.
- Add explicit lot reservation workflow with expiry only after lot rules are confirmed.
- Add document checklist and agreement readiness.
- Add sales reporting once real lead data is available.
