# Wamule Design System V2 - Customer Command Profile

## V1 Visual Diagnosis

Customer Detail V1 was functionally complete, but the first screen asked staff to interpret separate account cards, tabs, and a quick-actions sidebar before understanding the customer's current standing. Contract status, payment standing, collections context, documents, post-sales work, reservations, and guidance often appeared as similar card surfaces with similar weight.

The result was operationally useful but not immediate: staff had to inspect tabs to answer "What is going on with this person right now?"

## Visual References

The approved Customer Detail desktop and mobile mockups were used as visual composition targets only. They informed hierarchy, surface layering, status-strip placement, command-profile composition, mobile stacking, and material distinction.

Mockup filler was intentionally ignored. No fictional customer names, staff names, project names, dates, balances, document counts, readiness percentages, actions, workflows, navigation, branding, or automation were implemented.

## Current Functionality Preserved

The implementation preserves the existing Customer Detail data sources and workflows:

- Customer identity/contact data
- Application and lot context
- Related leads
- Related reservations and deposit readiness
- Related site visits
- Contracts and contract history
- Contract void workflow and restrictions
- Recorded payments and payment documents
- Payment requests and request status changes
- Balance statement
- Documents/payment proof uploads
- Post-Sales checklist, tasks, timeline, and summaries
- Customer Smart Summary / Collections Assistant
- Existing tabs and modal actions

No schema, query, RPC, Edge Function, calculation, permission, auth, or workflow behavior was changed.

## Command Profile Composition

Customer Detail now opens with a composed Customer Command Profile instead of a generic page header. The first screen presents:

- Customer identity and contact context
- Lot/customer-since context from existing records
- Primary record actions using existing handlers
- Signature status strip for Contract, Payments, Collections, Documents, and Post-Sales
- Deterministic Operational Summary from current page data
- Dark ledger-side panel for purchase price, recorded payments, remaining balance, next due date, and monthly payment

This makes current standing visible before staff choose a tab.

## Status Strip

The status strip is the signature Wamule record pattern for this pass. It recombines current standing into five cells:

- Contract: active/no active contract and contract id
- Payments: current/due/paid in full/no account and remaining balance where a contract exists
- Collections: open payment request state
- Documents: uploaded document count or missing receipt-number review
- Post-Sales: checklist status, open/blocked/overdue task context

The strip remains cohesive, but the cells use different material cues: payment/collections are more ledger-like, while documents/post-sales are workflow-oriented.

## Operational Summary

The Operational Summary is deterministic copy composed from existing state:

- Active contract status
- Remaining balance
- Open payment requests
- Latest reservation/deposit status
- Post-Sales checklist/tasks
- Missing manual receipt numbers

It does not call AI and does not present Smart Summary content as confirmed account truth.

## Four Materials Used

Financial Truth is used for the command-profile ledger, payment history, statement values, payment requests, recorded payments, balances, and receipt-related information. These surfaces use crisp light backgrounds, precise borders, and tabular numbers.

Workflow State is used for reservations/deposit readiness, site visit context, documents needing review, post-sales checklist/tasks, and current workflow rail content. These surfaces use soft land-green/cream treatments.

Staff Guidance is used for Operations Insights, Customer Smart Summary, and Post-Sales Smart Summary. These use warm advisor surfaces and clearly remain secondary to confirmed account facts.

History / Accountability is used for contract history, void/cancel notes, and post-sales timeline. These areas are quieter, timestamp-led where available, and do not use primary action styling except for preserved authorized workflow actions such as Contract Void.

## Tabs and Detail Workspace

The existing tabs remain intact:

- Overview
- Post-Sales
- Contract
- Payments
- Documents
- Requests
- Statement
- Smart Summary

Tabs now sit below the Command Profile and are visually secondary. The desktop workspace uses a main detail area and a right rail. The main area hosts the selected tab. The rail supports the current record with workflow, advisor, actions, and record context.

## Right Rail

The right rail contains:

- Current Workflow: reservation/deposit readiness, upcoming site visit, post-sales status when available
- Smart Summary: advisory customer guidance with existing generate/regenerate behavior
- Record Actions: preserved existing customer actions
- Record Context: compact counts from existing data

The rail supports the customer record without becoming the first mental model.

## Duplication Reduced

Current standing moved into the Command Profile and Status Strip. Detailed records remain in tabs. Guidance remains in advisor surfaces. Historical records remain quieter in history/timeline sections. This reduces repeated equal-weight status cards while preserving all functionality.

## Mobile Behavior

Without authenticated screenshot QA, the implementation was designed by code/layout inspection for:

- 390px: stacked Command Profile, wrapped real actions, two-column/horizontal-safe status strip behavior via responsive grid, operational summary near the top, tabs horizontally scrollable, right rail stacked below main tab content.
- 768px: identity, actions, status strip, summary, then single-column detail workspace.
- 1280px: sidebar-aware two-column content below the Command Profile, with safe wrapping for status/action areas.
- 1440px/1920px: command profile retains deliberate max width and does not allow ledger content to stretch without structure.

## Shared V2 Components

No cross-file shared component was extracted in this pass. The Customer Command Profile, status strip, operational summary, and rail are local to `CustomerDetailPage.tsx` until the three flagship screens are reviewed together and a stable shared primitive set is approved.

## Authenticated Screenshot QA

Authenticated screenshot QA remains deferred because the current local QA credential variables contain placeholder values. No login attempts were performed in this pass. Human review or approved QA credentials should validate:

- 390px
- 768px
- 1280px
- 1440px
- 1920px

## Known Limitations

- The status strip uses currently available customer data only; document review state is inferred from payment documents and missing manual receipt numbers because no additional document-review workflow was added.
- The Operational Summary is deterministic and intentionally conservative.
- The right rail does not add new activity/audit sources; it only uses data already loaded by the page.
- Typography keeps the existing sans-serif system. No serif accent was added because no approved existing font path was introduced for this pass.

## Recommendation After Flagship Screens

Review Dashboard V2, Leads V2, and Customer Command Profile together before proceeding. If human review confirms the direction, extract shared primitives intentionally: Status Strip, Operational Summary, Advisor Panel, Workflow Panel, and Archive Timeline treatment.
