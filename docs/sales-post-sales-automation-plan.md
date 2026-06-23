# Wamule Sales + Post-Sales Automation Discovery Plan

This document is a planning artifact only. It does not implement schema, frontend, Supabase, Edge Function, permission, payment, contract, or workflow changes.

## Pending QA Item

Authenticated protected-route mobile/browser QA still needs to be completed for Dashboard, Lots, Applications, Customers, Customer Detail, Payments, Collections, Reports, Emails, Daily Briefs, Settings, modals, upload/proof areas, and dense tables once valid admin credentials are provided.

## 1. Current System Summary

Wamule is currently an admin-first housing project operations CRM centered on public intake, application review, lot reservation, customer creation, contracts, payments, collections, documents, reports, daily briefs, and admin-controlled email notifications.

Applications:

- Public buyers submit applications through the public application page.
- Applications store applicant identity, phone/email, address/nationality/occupation, intended use, preferred lots, alternate lot preference, payment option, legal acknowledgement, and status.
- Current application statuses are `Pending Review`, `Approved`, and `Declined`.
- Admins review applications in a status-column card view.
- Approving an application requires selecting an available lot and calls the existing `approve_application` RPC.
- Approval creates a customer record from the application, reserves the selected lot, and preserves the application/customer relationship.

Customers:

- Customers are created from approved applications.
- A customer has one unique source application, contact fields, optional address, and future-ready `auth_user_id`.
- Customer detail is the main operational workspace: overview, contract, payments, documents, payment requests, statement, and Smart Summary.
- There is no dedicated lead record before application and no separate sales profile after application but before customer conversion.

Lots/parcels:

- Parcels represent lots and track lot number, dimensions, lot size, zoning, base price, and status.
- Current parcel statuses are `Available`, `Reserved`, and `Sold`.
- The lot board shows inventory status and the `parcel_board_view` links lots to customer/contract context.
- Approval reserves a lot; contract creation marks an active lot sold through existing database triggers.

Contracts:

- Contracts link a customer to a parcel and store purchase price, initial deposit, term, generated monthly payment, start date, due day, signed contract file path, and active status.
- Contract calculations are database-backed and should remain authoritative.
- The contract form supports configured installment plans, custom agreements, and signed contract upload.

Payments and collections:

- Transactions record down payments, land installments, garbage fees, and road maintenance.
- Collection method is currently `Cash` or `Online Transfer`.
- Online transfers require bank references and duplicate references are blocked.
- Payment recording supports manual receipt metadata and optional supporting documents.
- Payment requests support draft/sent/paid/cancelled operational requests.
- Collections groups active contracts by due date, overdue status, missing signed contracts, missing receipt numbers, and online transfers missing proof.

Documents/uploads:

- Contract files are stored in the private `contracts` bucket.
- Payment documents are stored in the private `payment-documents` bucket and linked to customers and optionally transactions.
- Payment document types are bank transfer proof, manual receipt photo, signed payment note, and other.
- There is not yet a general buyer document checklist for IDs, agreements, proof of funds, signed forms, or post-sales requirements.

AI summaries and operational guidance:

- Application AI reviews summarize application completeness, missing fields, risk flags, and recommended admin actions.
- Customer Smart Summary provides account status, balance/payment summaries, collections flags, missing items, recommended actions, and draft follow-up message.
- Daily Brief records summarize applications, lots, payments, contracts, collections, alerts, and recommended actions.
- Brief action items track carryover operational actions from generated brief recommendations.
- AI is currently advisory and does not approve applications, update records, log payments, or change contract/payment state.

Users and roles:

- Admin users are represented by `admin_profiles`.
- Roles are `Super Admin`, `Admin`, `Staff`, and `Read Only` in TypeScript, with migrations having evolved from `Admin`, `Staff`, and `Read Only`.
- RLS patterns generally allow internal read access and restrict writes to admin/staff or admin-only areas depending on sensitivity.
- Email Center and AI generation are admin-gated in the frontend.

Reports and email:

- Reports cover payments, balances, applications, lots, and missing items with CSV export.
- Email Center is an admin-controlled outbox with explicit preview/send behavior.
- Notification types exist for application, payment, balance statement, daily brief, developer feedback, and test email.

## 2. Gap Analysis

Compared to the desired Sales + Post-Sales Automation layer, Wamule already has strong operations records but lacks a sales pipeline model and task layer before and around application approval.

Missing or incomplete areas:

- Dedicated lead record before formal application.
- Lead source tracking.
- Sales pipeline stage separate from application status.
- Buyer journey stage and readiness tracking.
- Follow-up task tracking outside Daily Brief action items.
- Site visit scheduling.
- Staff assignment for leads, applications, customers, and next actions.
- Buyer decision blockers such as family decision, financing clarity, travel/site visit constraint, missing ID, or deposit uncertainty.
- Deposit readiness tracking before contract/payment entry.
- Reservation workflow with expiry, reason, assigned staff, and history.
- Activity timeline that spans lead, application, customer, contract, payment, document, and staff notes.
- Document checklist automation beyond payment document uploads and signed contract path.
- Agreement/contract readiness checklist before contract creation.
- Explicit sales-to-collections handoff.
- Sales pipeline reporting.
- Follow-up Center for operational accountability.
- Post-sales checklist after contract creation.
- Site visit outcomes and next-action conversion.
- Formal audit-style note/activity records for manual contact, WhatsApp/phone/email, meetings, document requests, and internal decisions.

Important overlaps to manage carefully:

- Applications already contain many lead-like intake fields. Adding `leads` must not duplicate public applications blindly.
- Customers are created only after approval. A lead may or may not become an application, and an application may or may not become a customer.
- `brief_action_items` already tracks action work from Daily Briefs, but it is too brief-specific to become the general follow-up/task system without creating confusing source semantics.
- `payment_requests` handles money requests after customer/contract context, but does not model deposit readiness or sales-stage deposit commitment before contract.
- Parcel `Reserved` is currently created by application approval. A more explicit reservation workflow must coexist with existing lot status triggers.

## 3. Recommended Data Model

These are proposed additions for later phases. Do not implement them until product decisions are confirmed and migrations are planned.

### `leads`

Purpose:

- Track buyer interest before, during, or alongside a formal application.
- Provide a sales pipeline record that can exist without immediately creating a customer.

Key fields:

- `id`
- `source_application_id` nullable reference to `applications`
- `converted_customer_id` nullable reference to `customers`
- `first_name`, `last_name`, `phone`, `email`
- `lead_source` text or enum, such as Public Application, Referral, Walk-in, Phone, WhatsApp, Facebook, Staff Entered
- `pipeline_stage` enum or text constrained to New Lead, Contacted, Interested, Family Decision, Site Visit Scheduled, Deposit Pending, Deposit Paid, Application Submitted, Contract Started, Closed/Won, Lost/Inactive
- `buyer_journey_stage` text for simpler reporting if pipeline needs grouping
- `preferred_parcel_ids` bigint array or link table
- `preferred_lot_notes`
- `budget_range`
- `intended_use`
- `payment_plan_interest`
- `assigned_to` references `auth.users`
- `next_action_at`
- `next_action_summary`
- `lost_reason`
- `created_by`
- timestamps

Relationships:

- May link to one application and one eventual customer.
- May have many activities, follow-up tasks, site visits, decision factors, and reservations.

Role/permission considerations:

- Internal users can read.
- Admin and Staff can create/update.
- Admin can delete or mark merged/lost.
- Read Only cannot change stage or assignment.

Phase:

- MVP / Phase 1.

### `lead_activities`

Purpose:

- Record contact history and manual sales activity.
- Create the foundation for an Activity Timeline.

Key fields:

- `id`
- `lead_id` nullable
- `application_id` nullable
- `customer_id` nullable
- `activity_type` such as Call, WhatsApp, Email, Site Visit, Note, Document Request, Payment Discussion, Status Change
- `subject`
- `body`
- `outcome`
- `created_by`
- `activity_at`
- timestamps

Relationships:

- Can attach to lead, application, customer, or later reservation/task records.

Role/permission considerations:

- Internal users can read.
- Admin and Staff can create.
- Updates should be limited to the creator or Admin if audit strictness matters.

Phase:

- MVP / Phase 1.

### `follow_up_tasks`

Purpose:

- Track next actions independent of Daily Brief action items.
- Power Follow-up Center, dashboard widgets, staff accountability, and sales handoff.

Key fields:

- `id`
- `lead_id` nullable
- `application_id` nullable
- `customer_id` nullable
- `contract_id` nullable
- `title`
- `details`
- `task_type` such as Call, WhatsApp, Email, Site Visit, Deposit, Document, Agreement, Collection, Internal
- `status` Open, In Progress, Done, Dismissed, Cancelled
- `priority` Low, Normal, High, Urgent
- `due_at`
- `assigned_to`
- `created_by`
- `completed_at`
- timestamps

Relationships:

- Can be created from lead stage changes, application reviews, customer summaries, daily brief actions, or manual staff entry.

Role/permission considerations:

- Internal users can read.
- Admin and Staff can create/update.
- Admin can reassign all tasks; Staff can update tasks assigned to them or created by them if desired.

Phase:

- MVP / Phase 1.

### `site_visits`

Purpose:

- Schedule and track buyer site visits.
- Capture attendance, outcome, and next action.

Key fields:

- `id`
- `lead_id` nullable
- `application_id` nullable
- `customer_id` nullable
- `scheduled_for`
- `status` Scheduled, Completed, No Show, Cancelled, Rescheduled
- `assigned_to`
- `meeting_location`
- `notes`
- `outcome`
- `next_action_task_id` nullable
- timestamps

Relationships:

- Usually belongs to a lead; can be linked to an application/customer after conversion.

Role/permission considerations:

- Internal users can read.
- Admin and Staff can manage.

Phase:

- MVP / Phase 1.

### `buyer_decision_factors`

Purpose:

- Track structured blockers/readiness signals such as family decision, payment clarity, ID missing, financing source, travel constraints, or lot concern.

Key fields:

- `id`
- `lead_id` nullable
- `application_id` nullable
- `customer_id` nullable
- `factor_type`
- `status` Open, Resolved, Not Applicable
- `details`
- `resolved_at`
- `created_by`
- timestamps

Relationships:

- Supports lead qualification and Buyer Insights.

Role/permission considerations:

- Internal read.
- Admin/Staff write.

Phase:

- Phase 1 if lightweight; Phase 2 if MVP must stay smaller.

### `lot_reservations`

Purpose:

- Make reservations explicit instead of relying only on `parcels.status = Reserved`.
- Track expiry, reason, deposit status, source, and staff accountability.

Key fields:

- `id`
- `parcel_id`
- `lead_id` nullable
- `application_id` nullable
- `customer_id` nullable
- `reservation_status` Draft, Active, Expired, Cancelled, Converted
- `reserved_at`
- `expires_at`
- `reservation_fee_due`
- `reservation_fee_paid_transaction_id` nullable
- `reserved_by`
- `notes`
- timestamps

Relationships:

- Belongs to one parcel and optionally one lead/application/customer.
- May link to a payment transaction once deposit/reservation fee is recorded.

Role/permission considerations:

- Internal read.
- Admin/Staff create/update.
- Admin-only cancellation after deposit may be appropriate.

Phase:

- Phase 2.

### `document_checklist_items`

Purpose:

- Track required buyer/customer documents beyond payment proof.
- Support agreement readiness and post-sales task automation.

Key fields:

- `id`
- `lead_id` nullable
- `application_id` nullable
- `customer_id` nullable
- `contract_id` nullable
- `document_type` such as ID, Proof of Address, Signed Application, Signed Agreement, Deposit Proof, Contract, Other
- `status` Missing, Requested, Uploaded, Pending Review, Approved, Rejected, Not Required
- `file_path` nullable
- `storage_bucket` nullable
- `original_file_name` nullable
- `reviewed_by` nullable
- `reviewed_at` nullable
- `notes`
- timestamps

Relationships:

- Can coexist with `payment_documents` initially. Later, payment documents could optionally appear as a specialized document type or stay separate for financial controls.

Role/permission considerations:

- Internal read.
- Admin/Staff create/upload/review.
- Admin can reject/delete.

Phase:

- Phase 2.

### `post_sales_tasks`

Purpose:

- Generate and manage tasks after contract creation.
- Track agreement readiness, signed contract upload, welcome/follow-up communication, payment-plan handoff, first payment confirmation, and collections handoff.

Key fields:

- `id`
- `customer_id`
- `contract_id` nullable
- `task_type`
- `title`
- `details`
- `status` Open, In Progress, Done, Dismissed
- `due_at`
- `assigned_to`
- `created_by`
- `completed_at`
- timestamps

Relationships:

- Usually created from contract creation or manually from customer detail.
- Could be implemented as a specialized view/filter over `follow_up_tasks` instead of a separate table if task behavior remains generic.

Role/permission considerations:

- Internal read.
- Admin/Staff write.

Phase:

- Phase 3.

### `customer_activity_timeline`

Purpose:

- Provide a unified readable timeline for sales, application, contract, payment, document, AI summary, email, and post-sales events.

Recommendation:

- Prefer a database view or frontend aggregation first, not a table that duplicates source records.
- Use `lead_activities` for manual entries and combine with existing records from applications, contracts, transactions, payment documents, payment requests, email notifications, customer summaries, and future tasks.

Phase:

- Phase 3 or later.

## 4. Recommended UX Flows

### New Lead Capture

MVP:

1. Staff creates a lead manually from Leads or Follow-up Center.
2. Public application submission can optionally create or link a lead during later implementation.
3. Lead starts at `New Lead`.
4. Staff assigns owner, preferred lots, source, and next action.

Later:

- Add lead import.
- Add WhatsApp/Facebook source tracking.
- Add duplicate matching by phone/email before creating a new lead.

### Lead Qualification

1. Staff reviews contact details, intended use, budget/payment plan interest, preferred lots, and missing information.
2. Staff records Buyer Insights fields or decision factors.
3. Staff moves stage to `Contacted`, `Interested`, or `Family Decision`.
4. Staff creates or updates a follow-up task with a due date.

### Buyer Journey Stage Updates

1. Lead stage is changed manually by Admin/Staff.
2. Stage changes write an activity record.
3. Important stages can prompt recommended tasks, but should not auto-approve or mutate existing application/customer/payment state.
4. Dashboard and reports summarize counts by stage.

### Family Decision / Payment Clarity Tracking

1. Staff marks decision factors such as family decision pending, payment plan unclear, deposit not ready, or missing ID.
2. Each open factor can create or link a follow-up task.
3. Smart Summary can later highlight unresolved blockers.

### Site Visit Booking

1. Staff schedules a site visit from lead detail or Follow-up Center.
2. The visit appears in dashboard widgets and Follow-up Center.
3. After the visit, staff records outcome: interested, needs family decision, deposit pending, not interested, or follow-up required.
4. Visit outcome can update lead stage and create a next-action task.

### Deposit Pending to Deposit Paid

1. Staff marks lead stage as `Deposit Pending` when buyer intent is strong but payment is not recorded.
2. A deposit follow-up task is created.
3. Actual payment remains recorded only through the existing PaymentForm/transaction workflow.
4. Once a down payment/reservation fee transaction exists, staff can mark `Deposit Paid` or a future automation can recommend the transition.

### Reservation to Application to Contract

MVP:

- Keep current application approval flow as the only authoritative lot reservation flow.
- Use lead stage and tasks to manage pre-application sales activity.

Phase 2:

1. Create explicit reservation linked to lead/application/customer and parcel.
2. Reservation sets or validates parcel availability under safe database rules.
3. Reservation expiry creates dashboard and Follow-up Center alerts.
4. Application approval and contract creation reconcile with the active reservation.

### Post-Sales Checklist

1. Contract creation triggers or suggests a checklist.
2. Checklist includes signed agreement uploaded, buyer contacted, payment plan explained, first due date confirmed, document checklist complete, and collections handoff done.
3. Tasks appear in customer detail and Follow-up Center.

### Document Checklist

1. Define required document templates by phase or workflow.
2. Generate missing checklist items for lead/application/customer/contract.
3. Staff uploads/reviews documents.
4. Customer and contract readiness panels show missing or rejected items.

### Sales Handoff to Collections

1. Contract is created and post-sales checklist begins.
2. Staff confirms payment plan terms, first due date, signed agreement, and required documents.
3. Handoff task marks account ready for collections monitoring.
4. Collections page continues to use contracts, transactions, payment requests, missing receipts, and proof status as operational source of truth.

## 5. Recommended Navigation Changes

MVP:

- Add `Leads` as the primary sales workspace.
- Add `Follow-up Center` if follow-up tasks are included in Phase 1.

Later:

- Add `Sales Pipeline` if a kanban-style pipeline becomes important enough to separate from Leads.
- Add `Site Visits` if volume warrants a schedule-focused page.
- Add `Post-Sales` if post-contract checklist work becomes large enough to leave Customer Detail / Follow-up Center.

Recommended MVP navigation:

- Dashboard
- Daily Brief
- Leads
- Follow-up Center
- Lots
- Applications
- Customers
- Contracts
- Payments
- Collections
- Reports
- Settings

Keep Email Center admin-only.

## 6. Recommended Dashboard Additions

Recommended widgets:

- Leads needing follow-up today.
- Overdue follow-ups.
- New leads this week.
- Sales pipeline summary by stage.
- Site visits scheduled today/this week.
- Deposit pending.
- Buyers needing family decision follow-up.
- Reservations expiring soon.
- Applications ready for review.
- Contracts awaiting signed documents.
- Post-sales tasks due.
- Sales-to-collections handoffs pending.

MVP dashboard additions should be limited to:

- Leads needing follow-up.
- Site visits scheduled.
- Deposit pending.
- Sales pipeline summary.

## 7. AI/Smart Summary Opportunities

AI should remain advisory, internal, and calm.

Useful opportunities:

- Lead summary: summarize contact history, intended use, preferred lots, and next action.
- Buyer readiness: indicate whether buyer appears ready for application, site visit, deposit, or contract.
- Missing information: flag missing phone/email, lot preference, intended use, payment clarity, ID/documents, or legal acknowledgement.
- Recommended next action: suggest call, WhatsApp follow-up, site visit, document request, deposit reminder, or application review.
- Follow-up suggestions: draft concise staff-facing follow-up notes or buyer messages.
- Risk flags: lot conflict, duplicate phone/email, stalled decision, expired reservation, missing proof, unclear payment plan.
- Daily sales brief: summarize new leads, overdue follow-ups, upcoming site visits, deposit pending, and stalled pipeline.
- Customer timeline summary: summarize key events from lead to contract to collections.

Guardrails:

- AI must not approve applications.
- AI must not reserve lots.
- AI must not create customers.
- AI must not create contracts.
- AI must not log payments.
- AI must not send emails without explicit admin action.
- AI must not change balances, statuses, permissions, or payment terms.

## 8. MVP Recommendation

The smallest useful first version should focus on sales accountability without disturbing current application, contract, or payment logic.

Recommended MVP scope:

1. Add leads with pipeline stage, source, assigned staff, next action, and optional application/customer link.
2. Add follow-up tasks linked to leads/applications/customers.
3. Add site visits linked to leads/applications/customers.
4. Add lead activity notes for calls, WhatsApp, email, site visits, and stage changes.
5. Add dashboard widgets for follow-ups, site visits, deposit pending, and pipeline stage counts.
6. Add a Leads page with list/filter and a lead detail workspace.
7. Add a Follow-up Center for due/overdue tasks.
8. Keep application approval, customer creation, lot reservation, contract creation, and payment recording unchanged.
9. Add post-contract checklist planning but defer automatic creation until Phase 3 unless the MVP needs a simple manual checklist.

Why this MVP:

- It solves the immediate spreadsheet/manual tracking gap.
- It gives staff a place to manage interested buyers before formal application approval.
- It avoids modifying fragile contract/payment calculations.
- It does not force a new reservation model before lot rules are fully decided.
- It creates the foundation for future automation and AI guidance.

## 9. Implementation Phases

### Phase 1: Sales Foundation

Data:

- `leads`
- `lead_activities`
- `follow_up_tasks`
- `site_visits`
- Optional lightweight `buyer_decision_factors`

UX:

- Leads page.
- Lead detail panel/page.
- Follow-up Center.
- Site visit scheduling inside lead detail.
- Pipeline filters or simple board.
- Dashboard widgets for follow-ups, site visits, deposit pending, and pipeline counts.

Integration:

- Link leads to applications and customers where applicable.
- Add manual conversion/linking controls.
- Do not change existing application approval or contract/payment logic.

### Phase 2: Reservation + Deposit Workflow

Data:

- `lot_reservations`
- `document_checklist_items`
- Optional reservation audit/activity extensions.

UX:

- Reservation panel on lead/application/customer detail.
- Reservation expiry queue.
- Deposit pending/paid readiness indicators.
- Document checklist on lead/application/customer detail.
- Agreement readiness panel before contract creation.

Integration:

- Reconcile reservation records with parcel status.
- Keep actual payment recording in `transactions`.
- Keep contract creation in existing ContractForm.

### Phase 3: Post-Sales Automation

Data:

- `post_sales_tasks` or post-sales task type in `follow_up_tasks`.
- Customer timeline aggregation view or frontend timeline aggregator.

UX:

- Post-sales checklist on customer detail.
- Sales handoff to collections panel.
- Staff assignment/reporting.
- Agreement readiness and document completion indicators.
- Collections handoff queue.

Integration:

- Trigger or suggest checklist creation after contract creation.
- Feed missing signed contract, first payment, documents, and payment plan confirmation into existing Collections and Reports surfaces.

### Phase 4: AI Assistance

Data:

- Lead summaries or buyer insight records if persistent AI output is needed.
- Daily sales brief fields or separate sales brief records if the current Daily Brief becomes too broad.

UX:

- Buyer Insights panel.
- Recommended Actions.
- Follow-up Suggestions.
- Missing Information.
- Risk Flags.
- Daily Sales Brief section.
- Customer Timeline Summary.

Integration:

- Use the existing advisory AI pattern.
- Keep actions manual and explicit.
- Consider creating follow-up task drafts instead of automatically inserting tasks until staff trust is established.

## 10. Risks and Questions

Risks:

- Application/customer overlap: Leads may duplicate applications unless phone/email matching and linking are designed carefully.
- Duplicate customer records: Conversion from lead/application/customer must preserve the existing one-application-to-one-customer rule.
- Lot availability rules: Explicit reservations could conflict with current `approve_application` and contract triggers if not designed carefully.
- Contract/payment logic: Deposit readiness must not become a second payment ledger.
- Permissions: Sales staff may need write access to leads/tasks but not settings/email/admin functions.
- Overcomplication: Too many stages or required fields could slow a small team.
- Reporting drift: Pipeline reports must define whether applications without leads are counted.
- AI trust: AI suggestions should remain advisory and should not become hidden workflow automation.
- Mobile density: Leads, Follow-up Center, and timeline pages will need responsive QA because admin mobile QA is still pending.

Open questions:

- Should every public application automatically create a lead, or should applications remain separate until staff chooses to link/create a lead?
- What are Wamule's exact sales pipeline stages for Phase 1?
- Should `Deposit Paid` be driven only by an actual transaction, or can staff mark readiness manually before finance confirms?
- How long can a lot be reserved before expiry?
- Can a lead reserve more than one lot, or only express preferences for multiple lots?
- Should reservation expiry automatically release a lot, or only alert staff?
- Which documents are required before contract creation?
- Which documents are required after contract creation?
- Which roles can assign staff and reassign tasks?
- Should Staff see all leads or only assigned leads?
- Should email/WhatsApp follow-ups be logged manually first, or integrated later?
- Should the Follow-up Center absorb Daily Brief action items, or should those remain separate but cross-linked?
- What sales reports matter most: conversion rate, stage aging, follow-up compliance, site visit conversion, deposit pending, or lost reasons?

## Recommended Next Step

Before implementation, confirm the MVP workflow decisions:

1. Lead creation/linking rules for public applications.
2. Final pipeline stage list.
3. Assignment/visibility rules by role.
4. Whether Phase 1 includes decision factors or keeps them as notes.
5. Whether site visits need calendar-style scheduling or simple date/time tracking.
6. Whether deposit readiness is manual stage tracking only or tied to transaction checks.

After those decisions, create a Phase 1 technical implementation spec with exact migrations, TypeScript types, RLS policies, route/page additions, query plans, and QA checklist.
