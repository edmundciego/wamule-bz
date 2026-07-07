# Wamule Design System V2 - Frontend Completion Pass

## Scope

This pass applied the established Wamule V2 visual language across the remaining protected frontend pages without changing backend behavior, data sources, calculations, auth, roles, permissions, routes, navigation, or workflows.

## Pages Updated

- Lots
- Contracts
- Payments
- Collections
- Daily Briefs
- Reports
- Audit Trail
- Settings
- Email Center
- Customers
- Deeper V2 sections inside Applications and shared payment/contract forms

## Major Visual Changes

- Added shared V2 utility classes in `src/index.css` for page shells, V2 headers, ledger panels, workflow panels, advisor panels, archive panels, filter bars, record rows, ledger rows, archive rows, table wrappers, and tabular money values.
- Replaced generic page headers on remaining protected pages with warm V2 operational headers.
- Reduced equal white-card repetition by assigning surfaces based on information type.
- Improved table containers through consistent bordered, scroll-contained ledger/report treatments.
- Improved long-page rhythm with section panels and clearer action placement.

## Shared V2 Patterns

- `v2-page-shell`
- `v2-page-header`
- `v2-ledger-panel`
- `v2-workflow-panel`
- `v2-advisor-panel`
- `v2-archive-panel`
- `v2-filter-bar`
- `v2-record-row`
- `v2-ledger-row`
- `v2-table-wrap`
- `v2-money`

These are CSS utility patterns, not a broad component refactor.

## Page Notes

### Lots

Lots now reads as land inventory management with a V2 inventory header, operational reservation explanation, inventory metrics, and a more deliberate lot board surface. Active reservation holds are visually clearer without changing parcel status behavior.

### Contracts

Contracts now uses formal record treatment. Active contracts use ledger-like surfaces with clear price/paid/balance facts. Voided, cancelled, and archived contracts use quieter archive material. Contract creation behavior is unchanged.

### Payments

Payments now uses Financial Truth strongly: ledger panels, prominent amounts, tabular money values, precise factual rows, and workflow treatment for document upload/edit details. Payment form behavior and payment editing behavior are unchanged.

### Collections

Collections separates ledger facts from workflow queues. Outstanding balance uses ledger material, due/overdue queues use workflow material, and operations insights use advisor material. Calculations are unchanged.

### Daily Briefs

Daily Briefs now feels like an operational briefing with a V2 header, advisor treatment for generated guidance, workflow treatment for custom generation, and archive treatment for previous briefs.

### Reports

Reports now has a management-review shell, archive note, polished tabs, ledger-style report summaries, and contained ledger tables. Report data/export behavior is unchanged.

### Audit Trail

Audit Trail now strongly uses History / Accountability material: read-only archive panels, quiet filters, contained detail table, and retrospective row treatment. Audit behavior is unchanged.

### Settings

Settings now feels more organized and premium through a V2 admin header, polished tab navigation, workflow panels, refined config rows, and clearer save action separation. No settings were added.

### Email Center

Email Center now separates queue/history from preview/actions with a V2 operational header, workflow test-email panel, archive outbox table, and workflow preview panel. Sending behavior is unchanged.

### Customers

Customers received a lightweight V2 shell and ledger row treatment so the protected frontend does not drop back to V1 styling between Customers and Customer Detail.

## Deeper V1 Sections Cleaned Up

- Application linked Lead / Reservation / Post-Sales panels now use V2 record-row treatment.
- Shared PaymentForm uses ledger/workflow materials.
- Shared ContractForm uses workflow/ledger materials for upload and calculated monthly payment areas.

## Responsive Notes

- V2 pages use max-width shells to prevent excessive stretching at 1920px.
- Tables use contained horizontal overflow.
- Panels stack naturally at 390px and 768px.
- Side forms and action panels remain sticky only at large widths.
- No automated authenticated screenshot QA was performed in this pass; local human review is expected.

## Remaining Legacy-Looking Areas

- Some deep generated brief detail blocks and report-specific filter cards still use existing local card structures, but shared report/table wrappers now make them less visually inconsistent.
- Settings still has many dense configuration forms; they are visually improved, but a future dedicated settings IA pass could simplify scanning further.
- Customers list received a lightweight treatment only, not a full command-profile redesign.

## Known Limitations

- No new shared React components were extracted; CSS utility patterns were used to reduce risk.
- No public pages were changed.
- No new data sources, metrics, automations, or workflows were added.

## Recommendation

Proceed to human local visual review across the protected navigation. If the direction holds, extract stable React primitives from the repeated CSS patterns in a later focused design-system cleanup.

## Public Application V2

### V1 Visual Problem

The public land application still felt like a long V1 admin form: all sections were visible at once, the form container dominated the page, lot selection was visually dense, payment plan and payment method concepts competed, and important notices were spread across the page.

### Guided Application Composition

`src/pages/ApplicationPage.tsx` now presents a guided public application experience while preserving the same one-form submission model. The page keeps the current public header, development introduction, lot pricing/sizing/availability facts, important notice, fields, acknowledgements, validation, and submit behavior.

### Step Structure

The application is composed into five local UI steps:

1. About You
2. Land Interest
3. Preferred Lot
4. Payment Preference
5. Review & Acknowledge

Step navigation only changes local presentation state. It does not create drafts, autosave records, create reservations, create payments, or alter submission behavior. If final validation finds an earlier missing field, the interface returns to the relevant step so the error is visible.

The step indicator was refined for readability: active, completed, and future steps now use clearer typography, stronger alignment, and safe horizontal scrolling on mobile.

### Lot Selection Treatment

Available lots are now shown as larger selectable land-interest cards with lot identifier, dimensions, price where public settings allow it, availability state, and a clear selected treatment. The actual Preferred Lot selection step intentionally renders the complete eligible/selectable lot inventory returned by the existing public lot availability query; it does not truncate, paginate, or hide eligible lots behind a secondary interaction.

The top-of-page development intro remains a compact preview only. That preview is limited to four lots for composition and includes a quiet clarification that buyers will see the complete available lot list when choosing a preferred lot. It is not the lot selection surface.

Preferred lot selection remains primary. The alternative lot field is visually secondary and explicitly framed as an option if the first preference is unavailable.

### Payment Plan vs Payment Method

Payment plan selection remains the submitted `payment_option` field and uses the current installment plan data/calculations. Payment methods are displayed separately as reference information only. The UI explicitly states that the application does not create a payment record.

### Review Step

The final step groups the entered application into Applicant, Land Interest, Lot Preference, Payment Preference, and Additional Notes. Each review group has a local Edit action that returns to the corresponding step. Existing acknowledgement/legal wording and required acknowledgement controls are preserved.

### Application Summary and Notice

The desktop Application Summary rail now behaves as a step-aware live companion. It shows the current step and progressively adds entered or selected application choices such as applicant name, intended use, parcel count, preferred lot, alternative lot, and payment plan. The previous duplicate long disclaimer block was removed from the summary rail and replaced with a concise clarification: submitting an application does not reserve a lot or guarantee approval.

The Important Notice remains visible on the public page, but its presentation is now calmer and more compact. The full existing notice meaning is preserved, with owner/developer and location metadata treated as quieter supporting context. Required final acknowledgements remain unchanged.

The redundant hero-level `Read important notice` button was removed because the `Before you apply` notice now appears directly below the hero. The existing public notice anchor/navigation behavior remains otherwise unchanged.

### Responsive Behavior

At 390px the page behaves as a guided mobile form: compact header, development context, notice, horizontal step navigation, current step only, and Back/Continue or final submit actions. The desktop summary rail is hidden on mobile so the form does not become a compressed desktop layout.

At 768px the form uses single-column step content with readable controls and horizontal step navigation. At 1280px, 1440px, and 1920px the application uses a deliberate max-width composition with a main step workspace and a desktop-only application summary rail.

### Visual QA

Public screenshots were captured locally without authentication at 390px, 768px, 1280px, 1440px, and 1920px. The visual pass checked hero composition, step navigation, application form hierarchy, mobile behavior, and desktop proportions. A correction was made after QA to hide the summary rail below desktop widths.

### Behavior Confirmation

No backend behavior changed. The pass did not change schema, migrations, RPCs, Edge Functions, application fields, required fields, lot availability logic, installment calculations, payment methods, acknowledgement meaning, submission behavior, or approval behavior.

### Remaining Limitations

The public page still depends on the current public settings and available lot data quality. If no lots are publicly available, the design correctly shows the existing empty/availability state but does not add new marketing content or imagery.

## Request Project Information

The public buyer funnel now supports a soft inquiry path for visitors who have questions before submitting a formal land application. The public page has two entry points: a composed `Request project information` panel below the development/lot preview and a quieter prompt inside the Payment Preference step for buyers who still have questions before applying.

The inquiry form collects only the approved fields: name and email are required, phone / WhatsApp is optional, interests can include Available lots, Lot pricing, Payment options, Site visit, Buying process, and A specific lot, and an optional additional message can be provided. If `A specific lot` is selected, the form uses the existing public eligible lot data as inquiry context only. It does not reserve, hold, or change lot availability.

Submissions use the focused `submit-public-inquiry` Edge Function rather than anonymous direct inserts into CRM tables. The function validates and trims public input, rejects invalid interests, validates any specific lot against `public_parcel_options`, creates one unassigned Lead with source `public_inquiry`, writes the inquiry context into lead notes/activity, performs lightweight review-only duplicate checks, and creates one unassigned follow-up task. It does not create applications, customers, reservations, contracts, payments, payment requests, or post-sales records.

Lead assignment intentionally remains blank. The inquiry becomes visible through existing lead and follow-up surfaces: Dashboard reads open lead/follow-up work, Daily Brief generation already includes leads and follow-up tasks, and Reports exposes lead sources dynamically. No new Dashboard or Daily Brief module was added.

The Leads workspace now gives `public_inquiry` leads a small advisor-style inquiry context panel so staff can quickly answer, `What did this buyer ask us about?` The underlying lead workflow, duplicate review behavior, assignment behavior, and follow-up behavior remain unchanged.

Email-path audit: `send-notification-email` is an internal Email Center/outbox function that requires an authenticated Admin/Super Admin token and processes `email_notifications`. It is not the right path for anonymous public buyer confirmations. The public inquiry function therefore sends the buyer confirmation directly through the existing Resend provider secrets when configured. The confirmation email thanks the buyer, confirms receipt, identifies the development/project where available, links back to the live public project/application page, and clearly states that an inquiry does not reserve a lot, guarantee availability, or imply approval. It does not include installment amounts, deposit figures, monthly payments, attachments, or approval/reservation language.

Lead capture is the primary event. The lead and follow-up task are created before email is attempted. If the provider is unavailable or the send fails, the lead remains captured, staff still get the follow-up task, and a lead activity records that the buyer confirmation email was not sent automatically. Public responses stay safe and do not expose duplicate-match details, staff details, provider secrets, or raw database errors.

Current abuse protections are intentionally lightweight for launch: server-side required-field validation, email format validation, text length limits, raw angle-bracket stripping, allowed-interest validation, specific-lot validation, safe public errors, and no broad anonymous CRM table permissions. There is no CAPTCHA or dedicated rate limiter yet.

## Final Visual Consistency Pass

### Pages Reviewed

Reviewed the implemented V2 frontend across Dashboard, Leads, Applications, Customers, Customer Detail, Lots, Contracts, Payments, Collections, Daily Briefs, Reports, Audit Trail, Settings, Email Center, and the Public Land Application.

### Legacy-Looking Areas Found

- Leads had deep follow-up, site visit, timeline-note, and lead edit/create panels that still used plain card surfaces.
- Customer Detail had lower overview, post-sales, ledger/history, document, request, statement, and smart-summary sections that visually dropped away from the Command Profile materials.
- Daily Briefs had generated brief metrics and detail sections using generic cards.
- Reports had repeated local filter cards that did not match the V2 filter-bar treatment.
- Settings had reusable configuration lists and empty states that still felt like older admin form surfaces.
- Deep timeline/activity rows used side-accent history styling instead of the quieter archive material.

### Visual Corrections Made

- Converted Leads deep forms to workflow material and timeline note creation to archive material.
- Converted Customer Detail lower sections to ledger, workflow, advisor, and archive panels according to content type.
- Converted Customer Detail payment/request rows to ledger rows and timeline/history rows to archive rows.
- Converted Daily Brief metrics, change history, comparisons, carryover work, and latest-brief surfaces to V2 materials.
- Converted Reports filters to `v2-filter-bar` and the missing-items summary to workflow material.
- Converted Settings configuration lists and empty states to V2 workflow/empty-state treatments.
- Refined shared `crm-subpanel` styling so remaining deep subpanels feel closer to V2 record surfaces.

### Responsive Corrections

No new responsive behavior or routing was added. The corrections preserve existing stacking, contained table overflow, mobile drill-in behavior, and public application responsive behavior while reducing visual inconsistency in deep sections.

### Remaining Intentional Differences

- Public application keeps its public-facing layout instead of adopting the protected CRM shell.
- Customer list remains a lightweight operational list, not a full command-profile pattern.
- Reports remain denser than workflow pages because export/review tasks require compact tables and filters.
- Settings remains form-heavy by nature, but sections now use more consistent V2 surfaces.

### Remaining Known Visual Limitations

- Authenticated screenshot QA remains dependent on valid local credentials or human review.
- Some generated AI/daily-brief content can vary in length and may still require human visual review with real production-like data.
- A future focused extraction pass could turn repeated V2 utility patterns into reusable React primitives, but that was intentionally out of scope here.
