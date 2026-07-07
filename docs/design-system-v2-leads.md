# Design System V2 Leads

## V1 Leads Visual Diagnosis

The V1 Leads page was functionally complete but visually presented too many concepts with similar card/table weight. The lead list, buyer details, buyer insights, smart summary, reservations, follow-up forms, site visits, and timeline all appeared as separate panels rather than one focused sales workspace.

The V2 goal is to make the page answer: "I am working this buyer. What do I need to know and do next?"

## Visual References

This pass used the approved Wamule V2 Leads desktop mockup and Leads mobile list/drill-in mockup as visual composition targets only.

Mockup filler was intentionally ignored. No fictional names, fictional staff, fictional dates, invented metrics, invented financial records, invented readiness percentages, invented actions, new navigation, or new workflows were implemented.

## Current Leads Functionality Preserved

The implementation preserves the existing Leads data sources and workflows:

- Lead list and selected lead state
- Pipeline stages and stage filtering
- Search, assigned staff, due/follow-up, and duplicate-review filters
- Lead create/edit form
- Assigned staff context
- Next action and next action due date
- Follow-up creation and status updates
- Site visit creation and status updates
- Reservation creation/editing
- Deposit readiness status tracking
- Quick reservation status/deposit updates
- Release alternate reservations RPC/modal flow
- Reservation settings validation/defaults
- Buyer Insights rule-based guidance
- Lead Smart Summary generation/regeneration
- Duplicate review flag/reason display
- Lead activity creation
- Lead activity timeline
- Reservation activity timeline

No data rules, calculations, schemas, RPC behavior, auth, permissions, routes, navigation, or business workflows were changed.

## V2 Two-Zone Composition

Desktop and laptop widths now use a two-zone sales workspace:

- Left zone: buyer queue, approximately 34-40% of comfortable desktop content width.
- Right zone: selected lead workbench, approximately 60-66%.

The layout avoids the earlier three-zone squeeze and is designed to remain usable inside the current Wamule sidebar shell at 1280px.

## Buyer Queue Design

The buyer queue combines:

- Horizontal pipeline strip with real pipeline stages and counts.
- Search and filters in a safe responsive form layout.
- Lead cards instead of a dense table.
- Selected-state treatment with a restrained land-green surface.
- Lead cards emphasizing buyer name, lot/link context, pipeline stage, next action, due state, assigned staff, and duplicate review only when relevant.

## Selected Lead Workbench Design

The selected lead workbench now starts with a stronger record header:

- Buyer name as the dominant identity.
- Lot/application/customer/source context.
- Contact chips where available.
- Pipeline and duplicate status.
- Edit Lead action where permitted.
- Owner, next action, follow-up count, and reservation state.

This makes the selected buyer feel like an active work surface rather than a generic detail card.

## Four Visual Materials Used

- Workflow State: selected lead header, next action, follow-ups, site visits, reservations/deposit readiness, and post-sales-style work panels use soft land-green/cream operational surfaces.
- Staff Guidance: Buyer Insights and Lead Smart Summary are grouped in a warm advisor region with secondary hierarchy.
- History / Accountability: Lead timeline and reservation timeline use quiet archive surfaces and timestamp-led read-only styling.
- Financial Truth: no broad financial ledger was added because confirmed financial records are not directly available in the lead context. Expected deposit remains operational deposit readiness, not financial truth.

## Mobile List-To-Drill-In Design

At mobile widths, the page is structured as:

1. Page header
2. Add Lead action when permitted
3. Pipeline strip
4. Buyer queue with search/filters and lead cards
5. Full selected lead drill-in after tapping a lead

The mobile detail includes a Back to Leads action and stacks:

1. Selected lead header
2. Next Action
3. Follow-ups
4. Site Visits
5. Reservations / Deposit Readiness
6. Buyer Insights / Smart Summary
7. Timeline
8. Existing creation forms where permitted

No new route was added; the drill-in uses local page state.

## Shared Components Extracted

No cross-page shared components were extracted. The V2 Leads components are local to `LeadsPage.tsx` because the pattern should be reviewed before being generalized:

- `PipelineStrip`
- `BuyerQueue`
- `LeadQueueCard`
- `SelectedLeadWorkbench`
- `NextActionPanel`
- `AdvisorRegion`

## Authenticated Screenshot QA

Authenticated screenshot QA is deferred because the local QA credential variables currently contain placeholder values. This implementation was validated through code/layout inspection, TypeScript, lint, and production build.

Viewports designed for:

- 390px: mobile list-to-drill-in sales flow.
- 768px: stacked tablet flow without squeezed desktop columns.
- 1280px: two-zone workspace within the existing sidebar shell.
- 1440px and 1920px: broader two-zone composition with a stronger selected buyer workbench.

## Known Limitations

- Authenticated visual QA must be completed later with approved QA credentials.
- The create/edit forms are preserved and restyled only lightly; deeper form polish should wait until the core workspace is reviewed.
- No financial ledger section is shown because confirmed financial records are not part of the current lead data context.
- Some older helper components remain in use for forms to avoid broad refactors.

## Recommendation Before Customer Command Profile

Review Leads V2 with real authenticated data and compare against the approved desktop/mobile Leads mockups. If the two-zone workspace and mobile drill-in behavior are accepted, then proceed to Customer Command Profile V2 using the same material grammar and record-header discipline.
