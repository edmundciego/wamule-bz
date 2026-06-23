# Phase 4D: AI Summaries Planning / Readiness Audit

This is a planning document only. It does not implement AI summaries, migrations, schema changes, Edge Functions, frontend features, prompt changes, AI calls, Daily Brief changes, Reports changes, or workflow changes.

Authenticated protected-route browser/mobile QA remains pending until valid admin credentials are available. This is a known limitation and should not block Phase 4D planning.

## 1. Current AI Capabilities

Wamule already has a focused advisory AI foundation.

### Application AI Review

- Edge Function: `generate-application-review`.
- Storage: `application_ai_reviews`.
- UI: Applications page.
- Gating: `ai_settings.is_enabled` and `ai_settings.application_summary_enabled`, plus server-side Gemini/Google API key.
- Permission: Super Admin/Admin generation.
- Pattern:
  - Authenticates the user.
  - Checks role.
  - Loads application and preferred lot data.
  - Builds deterministic review first.
  - Optionally calls Gemini.
  - Normalizes output to preserve manual approval boundaries.
  - Upserts advisory review by `application_id`.
- Output includes summary, completeness status, missing fields, risk flags, recommended admin actions, model, generated user, and generated timestamp.

### Customer Summary / Collections Assistant

- Edge Function: `generate-customer-summary`.
- Storage: `customer_ai_summaries`.
- UI: Customer Detail `Smart Summary` section.
- Gating: `ai_settings.is_enabled` and `ai_settings.collections_assistant_enabled`, plus server-side provider key.
- Permission: Super Admin/Admin/Staff generation.
- Pattern:
  - Authenticates the user.
  - Checks role.
  - Loads customer, application, contracts, transactions, payment documents, payment requests, payment methods, and fee types.
  - Builds deterministic account summary first.
  - Optionally calls Gemini.
  - Saves advisory summary by `customer_id`.
- Output includes summary, account status, balance summary, payment summary, collections flags, missing items, recommended actions, draft follow-up message, model, generated user, and generated timestamp.

### Daily Brief AI / Fallback Behavior

- Edge Function: `generate-daily-brief`.
- Storage: `ai_daily_briefs` and existing carryover `brief_action_items`.
- UI: Daily Briefs page.
- Gating: `ai_settings.is_enabled`, `ai_settings.daily_brief_enabled`, provider `Gemini`, and server-side provider key.
- Permission: Super Admin/Admin generation.
- Pattern:
  - Authenticates the user.
  - Checks role.
  - Loads operational CRM data.
  - Builds deterministic brief first.
  - Optionally calls Gemini.
  - Sanitizes AI output and merges deterministic Daily Operations sections back if omitted.
  - Saves generated brief.
  - Preserves existing carryover action item sync.

### AI Settings / Provider Gating

- Storage: `ai_settings`.
- UI: Settings page.
- Provider currently constrained to Gemini.
- Super Admin manages provider settings.
- Internal users can read AI settings.
- API keys remain server-side in Supabase secrets, not browser code.
- Settings include:
  - Global AI enabled flag.
  - Daily Brief toggle.
  - Application Summary toggle.
  - Collections Assistant toggle.
  - Provider/model metadata.
  - Provider health check.

### Generated Summary Storage Patterns

- Application summaries are stored one row per application via `application_ai_reviews`.
- Customer summaries are stored one row per customer via `customer_ai_summaries`.
- Daily briefs are stored historically via `ai_daily_briefs`.
- Daily Brief recommended actions also sync to `brief_action_items`.
- Existing summary tables use RLS, generated metadata, model metadata, JSON array constraints, and comments that reinforce advisory/read-only behavior.

### Deterministic Fallback Patterns

Existing AI functions all build deterministic output before any provider call. If AI is disabled, missing a key, fails, or returns unusable output, Wamule still produces a structured deterministic result. This pattern should be mandatory for Phase 4D.

## 2. What Rule-Based Insights Already Cover

Phase 4A, 4B, and 4C already cover most operational decision support without AI.

- Overdue follow-ups.
- Missing next actions.
- Unassigned leads.
- Closed/won and lost/inactive lead suppression.
- Reservation expiry and expired active reservations.
- Deposit pending, overdue, proof submitted, confirmed, and ready-next-step states.
- Missing buyer/application information.
- Unavailable selected lots.
- Approved applications without post-sales checklists.
- Active contract signed-upload gaps.
- Missing payment proof and receipt flags.
- Overdue expected/requested payments.
- Post-sales document, agreement, payment setup, checklist, and task blockers.
- Collections handoff readiness.
- Dashboard Operations Insights.
- Expanded Daily Brief deterministic operational sections.
- Daily Brief recommended priorities.
- Reports counts, filters, tables, and CSV exports for sales, follow-ups, site visits, reservations, deposits, applications, post-sales, workload, demand, payments, balances, and missing items.

These rules already answer "what needs attention." Phase 4D should focus only where staff benefit from narrative synthesis across many notes, activities, linked records, and timeline events.

## 3. Where AI Adds Real Value

### 1. Lead Smart Summary

- Purpose: Summarize a buyer's current journey, recent activity, blockers, readiness, and staff review notes.
- Source data needed: `leads`, `lead_activities`, `follow_up_tasks`, `site_visits`, `lot_reservations`, linked `applications`, linked `customers`, `parcels`, `admin_profiles`.
- Why rules are not enough: Rules flag overdue/missing items but do not synthesize a long buyer timeline, repeated objections, family decision context, or conversation history into a concise staff handoff.
- Expected output: Short buyer summary, readiness status, key risks, missing information, recent timeline highlights, recommended staff review notes, next best manual action, confidence notes.
- Risk level: Medium. Buyer/contact data is sent to provider; AI could overstate readiness or invent intent if not tightly grounded.
- Recommendation: MVP candidate.

### 2. Reservation Readiness Summary

- Purpose: Summarize reservation/deposit state, expiry risk, proof review context, and linked buyer/application readiness.
- Source data needed: `lot_reservations`, `reservation_activities`, linked `leads`, `applications`, `customers`, `parcels`, optional linked transaction metadata.
- Why rules are not enough: Rules already cover most reservation status flags. AI adds value only if reservation activities/notes become long.
- Expected output: Reservation status narrative, expiry/deposit context, missing information, staff review notes.
- Risk level: Medium-high. AI must not imply a deposit is confirmed, payment is reconciled, or a hold should be released.
- Recommendation: Later, not MVP.

### 3. Post-Sales Checklist Summary

- Purpose: Summarize checklist readiness, open/overdue tasks, blockers, documents, agreement status, payment setup, and collections handoff.
- Source data needed: `post_sales_checklists`, `post_sales_tasks`, `post_sales_activities`, linked `customers`, `applications`, `contracts`, `leads`, `lot_reservations`, `admin_profiles`.
- Why rules are not enough: Rules identify blockers, but AI can summarize several checklist dimensions and activity notes into a staff handoff for operations.
- Expected output: Operations summary, blocker summary, missing information, readiness review, recommended staff review notes, next best manual action, confidence notes.
- Risk level: Medium. Must not update checklist status, approve documents, send agreements, or hand off automatically.
- Recommendation: MVP candidate, possibly second after Lead Smart Summary.

### 4. Customer Operations Summary

- Purpose: Provide a combined customer lifecycle summary across sales, reservation, contract, payment, documents, post-sales, and collections.
- Source data needed: Existing Customer Summary sources plus related leads, reservations, site visits, post-sales checklists/tasks/activities.
- Why rules are not enough: Customer history can span many records. A lifecycle narrative could help staff understand context faster.
- Expected output: Customer operations summary, account context, post-sales readiness, collections status, risk flags, recommended staff review notes.
- Risk level: Medium-high because Customer Summary already covers collections. Expanding too soon could duplicate or confuse existing account summary behavior.
- Recommendation: Later. Extend existing Customer Summary only after Lead/Post-Sales MVPs prove useful.

### 5. Daily Operations Narrative

- Purpose: Turn deterministic Daily Brief sections into a short management narrative.
- Source data needed: Existing generated Daily Brief fields and deterministic expanded sections.
- Why rules are not enough: The existing brief already has counts and priorities. AI can add a concise "what changed / where to focus" narrative but may duplicate current summary.
- Expected output: Operations narrative, top themes, staff focus areas, confidence notes.
- Risk level: Low-medium if it only summarizes already-generated brief data.
- Recommendation: Later or small add-on after MVP. The current Daily Brief already has optional AI behavior and deterministic fallback.

### 6. Reports Executive Summary

- Purpose: Interpret report counts for management.
- Source data needed: Filtered report aggregates from Reports page or server-side equivalent.
- Why rules are not enough: Management may want trend interpretation, but current reports are single-period operational tables without trend baselines.
- Expected output: Executive summary, notable changes, risk areas, follow-up questions.
- Risk level: Medium. Risk of unsupported trend claims without historical baselines.
- Recommendation: Reject for MVP. Revisit after report usage, trend data, and stable time-series needs are clear.

## 4. Recommended Phase 4D MVP

The recommended MVP is:

1. Lead Smart Summary.
2. Post-Sales Checklist Summary only if capacity allows, otherwise defer to Phase 4D-2.

The smallest safe first build is `Lead Smart Summary` only.

MVP requirements:

- Use existing AI settings/provider gating.
- Use deterministic fallback when AI is disabled, provider key is missing, provider fails, or output is invalid.
- Be staff-triggered from the Lead workspace.
- Clearly label output as AI-generated or deterministic fallback.
- Store generated summary separately from operational lead records.
- Never mutate leads, reservations, follow-ups, site visits, applications, customers, payments, contracts, documents, or post-sales records.
- Never approve, confirm, convert, release, complete, create tasks, or send messages.
- Use calm language: `Smart Summary`, `Buyer Insights`, `Readiness Review`, `Recommended Actions`, `Risk Flags`, `Missing Information`, `Staff Review Notes`.

Post-Sales Checklist Summary is a strong second candidate because it summarizes multi-part operational readiness without touching payment/contract calculations.

Daily Operations Narrative should not be first because Daily Brief already has optional AI and expanded deterministic sections.

Reports Executive Summary should wait until report users confirm what management interpretation is needed.

## 5. Proposed Edge Function Strategy

### Option A: Add One New Focused Edge Function

Proposed name: `generate-lead-summary`.

Pros:

- Matches existing `generate-application-review` and `generate-customer-summary` patterns.
- Keeps lead-specific prompts, permissions, data loading, deterministic fallback, and storage isolated.
- Avoids expanding Daily Brief or Customer Summary responsibilities.
- Easier to test and audit.

Cons:

- Requires one new Edge Function.
- Likely requires a storage migration if summaries are persisted.
- Requires a new AI settings toggle if product wants independent enable/disable control.

Recommendation: Best option for Phase 4D-1, if implementation is approved later.

### Option B: Extend Existing Customer Summary

Pros:

- Reuses existing storage, UI section, and collections AI toggle.
- Good fit for customer lifecycle summaries after a lead converts.

Cons:

- Poor fit for pre-customer leads.
- Could blur collections assistant scope with sales guidance.
- Does not solve lead handoff summaries.

Recommendation: Later, not MVP.

### Option C: Extend Existing Daily Brief

Pros:

- Existing Daily Brief already has AI/fallback behavior and expanded operations sections.
- No new UI surface needed for daily operations narrative.

Cons:

- Daily Brief is period-level, not record-level.
- Existing Phase 4B already covers operational priorities.
- Additional narrative could duplicate current summaries.

Recommendation: Later, only if staff request a management narrative.

### Option D: Avoid Backend AI For Now

Pros:

- No new migrations, functions, or privacy exposure.
- Keeps Phase 4 deterministic.

Cons:

- Does not address long buyer/post-sales timeline synthesis.
- Leaves Phase 4D value unrealized.

Recommendation: Reasonable if credentials/QA or privacy approval is not ready. Otherwise use Option A.

## 6. Proposed Data Storage Strategy

### Option A: Generated Live And Not Stored

Pros:

- No migration.
- Always uses current data.
- Lower long-term data retention risk.

Cons:

- Repeated AI calls cost more and are slower.
- No audit trail of what staff saw.
- Cannot show last generated date/model.
- Harder to compare stale vs current summaries.

Data freshness: Always fresh at generation time.

Permission/RLS: Mostly handled by function auth, but no persistent read policy exists.

Migration required: No.

Recommendation: Useful only for prototypes, not ideal for production.

### Option B: Store In Existing Related Tables If Fields Already Exist

Pros:

- Avoids new tables if a safe summary field already exists.

Cons:

- Lead, reservation, and post-sales operational tables do not currently have dedicated AI summary fields.
- Mixing AI text into operational records increases risk of accidental workflow coupling.
- Harder to maintain clear advisory/read-only boundaries.

Data freshness: Requires generated metadata fields or staff may not know staleness.

Permission/RLS: Would inherit operational table permissions, which may not match AI summary generation rules.

Migration required: Likely yes if fields are absent.

Recommendation: Not recommended.

### Option C: Store In New Focused Summary Tables

Possible table names:

- `lead_ai_summaries`.
- `post_sales_ai_summaries`.

Pros:

- Matches existing `application_ai_reviews` and `customer_ai_summaries` patterns.
- Clear advisory boundary.
- Can store model, generated_by, generated_at, source record id, structured JSON arrays, status, and stale metadata.
- Easier RLS policy design.

Cons:

- Requires migration.
- Requires type updates and UI integration.
- Must define retention/freshness behavior.

Data freshness: Store source `updated_at` snapshot or generated_at; UI should warn when lead/checklist changed after summary generation.

Permission/RLS: Internal users can read if they can see the underlying record; Staff/Admin/Super Admin can generate depending on existing write access; Admin/Super Admin manage settings.

Migration required: Yes.

Recommendation: Best production approach for Phase 4D-1 if implementation proceeds.

### Option D: Store As Activity / Timeline Notes

Pros:

- Uses existing `lead_activities` or `post_sales_activities`.
- Summaries become part of timeline context.

Cons:

- Pollutes human activity history with generated content.
- Harder to distinguish AI-generated advisory output from staff-entered notes.
- Could imply a workflow action occurred.

Data freshness: Old summaries remain in timeline and may become stale.

Permission/RLS: Inherits activity permissions.

Migration required: No, but not semantically clean.

Recommendation: Not recommended for MVP.

### Option E: Store In Existing AI Review/Summary Tables

Pros:

- Reuses existing tables.

Cons:

- `application_ai_reviews` is application-specific.
- `customer_ai_summaries` is customer-specific.
- `ai_daily_briefs` is period-level.
- Reusing these tables for leads/post-sales would distort data meaning.

Migration required: No, but schema semantics would be wrong.

Recommendation: Reject.

## 7. Prompt / Output Shape Recommendations

Phase 4D outputs should be structured JSON and concise.

Recommended Lead Smart Summary shape:

- `summary`
- `readiness_status`
- `key_risks`
- `missing_information`
- `recent_activity_highlights`
- `recommended_actions`
- `next_best_action`
- `confidence_notes`
- `source_record_updated_at`
- `model`
- `generated_by`
- `generated_at`

Recommended Post-Sales Summary shape:

- `summary`
- `readiness_status`
- `blockers`
- `missing_information`
- `document_notes`
- `agreement_notes`
- `payment_setup_notes`
- `collections_handoff_notes`
- `recommended_actions`
- `next_best_action`
- `confidence_notes`
- `source_record_updated_at`
- `model`
- `generated_by`
- `generated_at`

Prompt guidance:

- Use only supplied Wamule data.
- Do not infer facts not present in source records.
- Do not make legal, financial, payment, or approval promises.
- Do not say a deposit/payment/document is confirmed unless the source status says so.
- Keep output short enough for staff review.
- Prefer uncertainty notes over speculation.
- Include empty arrays when no risks/missing items exist.
- Return valid JSON only.
- Deterministic fallback must be available and sanitized into the same shape.

## 8. UI Placement Recommendations

### Lead Detail / Leads Workspace

- MVP: Yes.
- Generate button: Yes, Staff/Admin/Super Admin if allowed by final RLS/function policy.
- Last generated date/model: Yes.
- Copy: Yes, copy summary and staff review notes only.
- Fallback text if AI disabled: Yes. Show deterministic Buyer Insights and a note that AI summaries are disabled.

### Customer Detail

- MVP: Already has Customer Smart Summary / Collections Assistant.
- Generate button: Existing.
- Last generated date/model: Existing pattern should remain.
- Copy: Existing draft follow-up copy exists; future operations summary copy can be later.
- Fallback text: Existing deterministic fallback pattern.
- Recommendation: Later extension only, not Phase 4D-1.

### Post-Sales Tab

- MVP: Later or second MVP candidate.
- Generate button: Yes, but only for Staff/Admin/Super Admin.
- Last generated date/model: Yes.
- Copy: Yes, copy operations summary/staff notes.
- Fallback text: Show deterministic Recommended Actions from Phase 4A if AI disabled.

### Daily Briefs Page

- MVP: No.
- Generate button: Existing Daily Brief generation only.
- Last generated date/model: Existing.
- Copy: Existing.
- Fallback text: Existing deterministic Daily Brief behavior.
- Recommendation: Add Daily Operations Narrative later only if requested.

### Reports Page

- MVP: No.
- Generate button: No for Phase 4D-1.
- Last generated date/model: Not needed yet.
- Copy: Not needed yet.
- Fallback text: Not needed because reports are deterministic.
- Recommendation: Defer Reports Executive Summary.

### Dashboard

- MVP: No.
- Generate button: No.
- Last generated date/model: No.
- Copy: No.
- Fallback text: Continue showing deterministic Operations Insights.

### Applications Page

- MVP: Existing Application AI Review is sufficient.
- Generate button: Existing.
- Last generated date/model: Existing review pattern.
- Copy: Not required.
- Fallback text: Existing deterministic review/fallback behavior.

## 9. Safety / Guardrails

AI must not:

- Approve applications.
- Confirm deposits.
- Modify payments.
- Modify contracts.
- Modify collections.
- Mark documents approved.
- Change post-sales status.
- Create customers.
- Create tasks automatically.
- Create, release, expire, or convert reservations.
- Create or update leads except for storing generated advisory summary records in a dedicated summary table.
- Send emails or WhatsApp messages.
- Create notifications.
- Make legal or financial promises.
- Hide uncertainty.
- Invent facts not present in Wamule data.
- Override deterministic risk flags.
- Present draft messages as sent communications.

Staff remain responsible for decisions, status changes, communication, approval, confirmation, collection, and document review.

## 10. Permissions / Privacy

Access expectations:

- Anonymous/public: no AI summary access.
- Internal/read-only: may read existing summaries only where the underlying record is already visible.
- Staff/Admin/Super Admin: may generate summaries when existing write/operational permissions allow.
- Admin/Super Admin: may generate more sensitive summaries if a workflow is management-only.
- Super Admin: manages provider settings.

Privacy considerations:

- Buyer/customer names, contact details, notes, lead activity, payment context, and operational history may be sent to the AI provider.
- Provider keys must remain server-side.
- Prompts should include only necessary fields.
- Avoid sending full payment document paths or storage URLs unless explicitly needed.
- UI should clearly label generated text as advisory.
- Future implementation should confirm whether Wamule has consent/privacy terms covering AI processing of buyer/customer data.

## 11. Failure And Fallback Behavior

When AI provider is disabled:

- Do not call provider.
- Return deterministic fallback summary.
- UI should state summaries are generated from rules only or AI is disabled.

When API key is missing:

- Do not call provider.
- Return deterministic fallback.
- Function response should indicate fallback.

When provider health check fails:

- Generation should still use deterministic fallback if possible.
- Settings page health check should remain advisory.

When AI call times out:

- Return deterministic fallback.
- Avoid leaving UI in loading state.

When AI returns invalid JSON:

- Discard AI response.
- Return deterministic fallback or sanitized deterministic baseline.

When source data is incomplete:

- Summary should explicitly list missing information.
- Confidence notes should mention limited source data.

When summary is stale:

- UI should compare summary `generated_at` or source `updated_at` snapshot to current source data.
- Show "Source data changed since this summary was generated" if applicable.

When user lacks permission:

- Function returns 403.
- UI hides or disables generate button and may still show existing summaries if readable.

## 12. Phase 4D Implementation Options

### Phase 4D-1: Lead Smart Summary

- Purpose: Smallest targeted AI summary for sales team.
- Files likely touched:
  - `src/pages/LeadsPage.tsx`
  - `src/types/database.ts`
  - new Edge Function `supabase/functions/generate-lead-summary/index.ts`
  - new migration for `lead_ai_summaries`
  - possible docs update
- Edge Function needs: Yes, recommended.
- Schema needs: Yes, recommended `lead_ai_summaries`.
- UI needs: Smart Summary panel on selected lead detail; generate button; last generated date/model; fallback/disabled state; copy summary.
- Risks: Privacy exposure for buyer notes/contact data; AI overstatement of buyer readiness; summary staleness; permissions design.

### Phase 4D-2: Post-Sales Summary

- Purpose: Checklist/task readiness summary for operations handoff.
- Files likely touched:
  - `src/pages/CustomerDetailPage.tsx`
  - `src/types/database.ts`
  - new Edge Function `generate-post-sales-summary`
  - migration for `post_sales_ai_summaries`
  - docs update
- Edge Function needs: Yes, recommended.
- Schema needs: Yes, recommended if persisted.
- UI needs: Post-Sales tab summary panel; generate button; last generated date/model; copy summary.
- Risks: AI might imply document approval, agreement send status, payment setup completion, or collections handoff without staff action.

### Phase 4D-3: Daily Operations Narrative

- Purpose: Narrative summary using expanded Daily Brief data.
- Files likely touched:
  - `supabase/functions/generate-daily-brief/index.ts`
  - `src/pages/DailyBriefsPage.tsx`
  - `src/types/database.ts` only if schema changes are required
  - docs update
- Edge Function needs: No new function; extend existing only if approved.
- Schema needs: Possibly none if using existing `summary`, but a new field would require migration.
- UI needs: Possibly label existing summary more clearly as narrative; no new generate workflow.
- Risks: Duplicates existing Daily Brief summary; may add little value after Phase 4B.

### Phase 4D-4: Reports Executive Summary

- Purpose: Management-level report interpretation.
- Files likely touched:
  - `src/pages/ReportsPage.tsx`
  - possible new Edge Function `generate-operations-summary`
  - possible summary table or generated-live flow
  - docs update
- Edge Function needs: Maybe, if using backend AI.
- Schema needs: Maybe, depending on whether summaries are stored.
- UI needs: Generate summary button on Reports; selected filter context; last generated model/date if stored.
- Risks: Unsupported trend claims, noisy summaries, high context size, unclear management requirements.
- Recommendation: Defer until report users validate what they need.

## 13. Recommended Next Implementation Prompt

Use this prompt when Phase 4D implementation is approved:

```text
You are working in the Wamule codebase.

Implement Phase 4D-1: Lead Smart Summary only.

Do not implement Post-Sales Summary, Daily Operations Narrative, or Reports Executive Summary yet.
Do not change payments, contracts, collections, applications, customers, reservations, documents, auth, roles, or permissions.
Do not send messages, create tasks automatically, approve applications, confirm deposits, or mutate operational lead/reservation/post-sales records.

Use the existing AI implementation pattern:
- Existing `ai_settings` provider gating.
- Deterministic fallback first.
- Optional Gemini call only when enabled and server-side key exists.
- Staff-controlled generate action.
- Stored advisory output separate from operational records.
- Clear AI-generated/fallback labeling.

Recommended implementation:
- Add a focused `generate-lead-summary` Edge Function.
- Add a dedicated `lead_ai_summaries` table only if schema migration is approved.
- Add a Lead Smart Summary panel in the selected lead detail area.
- Use source data from `leads`, `lead_activities`, `follow_up_tasks`, `site_visits`, `lot_reservations`, linked `applications`, linked `customers`, `parcels`, and `admin_profiles`.
- Output structured JSON with `summary`, `readiness_status`, `key_risks`, `missing_information`, `recent_activity_highlights`, `recommended_actions`, `next_best_action`, `confidence_notes`, `model`, `generated_by`, and `generated_at`.

Run typecheck, lint, build, and document guardrails.
```
