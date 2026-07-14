# Wamuale Development Platform — Quality and Correctness Audit

**Audit date:** 2026-07-14  
**Scope:** Findings only. Source, route definitions, migrations, calculation implementations, Edge Functions, and RLS definitions were reviewed. No application code, migration, style, test data, deployment, or production configuration was changed for this audit.

## Executive summary

The application has strong foundational controls in several areas: public applications have a unique linked lead, land-payment writes require a contract at the database layer, AI generation functions validate authenticated internal roles, and the customer Smart Summary now has a visible stale-state mechanism.

However, the current source contains three production-blocking integrity risks:

1. The later contract-validation migration replaced the original validation and removed the check that a contract lot matches the customer's application lot.
2. Contract voiding deliberately leaves the parcel `Sold`; the system has no linked release decision, so a voided mistaken contract can keep a lot unavailable indefinitely.
3. Payments can already be hard-deleted by Admin/Super Admin through existing transaction RLS. The proposed payment-removal migration makes a user-facing hard-delete flow, but does not preserve all linked evidence or prevent direct deletion. It should not be applied in its current form.

The supplied Customer Detail scenario is technically possible only in part. A live **land** payment without a contract is blocked by both a database constraint and a write trigger. Therefore, a page showing `$750` as **Recorded land payments** while having no current or historical linked contract needs data inspection: it is either an old/deleted/invalid record, a presentation/query defect, or an unverified screenshot state. Community-fee payments without a contract are allowed, but are not included in the page's land-payment total.

No authenticated browser session or safe test account was available, and the in-app browser connector could not initialize in this environment. All required viewport, keyboard, populated-state, and RLS runtime tests are therefore marked **unverified**, not passed.

## Method and limits

- Reviewed `docs/internal-quality-audit.md` as prior work only; its claims were not treated as proof.
- Reviewed `src/App.tsx`, page components, forms, shared helpers, Edge Functions, foundation SQL, and current migrations, including the un-applied payment-removal migration.
- Confirmed route definitions from the router rather than sidebar navigation alone.
- Did not query production data, apply migrations, or use customer data.
- The current working tree already contains unrelated, uncommitted quality-pass changes. They were inspected, not edited.

## Route inventory

| Route | Access expected by router/RLS | Principal sources and derived values | Mutations/actions | Failure-state notes |
| --- | --- | --- | --- | --- |
| `/`, `/apply` | Public | public application options/settings, public submit function | submit application/inquiry | Public validation and availability require runtime verification. |
| `/login` | Public | Auth, public company profile | sign in | Branding/configuration failure state exists; runtime unverified. |
| `/logout` | Authenticated route not required | Auth session | sign out then navigate | Navigation occurs immediately; logout completion is not awaited. |
| `/admin` | Protected | none | redirect to dashboard | Redirect only. |
| `/dashboard` | All internal roles | applications, leads, reservations, contracts, payments, post-sales; rule-based insights | navigation | Contains multiple local operational calculations. |
| `/briefs` | All internal can read; Admin/Super Admin generate/update | AI daily briefs, brief actions, all operational entities | generate/manage brief actions | Source-backed at generation time, but historical briefs have no stale marker. |
| `/emails` | UI: Admin/Super Admin; database must enforce | email notifications/settings | send/retry/operate email workflow | Role and send behavior require runtime/RLS verification. |
| `/leads` | All internal read; Staff+ write | leads, applications, activities, follow-ups, visits, reservations, lead summaries | stage/activity/task/visit/reservation/AI actions | No separate lead-detail route; uses an in-page detail surface. |
| `/lots` | All internal read; Staff+ mutations subject to RLS | parcels, applications, reservations/contracts as applicable | lot management | Cross-record status consistency needs live data verification. |
| `/applications` | All internal read; approval decision requires runtime/RLS verification | applications, parcels, lead, AI review | approve/decline, review, AI generation | No separate application-detail route; uses an in-page detail surface. |
| `/customers` | Internal | customers, applications/contracts/payments | navigate to customer | List-state behavior unverified. |
| `/customers/:id` | Internal | customer, application, contracts, transactions, documents, requests, leads, reservations, visits, post-sales, AI summaries | contract/payment/request/document/post-sales/AI/void contract | Primary correctness case; several confirmed issues below. |
| `/contracts` | Internal read; Staff+ create; Admin+ lifecycle changes | contracts, customer, parcel, payments | create; navigate; lifecycle actions | Contract validation issue applies. |
| `/contracts/:id` | Internal | Contract detail component | view/document actions | Route exists in router; detailed runtime behavior not verified. |
| `/payments` | Internal read; Staff+ create, Admin+ update/delete | transactions, customers, contracts, payment documents | create/edit/upload/remove payment | Direct deletion and proposed removal flow are material risks. |
| `/collections` | Internal | active contracts, transaction totals, payment documents | navigate/follow up | Local balance and due-date calculation is duplicated. |
| `/reports` | Internal | contracts/payments/leads/reservations/post-sales | CSV export | Financial report definition is duplicated. |
| `/audit-trail` | Internal read | audit events | filtering/viewing | Audit immutability and record completeness require runtime/schema verification. |
| `/settings` | Route protected for all internal users; individual panels role-gate | company/settings/users/methods/plans/AI/data management | configuration and privileged tools | Must confirm every privileged panel rejects Staff/Read Only through RLS. |
| `/documents/:kind/:id` | Protected | document/storage and related record lookup | view/download | Authorization for file URLs requires runtime verification. |
| `*` | Any path | none | redirects to `/dashboard` | No dedicated not-found route; public unknown URLs ultimately resolve through protected navigation. |

There are **20 explicit route patterns** in the router, representing 18 unique destinations plus the public root alias and catch-all route. There are no router-defined `/leads/:id` or `/applications/:id` routes.

## Cross-page consistency and shared-definition matrix

| Concept | Current implementations | Finding / canonical recommendation |
| --- | --- | --- |
| Active contract | Customer Detail requires `is_active && status === "active"`; Collections queries `is_active = true`; customer AI uses `is_active` only; Daily Brief uses `is_active` only. | **High risk.** Use one shared/database definition: active only when `is_active = true AND status = 'active'`. |
| Total paid / recorded land payments | Customer Detail, Collections, Reports, Document Page, customer AI, and Daily Brief each filter/sum independently. | **High risk.** Canonical: sum only persisted land transaction types linked to the active contract (and define treatment of void/reversal separately). |
| Remaining balance | Customer Detail, Collections, Reports, Document Page, customer AI, and Daily Brief independently calculate `price - land payments`. | Same formula, but not centralized; inclusion of inactive/voided-contract payments can diverge. |
| Next due date | `accountDueDate` used in Customer Detail/Collections; local helpers also exist in Document Page and Reports; Edge Functions have their own logic. | **High risk.** Canonicalize using one test-covered implementation and an explicit as-of date. |
| Overdue | Customer Detail labels an overdue due date as `Due`, whereas customer AI and Collections/Daily Brief use `Overdue`; each applies its own expected-payment test. | **Medium risk.** The displayed terminology and calculations can disagree. |
| Assigned lot | Customer Detail returns active-contract parcel, otherwise application parcel. | **Confirmed misleading presentation.** The fallback is a requested/preferred application lot, not an assigned lot. |
| Active reservation | Reservation pages/briefs use reservation statuses; Customer Detail displays newest customer reservation without filtering its lifecycle. | **Likely risk.** Never use the most recent reservation as current without a defined active-status filter. |
| Open payment request | Customer Detail counts anything not `Paid` or `Cancelled`; Reports uses `Draft` or `Sent`. | The definitions currently agree for known statuses, but should be centralized. |
| Post-Sales In Progress | Checklist status is directly user-set; starting creates `in_progress` with zero tasks allowed. | Technically valid, but operational meaning requires a business policy. |
| Lead needing follow-up | Dashboard, Reports, Daily Brief, and lead AI each apply separate due/status logic. | **Medium risk.** Establish one definition that excludes completed/cancelled work and clearly handles missing due dates. |

## Role and access matrix (source review)

| Capability | Super Admin | Admin | Staff | Read Only | Public |
| --- | --- | --- | --- | --- | --- |
| Read protected operational data | Expected allowed | Expected allowed | Expected allowed | Expected allowed | Denied by protected route/RLS |
| Create operational records | Expected allowed | Expected allowed | Expected allowed via `can_write_admin_data()` | Denied | Public application only |
| Transaction insert | Allowed | Allowed | Allowed | Denied | Denied |
| Transaction update/delete | Allowed by `is_admin_user()` | Allowed by `is_admin_user()` | Denied | Denied | Denied |
| Proposed `remove_payment_record` RPC | Allowed | Allowed | Denied | Denied | Denied |
| Contract void | Allowed | Allowed | Denied | Denied | Denied |
| Customer/lead/post-sales AI generation | Allowed | Allowed | Allowed | Denied | Denied |
| Application review and Daily Brief generation | Allowed | Allowed | Denied in Edge Functions | Denied | Denied |
| Email Center navigation | Allowed | Allowed | hidden in UI | hidden in UI | Denied |
| Super Admin configuration | Expected allowed | needs per-panel review | denied in UI where applicable | denied | denied |

The role table reflects source definitions, not a runtime permission test. Frontend visibility must never be treated as enforcement; the verified database enforcement is strongest for transaction lifecycle and the reviewed Edge Functions. Settings, storage/document access, emails, and every operational table still require test-role verification.

## Data-flow findings and issue register

### 1. Financial and data-integrity risks

#### FIN-001 — Contract validation no longer binds a contract to the customer's approved lot

- **Route/component:** Contract form; Customer Detail contract action; `public.validate_contract_write`
- **Category / severity / confidence:** Data integrity / **Critical** / **Confirmed**
- **Current behavior:** `20260624000200_contract_void_cancel_phase_b.sql` replaces `validate_contract_write` with a function that checks only that the selected parcel is not `Sold`. It removes the prior lookup comparing `customers.application_id -> applications.parcel_id` to `new.parcel_id`. The form itself offers both `Available` and `Reserved` lots.
- **Expected behavior:** A contract must only be created for the approved/otherwise explicitly authorized reservation lot for that customer; the database should reject mismatches.
- **Evidence:** `wamuale_supabase_foundation_migration.sql` lines covering the original validation; `supabase/migrations/20260624000200_contract_void_cancel_phase_b.sql` replacement function; `src/components/forms/ContractForm.tsx` available parcel query.
- **Source of truth:** Customer's approved application and an approved reservation/lot assignment policy.
- **Business impact:** A valid-looking contract can sell the wrong lot and cause a false `Sold` status.
- **Likely root cause:** Lifecycle migration replaced, rather than extended, the original validation function.
- **Recommended correction:** Restore relationship validation in the lifecycle-safe function; decide how a formally approved alternate-lot change is represented and audited.
- **Likely files affected:** Contract lifecycle migration/new corrective migration; `ContractForm`; shared lot-assignment helper/tests.
- **Database migration required:** Yes.
- **Business clarification required:** Yes, for allowed alternate-lot workflow.
- **Suggested regression test:** Attempt contract creation for a customer against another available lot and assert database rejection; assert valid approved/reserved lot succeeds.

#### FIN-002 — Contract void leaves the parcel `Sold`

- **Route/component:** Customer Detail void action; Contracts; Lots; Collections
- **Category / severity / confidence:** Lot/contract integrity / **Critical** / **Confirmed**
- **Current behavior:** Creating an active contract marks its parcel `Sold`. `void_contract` changes the contract to inactive/voided and writes an audit event, but explicitly does not change the parcel. The Customer Detail UI tells staff to review lot status manually.
- **Expected behavior:** A voided mistaken contract must enter an explicit, audited lot-resolution workflow; the lot must not remain silently blocked without a defined business outcome.
- **Evidence:** `mark_parcel_sold_after_contract` in the foundation migration; `void_contract` comment and implementation in `20260624000200_contract_void_cancel_phase_b.sql`.
- **Source of truth:** Active contract lifecycle plus approved lot-release/reservation policy.
- **Business impact:** Lots can remain unavailable or appear sold after the only active contract is voided.
- **Likely root cause:** Void was intentionally scoped not to mutate parcel/reservation records, without a required follow-up state.
- **Recommended correction:** Add an explicit, audited post-void resolution choice (retain Sold with reason, release to Available, or re-reserve) with safeguards for related reservations/payments.
- **Likely files affected:** Contract lifecycle SQL, Lots/Contracts/Customer Detail workflow, audit tests.
- **Database migration required:** Yes.
- **Business clarification required:** Yes.
- **Suggested regression test:** Void an active contract and verify the required lot-resolution state and audit evidence.

#### FIN-003 — Payment removal is hard deletion and existing RLS already allows direct Admin deletion

- **Route/component:** Payments; `transactions` RLS; `20260714203000_controlled_payment_removal.sql`
- **Category / severity / confidence:** Financial integrity / **Critical** / **Confirmed**
- **Current behavior:** Existing RLS allows Admin/Super Admin `delete` on `transactions`. The proposed RPC writes one audit row containing the transaction JSON, deletes receipt jobs, then hard-deletes the transaction. Payment documents are retained with `transaction_id` set to null; reservation deposit links are also `ON DELETE SET NULL`. The RPC does not snapshot linked documents, receipt job state, related reservation links, or storage-file context.
- **Expected behavior:** Corrections must preserve an immutable financial trail and linked evidence. A destructive action should not be available through a direct table delete path.
- **Evidence:** Transactions policies in `wamuale_supabase_foundation_migration.sql`; foreign keys in `20260612000100_manual_receipts_payment_documents.sql` and `20260619000100_reservation_deposit_workflow_phase_2.sql`; proposed removal migration and `PaymentsPage.tsx`.
- **Source of truth:** Posted payment ledger and accountable correction policy.
- **Business impact:** Historic reports/statements recalculate as if the payment never existed; proof becomes detached; deposit linkage is lost; an audit snapshot is incomplete; direct API deletes bypass the new reason requirement.
- **Likely root cause:** Hard-delete workflow was added around an existing direct-delete policy rather than replacing it with a controlled immutable reversal/void model.
- **Recommended correction:** Do not apply the migration. Obtain approval for a payment lifecycle model (void/reversal/correction) and disable direct transaction deletion after a compatible controlled workflow exists.
- **Likely files affected:** New financial migration(s), transactions policies, payment types/calculation helpers, Payments UI, reports/statements, audit tests.
- **Database migration required:** Yes.
- **Business clarification required:** Yes.
- **Suggested regression test:** Attempt direct Admin delete; void/reverse a payment with proof and reservation linkage; assert balances, reports, statements, documents, and audit history retain prescribed evidence.

#### FIN-004 — Financial calculations and active-contract rules are duplicated

- **Route/component:** Customer Detail, Collections, Reports, Document Page, Dashboard, Daily Brief, customer AI
- **Category / severity / confidence:** Calculation consistency / **High** / **Confirmed**
- **Current behavior:** Each location independently filters payments and calculates balance/due/overdue. Customer Detail requires `status === 'active'`; customer AI and Daily Brief select active contracts with `is_active` only.
- **Expected behavior:** Shared, test-covered definitions must yield the same totals and standing across live pages, reports, and AI source snapshots.
- **Evidence:** `src/pages/CustomerDetailPage.tsx`, `CollectionsPage.tsx`, `ReportsPage.tsx`, `DocumentPage.tsx`, `src/lib/accountDates.ts`, `generate-customer-summary`, `generate-daily-brief`.
- **Source of truth:** Persisted contract/payment records and a centrally documented accounting policy.
- **Business impact:** The same customer can be current in one surface and overdue/no-contract in another.
- **Likely root cause:** Incremental feature additions retained local helpers.
- **Recommended correction:** Establish canonical calculation helpers/database views and test them against shared fixtures; define void/reversal treatment before implementation.
- **Likely files affected:** Shared financial module, all listed pages/functions, reports tests.
- **Database migration required:** No/Unknown (depends on whether a view is selected).
- **Business clarification required:** Yes, for treatment of deposits, voids, and pre-contract fees.
- **Suggested regression test:** One fixture set must produce identical total paid, balance, due date, and overdue result in every named surface.

#### FIN-005 — Manual receipt and transfer-proof requirements are review queues, not write blockers

- **Route/component:** Payment Form; Payments; Collections; Daily Brief
- **Category / severity / confidence:** Financial workflow / **Medium** / **Confirmed**
- **Current behavior:** The database enforces an online-transfer bank reference and land-payment contract, but allows a payment without a manual receipt number and allows an online transfer without a proof document. Collections then flags missing records.
- **Expected behavior:** The business must explicitly decide whether these are permitted pending-review states or hard prerequisites.
- **Evidence:** Transaction constraints/trigger; `PaymentForm`; Collections missing receipt/proof queues.
- **Source of truth:** Approved finance-control policy.
- **Business impact:** If receipt/proof is mandatory at posting, the current ledger can contain noncompliant entries.
- **Likely root cause:** Deliberate deferred-document workflow, not formally stated in UI policy.
- **Recommended correction:** Make the intended policy explicit and align form copy, statuses, report queues, and acceptance tests.
- **Likely files affected:** Payment form/schema, finance policy documentation, possibly migration.
- **Database migration required:** Unknown.
- **Business clarification required:** Yes.
- **Suggested regression test:** Verify the chosen permitted/blocked path for cash receipt and online-transfer proof.

### 2. Workflow contradictions

#### WF-001 — Customer Detail presents a requested application lot as an assigned lot

- **Route/component:** Customer Detail `assignedLot` / Customer Command Profile
- **Category / severity / confidence:** Relationship integrity / **High** / **Confirmed**
- **Current behavior:** When no active contract exists, `assignedLot` falls back to `customer.applications.parcels`, yet the UI says `Lot …` / `No lot assigned`.
- **Expected behavior:** A preferred/requested application lot, active reservation lot, and active-contract lot must have distinct labels and precedence.
- **Evidence:** `src/pages/CustomerDetailPage.tsx` `assignedLot` function and hero presentation.
- **Source of truth:** Active contract first; active reservation second; application preference separately.
- **Business impact:** Staff can assume a customer owns or has reserved a lot when no supporting record exists.
- **Likely root cause:** Presentation fallback reused the application parcel as an assignment.
- **Recommended correction:** Display separate `Contract lot`, `Reserved lot`, and `Requested/preferred lot` states; do not collapse them.
- **Likely files affected:** Customer Detail and shared relationship presentation helper.
- **Database migration required:** No.
- **Business clarification required:** Yes, for reservation precedence and customer-stage terminology.
- **Suggested regression test:** Customer with application only, active reservation, active contract, released reservation, and voided contract each receives the correct label.

#### WF-002 — Post-Sales can start `In Progress` with no contract, reservation, or task

- **Route/component:** Customer Detail Post-Sales start action; post-sales tables
- **Category / severity / confidence:** Workflow correctness / **High** / **Confirmed**
- **Current behavior:** `startPostSalesChecklist` inserts `in_progress` for any customer and records optional current contract/reservation IDs. Table constraints only require some context, and zero tasks are valid.
- **Expected behavior:** The system should follow an approved start condition and explain whether a zero-task `In Progress` checklist is acceptable.
- **Evidence:** `startPostSalesChecklist` in Customer Detail; `20260620000100_post_sales_automation_phase_3.sql` constraints.
- **Source of truth:** Approved post-sale handoff policy.
- **Business impact:** The screenshot state “In Progress” with zero tasks may look like active work while representing no actual handoff work.
- **Likely root cause:** Flexible checklist design without a defined initiation gate.
- **Recommended correction:** Decide the minimum condition and status terminology; if allowed, label it as `Started — tasks not yet created` rather than implying work is underway.
- **Likely files affected:** Customer Detail, post-sales policy/constraints, reports.
- **Database migration required:** Unknown.
- **Business clarification required:** Yes.
- **Suggested regression test:** Assert allowed and disallowed start conditions and expected task/status presentation.

#### WF-003 — Primary customer actions open before their prerequisites are explained

- **Route/component:** Customer Detail primary action cluster
- **Category / severity / confidence:** Action availability / **Medium** / **Confirmed**
- **Current behavior:** Record Payment, Create Contract, and Create Request are always shown. The forms reject some invalid combinations, but buttons do not say why the operation is unavailable or what prerequisite is missing.
- **Expected behavior:** Contextual actions should be enabled only when their workflow conditions exist, or clearly explain the valid exception.
- **Evidence:** `CustomerCommandProfile` / `PrimaryActionCluster`; `PaymentForm` schema; `ContractForm`.
- **Source of truth:** Approved sales/finance workflow and backend constraints.
- **Business impact:** Users can enter an action path that predictably fails or choose a community-fee workaround where a land-payment workflow is intended.
- **Likely root cause:** Header actions are generic rather than state-aware.
- **Recommended correction:** Add state-aware action copy/gating after the business rules are approved; retain backend validation as the enforcement layer.
- **Likely files affected:** Customer Detail, forms, action tests.
- **Database migration required:** No.
- **Business clarification required:** Yes.
- **Suggested regression test:** Customer without contract, customer with active contract, and customer with only community-fee eligibility show the correct action affordance.

#### WF-004 — A voided contract can leave financial and customer context without an explicit operational state

- **Route/component:** Customer Detail, Collections, Reports, Documents
- **Category / severity /confidence:** Workflow truth / **High** / **Confirmed**
- **Current behavior:** Contract void preserves linked payments and documents; live calculations generally filter to active contract or use raw payment totals. The UI advises manual review but does not present a defined state for retained payments after void.
- **Expected behavior:** Void/cancel should specify whether payments are refundable, reallocated, retained as fees, or reversed—and how balance/report/statement pages describe them.
- **Evidence:** Contract-void migration comment; Customer Detail void warning; independent calculation paths.
- **Source of truth:** Finance and cancellation policy.
- **Business impact:** Statements and collections can be misleading after correction of a contract created in error.
- **Likely root cause:** Contract lifecycle was introduced without a corresponding payment-resolution workflow.
- **Recommended correction:** Add a documented, enforced post-void financial resolution status before treating void as production ready.
- **Likely files affected:** Contract/payment lifecycle, calculations, Customer Detail, reports.
- **Database migration required:** Likely.
- **Business clarification required:** Yes.
- **Suggested regression test:** Void a contract with payments and verify each required financial outcome by policy.

### 3. AI correctness risks

#### AI-001 — Customer Smart Summary stale check misses payment edits and source records used by the summary

- **Route/component:** Customer Detail Smart Summary
- **Category / severity / confidence:** AI freshness / **High** / **Confirmed**
- **Current behavior:** Staleness compares transactions by `created_at` only. Transactions do not have `updated_at` in the reviewed schema, so edits to amount, type, contract link, receipt fields, or reference do not make the summary stale. The check also omits related leads, site visits, post-sales tasks/activities, and documents even where summary/context guidance can depend on them.
- **Expected behavior:** Any relevant source change must either mark the summary stale or be excluded from its displayed assertions.
- **Evidence:** `isCustomerSummaryStale` in Customer Detail; transaction schema; `generate-customer-summary` context/calculation logic.
- **Source of truth:** Current persisted customer, contract, payment, request, reservation, and post-sales data.
- **Business impact:** An old financial or overdue assertion can still look current after correction.
- **Likely root cause:** Stale check was added at the UI without a complete dependency list or update timestamps on all source records.
- **Recommended correction:** Store a source-version/fingerprint or complete relevant timestamps; treat payment updates/removals and related operational changes as stale triggers.
- **Likely files affected:** Transactions schema/migration, Customer Detail, customer AI function, tests.
- **Database migration required:** Likely.
- **Business clarification required:** No.
- **Suggested regression test:** Generate summary, edit amount/contract/payment type, then assert `Update available` and no financial/status claims display as current.

#### AI-002 — Other stored AI outputs have no equivalent visible staleness policy

- **Route/component:** Lead summaries, Application AI Review, Daily Brief, Post-Sales summaries
- **Category / severity / confidence:** AI freshness / **Medium** / **Confirmed**
- **Current behavior:** Edge Functions record generation timestamps and source snapshots in varying forms, but the reviewed pages/functions do not implement a consistent stale comparison and warning like Customer Detail.
- **Expected behavior:** Every stored advisory output must show generation time and stale/refresh state when relevant source records change.
- **Evidence:** AI migration schemas and Edge Functions; Customer Detail is the only reviewed page with `isCustomerSummaryStale`.
- **Source of truth:** Current operational records, never AI output.
- **Business impact:** Old recommendations, readiness states, or daily-brief alerts may be acted on as current.
- **Likely root cause:** Customer stale handling was implemented as a page-specific repair.
- **Recommended correction:** Define a shared stale-state contract for each AI record type; do not automatically regenerate on page load.
- **Likely files affected:** AI schema/functions, Leads, Applications, Daily Brief, Customer Detail, Post-Sales.
- **Database migration required:** Unknown.
- **Business clarification required:** No.
- **Suggested regression test:** Change each relevant source record after generation and assert warning, date, and advisory labeling.

#### AI-003 — AI role enforcement is substantially present, but runtime policy verification remains open

- **Route/component:** All reviewed AI Edge Functions and UI generation controls
- **Category / severity / confidence:** Permissions / **Low** / **Confirmed source; runtime verification needed**
- **Current behavior:** Customer/lead/post-sales generation permits Super Admin/Admin/Staff; application review and Daily Brief permit Super Admin/Admin. Functions authenticate the bearer token and query `admin_profiles`; prompts explicitly prohibit operational mutation.
- **Expected behavior:** UI should mirror Edge Function policy and no AI output may mutate operational data.
- **Evidence:** `generate-customer-summary`, `generate-lead-summary`, `generate-post-sales-summary`, `generate-application-review`, and `generate-daily-brief`.
- **Source of truth:** Edge Function role checks and RLS.
- **Business impact:** No defect confirmed in code, but deployed function versions and role test accounts were not exercised.
- **Likely root cause:** Verification limitation.
- **Recommended correction:** Execute role-matrix tests against a non-production project; retain this as a release gate.
- **Likely files affected:** Tests/QA only unless a mismatch is found.
- **Database migration required:** No.
- **Business clarification required:** No.
- **Suggested regression test:** Invoke each function as every role and confirm denied roles cannot write an AI record.

### 4. Permissions and security

#### SEC-001 — Direct transaction deletion bypasses the proposed removal confirmation/reason

- **Route/component:** Supabase table API/RLS; Payments
- **Category / severity / confidence:** Authorization / **Critical** / **Confirmed**
- **Current behavior:** The pre-existing `Transactions deletable by admins` RLS policy grants direct delete to `is_admin_user()`. The new UI calls an RPC, but does not revoke that route.
- **Expected behavior:** If deletion/reversal is permitted, all paths must enforce the same reason, confirmation, retention, and audit policy.
- **Evidence:** Transaction RLS definition in foundation migration; removal RPC grant/revoke does not alter table delete policy.
- **Source of truth:** Database policy, not frontend control.
- **Business impact:** Admins with API access can erase a payment without the proposed audit event.
- **Likely root cause:** Existing admin-delete policy remained in place.
- **Recommended correction:** Do not deploy the new removal migration; design a single controlled financial correction path and revoke ordinary delete accordingly.
- **Likely files affected:** Transactions RLS/migration and correction workflow.
- **Database migration required:** Yes.
- **Business clarification required:** Yes.
- **Suggested regression test:** Direct delete is denied; approved correction path is allowed and fully audited.

#### SEC-002 — Route protection is authentication/profile protection, not per-route authorization

- **Route/component:** `ProtectedRoute`; Settings and operational routes
- **Category / severity / confidence:** Authorization design / **Medium** / **Confirmed**
- **Current behavior:** The router admits any user with an admin profile to all protected routes; granular access depends on page UI and table/function RLS. For example, Settings navigation is visible to all internal profiles.
- **Expected behavior:** Read Only/Staff users should either see a clearly read-only page or be routed away from privileged settings, with RLS enforcing the same restriction.
- **Evidence:** `ProtectedRoute.tsx`, `AdminLayout.tsx`, roles/RLS helpers.
- **Source of truth:** RLS plus approved role matrix.
- **Business impact:** Users can reach pages containing controls they cannot use, and any missed RLS policy becomes a privilege escalation.
- **Likely root cause:** Broad authenticated shell with per-component role gates.
- **Recommended correction:** Audit each settings/data-management/email control under real roles; add route-level read-only messaging/gates for clarity while retaining RLS enforcement.
- **Likely files affected:** Router/layout/settings and QA tests.
- **Database migration required:** No/Unknown.
- **Business clarification required:** Yes, for Staff read-only settings visibility.
- **Suggested regression test:** Navigate directly to every protected route as all roles; attempt each mutation through UI and direct API.

### 5. Layout, responsive, and accessibility findings

#### UI-001 — Customer Detail layout repairs are not runtime-verified

- **Route/component:** Customer Detail; shared CSS/layout
- **Category / severity / confidence:** Responsive layout / **Medium** / **Needs runtime verification**
- **Current behavior:** Source now places the rail in a normal responsive grid and collapses it below the main content at narrower widths. The previous audit asserts the overlap was repaired, but no authenticated viewport evidence was available in this audit.
- **Expected behavior:** No overlap/overflow at 1536, 1440, 1280, 1024, 768, 430, and 390 px; tabs and actions remain reachable.
- **Evidence:** Current `CustomerDetailPage.tsx` and `src/index.css`; no browser result.
- **Source of truth:** Rendered application with realistic long data.
- **Business impact:** The confirmed screenshot defect may still recur at a breakpoint or with long content.
- **Likely root cause:** Unverified runtime state.
- **Recommended correction:** Treat mobile/tablet screenshot and interaction tests as a release gate; do not mark repaired until tested.
- **Likely files affected:** Potentially shared CSS/Customer Detail after verification.
- **Database migration required:** No.
- **Business clarification required:** No.
- **Suggested regression test:** Screenshot/layout test with long name/email/address at all required widths.

#### A11Y-001 — Custom action modal lacks focus management and keyboard escape behavior

- **Route/component:** Customer Detail `ActionModal`; feedback modal in Admin Layout
- **Category / severity / confidence:** Accessibility / **Medium** / **Confirmed**
- **Current behavior:** The modal uses `role="dialog"` and `aria-modal`, but has no labelled relationship, initial-focus handling, focus trap, focus restoration, or Escape-to-close handler.
- **Expected behavior:** Keyboard focus enters the dialog predictably, remains within it, Escape closes it where safe, and returns to the invoking action.
- **Evidence:** `ActionModal` in Customer Detail and comparable hand-built feedback modal in `AdminLayout.tsx`.
- **Source of truth:** Accessible modal interaction requirements.
- **Business impact:** Keyboard and assistive-technology users can lose context or interact with background controls.
- **Likely root cause:** Custom modal primitives rather than an accessible dialog component.
- **Recommended correction:** Adopt a tested accessible dialog primitive or fully implement focus behavior; verify on mobile screen readers/keyboard.
- **Likely files affected:** Customer Detail, Admin Layout, shared UI.
- **Database migration required:** No.
- **Business clarification required:** No.
- **Suggested regression test:** Keyboard-only modal open/close/focus-trap/restore test.

#### UI-002 — No explicit not-found route

- **Route/component:** Router catch-all
- **Category / severity / confidence:** Usability / **Low** / **Confirmed**
- **Current behavior:** Unknown paths redirect to `/dashboard`, which redirects unauthenticated users to login; no explanation identifies an invalid URL.
- **Expected behavior:** A clear safe not-found page that preserves authentication boundaries.
- **Evidence:** `src/App.tsx` catch-all route.
- **Source of truth:** Router behavior.
- **Business impact:** Support troubleshooting and deep-link diagnosis are harder.
- **Likely root cause:** Convenience redirect.
- **Recommended correction:** Add a simple not-found route in a later low-risk batch.
- **Likely files affected:** Router/new page.
- **Database migration required:** No.
- **Business clarification required:** No.
- **Suggested regression test:** Invalid public and protected URLs show appropriate error page.

## Customer Detail correctness conclusion

For the visible scenario:

| Screenshot combination | Assessment |
| --- | --- |
| Lot 01 shown as assigned, no reservation, no active contract | **Misleading/contradictory presentation.** Current code can label the application parcel as the customer lot. It should be `Requested/preferred lot` until an active reservation or contract supports assignment. |
| No active contract; purchase price and remaining balance `N/A` | **Valid live presentation** if no active contract exists. |
| `$750` shown as recorded **land** payments with no active contract | **Requires data verification.** Current DB constraints reject new land payments without a contract. Community fees may be recorded without a contract but should not appear in the land total. |
| Two missing manual receipt numbers; transfer proof needs review | **Technically valid under current policy** and intentionally queued for review; whether it is compliant needs business confirmation. |
| Post-Sales `In Progress`, zero tasks | **Technically valid but misleading without policy.** Current implementation permits it, but the business must define whether post-sales can begin before a reservation/contract and with no task. |
| Older AI summary claims a contract/balance/overdue while live account says no contract | **Contradictory if shown as current.** The new stale warning helps only if a tracked source timestamp is newer. It does not fully protect against payment edits or omitted source dependencies. |

**Actions by state:**

- With application only: show requested lot; contract/payment-request actions should explain prerequisites. Community-fee payment eligibility needs a business decision.
- With an active reservation but no contract: show reserved lot and reservation/deposit readiness, not payment-ledger confirmation.
- With an active contract: allow contract-linked land payment and contractual collection actions.
- With a voided contract: do not imply normal collections/assignment until lot and retained-payment resolution have been completed.

**Business clarification required:** Whether any payment without a contract is an approved workflow. The current technical rule permits only community fees without a contract; it does not permit pre-contract land deposits/installments.

## Payment-removal workflow conclusion

**Classification: Do not apply in current form.**

The reviewed file `supabase/migrations/20260714203000_controlled_payment_removal.sql` is un-applied in this workspace. It is not safe to apply because it performs hard deletion, loses live transaction references, preserves only a transaction-row snapshot (not a complete evidence bundle), changes historical live calculations/reports, and leaves the older direct Admin table-delete path available. It also lacks an approved finance policy for voids, reversals, refunds, corrections, statements, and reservation deposits.

The requested ability to remove/delete a payment is therefore **not approved by this audit as a production operation**. The business must first approve a controlled accounting model. A void/reversal/correction model is safer than deletion because it retains ledger history and attached evidence while allowing accurate current balances.

## Business clarification questions

1. Can a contract be written for a lot other than the application lot? If yes, what approved reservation/alternate-lot record authorizes it?
2. After a contract is voided/cancelled, should the lot become Available, return to a reservation, remain Sold, or require a separate resolution workflow?
3. How must payments tied to a voided/cancelled contract be handled: refund, reversal, reallocation, retained fee, or another status?
4. Is it ever valid to record a payment without an active contract? Current database rules allow only community fees, not land payments.
5. Are manual receipt numbers and online-transfer proof required before posting, or may they be completed later as controlled exceptions?
6. What should `Post-Sales In Progress` mean, and what minimum condition/task set is required before it can be started?
7. Should Staff see Settings as a read-only reference, or be denied route access entirely?
8. Does the organization require financial corrections to be void/reversal-only rather than deletion? (Recommended: yes.)

## Recommended repair sequence

### Batch 1 — Critical correctness

1. Block or replace the payment-removal migration; remove ordinary direct transaction deletion as part of an approved correction design.
2. Restore database enforcement that binds a contract to the approved/authorized lot.
3. Define and enforce voided-contract lot/payment resolution.
4. Establish one active-contract and financial-calculation definition before changing reports or dashboards.

### Batch 2 — Workflow correctness

1. Separate requested, reserved, and contracted lot presentation.
2. Make customer actions state-aware with clear prerequisite explanations.
3. Define post-sales start/zero-task rules and voided-contract customer handling.
4. Decide receipt/proof posting policy and align queues with it.

### Batch 3 — AI correctness

1. Complete Customer Smart Summary dependency tracking, including payment updates/corrections.
2. Implement shared freshness/advisory display for Lead, Application, Daily Brief, and Post-Sales outputs.
3. Add role and source-precedence regression tests.

### Batch 4 — Structural UI defects

1. Run authenticated visual checks at every required viewport, particularly Customer Detail tabs/rail/actions and payment cards.
2. Fix only verified overflow, overlap, focus, and keyboard defects.
3. Add targeted screenshot tests if an existing browser framework is available.

### Batch 5 — Lower-risk consistency

1. Add a not-found route.
2. Consolidate terminology (`Due` versus `Overdue`, assigned versus preferred lot).
3. Normalize empty/loading/error language after live workflow verification.

## Routes and behaviors not runtime-tested

All routes remain runtime-unverified in this audit because no authenticated test account/browser session was available. In particular, the following release gates remain open:

- desktop/tablet/mobile checks at 1536, 1440, 1280, 1024, 768, 430, and 390 px;
- Customer Detail with no contract, active contract, long contact text, stale AI summary, zero-task post-sales, and action preconditions;
- RLS/direct API checks for Super Admin, Admin, Staff, Read Only, and anonymous users;
- deployed Edge Function role behavior;
- storage/document authorization and failed upload behavior;
- empty, loading, failed-query, and deleted-related-record states;
- reports/statements after any payment correction or contract void.

## Verification status

This document records source-verified findings only. It does **not** certify any route as production-ready. No deployment, DNS, Netlify configuration, production data, tests, or application code were changed during this audit.

## Batch 1 implementation update — 2026-07-14

| Audit issue | Implementation status |
| --- | --- |
| FIN-001 Contract-to-lot validation | **Fixed in source; migration pending.** New active contracts are database-bound to a customer active reservation lot or approved application lot. |
| FIN-002 Contract void leaves parcel sold | **Fixed in source; migration pending.** Voiding creates a pending resolution record and locks new contracts for that parcel until an explicit Admin/Super Admin resolution. No auto-release occurs. |
| FIN-003 / SEC-001 payment deletion | **Fixed in source; migration pending.** Direct delete policy is removed and a void-only RPC preserves transaction/document history. The unsafe hard-delete migration must not be independently applied. |
| FIN-004 duplicated current totals | **Fixed in source; runtime verification pending.** Canonical client, Edge Function, and database-view definitions now exclude voided/reversed/unrelated payments. |
| WF-001 requested lot presented as assigned | **Fixed in source; runtime verification pending.** Customer Detail labels contract, reservation, and requested lots separately. |
| WF-004 voided-contract payment state | **Partially fixed in source; business decision still pending.** Payments remain visible and are excluded from current active-account totals. Refund/reallocation policy remains unresolved. |

See `critical-correctness-repair.md` for migration order, data-inspection queries, containment notes, and remaining runtime requirements.
