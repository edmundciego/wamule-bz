Below is a clean **developer build plan / ticket breakdown** for the Wamuale Development system.

This assumes the first release is **admin-first**, with a simple **public intake/application page**, and the full customer login portal pushed to a later phase. The system requirements are based on the React/Vite/Tailwind/Shadcn + Supabase/PostgreSQL architecture and the five core entities: parcels, applications, customers, contracts, and transactions. 

---

# Wamuale Development System Build Plan

## MVP Goal

Build a secure internal web dashboard that allows Wamuale Development to:

* Track the first 24 lots
* Accept and review land applications
* Reserve lots after approval
* Create customers from approved applicants
* Manage contracts up to 60 months
* Track land payments and community service fees
* Generate receipts
* View payment history, balances, and delinquency reports

The initial public-facing side should only include an **interest/application form**, not a full customer portal yet.

---

# Phase 0 — Project Foundation

## WAM-001 — Set Up React Frontend Project

**Priority:** P0
**Area:** Frontend
**Goal:** Create the base React dashboard application.

**Requirements:**

* Set up Vite + React
* Install Tailwind CSS
* Install Shadcn/ui
* Set up routing
* Create base layout with sidebar navigation
* Create placeholder pages:

  * Dashboard
  * Applications
  * Lots
  * Customers
  * Contracts
  * Payments
  * Reports
  * Settings

**Acceptance Criteria:**

* App runs locally without errors
* Navigation works between all placeholder pages
* UI has a clean admin dashboard layout
* Mobile/tablet responsive foundation is in place

---

## WAM-002 — Set Up Supabase Project

**Priority:** P0
**Area:** Backend
**Goal:** Create the Supabase backend foundation.

**Requirements:**

* Create Supabase project
* Configure environment variables
* Connect frontend to Supabase client
* Create migration folder/process
* Enable authentication for admin users

**Acceptance Criteria:**

* Frontend connects to Supabase successfully
* Supabase client is isolated in a reusable service file
* Environment variables are not hardcoded
* Admin authentication is available for protected dashboard pages

---

## WAM-003 — Admin Authentication & Protected Routes

**Priority:** P0
**Area:** Auth / Security
**Goal:** Only approved internal users can access the admin dashboard.

**Requirements:**

* Implement login page
* Add logout
* Protect dashboard routes
* Store user session securely through Supabase Auth
* Create user roles:

  * Admin
  * Staff / Agent
  * Read-only, optional later

**Acceptance Criteria:**

* Unauthenticated users are redirected to login
* Logged-in users can access dashboard
* User session persists on refresh
* Logout clears access

---

# Phase 1 — Database Foundation

The database must maintain relational integrity and prevent unsafe deletes, especially once lots, contracts, and transactions exist. The original spec calls for five main logical tables and strict relational constraints. 

---

## WAM-004 — Create Parcels Table

**Priority:** P0
**Area:** Database
**Goal:** Track the 24 physical lots.

**Table:** `parcels`

**Fields:**

* `id`
* `lot_number`
* `dimensions`
* `zoning`
* `status`
* `base_price`
* `created_at`
* `updated_at`

**Rules:**

* `lot_number` must be unique
* `dimensions` defaults to `75x100 ft`
* `zoning` allowed values:

  * Residential
  * Commercial
  * Green Space
* `status` allowed values:

  * Available
  * Reserved
  * Sold
* Index `lot_number`

**Acceptance Criteria:**

* Parcels table exists
* Lot number cannot be duplicated
* Invalid zoning/status values are rejected
* Seed data creates exactly 24 lots

---

## WAM-005 — Create Applications Table

**Priority:** P0
**Area:** Database
**Goal:** Store public and manually entered land applications.

**Table:** `applications`

**Fields:**

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

**Rules:**

* `parcel_id` references `parcels.id`
* Status values:

  * Pending Review
  * Approved
  * Declined
* Sustainability terms is boolean

**Acceptance Criteria:**

* Applications can be created
* Applications can reference a desired lot
* Invalid application statuses are rejected
* Deleting a parcel with linked applications is blocked or safely restricted

---

## WAM-006 — Create Customers Table

**Priority:** P0
**Area:** Database
**Goal:** Store approved applicants as validated customers.

**Table:** `customers`

**Fields:**

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

**Rules:**

* `application_id` references `applications.id`
* `auth_user_id` is nullable for future customer portal

**Acceptance Criteria:**

* Customer can be created from an approved application
* Customer keeps link to source application
* Duplicate customer creation from the same application is prevented

---

## WAM-007 — Create Contracts Table

**Priority:** P0
**Area:** Database / Finance
**Goal:** Manage long-term land purchase contracts.

**Table:** `contracts`

**Fields:**

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

**Rules:**

* `customer_id` references `customers.id`
* `parcel_id` references `parcels.id`
* `term_months` cannot exceed 60
* `monthly_payment` can be calculated from balance / term
* Active contract should reserve or sell the related lot depending on business rule

**Acceptance Criteria:**

* Contract cannot be created for more than 60 months
* Contract must be linked to one customer and one parcel
* Contract cannot be created for an already sold lot
* Contract file path can be saved after upload

---

## WAM-008 — Create Transactions Table

**Priority:** P0
**Area:** Database / Ledger
**Goal:** Track all money collected.

**Table:** `transactions`

**Fields:**

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

**Transaction Types:**

* Down Payment
* Land Installment
* Garbage Fee
* Road Maintenance

**Collection Methods:**

* Cash
* Online Transfer

**Rules:**

* `customer_id` required
* `contract_id` nullable for community fees
* Online Transfer requires `bank_reference`
* Bank reference must be unique when provided
* Amount must be greater than 0

**Acceptance Criteria:**

* Cash payments can be saved without bank reference
* Online transfers cannot be saved without bank reference
* Duplicate bank references are blocked
* Transaction links back to customer and contract where applicable

---

## WAM-009 — Add Database Delete Restrictions

**Priority:** P0
**Area:** Database Integrity
**Goal:** Prevent accidental deletion of financial history.

**Requirements:**

* Prevent deleting parcels with contracts or transactions
* Prevent deleting customers with contracts or transactions
* Prevent deleting contracts with transactions

**Acceptance Criteria:**

* Database blocks unsafe deletes
* User sees a clean error message in the UI
* Historical ledger records remain protected

---

# Phase 2 — Admin Dashboard Core

The interface spec requires four main operational modules: intake pipeline, 24-lot board, amortization ledger, and document/analytics panel. 

---

## WAM-010 — Dashboard Overview Page

**Priority:** P0
**Area:** Frontend
**Goal:** Give management a quick snapshot.

**Cards/Metrics:**

* Total lots
* Available lots
* Reserved lots
* Sold lots
* Pending applications
* Total revenue collected
* Overdue accounts
* Community fee delinquency count

**Acceptance Criteria:**

* Dashboard loads real data from Supabase
* Metrics update when records change
* Empty states display cleanly

---

## WAM-011 — 24-Lot Management Board

**Priority:** P0
**Area:** Frontend / Parcels
**Goal:** Show all 24 lots visually.

**Requirements:**

* Render exactly 24 lot tiles
* Color-code:

  * Available = Green
  * Reserved = Amber
  * Sold = Crimson
* Show lot number, dimensions, status, base price
* Clicking lot opens detail drawer/modal

**Acceptance Criteria:**

* All 24 lots display in a grid
* Status colors are correct
* Lot detail opens on click
* Lot data updates from database

---

## WAM-012 — Lot Detail Modal

**Priority:** P0
**Area:** Frontend / Parcels
**Goal:** View lot-specific information.

**Requirements:**

* Show lot number
* Show dimensions
* Show zoning
* Show status
* Show base price
* Show assigned customer if reserved/sold
* Show active contract if one exists
* Show transaction history if contract exists

**Acceptance Criteria:**

* Available lot shows basic details only
* Reserved/sold lot shows linked customer/contract
* Ledger history appears when available
* Empty state appears when no contract exists

---

# Phase 3 — Public Intake + Application Review

The project should begin with public lead capture and admin review. The roadmap in the PDF identifies the first phase as database foundation, 24-lot board, and applicant intake while early site preparation is underway. 

---

## WAM-013 — Public Interest/Application Page

**Priority:** P0
**Area:** Public Frontend
**Goal:** Allow interested buyers to submit applications.

**Fields:**

* First name
* Last name
* Phone
* Email
* Desired lot, optional
* Message / reason for interest
* Agreement to community expectations
* Sustainability terms checkbox

**Important Note:**

The application should focus on objective community commitments: waste sorting, composting, road/garbage fees, community rules, and residential expectations. Any applicant review criteria should be legally reviewed before launch.

**Acceptance Criteria:**

* Public users can submit an application
* Application appears in admin dashboard
* Form validates required fields
* User receives success message after submission
* No admin dashboard access is exposed publicly

---

## WAM-014 — Intake Kanban Board

**Priority:** P0
**Area:** Admin / Applications
**Goal:** Review applications by status.

**Columns:**

* Pending Review
* Approved
* Declined

**Card Displays:**

* Applicant name
* Desired lot number
* Phone
* Sustainability verified flag
* Application date

**Acceptance Criteria:**

* Applications display under correct status
* Cards are grouped by application status
* Card opens details modal
* Status updates reflect immediately

---

## WAM-015 — Application Detail Modal

**Priority:** P0
**Area:** Admin / Applications
**Goal:** Allow leadership/admin to review application details.

**Requirements:**

* Show applicant contact info
* Show selected lot
* Show community/sustainability answers
* Show notes/review text
* Allow status change:

  * Pending Review
  * Approved
  * Declined

**Acceptance Criteria:**

* Admin can review full application
* Admin can update status
* Status update is saved to Supabase
* Modal handles loading/error states

---

## WAM-016 — Approval Automation

**Priority:** P0
**Area:** Backend / Application Workflow
**Goal:** When application is approved, create customer and reserve lot.

**Logic:**

When status changes to `Approved`:

1. Create customer record
2. Link customer to application
3. Update parcel status to `Reserved`
4. Prevent duplicate customer creation
5. Prevent approval if selected lot is already sold

**Acceptance Criteria:**

* Approving application creates customer automatically
* Selected lot becomes Reserved
* Duplicate approvals do not create duplicate customers
* If lot is unavailable, approval is blocked with error

---

# Phase 4 — Customer & Contract Management

---

## WAM-017 — Customer List Page

**Priority:** P0
**Area:** Admin / Customers
**Goal:** View all approved customers.

**Requirements:**

* Search by name, phone, email
* Filter by active contract status
* Show linked lot
* Show balance summary
* Open customer profile

**Acceptance Criteria:**

* Customer list loads from Supabase
* Search works
* Customer profile opens correctly
* Empty states are handled

---

## WAM-018 — Customer Profile Page

**Priority:** P0
**Area:** Admin / Customers
**Goal:** Central customer record view.

**Sections:**

* Customer details
* Linked application
* Linked lot
* Contract summary
* Land payment history
* Community fee history
* Uploaded files
* Receipts

**Acceptance Criteria:**

* Customer profile shows all related records
* Land and community ledgers are separated
* Admin can navigate to contract/payment actions

---

## WAM-019 — Create Contract Form

**Priority:** P0
**Area:** Admin / Contracts
**Goal:** Create installment contract for approved customer.

**Fields:**

* Customer
* Parcel
* Final purchase price
* Initial deposit
* Term months
* Start date
* Due day
* Monthly payment
* Signed contract upload

**Rules:**

* Term cannot exceed 60 months
* Final price must be greater than 0
* Initial deposit cannot exceed final price
* Parcel must not be sold
* Monthly payment auto-calculates

**Acceptance Criteria:**

* Admin can create valid contract
* Invalid contract term is blocked
* Contract links customer and parcel
* Signed contract path is saved
* Parcel status updates appropriately

---

## WAM-020 — Contract Detail Page

**Priority:** P0
**Area:** Admin / Contracts
**Goal:** View contract balance and payment progress.

**Requirements:**

* Original purchase price
* Initial deposit
* Total paid
* Remaining balance
* Monthly payment
* Due day
* Contract status
* Linked receipts
* Payment history

**Acceptance Criteria:**

* Contract financial totals calculate correctly
* Payment history matches transactions
* Remaining balance updates after payments
* Contract can be marked inactive/closed when paid off

---

# Phase 5 — Payment Ledger

The system needs two separate billing histories: the land contract aging statement and the ongoing community service fee standing. It also needs one unified payment form with bank reference validation for online transfers. 

---

## WAM-021 — Unified Payment Logging Form

**Priority:** P0
**Area:** Admin / Payments
**Goal:** Admin can log all cash and online transfer payments.

**Fields:**

* Customer
* Contract, optional depending on payment type
* Transaction type
* Amount
* Collection method
* Bank reference, required only for Online Transfer
* Notes

**Acceptance Criteria:**

* Admin can log cash payment
* Admin can log online transfer only with bank reference
* Amount must be greater than 0
* Payment is saved to transaction ledger
* Authorized admin user is recorded

---

## WAM-022 — Duplicate Bank Reference Check

**Priority:** P0
**Area:** Ledger / Validation
**Goal:** Prevent double entry of online transfer payments.

**Requirements:**

* When bank reference is entered, check Supabase for existing reference
* If duplicate exists, block submission
* Show prominent warning

**Acceptance Criteria:**

* Duplicate bank reference cannot be submitted
* Error identifies that the reference already exists
* Unique bank reference allows transaction

---

## WAM-023 — Land Contract Payment History

**Priority:** P0
**Area:** Ledger / Frontend
**Goal:** Show land installment history separately.

**Requirements:**

* Show down payments
* Show land installments
* Show total paid toward land
* Show remaining balance
* Show payment dates and receipt links

**Acceptance Criteria:**

* Only land-related transactions appear
* Totals calculate correctly
* Receipt links appear when generated

---

## WAM-024 — Community Fee Payment History

**Priority:** P0
**Area:** Ledger / Frontend
**Goal:** Track road and garbage fees separately from land payments.

**Requirements:**

* Show garbage fee payments
* Show road maintenance payments
* Show monthly standing
* Show delinquency status
* Keep visible after land contract is paid off

**Acceptance Criteria:**

* Community fees are separate from land balance
* Customer can have fee history without active contract
* Delinquency calculation works based on expected monthly fees

---

# Phase 6 — Receipts & File Management

The original spec requires successful transaction insertion to create a receipt artifact, store it, and attach the file path back to the transaction record. 

---

## WAM-025 — Supabase Storage Buckets

**Priority:** P0
**Area:** Backend / Storage
**Goal:** Store contracts and receipts securely.

**Buckets:**

* `contracts`
* `receipts`
* `application-documents`, optional later

**Acceptance Criteria:**

* Buckets exist
* Files can be uploaded from admin dashboard
* File paths are saved to related records
* Private access rules are configured

---

## WAM-026 — Receipt PDF Template

**Priority:** P1
**Area:** Document Generation
**Goal:** Generate clean payment receipts.

**Receipt Fields:**

* Wamuale Development name
* Receipt number
* Customer name
* Lot number
* Transaction type
* Amount paid
* Collection method
* Bank reference, if applicable
* Payment date
* Authorized by
* Remaining balance, if land payment

**Acceptance Criteria:**

* Receipt layout is consistent
* PDF generates after payment
* PDF stores in Supabase bucket
* Transaction row updates with receipt path

---

## WAM-027 — Receipt Download/View Action

**Priority:** P1
**Area:** Frontend
**Goal:** Allow admin to view/download generated receipts.

**Acceptance Criteria:**

* Receipt link appears in payment history
* Admin can open receipt
* Missing receipt shows “Generating” or “Unavailable”
* Access is protected

---

# Phase 7 — Reports & Analytics

The analytics dashboard should show Total Aggregated Revenue, Overdue Installment Balances, and Active Community Delinquency Accounts. 

---

## WAM-028 — Revenue Report

**Priority:** P1
**Area:** Reports
**Goal:** Show total money collected.

**Filters:**

* Date range
* Transaction type
* Payment method
* Customer
* Lot

**Acceptance Criteria:**

* Revenue total matches transaction ledger
* Filters work correctly
* Report can be exported to CSV

---

## WAM-029 — Land Balance / Overdue Report

**Priority:** P1
**Area:** Reports
**Goal:** Identify customers behind on land installment payments.

**Requirements:**

* Calculate expected payment total by date
* Compare expected vs actual paid
* Flag overdue customers
* Show amount overdue

**Acceptance Criteria:**

* Overdue customers appear in report
* Current customers do not show as overdue
* Report includes customer, lot, due amount, last payment date

---

## WAM-030 — Community Fee Delinquency Report

**Priority:** P1
**Area:** Reports
**Goal:** Track unpaid road/garbage/community fees.

**Requirements:**

* Show customers with missing fee payments
* Separate garbage and road maintenance
* Filter by month
* Export to CSV

**Acceptance Criteria:**

* Delinquent accounts are listed correctly
* Paid accounts are excluded
* Report supports monthly review

---

## WAM-031 — Basic Export Tools

**Priority:** P1
**Area:** Reports / Admin
**Goal:** Allow records to be exported.

**Exports:**

* Customers
* Applications
* Lots
* Transactions
* Overdue report
* Community fee report

**Acceptance Criteria:**

* CSV export works
* Export respects active filters
* File names include date

---

# Phase 8 — Notifications

---

## WAM-032 — Manual Payment Reminder Generator

**Priority:** P2
**Area:** Notifications
**Goal:** Generate reminder text for overdue accounts.

**Requirements:**

* Create message template
* Include customer name
* Amount due
* Due date
* Payment options
* Copy-to-clipboard button

**Acceptance Criteria:**

* Admin can generate a reminder message
* Message can be copied and sent by WhatsApp/SMS manually
* No automatic sending required for MVP

---

## WAM-033 — Email Receipt Sending

**Priority:** P2
**Area:** Notifications
**Goal:** Send receipt by email after payment.

**Acceptance Criteria:**

* If customer email exists, admin can send receipt
* Email includes receipt PDF link or attachment
* Sent status is recorded

---

# Phase 9 — Future Customer Portal

This should be deferred until after launch, but the data model should leave room for it. The spec already includes a future authentication placeholder on the customer record. 

---

## WAM-034 — Customer Portal Auth

**Priority:** P3
**Area:** Future Client Portal
**Goal:** Let established customers log in.

**Features:**

* Customer login
* Link Supabase auth user to customer record
* Protected customer dashboard

**Acceptance Criteria:**

* Customer can only see their own records
* Admin records remain private
* Customer profile links to existing customer row

---

## WAM-035 — Customer Balance Dashboard

**Priority:** P3
**Area:** Future Client Portal
**Goal:** Let customers view balances.

**Features:**

* Land balance
* Payment history
* Receipt downloads
* Community fee standing
* Next due date

**Acceptance Criteria:**

* Customer sees accurate balance
* Customer cannot edit financial records
* Receipts are downloadable

---

## WAM-036 — Customer Upload Payment Proof

**Priority:** P3
**Area:** Future Client Portal
**Goal:** Allow customer to upload online transfer proof.

**Acceptance Criteria:**

* Customer can upload proof
* Admin can approve/reject proof
* Approved proof creates official transaction
* Duplicate bank reference is still blocked

---

# Recommended MVP Cut

For the first working release, build only these:

| MVP Ticket | Name                           |
| ---------- | ------------------------------ |
| WAM-001    | Set Up React Frontend Project  |
| WAM-002    | Set Up Supabase Project        |
| WAM-003    | Admin Authentication           |
| WAM-004    | Parcels Table                  |
| WAM-005    | Applications Table             |
| WAM-006    | Customers Table                |
| WAM-007    | Contracts Table                |
| WAM-008    | Transactions Table             |
| WAM-009    | Delete Restrictions            |
| WAM-010    | Dashboard Overview             |
| WAM-011    | 24-Lot Management Board        |
| WAM-012    | Lot Detail Modal               |
| WAM-013    | Public Application Page        |
| WAM-014    | Intake Kanban                  |
| WAM-015    | Application Detail Modal       |
| WAM-016    | Approval Automation            |
| WAM-017    | Customer List                  |
| WAM-018    | Customer Profile               |
| WAM-019    | Create Contract Form           |
| WAM-021    | Unified Payment Logging Form   |
| WAM-022    | Duplicate Bank Reference Check |
| WAM-023    | Land Payment History           |
| WAM-024    | Community Fee History          |

That gives them the core operational system without overbuilding.

---

# Suggested Sprint Order

## Sprint 1 — Foundation

* Project setup
* Supabase setup
* Auth
* Database schema
* Seed 24 lots

## Sprint 2 — Lot & Intake System

* 24-lot board
* Public application form
* Intake Kanban
* Application approval workflow
* Auto-create customer
* Auto-reserve lot

## Sprint 3 — Contracts & Customers

* Customer list/profile
* Contract creation
* Contract validation
* Contract balance calculations

## Sprint 4 — Payments

* Payment logging
* Cash vs online transfer rules
* Duplicate bank reference blocking
* Land/community ledger split

## Sprint 5 — Reports & Receipts

* Revenue report
* Overdue report
* Community delinquency report
* Receipt generation
* CSV export

---

# Clean MVP Summary for Developer

Build an admin-first React/Supabase system for Wamuale Development that tracks 24 Phase 1 land lots, applications, customers, contracts, payments, receipts, and reports. The system must support cash and online transfer payments, prevent duplicate bank references, separate land installment payments from road/garbage community fees, and block contracts longer than 60 months. Public users should only be able to submit an application/interest form in the MVP. Full customer login is a future phase.
