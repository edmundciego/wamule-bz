# Design System V2 Dashboard

## V1 Visual Diagnosis

The V1 Dashboard was functionally useful but visually flattened too many different operational concepts into similar white cards, equal grids, small metrics, and repeated badge treatments. Follow-ups, reservations, payments, collections, post-sales work, and insights all competed with similar weight, so the page did not immediately answer: "What requires my attention today?"

## Visual References

This pass used the approved Wamule V2 desktop Dashboard concept and the BZ$ mobile Dashboard concept as visual composition targets. The mockups were used for composition, hierarchy, material distinction, spacing, responsive sequencing, and attention emphasis.

The mockup filler was intentionally not implemented as product logic. Invented navigation, invented metrics, UGX values, mockup names, mockup dates, engagement/readiness percentages, proposed-sales metrics, and new actions were ignored.

## Real Dashboard Data Sources Preserved

The Dashboard continues to use the existing data sources from `DashboardPage.tsx`:

- `parcels`
- `applications`
- `transactions`
- `customer_balance_view`
- `leads`
- `follow_up_tasks`
- `site_visits`
- `lot_reservations`
- `post_sales_tasks`
- `post_sales_checklists`

Existing summary rules were preserved for sales, reservation/deposit readiness, post-sales, recorded transaction totals, open land balances, pending applications, and community delinquency indicators.

No schema, migration, RPC, Edge Function, AI call, calculation, workflow, permission, auth, navigation, or branding changes were made.

## V2 Composition

Dashboard V2 is recomposed around a daily operations flow:

1. Restrained operational header with date orientation.
2. Dominant `Today's Attention` band using current follow-up, reservation, deposit readiness, and post-sales risk signals.
3. Supporting attention items for site visits today, pending applications, and collections alerts.
4. `Sales Movement` workflow section.
5. `Reservations / Deposit Readiness` workflow section.
6. `Smart Insights` advisor section.
7. `Collections / Financial Snapshot` ledger section.
8. `Post-Sales Work` workflow section.
9. De-emphasized supporting totals for inventory and pending applications.

Recent Activity was omitted because the current Dashboard does not have a safe existing activity feed source. No events were invented.

## Four Materials Used

- Financial Truth: `Collections / Financial Snapshot` uses a crisp white ledger surface, stronger borders, tabular numbers, and compact factual copy.
- Workflow State: sales, reservations, deposit readiness, and post-sales use soft land-green/cream operational panels with current states and due/action context.
- Staff Guidance: `Smart Insights` uses a warm advisor surface and existing rule-based insights only.
- History / Accountability: not implemented in Dashboard V2 because no existing Dashboard-accessible activity source was available without adding data flow.

## Typography Decision

The pass preserved the current operational UI type system. No external serif font was added. Serif accent treatment is deferred until there is an approved font-loading pattern and a broader V2 type decision.

## Shared Components Created

No cross-page shared components were created. Dashboard-proven V2 pieces were kept local to `DashboardPage.tsx`:

- `AttentionBand`
- `WorkflowPanel`
- `FinancialSnapshot`
- `AdvisorPanel`
- `PostSalesWork`
- `SupportingTotals`

This avoids accidentally redesigning unrelated pages.

## Responsive Behavior

- 1440px and up: asymmetric composition with a dominant attention area, supporting attention column, workflow/advisor split, and financial/post-sales split.
- 1280px: composition remains spacious within the existing app shell and avoids cramped equal-card grids.
- 768px: sections stack in priority order while preserving material distinction.
- 390px: the Dashboard becomes a daily briefing feed: attention, supporting priorities, sales, reservations, collections, post-sales, insights, and supporting totals. Existing Wamule navigation behavior is preserved; generated mockup bottom navigation was not copied.

## Screenshot QA Findings

The local dev server rendered successfully, but protected Dashboard screenshot QA was blocked by authentication. The available browser screenshot landed on the real `/login` screen. Existing documentation confirms temporary QA credentials are passed through an approved local handoff method and are intentionally not stored in the repo.

The in-app browser backend was unavailable in this session. Playwright CLI screenshot capture worked after installing browser binaries, but it could only capture the unauthenticated login redirect without valid QA credentials.

Screenshot status:

- 390px: blocked by missing authenticated session.
- 768px: blocked by missing authenticated session.
- 1280px: blocked by missing authenticated session.
- 1440px: captured login redirect, not authenticated Dashboard.
- 1920px: blocked by missing authenticated session.

## Visual Corrections

The correction pass was done through code/layout inspection because authenticated screenshots were unavailable. The V2 implementation intentionally:

- Removes the equal KPI card grid from the primary visual hierarchy.
- Makes `Today's Attention` the strongest area.
- Separates reservation/deposit readiness from confirmed financial facts.
- Makes collections look ledger-like instead of operational.
- Keeps Smart Insights advisory and secondary.
- De-emphasizes supporting inventory totals.

## Known Limitations

- Authenticated visual QA must be repeated with valid QA credentials before client review.
- No recent activity/archive section is shown until a safe existing Dashboard activity source is selected.
- Serif display typography was deferred.
- The Dashboard V2 pieces are local to the page; shared extraction should wait until Dashboard is accepted by human review.

## Recommendation Before Leads V2

Review Dashboard V2 visually with authenticated data at the required viewports. If the attention band, workflow material, ledger material, advisor material, and mobile briefing flow are accepted, then extract only the proven primitives needed for Leads V2.
