# Wamule Design System V2 - Applications

## V1 Applications Visual Diagnosis

Applications V1 used a three-column kanban grouped by status. It preserved the right workflows, but each application card carried identity, lot details, lead/reservation context, rule-based guidance, AI review, lot selection, and decision actions with similar visual weight.

That made the page feel like a collection of application cards rather than a focused review workspace. Staff had to scan repeated panels to answer: which application needs review, what is missing, and what decision is being prepared?

## Current Functionality Inventory

Applications V2 preserves the current data sources:

- `applications` with linked parcel and application AI reviews
- `ai_settings`
- parcel/lot options
- linked leads
- linked lot reservations
- reservation workflow settings
- post-sales checklists
- session/profile role context

It preserves current actions:

- Approve / decline application through existing `updateApplicationStatus`
- Optional lot selection before approval
- Generate/regenerate existing Application AI Review
- Create linked Lead from application
- Create linked Reservation from application with reservation settings defaults
- View linked lead
- Display linked reservation/deposit readiness
- Display post-sales checklist state for approved applications

No schema, query, RPC, Edge Function, approval logic, lead behavior, reservation logic, customer creation behavior, parcel status behavior, auth, roles, or permissions were changed.

## V2 Review Workspace Composition

The page now uses:

- Restrained Applications header
- Horizontal review-state strip using actual statuses and counts
- Left Review Queue
- Selected Application Workbench

The product question is now visible in the composition: which applicant is selected, what is their review state, what lot direction is involved, what is missing, and what actions are available.

## Review Queue

The left zone is a review queue with search and selected-record treatment. Queue items emphasize:

- Applicant name
- Application status
- Preferred lot
- Submission date
- Known missing fields
- Lot issue
- Possible duplicate flag when linked lead has one
- Reservation and post-sales context when present

The queue uses V2 operational material instead of equal white cards.

## Application Workbench

The selected workbench contains:

- Applicant identity header
- Submission/contact context
- Decision action panel
- Current Review State strip
- Lot Preference workspace
- Missing Information
- Applicant Information
- Buyer Journey / related records
- Application AI Review
- Application Context

The selected applicant dominates the work surface, shifting the page from "browse cards" to "review this application."

## Current Review State

The current-review strip uses actual state only:

- Application status
- Lot availability / lot issue
- Known missing information count
- Buyer journey linkage

No readiness percentage, score, or invented metric was added.

## Applicant Detail Grouping

Applicant details are grouped into compact definition blocks:

- Identity / Contact
- Submitted Use

This keeps the full submitted information available without letting individual fields dominate the review decision.

## Lot Preference Treatment

Lot Preference is a major workflow section. It shows:

- Preferred/assigned lot context
- Preferred lot labels from submitted `preferred_parcel_ids`
- Parcel count
- Current lot status
- Alternative lot preference as secondary context

If a selected/preferred lot is unavailable, the section shows a calm warning. It does not auto-change the lot or change approval behavior.

## Buyer Journey / Related Records

The Buyer Journey section preserves:

- Linked Lead display/create action
- Reservation / Deposit Readiness display/create action
- Post-Sales checklist state after approval

This uses workflow material and keeps Deposit Readiness distinct from financial truth.

## Missing Information Distinction

Known missing facts are displayed separately from rule-based guidance:

- Known missing facts: operational review state
- Rule-based guidance: advisor material via existing `applicationSmartInsights`
- AI Review: advisor material via existing Application AI Review

This prevents missing required fields and smart suggestions from looking identical.

## AI Review Advisor Treatment

Application AI Review now uses warm advisor material and remains secondary to actual application status, lot preference, missing facts, and staff decision actions.

Existing generation behavior is preserved. No AI calls were added beyond the existing generate/regenerate action.

## Decision Action Treatment

Approve/Decline remain in a deliberate Review Decision panel near the workbench header. The optional lot selector remains available for non-approved applications and uses the current available-lot list.

No auto-approval, auto-rejection, new confirmation flow, or permission change was added.

## Mobile Queue-to-Drill-In Behavior

At small widths, the page stacks as:

1. Header
2. Review-state strip
3. Review Queue
4. Selected Application Workbench

The workbench includes a mobile "Back to queue" control and stacked sections. It does not squeeze the desktop two-zone layout into tiny columns. Human local visual review should validate whether the current stacked behavior is sufficient or if a stricter full-screen drill-in should be added later.

## Shared V2 Components

No cross-file shared component was extracted. The repeated patterns are now clear across Dashboard, Leads, Customer Detail, and Applications, but extraction should happen after human review confirms the pattern boundaries.

## Mockup / Product Filler

No mockup filler was added. Applications V2 uses actual statuses, fields, linked records, lot options, AI review data, and existing Wamule actions only.

Financial Truth material is intentionally absent because Applications does not display confirmed financial records.

## Authenticated Automated Screenshot QA

Automated authenticated screenshot QA was not performed per the current workflow. The application is running locally and human visual review will be performed directly against the real UI.

## Known Limitations

- There is no existing application activity feed; no archive timeline was invented.
- Search is local to loaded application rows and does not change data sources.
- Mobile currently uses stacked queue/workbench behavior with a back control; human review should decide whether to make it a stricter drill-in state.
- Missing information uses existing deterministic fields and existing rule-based insights; it does not add validation rules.

## Recommendation Before Lots V2

Review Applications V2 alongside Dashboard, Leads, and Customer Command Profile. If approved, extract shared primitives for Review Queue, Status Strip, Workflow Panel, Advisor Panel, and Operational Summary before implementing Lots V2.
