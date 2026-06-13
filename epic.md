# Wamuale Development Platform

## Product Requirements Document / Epic Specification

## 1. Document Overview

### Product Name

Wamuale Development Platform

### Product Type

Admin-first land development management system with public application intake and future customer portal capability.

### Prepared For

Wamuale Development shareholders, directors, administrators, and development team.

### Primary Objective

Build a centralized digital system that allows Wamuale Development to manage land applications, lot inventory, contracts, monthly payments, receipts, customer records, community service fees, and financial reporting for the Phase 1 land development project.

The system will replace manual spreadsheet tracking with a structured, secure, database-driven platform that protects financial records, prevents double-selling of lots, improves visibility into customer balances, and supports long-term community management.

---

# 2. Executive Summary

Wamuale Development is preparing to formalize and launch a structured land development project outside Dangriga. The first operational focus is the initial 5-acre subdivision, consisting of 24 lots measuring approximately 75x100 ft each. The broader land holding is 20 acres, but the first software release will focus on the first 24 Phase 1 lots.

Current operations are expected to begin with a small internal team entering applications, uploading contract files, recording payments, and generating reports. Customers will not need login access in the first release, but the system should be designed so that a customer portal can be added later.

The platform must support two long-term financial streams:

1. Land purchase contracts paid over a maximum of 60 months.
2. Ongoing community fees for road maintenance, garbage disposal, and related neighborhood services.

This is not a standard CRM. Wamuale Development needs an operational ledger and asset management system where the most important work begins after a customer is approved and a land contract is created.

---

# 3. Business Context

## 3.1 Current Problem

Wamuale Development currently needs a way to track:

* Who has applied for land.
* Which lots are available, reserved, or sold.
* Which applicants have been approved.
* Which customers have active contracts.
* Who is making monthly payments.
* Who is behind on payments.
* Which payments were made by cash or online transfer.
* Which receipts were issued.
* Which customers owe ongoing community fees.
* Which lots are tied to which customers and contracts.

Using Excel or manual registers creates risk as the project grows. Manual tracking can lead to:

* Duplicate entries.
* Missed payments.
* Unclear customer balances.
* Difficulty identifying delinquent customers.
* No real-time view of lot availability.
* Weak audit trail.
* Difficulty producing reports for directors or shareholders.
* Risk of double-selling or incorrectly reserving lots.

## 3.2 Business Opportunity

A custom platform gives Wamuale Development a controlled operating system for the land project. It can act as a digital twin of the physical subdivision, showing the status of every lot, every customer, every payment, and every outstanding balance.

This will help leadership:

* Launch more professionally.
* Manage buyer interest from the beginning.
* Protect financial records.
* Reduce manual administrative work.
* Create receipts and reports faster.
* Track both land payments and community fees.
* Prepare for a future customer-facing portal.

---

# 4. Product Goals

## 4.1 Primary Goals

The first release must allow internal users to:

* Log into a secure admin dashboard.
* View and manage all 24 Phase 1 lots.
* Accept public land applications through an intake form.
* Review applications through a Kanban-style pipeline.
* Approve or decline applicants.
* Automatically create customer records from approved applications.
* Reserve lots when applications are approved.
* Create contracts with a maximum payment term of 60 months.
* Upload signed contract documents.
* Record down payments, land installments, garbage fees, and road maintenance fees.
* Separate land payment history from community fee history.
* Require bank reference numbers for online transfers.
* Prevent duplicate online transfer references.
* Generate or queue receipts for every payment.
* View reports for total revenue, overdue land balances, and community fee delinquency.

## 4.2 Secondary Goals

The system should also:

* Keep an audit trail of which admin logged each payment.
* Support future customer login.
* Support future customer balance viewing.
* Support future customer receipt downloads.
* Support future customer upload of transfer proof.
* Support future notification workflows for overdue accounts.

---

# 5. Product Scope

## 5.1 MVP Scope

The MVP will include:

* Admin authentication.
* Admin dashboard.
* Public application form.
* Application review pipeline.
* 24-lot status board.
* Customer management.
* Contract management.
* Payment ledger.
* Receipt generation workflow.
* Basic analytics and reporting.
* Secure file storage for contracts and receipts.

## 5.2 Out of Scope for MVP

The following should not be built in the first release unless time allows:

* Full customer login portal.
* Automated WhatsApp reminders.
* Automated SMS reminders.
* Online card payments.
* Full accounting software integration.
* Advanced document signing.
* GIS/map-based land visualization.
* Multi-project/multi-subdivision support.
* Full mobile app.

## 5.3 Future Scope

Future versions may include:

* Customer portal.
* Customer payment proof uploads.
* Automated email/WhatsApp reminders.
* Online payment gateway integration.
* Director/shareholder reporting portal.
* Public lot availability map.
* Community announcements.
* Resident service requests.
* Maintenance work order tracking.

---

# 6. User Personas

## 6.1 System Administrator

### Description

A trusted internal user with full access to manage the system.

### Responsibilities

* Manage lots.
* Manage applications.
* Approve applicants.
* Create contracts.
* Record payments.
* Upload documents.
* Generate reports.
* Manage admin users.

### Access Level

Full system access.

---

## 6.2 Staff / Agent

### Description

An internal user who helps with data entry, payment logging, and customer record updates.

### Responsibilities

* Enter applications manually if needed.
* Update customer contact details.
* Log payments.
* Upload receipts or documents.
* View reports.

### Access Level

Limited operational access. Cannot delete financial history or change system-level settings.

---

## 6.3 Director / Shareholder

### Description

A leadership user who needs visibility into performance and risk.

### Responsibilities

* View revenue.
* View lot status.
* View delinquency reports.
* View contract summaries.
* Monitor launch progress.

### Access Level

Read-only or reporting-focused access.

---

## 6.4 Applicant

### Description

A person interested in purchasing land in the development.

### Responsibilities

* View basic project information.
* Submit application or interest form.
* Confirm understanding of community expectations.

### Access Level

Public form only. No login in MVP.

---

## 6.5 Customer

### Description

An approved applicant who has a reserved or sold lot and may have an active contract.

### Responsibilities

* Make land payments.
* Pay ongoing community fees.
* Receive receipts.

### Access Level

No direct login in MVP. Future portal access planned.

---

# 7. Core Product Architecture

## 7.1 Recommended Stack

### Frontend

* React
* Vite
* Tailwind CSS
* Shadcn/ui
* React Router
* TanStack Query or equivalent data-fetching layer
* React Hook Form
* Zod validation

### Backend

* Supabase
* PostgreSQL
* Supabase Auth
* Supabase Storage
* Supabase Edge Functions for receipt generation and backend automation where needed

### Storage

* Private Supabase storage buckets:

  * contracts
  * receipts
  * application-documents

---

# 8. Database Entities

## 8.1 Parcels

### Purpose

Tracks physical land lots.

### Required Fields

* ID
* Lot number
* Dimensions
* Zoning
* Status
* Base price
* Created date
* Updated date

### Business Rules

* Lot numbers must be unique.
* Default dimensions should be 75x100 ft.
* Lot status must be one of:

  * Available
  * Reserved
  * Sold
* Zoning must be one of:

  * Residential
  * Commercial
  * Green Space
* Phase 1 must seed exactly 24 lots.

---

## 8.2 Applications

### Purpose

Tracks applicants interested in land purchase.

### Required Fields

* ID
* First name
* Last name
* Phone
* Email
* Desired parcel
* Cultural/community review notes
* Sustainability terms verified
* Application status
* Created date
* Updated date

### Business Rules

* Application status must be one of:

  * Pending Review
  * Approved
  * Declined
* Desired parcel should link to a valid parcel when selected.
* Sustainability agreement should be recorded as true or false.
* Approval should trigger customer creation and lot reservation.

---

## 8.3 Customers

### Purpose

Stores approved applicants who become validated customers.

### Required Fields

* ID
* Application ID
* First name
* Last name
* Phone
* Email
* Address
* Future auth user ID
* Created date
* Updated date

### Business Rules

* Customer should be linked to the originating application.
* A single application should not create multiple duplicate customers.
* Auth user ID should remain nullable until a customer portal is launched.

---

## 8.4 Contracts

### Purpose

Tracks formal land purchase agreements.

### Required Fields

* ID
* Customer ID
* Parcel ID
* Final purchase price
* Initial deposit
* Contract term in months
* Monthly payment
* Start date
* Payment due day
* Signed contract file path
* Active status
* Created date
* Updated date

### Business Rules

* Contract must link to one customer and one parcel.
* Contract term cannot exceed 60 months.
* Initial deposit cannot exceed final purchase price.
* Monthly payment should be calculated from remaining balance divided by contract term.
* Contract should not be created for a sold lot.
* Contract should update the parcel status according to the agreed business rule.
* Signed contract document should be stored securely.

---

## 8.5 Transactions

### Purpose

Central financial ledger for all incoming money.

### Required Fields

* ID
* Customer ID
* Contract ID, nullable
* Amount
* Transaction type
* Collection method
* Bank reference
* Authorized by
* Receipt file path
* Notes
* Created date

### Transaction Types

* Down Payment
* Land Installment
* Garbage Fee
* Road Maintenance

### Collection Methods

* Cash
* Online Transfer

### Business Rules

* Amount must be greater than zero.
* Online Transfer requires a bank reference number.
* Bank reference numbers must be unique when provided.
* Contract ID may be null for community fees.
* Every transaction must be tied to a customer.
* Every transaction should record the admin user who authorized the entry.
* Every successful transaction should create or queue a receipt.

---

# 9. Functional Requirements

## Epic 1: Authentication & User Access

### Goal

Only authorized internal users should access the admin dashboard.

### Features

* Admin login.
* Logout.
* Protected routes.
* User role profiles.
* Session persistence.

### User Stories

* As an admin, I want to log in securely so I can manage Wamuale Development records.
* As a staff user, I want access only to the tools I need so that sensitive settings remain protected.
* As a director, I want reporting access so I can monitor the project without editing financial records.

### Acceptance Criteria

* Unauthenticated users are redirected to the login page.
* Authenticated users can access the dashboard.
* User role is loaded after login.
* Logout ends the active session.
* Admin-only actions are hidden or blocked for lower roles.

---

## Epic 2: Public Application Intake

### Goal

Allow interested buyers to submit a land application or interest form.

### Features

* Public application page.
* Project overview section.
* Applicant contact form.
* Desired lot selection.
* Community expectation acknowledgment.
* Sustainability terms checkbox.
* Success confirmation after submission.

### User Stories

* As an applicant, I want to submit my interest online so Wamuale can review me.
* As an applicant, I want to understand the community expectations before applying.
* As an admin, I want public applications to appear in the review dashboard automatically.

### Acceptance Criteria

* Public users can access the application form without logging in.
* Required fields are validated.
* Application creates a database record.
* Application status defaults to Pending Review.
* Admin dashboard displays new applications.
* Public users cannot access admin records.

### Notes

Application language should focus on objective community requirements such as sustainability, waste sorting, fee obligations, road maintenance, and community participation. Any applicant screening criteria should be reviewed by local legal counsel before launch.

---

## Epic 3: Intake Kanban Pipeline

### Goal

Allow internal users to review and process applications through clear status stages.

### Features

* Kanban board with three columns:

  * Pending Review
  * Approved
  * Declined
* Application cards.
* Applicant detail modal.
* Status update control.
* Sustainability flag.
* Desired lot display.

### User Stories

* As an admin, I want to see all pending applications so I know who needs review.
* As an admin, I want to open an application and read details before approving.
* As an admin, I want approved applications to automatically create customers and reserve lots.

### Acceptance Criteria

* Applications display under the correct status.
* Cards show applicant name, phone, desired lot, and sustainability flag.
* Clicking a card opens a full detail modal.
* Admin can update application status.
* Approval creates a customer record.
* Approval reserves the selected lot.
* Duplicate customer creation is prevented.
* Approval is blocked if the desired lot is sold or unavailable.

---

## Epic 4: 24-Lot Status Management Board

### Goal

Show real-time inventory status for all Phase 1 lots.

### Features

* Grid layout with exactly 24 lot tiles.
* Lot status color coding.
* Lot detail modal or drawer.
* Lot price display.
* Lot zoning display.
* Linked customer and contract summary.

### Status Colors

* Available: Green
* Reserved: Amber
* Sold: Crimson

### User Stories

* As an admin, I want to see all 24 lots at once so I can understand inventory.
* As an admin, I want to click a lot and view details.
* As a director, I want a clear view of sold, reserved, and available lots.

### Acceptance Criteria

* Exactly 24 lots render for Phase 1.
* Each tile displays lot number, dimensions, status, and base price.
* Tile color matches parcel status.
* Clicking a lot opens details.
* Reserved or sold lots show linked customer information if available.
* Lots with contracts show contract and ledger summary.

---

## Epic 5: Customer Management

### Goal

Provide a central view of approved customers and their related records.

### Features

* Customer list.
* Customer search.
* Customer profile.
* Linked application display.
* Linked lot display.
* Contract summary.
* Payment history.
* Community fee history.
* Receipt links.

### User Stories

* As an admin, I want to search for a customer quickly.
* As an admin, I want to see a customer’s lot, contract, and payment history in one place.
* As a staff member, I want to update customer contact details when needed.

### Acceptance Criteria

* Customer list loads approved customers.
* Search works by name, phone, and email.
* Customer profile displays application, parcel, contract, and transaction data.
* Land payment history and community fee history are separated.
* Customer record cannot be deleted if linked to contracts or financial history.

---

## Epic 6: Contract Management

### Goal

Create and manage land purchase contracts.

### Features

* Contract creation form.
* Contract detail page.
* Monthly payment calculation.
* Signed contract upload.
* Contract active/inactive status.
* Contract balance summary.

### User Stories

* As an admin, I want to create a contract for an approved customer.
* As an admin, I want the monthly payment to calculate automatically.
* As an admin, I want to upload the signed contract so it is stored with the customer record.
* As a director, I want to see the total contract value and remaining balance.

### Acceptance Criteria

* Contract can only be created for valid customer and parcel.
* Contract term greater than 60 months is blocked.
* Final purchase price must be greater than zero.
* Initial deposit cannot exceed final purchase price.
* Monthly payment is calculated correctly.
* Signed contract file uploads to secure storage.
* Contract links to customer and parcel.
* Contract cannot be deleted if it has transaction history.
* Contract balance updates when payments are recorded.

---

## Epic 7: Unified Payment Ledger

### Goal

Record all incoming payments in one secure ledger while keeping land payments and community fees logically separate.

### Features

* Unified payment logging form.
* Customer selection.
* Optional contract selection.
* Transaction type dropdown.
* Collection method dropdown.
* Bank reference field.
* Duplicate bank reference check.
* Payment notes.
* Authorized admin tracking.

### User Stories

* As a staff member, I want to log cash payments quickly.
* As a staff member, I want to log online transfers with bank references.
* As an admin, I want duplicate bank references blocked so payments are not double counted.
* As a director, I want all money collected to appear in one auditable ledger.

### Acceptance Criteria

* Cash payments can be saved without a bank reference.
* Online transfer payments require a bank reference.
* Duplicate bank references are blocked.
* Transaction amount must be greater than zero.
* Transaction records the logged-in admin user.
* Land payments update contract balance.
* Community fees do not incorrectly reduce land balance.
* Every successful transaction creates or queues a receipt.

---

## Epic 8: Dual-Stream Account Summary

### Goal

Separate customer financial records into land contract balances and ongoing community fees.

### Features

* Land account summary.
* Community fee summary.
* Land installment history.
* Garbage fee history.
* Road maintenance fee history.
* Remaining land balance.
* Community delinquency standing.

### User Stories

* As an admin, I want to know how much a customer still owes on land.
* As an admin, I want to know if a customer is behind on garbage or road fees.
* As a director, I want clear separation between asset financing and community services.

### Acceptance Criteria

* Land payments and down payments appear in the land ledger.
* Garbage and road maintenance payments appear in the community ledger.
* Remaining land balance calculates correctly.
* Community fees continue to track even after land is fully paid.
* Customer profile clearly separates both financial streams.

---

## Epic 9: Receipt & Document Management

### Goal

Automatically generate and store receipts and keep important files linked to records.

### Features

* Receipt generation queue.
* PDF receipt template.
* Receipt storage bucket.
* Contract storage bucket.
* Receipt download/view links.
* Contract document upload and view links.

### User Stories

* As a customer, I need a receipt after every payment.
* As an admin, I want receipts generated automatically so I do not manually create them.
* As a director, I want all receipts and contracts stored securely for audit purposes.

### Acceptance Criteria

* Every successful transaction queues a receipt.
* Receipt includes customer, lot, amount, payment type, method, date, and authorized admin.
* Receipt is saved as a PDF.
* Receipt file path is attached to the transaction.
* Admin can open or download receipts.
* Contract files are stored securely.
* Missing or failed receipt generation is visible to admin.

### Technical Note

PostgreSQL should not directly generate PDFs. The database should trigger or queue the receipt job, while a Supabase Edge Function or backend worker generates the PDF, uploads it to storage, and updates the transaction record.

---

## Epic 10: Reports & Analytics

### Goal

Give management visibility into revenue, overdue accounts, and community fee standing.

### Features

* Dashboard summary cards.
* Total revenue report.
* Overdue land installment report.
* Community fee delinquency report.
* Customer balance report.
* CSV export.

### User Stories

* As a director, I want to see total revenue collected.
* As an admin, I want to identify customers behind on land payments.
* As an admin, I want to identify customers behind on garbage or road fees.
* As a director, I want exportable reports for meetings.

### Acceptance Criteria

* Dashboard shows total revenue.
* Dashboard shows available, reserved, and sold lots.
* Dashboard shows pending applications.
* Dashboard shows overdue installment balances.
* Dashboard shows community delinquency count.
* Reports can be filtered by date range.
* Reports can be exported to CSV.
* Report totals match the transaction ledger.

---

## Epic 11: Future Customer Portal

### Goal

Prepare the system for future customer self-service access.

### Future Features

* Customer login.
* Customer balance dashboard.
* Payment history.
* Receipt downloads.
* Contract document access.
* Upload bank transfer proof.
* View next due date.
* View community fee standing.

### User Stories

* As a customer, I want to log in and see my balance.
* As a customer, I want to download my receipts.
* As a customer, I want to upload proof of bank transfer.
* As an admin, I want to review customer-submitted transfer proof before it becomes an official transaction.

### MVP Decision

Do not build the full customer portal in the first release. The MVP should include a nullable customer authentication field so this can be added later without redesigning the database.

---

# 10. Non-Functional Requirements

## 10.1 Security

* Admin dashboard must require authentication.
* Public application form must not expose admin data.
* Financial records must be protected by row-level security.
* Storage buckets for contracts and receipts should be private.
* Admin roles should control sensitive operations.
* Deleting financial records should be restricted.
* Database constraints should protect against invalid states.

## 10.2 Data Integrity

* Lot numbers must be unique.
* Bank references must be unique when provided.
* Contract terms must not exceed 60 months.
* Online transfers must have bank references.
* Payments must have positive amounts.
* Contracts must link to valid customers and parcels.
* Transactions must link to valid customers.
* Historical financial records should not be deleted casually.

## 10.3 Performance

* Lot board should load quickly.
* Lot number should be indexed.
* Customer search should be responsive.
* Reports should handle growing payment history.
* Dashboard should avoid unnecessary full-table reloads.

## 10.4 Usability

* Interface should be clean and simple for non-technical users.
* Forms should have clear validation messages.
* Lot statuses should be visually obvious.
* Payment logging should be fast and hard to misuse.
* Empty states should explain what to do next.
* Errors should be written in plain language.

## 10.5 Auditability

* Every transaction should show who authorized it.
* Receipts should be linked to payment records.
* Contract files should be linked to contract records.
* Duplicate online transfer references should be blocked.
* Financial history should be preserved.

---

# 11. Key Workflows

## 11.1 Public Application Workflow

1. Applicant opens public Wamuale Development application page.
2. Applicant reads project/community overview.
3. Applicant enters contact details.
4. Applicant selects desired lot if applicable.
5. Applicant agrees to community expectations.
6. Applicant submits form.
7. System creates application with Pending Review status.
8. Admin sees application in Kanban pipeline.

---

## 11.2 Application Approval Workflow

1. Admin opens pending application.
2. Admin reviews applicant details and community agreement.
3. Admin chooses Approved.
4. System checks selected lot status.
5. If lot is available, system creates customer record.
6. System links customer to application.
7. System updates selected lot to Reserved.
8. Application moves to Approved column.
9. Customer appears in customer list.

---

## 11.3 Contract Creation Workflow

1. Admin opens customer profile.
2. Admin selects Create Contract.
3. Admin enters final price, deposit, term, start date, and due day.
4. System validates that term is 60 months or less.
5. System calculates monthly payment.
6. Admin uploads signed contract document.
7. System creates contract.
8. System links contract to customer and parcel.
9. System updates lot status according to business rule.
10. Contract appears in customer profile.

---

## 11.4 Payment Logging Workflow

1. Admin opens customer profile or payment screen.
2. Admin selects customer.
3. Admin selects transaction type.
4. Admin enters amount.
5. Admin selects Cash or Online Transfer.
6. If Online Transfer, admin enters bank reference.
7. System checks for duplicate bank reference.
8. If unique, system saves transaction.
9. System records authorized admin.
10. System queues receipt generation.
11. Land balance or community fee standing updates.

---

## 11.5 Receipt Generation Workflow

1. Transaction is saved.
2. Database creates receipt job.
3. Backend worker or Edge Function picks up receipt job.
4. Receipt PDF is generated.
5. PDF is uploaded to secure receipt storage.
6. Transaction record is updated with receipt file path.
7. Admin can view/download receipt from payment history.

---

## 11.6 Delinquency Reporting Workflow

1. Admin opens reports dashboard.
2. System checks active contracts and expected payment schedules.
3. System compares expected land payments against actual payments.
4. System flags overdue land accounts.
5. System checks monthly community fee obligations.
6. System flags community fee delinquency.
7. Admin exports or copies reminder details.

---

# 12. MVP Release Plan

## Sprint 1: Foundation

### Deliverables

* React/Vite project setup.
* Tailwind and Shadcn/ui setup.
* Supabase connection.
* Admin authentication.
* Base dashboard layout.
* Protected routes.

### Exit Criteria

* Admin can log in and access a protected dashboard.
* Unauthenticated users cannot access admin pages.

---

## Sprint 2: Database & Lot Board

### Deliverables

* Parcels table.
* Applications table.
* Customers table.
* Contracts table.
* Transactions table.
* Seed 24 lots.
* 24-lot management board.
* Lot detail modal.

### Exit Criteria

* Admin can view all 24 lots.
* Lot status displays correctly.
* Lot detail opens from the board.

---

## Sprint 3: Public Intake & Application Pipeline

### Deliverables

* Public application form.
* Intake Kanban board.
* Application detail modal.
* Status updates.
* Approval automation.

### Exit Criteria

* Public users can submit applications.
* Admin can approve or decline applications.
* Approved applications create customers and reserve lots.

---

## Sprint 4: Customer & Contract Management

### Deliverables

* Customer list.
* Customer profile.
* Contract creation.
* Contract upload.
* Contract detail summary.
* Balance calculation.

### Exit Criteria

* Admin can create a valid contract.
* Contract term over 60 months is blocked.
* Customer profile shows contract and lot details.

---

## Sprint 5: Payment Ledger

### Deliverables

* Unified payment logging form.
* Cash payment support.
* Online transfer support.
* Required bank reference validation.
* Duplicate bank reference check.
* Land ledger.
* Community fee ledger.

### Exit Criteria

* Admin can log payments.
* Duplicate online transfer references are blocked.
* Land and community fees remain separated.
* Customer balance updates correctly.

---

## Sprint 6: Receipts & Reports

### Deliverables

* Receipt queue.
* Receipt PDF generation.
* Receipt storage.
* Dashboard analytics.
* Revenue report.
* Overdue land report.
* Community fee delinquency report.
* CSV export.

### Exit Criteria

* Every payment queues or generates a receipt.
* Reports show accurate ledger totals.
* Admin can export reports.

---

# 13. MVP Acceptance Checklist

The MVP is considered complete when:

* Admin users can log in securely.
* Public users can submit applications.
* Admin can review applications in a Kanban board.
* Admin can approve applications.
* Approved applications create customer records.
* Approved applications reserve selected lots.
* Admin can view all 24 lots in a color-coded board.
* Admin can create contracts with maximum 60-month terms.
* Admin can upload contract files.
* Admin can log cash payments.
* Admin can log online transfers only with bank references.
* System blocks duplicate bank references.
* Land payment history is separate from community fee history.
* Customer balances calculate correctly.
* Receipts are generated or queued.
* Reports show revenue, overdue balances, and community delinquency.
* Unsafe deletes are restricted.

---

# 14. Risks & Mitigation

## Risk 1: Applicant Screening Could Create Legal Exposure

### Description

The project vision includes community and cultural preservation goals. Application review should be handled carefully to avoid unlawful or unfair discrimination.

### Mitigation

Use objective written criteria focused on community rules, financial readiness, sustainability commitments, road/garbage fee obligations, residential expectations, and legal compliance. Have all screening language reviewed by a local attorney before public launch.

---

## Risk 2: Receipt Generation Complexity

### Description

PDF generation from database triggers can become complex if implemented directly in PostgreSQL.

### Mitigation

Use database triggers only to queue receipt jobs. Generate PDFs through a Supabase Edge Function or backend service.

---

## Risk 3: Manual Payment Entry Errors

### Description

Staff may enter duplicate or incorrect payments.

### Mitigation

Require bank references for online transfers, enforce uniqueness, show confirmation screens, and preserve audit fields.

---

## Risk 4: Lot Status Confusion

### Description

Lots may be incorrectly marked as available, reserved, or sold.

### Mitigation

Automate lot reservation during approval and automate sold/reserved transitions through contract workflows where possible.

---

## Risk 5: Scope Creep Before Launch

### Description

Building a full customer portal too early may delay the admin system.

### Mitigation

Launch admin dashboard and public intake first. Defer customer login to a later phase after real customers and payment cycles exist.

---

# 15. Open Questions

1. What are the final base prices for each of the 24 lots?
2. Will all 24 lots be residential, or will some be commercial or green space?
3. Does a lot become Sold immediately when a contract is created, or only after full payment?
4. What is the exact monthly garbage fee?
5. What is the exact monthly road maintenance fee?
6. Will garbage and road fees begin immediately after contract signing or after move-in?
7. Should directors have read-only access?
8. Who are the first admin users?
9. Should application approval require one admin approval or multiple shareholder approvals?
10. What should the receipt number format be?
11. Should receipts be sent by email automatically or downloaded manually?
12. Will customers pay only by cash and bank transfer for MVP?
13. Should payment reminders be generated manually or automatically?
14. What documents should applicants upload, if any?
15. Should the public application page show lot prices or only general availability?

---

# 16. Recommended MVP Decision

The first version should be admin-first. Build the public-facing side only as a simple project information and application intake page. Do not build a full customer login portal yet.

This approach gives Wamuale Development the tools needed to launch and operate the first phase:

* Track interest.
* Control approvals.
* Protect lot inventory.
* Create contracts.
* Record payments.
* Issue receipts.
* Monitor delinquencies.
* Produce reports.

The customer portal should come later, once active customers are making payments and there is enough value in letting them log in to check balances and download receipts.

---

# 17. Final Product Statement

The Wamuale Development Platform is a custom administrative and financial management system for a structured land development project. It centralizes the full lifecycle of the business: from public interest and application review, to lot reservation, contract creation, payment collection, receipt generation, and long-term community fee tracking.

The platform is designed to protect the business from manual ledger errors, improve transparency for shareholders, and support the long-term vision of a planned, sustainable community managed by Wamuale Development.
