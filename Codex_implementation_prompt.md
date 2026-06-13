# Codex Implementation Prompt — Wamuale Development Platform

You are an expert full-stack developer. Build the Wamuale Development Platform as a clean, admin-first web application using:

* React
* Vite
* TypeScript
* Tailwind CSS
* Shadcn/ui
* Supabase
* PostgreSQL
* Supabase Auth
* Supabase Storage
* Supabase Edge Functions where needed

This platform manages a Phase 1 land development project for Wamuale Development. The first phase includes exactly 24 land lots from the first 5-acre subdivision of a larger 20-acre property outside Dangriga. Each lot is approximately 75x100 ft. The system must replace spreadsheet tracking with a secure internal dashboard for applications, lot status, customers, contracts, payments, receipts, and reports.

Do not build a full customer login portal in this MVP. Build only:

1. Admin dashboard
2. Public application/intake page
3. Internal lot, customer, contract, payment, receipt, and reporting tools

The system should be designed so that a customer portal can be added later without redesigning the database.

---

## 1. First Step: Inspect the Existing Repo

Before writing code:

1. Inspect the repository structure.
2. Identify whether this is an empty project or an existing app.
3. Do not overwrite existing business logic without checking surrounding files.
4. If the project is not already set up, scaffold a Vite React TypeScript app.
5. If Supabase files already exist, inspect them before creating new migrations.
6. If a migration file already exists for Wamuale, preserve it unless it conflicts with the requirements.

After inspection, provide a brief implementation plan, then proceed.

---

## 2. Core MVP Objective

Build an admin-first land development management system that allows Wamuale Development staff to:

* Log in securely.
* View the Phase 1 24-lot board.
* Track available, reserved, and sold lots.
* Accept public land applications.
* Review applications in a Kanban pipeline.
* Approve or decline applications.
* Automatically create customers from approved applications.
* Automatically reserve selected lots after approval.
* Create land purchase contracts.
* Enforce a maximum contract duration of 60 months.
* Upload signed contract documents.
* Log cash and online transfer payments.
* Require bank reference numbers for online transfers.
* Prevent duplicate bank reference entries.
* Separate land installment payments from road/garbage/community fees.
* Generate or queue receipts for every transaction.
* Show total revenue, overdue land balances, and community delinquency reports.

---

## 3. Required Tech Standards

### Frontend

Use:

* React + Vite + TypeScript
* Tailwind CSS
* Shadcn/ui components
* React Router
* React Hook Form
* Zod validation
* TanStack Query or a clean equivalent for data fetching
* Supabase JS client

Frontend rules:

* Build clean reusable components.
* Keep business logic out of UI components where practical.
* Use typed data models.
* Use loading, empty, and error states on all data screens.
* Use form-level validation and database-level validation.
* Do not expose service-role keys in the browser.
* Use the public anon key only with RLS enabled.
* Make the layout responsive for desktop, tablet, and mobile.

### Backend

Use Supabase PostgreSQL for:

* Tables
* Constraints
* Indexes
* Triggers
* Functions
* Row Level Security policies
* Storage buckets
* Receipt job queue

Use Supabase Edge Functions for:

* Receipt PDF generation
* Any backend-only process needing elevated privileges
* Any logic requiring a service-role key

Never put service-role keys in client-side code.

---

## 4. Database Requirements

Create or verify the following database model.

### 4.1 Admin Profiles

Table: `admin_profiles`

Purpose:
Controls access for internal users.

Fields:

* `id`
* `user_id` linked to `auth.users.id`
* `full_name`
* `role`
* `created_at`
* `updated_at`

Allowed roles:

* `Admin`
* `Staff`
* `Read Only`

Rules:

* Only authenticated admin/staff users can access admin dashboard data.
* Admins can manage users and settings.
* Staff can create and update operational records.
* Read Only users can view but not edit.

---

### 4.2 Parcels

Table: `parcels`

Purpose:
Tracks physical lot inventory.

Fields:

* `id`
* `lot_number`
* `dimensions`
* `zoning`
* `status`
* `base_price`
* `created_at`
* `updated_at`

Rules:

* `lot_number` must be unique.
* `dimensions` defaults to `75x100 ft`.
* `zoning` allowed values:

  * `Residential`
  * `Commercial`
  * `Green Space`
* `status` allowed values:

  * `Available`
  * `Reserved`
  * `Sold`
* Index `lot_number`.
* Seed exactly 24 Phase 1 lots.
* Default all initial lots to `Available` unless data already exists.

---

### 4.3 Applications

Table: `applications`

Purpose:
Tracks public and manually entered land applications.

Fields:

* `id`
* `first_name`
* `last_name`
* `phone`
* `email`
* `parcel_id`
* `cultural_preservation_review`
* `sustainability_terms_verified`
* `status`
* `notes`
* `created_at`
* `updated_at`

Rules:

* `parcel_id` references `parcels.id`.
* `email` is optional.
* `sustainability_terms_verified` is boolean.
* Status allowed values:

  * `Pending Review`
  * `Approved`
  * `Declined`
* New public applications default to `Pending Review`.

Important legal wording note:
Do not hard-code discriminatory buyer approval language. Keep public-facing criteria objective and focused on community obligations, sustainability rules, road/garbage fees, waste sorting, composting, and agreement to community guidelines.

---

### 4.4 Customers

Table: `customers`

Purpose:
Stores validated customers created from approved applications.

Fields:

* `id`
* `application_id`
* `first_name`
* `last_name`
* `phone`
* `email`
* `address`
* `auth_user_id`
* `created_at`
* `updated_at`

Rules:

* `application_id` references `applications.id`.
* `application_id` should be unique to prevent duplicate customers from the same application.
* `auth_user_id` is nullable and reserved for a future customer portal.
* Do not build customer login in MVP.

---

### 4.5 Contracts

Table: `contracts`

Purpose:
Tracks long-term land purchase obligations.

Fields:

* `id`
* `customer_id`
* `parcel_id`
* `final_purchase_price`
* `initial_deposit`
* `term_months`
* `monthly_payment`
* `start_date`
* `payment_due_day`
* `signed_contract_file_path`
* `is_active`
* `created_at`
* `updated_at`

Rules:

* `customer_id` references `customers.id`.
* `parcel_id` references `parcels.id`.
* `term_months` cannot exceed 60.
* `final_purchase_price` must be greater than 0.
* `initial_deposit` cannot exceed `final_purchase_price`.
* `monthly_payment` should be calculated from:

  * `(final_purchase_price - initial_deposit) / term_months`
* `payment_due_day` should be 1–31.
* Contract cannot be created for a sold lot.
* Contract should update the linked lot status according to business rule:

  * MVP default: set lot to `Sold` when contract is created.
  * If existing project notes indicate that contracted lots should remain `Reserved` until fully paid, preserve that rule instead.
* Signed contract files should be stored in private Supabase Storage.

---

### 4.6 Transactions

Table: `transactions`

Purpose:
Central financial ledger for all incoming money.

Fields:

* `id`
* `customer_id`
* `contract_id`
* `amount`
* `transaction_type`
* `collection_method`
* `bank_reference`
* `authorized_by`
* `receipt_file_path`
* `notes`
* `created_at`

Transaction types:

* `Down Payment`
* `Land Installment`
* `Garbage Fee`
* `Road Maintenance`

Collection methods:

* `Cash`
* `Online Transfer`

Rules:

* `customer_id` is required.
* `contract_id` is nullable because community fees can exist outside a land installment contract.
* `amount` must be greater than 0.
* `authorized_by` should reference the logged-in admin user.
* If `collection_method = Online Transfer`, `bank_reference` is required.
* If `bank_reference` is provided, it must be unique.
* Cash payments do not require bank reference.
* Land payments and community fees must remain logically separate in the UI and reporting.

---

### 4.7 Community Fee Settings

Table: `community_fee_settings`

Purpose:
Stores configurable monthly service fee amounts.

Fields:

* `id`
* `garbage_fee_amount`
* `road_maintenance_fee_amount`
* `effective_date`
* `is_active`
* `created_at`
* `updated_at`

Rules:

* Only one setting should be active at a time unless historical fee calculation requires effective-date logic.
* Use this for delinquency reports.

---

### 4.8 Receipt Jobs

Table: `receipt_jobs`

Purpose:
Queues PDF receipt generation after each successful transaction.

Fields:

* `id`
* `transaction_id`
* `status`
* `attempts`
* `error_message`
* `created_at`
* `updated_at`

Statuses:

* `Pending`
* `Processing`
* `Completed`
* `Failed`

Rules:

* Every transaction insert should create a pending receipt job.
* Receipt generation should be handled by an Edge Function or backend worker.
* The generated PDF should be uploaded to private Supabase Storage.
* After upload, update `transactions.receipt_file_path`.

---

## 5. Required Database Constraints

Implement strict database-level protections.

Required constraints:

* Unique parcel lot numbers.
* Valid parcel zoning.
* Valid parcel status.
* Valid application status.
* Contract term cannot exceed 60 months.
* Initial deposit cannot exceed final purchase price.
* Transaction amount must be greater than 0.
* Online transfer requires bank reference.
* Bank reference must be unique when provided.
* Prevent deleting parcels with dependent contracts or transaction history.
* Prevent deleting customers with dependent contracts or transaction history.
* Prevent deleting contracts with transaction history.

Use foreign keys with restrictive delete behavior where appropriate.

---

## 6. Row Level Security

Enable RLS on all application tables.

MVP security model:

* Public users can insert into `applications` only.
* Public users cannot read admin records.
* Authenticated internal users with an active `admin_profiles` row can read operational records.
* Admin and Staff users can create/update operational records.
* Read Only users can only read.
* Only Admin users can manage admin profiles and system settings.

Storage security:

* Contract files must be private.
* Receipt files must be private.
* Application documents, if added, must be private.
* Signed URLs or controlled download actions should be used when viewing files.

---

## 7. Required Frontend Routes

Create the following routes.

### Public Routes

* `/`

  * Public landing/intake page or redirect to `/apply`.
* `/apply`

  * Public application form.

### Auth Routes

* `/login`

  * Admin login.
* `/logout`

  * Logout action or handled through UI.

### Protected Admin Routes

* `/dashboard`

  * Overview metrics.
* `/lots`

  * 24-lot management board.
* `/applications`

  * Intake Kanban.
* `/customers`

  * Customer list.
* `/customers/:id`

  * Customer profile.
* `/contracts`

  * Contract list.
* `/contracts/:id`

  * Contract detail.
* `/payments`

  * Unified payment logging and payment history.
* `/reports`

  * Revenue, overdue, and community delinquency reports.
* `/settings`

  * Admin settings and fee settings.

---

## 8. UI Requirements

### 8.1 Base Layout

Build a clean admin layout with:

* Sidebar navigation
* Top bar
* User profile/logout area
* Responsive mobile menu
* Page header
* Breadcrumbs where useful
* Loading states
* Empty states
* Error states
* Toast notifications

Use Shadcn/ui components where practical:

* Cards
* Tables
* Dialogs
* Drawers
* Buttons
* Inputs
* Selects
* Tabs
* Badges
* Dropdowns
* Toasts
* Forms

---

## 9. Feature Implementation Requirements

## Epic A — Public Application Form

Build a public intake form.

Fields:

* First name
* Last name
* Phone
* Email, optional
* Desired lot, optional
* Message or notes
* Community expectations acknowledgment
* Sustainability terms checkbox

Community expectation text should mention:

* Road maintenance fees
* Garbage disposal fees
* Waste sorting
* Composting
* Community rules
* Sustainable neighborhood goals

Acceptance criteria:

* Public users can submit the form.
* Required fields are validated.
* Sustainability checkbox must be captured.
* New application is created as `Pending Review`.
* User sees a success message.
* Public users cannot access admin dashboard or records.

---

## Epic B — Admin Authentication

Build Supabase Auth login.

Acceptance criteria:

* Unauthenticated users are redirected to `/login`.
* Logged-in admin users can access protected pages.
* Users without an `admin_profiles` row cannot access admin tools.
* Logout works.
* Session persists on refresh.

---

## Epic C — Dashboard Overview

Build `/dashboard`.

Metrics:

* Total lots
* Available lots
* Reserved lots
* Sold lots
* Pending applications
* Total revenue collected
* Overdue installment balance
* Active community delinquency accounts

Acceptance criteria:

* Metrics load from Supabase.
* Empty database states are handled.
* Cards update after related records change.

---

## Epic D — 24-Lot Board

Build `/lots`.

Requirements:

* Render exactly 24 lot tiles.
* Color-code by status:

  * Available = green
  * Reserved = amber
  * Sold = crimson
* Tile should show:

  * Lot number
  * Dimensions
  * Zoning
  * Status
  * Base price
* Clicking a tile opens a detail drawer/modal.

Lot detail drawer should show:

* Lot number
* Dimensions
* Zoning
* Status
* Base price
* Linked customer if reserved/sold
* Active contract if present
* Ledger history if present

Acceptance criteria:

* All 24 lots appear.
* Status colors are correct.
* Detail drawer loads relational data.
* No broken UI when a lot has no customer or contract.

---

## Epic E — Intake Kanban

Build `/applications`.

Columns:

* Pending Review
* Approved
* Declined

Application card should show:

* Applicant name
* Phone
* Desired lot number
* Sustainability verified badge
* Created date

Clicking a card opens a detail modal.

Detail modal should show:

* Applicant contact info
* Desired lot
* Notes
* Cultural/community review text
* Sustainability verification
* Admin notes
* Status update controls

Approval behavior:

When application status changes to `Approved`:

1. Verify selected lot is not sold.
2. Create customer if one does not already exist for the application.
3. Update selected parcel status to `Reserved`.
4. Move card to Approved column.

Acceptance criteria:

* Applications group correctly by status.
* Admin can update status.
* Approving creates customer.
* Approving reserves lot.
* Duplicate customer creation is prevented.
* Approval is blocked if lot is sold or unavailable.

---

## Epic F — Customer Management

Build `/customers` and `/customers/:id`.

Customer list requirements:

* Search by name, phone, or email.
* Show linked lot.
* Show active contract status.
* Show outstanding land balance.
* Show community fee standing.

Customer profile sections:

* Customer details
* Originating application
* Linked lot
* Active contract summary
* Land payment history
* Community fee history
* Receipt links
* Contract documents

Acceptance criteria:

* Customer profile centralizes related records.
* Land ledger and community ledger are separate.
* Customer records with financial history cannot be deleted casually.
* UI handles missing contract state.

---

## Epic G — Contract Management

Build contract creation and detail views.

Contract form fields:

* Customer
* Parcel
* Final purchase price
* Initial deposit
* Term months
* Start date
* Payment due day
* Signed contract upload

Validation:

* Term months cannot exceed 60.
* Final purchase price must be greater than 0.
* Initial deposit cannot exceed final purchase price.
* Parcel cannot be sold.
* Monthly payment auto-calculates.

Acceptance criteria:

* Contract can be created from customer profile.
* Contract monthly payment calculates correctly.
* Contract file uploads to private storage.
* Contract links to customer and parcel.
* Contract updates lot status based on chosen business rule.
* Contract detail shows total paid and remaining balance.

---

## Epic H — Unified Payment Ledger

Build `/payments` and payment logging UI inside customer profile.

Payment form fields:

* Customer
* Contract, optional
* Transaction type
* Amount
* Collection method
* Bank reference
* Notes

Validation:

* Amount must be greater than 0.
* Online Transfer requires bank reference.
* Cash does not require bank reference.
* Duplicate bank reference is blocked before submit.
* Transaction type controls whether the payment counts toward land balance or community fees.

Land-related transaction types:

* Down Payment
* Land Installment

Community-related transaction types:

* Garbage Fee
* Road Maintenance

Acceptance criteria:

* Admin can log cash payment.
* Admin can log online transfer payment only with bank reference.
* Duplicate references are blocked with a clear error.
* Authorized admin is recorded.
* Receipt job is created after successful transaction.
* Land balance updates only from land-related transactions.
* Community fee records remain separate.

---

## Epic I — Receipt Generation

Implement receipt queue and Edge Function.

Receipt content:

* Wamuale Development name
* Receipt number
* Customer name
* Lot number, if applicable
* Transaction type
* Amount paid
* Collection method
* Bank reference, if applicable
* Payment date
* Authorized by
* Remaining land balance, if applicable

Technical approach:

* Database trigger creates `receipt_jobs` row after transaction insert.
* Supabase Edge Function processes pending jobs.
* Function generates PDF.
* Function uploads PDF to private `receipts` bucket.
* Function updates `transactions.receipt_file_path`.
* Function marks job as Completed or Failed.

Acceptance criteria:

* Transaction creates receipt job.
* Receipt PDF is generated.
* Receipt file path is attached to transaction.
* Admin can open/download receipt through controlled access.
* Failed receipt jobs show visible error state.

---

## Epic J — Reports & Analytics

Build `/reports`.

Reports:

1. Total revenue report
2. Overdue land installment report
3. Community fee delinquency report
4. Customer balance report
5. Transaction export

Filters:

* Date range
* Customer
* Lot
* Transaction type
* Collection method

Exports:

* CSV export for transactions
* CSV export for overdue accounts
* CSV export for community delinquency

Acceptance criteria:

* Revenue totals match transactions.
* Overdue land accounts are calculated from contract schedule vs actual land payments.
* Community delinquency is calculated separately from land balance.
* Reports can be filtered.
* CSV exports respect filters.

---

## 10. Business Logic Details

### 10.1 Land Balance Calculation

For a contract:

* Original balance = final purchase price
* Initial deposit = contract initial deposit
* Land payments = transactions where type is `Down Payment` or `Land Installment`
* Remaining balance = final purchase price - total land payments

Be careful not to double-count `initial_deposit` if it is already recorded as a transaction. Choose one consistent approach:

Preferred MVP approach:

* Store `initial_deposit` on contract for contract terms.
* Also create a `Down Payment` transaction when actual payment is received.
* Balance calculations should use transaction totals as actual collected money.
* Display contract initial deposit as agreed deposit amount.

### 10.2 Community Fee Calculation

Community fee payments do not reduce land balance.

Community fee transaction types:

* `Garbage Fee`
* `Road Maintenance`

Community delinquency should compare expected monthly fees against actual community fee payments.

For MVP, implement a simple monthly expected fee model using active fee settings and customer/contract start date.

### 10.3 Contract Status

A contract is active when `is_active = true`.

When the remaining land balance reaches zero:

* Show contract as paid off.
* Allow admin to mark contract inactive/closed.
* Continue tracking community fees.

---

## 11. Storage Requirements

Create private buckets:

* `contracts`
* `receipts`
* `application-documents`, optional

Rules:

* Only authenticated internal users can upload/view contracts.
* Only authenticated internal users can view receipts in MVP.
* Future customer portal should use signed URLs or customer-scoped access.
* Never expose raw private bucket paths publicly without access control.

---

## 12. Error Handling Requirements

Add clean user-facing errors for:

* Login failure
* Missing permission
* Failed data load
* Failed form submission
* Contract term over 60 months
* Sold lot selected for approval/contract
* Duplicate bank reference
* Online transfer missing bank reference
* Receipt generation failed
* File upload failed
* Unsafe delete blocked

Use plain-language messages.

---

## 13. Validation Requirements

Use both frontend validation and database constraints.

Frontend:

* Zod schemas for forms
* Required field validation
* Dropdown enum validation
* Amount validation
* Date validation
* Conditional bank reference validation
* Contract term validation

Database:

* Check constraints
* Foreign keys
* Unique indexes
* Restrictive deletes
* RLS policies
* Trigger functions for automation

Do not rely only on frontend validation.

---

## 14. Testing Requirements

Add tests where the project setup supports them.

Minimum testing expectations:

* Build passes.
* TypeScript passes.
* Lint passes.
* Application form validation works.
* Contract term over 60 months is blocked.
* Online transfer without bank reference is blocked.
* Duplicate bank reference is blocked.
* Approval workflow creates customer and reserves lot.
* Land balance excludes community fee payments.
* Community fees do not reduce land balance.

Before finishing, run:

* Install dependencies
* Typecheck
* Lint
* Build

Use the package manager already present in the repo. Do not switch package managers unless necessary.

---

## 15. UX / Design Direction

Use a clean admin dashboard design.

Visual direction:

* Professional
* Simple
* Trustworthy
* Easy for non-technical users
* Clear status colors
* Clear financial summaries

Suggested navigation:

* Dashboard
* Lots
* Applications
* Customers
* Contracts
* Payments
* Reports
* Settings

Use badges for statuses:

* Available
* Reserved
* Sold
* Pending Review
* Approved
* Declined
* Active
* Paid Off
* Overdue

Use confirmation dialogs for:

* Approving applications
* Declining applications
* Creating contracts
* Recording payments
* Uploading contract files
* Any destructive action

---

## 16. Do Not Build in MVP

Do not build these unless all MVP requirements are complete:

* Full customer login portal
* Customer self-service dashboard
* Customer payment proof upload
* Automated WhatsApp reminders
* SMS integration
* Online card payments
* Payment gateway integration
* GIS/map visualization
* Mobile app
* Advanced accounting integration
* Multi-subdivision support

However, leave clean extension points for these future features.

---

## 17. Implementation Order

Build in this order:

### Step 1 — Project Foundation

* Inspect repo.
* Set up Vite React TypeScript if needed.
* Add Tailwind CSS.
* Add Shadcn/ui.
* Add routing.
* Add Supabase client.
* Add base layout.
* Add auth guard.

### Step 2 — Database

* Add Supabase migration.
* Create tables.
* Create constraints.
* Create indexes.
* Create functions/triggers.
* Enable RLS.
* Create policies.
* Create storage buckets.
* Seed 24 lots.

### Step 3 — Auth

* Login page.
* Logout.
* Protected admin routes.
* Admin profile permission check.

### Step 4 — Public Intake

* Public application page.
* Application submission.
* Success confirmation.

### Step 5 — Lot Board

* 24-lot board.
* Lot detail drawer.
* Status colors.
* Linked records.

### Step 6 — Application Pipeline

* Kanban columns.
* Application card.
* Detail modal.
* Approve/decline.
* Auto-create customer.
* Auto-reserve lot.

### Step 7 — Customers

* Customer list.
* Search/filter.
* Customer profile.
* Linked application/lot/contract/ledger data.

### Step 8 — Contracts

* Contract creation.
* Contract validation.
* Upload signed contract.
* Contract detail.
* Balance calculation.

### Step 9 — Payments

* Unified payment form.
* Duplicate bank reference check.
* Ledger insert.
* Land/community separation.
* Receipt job creation.

### Step 10 — Receipts

* Receipt Edge Function.
* PDF generation.
* Upload to storage.
* Update transaction.
* View/download receipt.

### Step 11 — Reports

* Dashboard metrics.
* Revenue report.
* Overdue installment report.
* Community delinquency report.
* CSV exports.

### Step 12 — Polish

* Loading states.
* Empty states.
* Error states.
* Responsive layout.
* Final build/test pass.

---

## 18. Final Deliverables

When complete, provide:

1. Summary of files created/changed.
2. Database migration location.
3. Required environment variables.
4. How to create the first admin user.
5. How to run the app locally.
6. How to run Supabase locally or connect to hosted Supabase.
7. How to deploy.
8. Known limitations.
9. Future customer portal notes.
10. Confirmation that build/typecheck/lint passed, or exact errors if not.

---

## 19. Environment Variables

Use environment variables. Do not hardcode credentials.

Frontend:

* `VITE_SUPABASE_URL`
* `VITE_SUPABASE_ANON_KEY`

Backend / Edge Function:

* `SUPABASE_URL`
* `SUPABASE_ANON_KEY`
* `SUPABASE_SERVICE_ROLE_KEY`

Rules:

* `VITE_SUPABASE_ANON_KEY` may be used in browser with RLS.
* `SUPABASE_SERVICE_ROLE_KEY` must never be exposed to frontend code.
* Service-role key is only for trusted backend/Edge Function logic.

---

## 20. Important Product Decision

This is an admin-first MVP.

Build the public-facing side only as a landing/application intake page. Do not build customer login yet. The customer table should include a nullable `auth_user_id` field so that a future customer portal can be added later.

The MVP is complete when Wamuale Development can:

* Capture land applications
* Review applicants
* Reserve lots
* Create customers
* Create contracts
* Log payments
* Track balances
* Issue receipts
* View reports
* Identify overdue accounts

Proceed carefully, keep the implementation clean, and prioritize database integrity over fast but fragile UI-only logic.
