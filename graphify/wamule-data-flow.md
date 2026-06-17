# Wamule Data Flow

Data flows primarily between React pages and Supabase. Supabase RLS enforces role boundaries, while Edge Functions perform server-side work that requires privileged credentials or server-only secrets.

## Core Flow
1. **Frontend request:** React pages and forms call the shared Supabase client in `src/lib/supabase.ts`.
2. **Protected routing:** `ProtectedRoute` checks the active session and `admin_profiles` before admin pages render.
3. **Database access:** Supabase tables, views, RPCs, storage policies, and RLS policies control reads and writes.
4. **Edge Functions:** Privileged workflows run server-side, validate the bearer token, check `admin_profiles.role`, and then read/write allowed records.

## Public Application Flow
1. Public visitor submits `/apply`.
2. Frontend inserts a row into `applications`.
3. Admin reviews the application on `/applications`.
4. Admin approval uses `approve_application`, which creates/links customer data and reserves the selected lot according to existing database logic.

## Application AI Review Flow
1. Admin opens `/applications`.
2. Applications page loads `applications`, selected `parcels`, and existing `application_ai_reviews`.
3. Super Admin/Admin clicks Generate AI Review.
4. Frontend invokes `generate-application-review`.
5. Edge Function validates role and loads the application, preferred lots, and `ai_settings`.
6. If AI settings, Gemini provider, and server-side key are available, the function calls Gemini.
7. If Gemini is disabled, unavailable, or returns invalid output, the function uses deterministic fallback.
8. Function upserts `application_ai_reviews` with summary, completeness status, missing fields, risk flags, recommended admin actions, model, and generated_by.

Workflow: `Application -> Generate AI Review -> Edge Function -> Gemini or fallback -> application_ai_reviews -> Applications UI`.

## Daily Brief Flow
1. Admin opens `/briefs`.
2. Page reads previous `ai_daily_briefs`.
3. Super Admin/Admin generates today or a custom date range.
4. Frontend invokes `generate-daily-brief`.
5. Edge Function validates role and loads operational records:
   - `applications` with `application_ai_reviews`
   - `parcels`
   - `transactions` with customers, contracts, and `payment_documents`
   - `contracts` with customers, parcels, and transactions
   - `payment_requests`
   - `ai_settings`
6. Function summarizes applications, lots, payments, contracts, collections, alerts, and recommended actions.
7. If configured AI is available, Gemini can refine the structured JSON brief.
8. If AI is disabled or unavailable, deterministic fallback generates the brief.
9. Function inserts a new `ai_daily_briefs` row.
10. Function converts recommended actions into `brief_action_items`.
11. If an open item with the same stable `source_key` exists, `last_seen_on` and related fields are updated instead of creating a duplicate.
12. Brief and action items return to the page.

Workflow: `System records -> Daily Brief Edge Function -> Gemini or fallback -> ai_daily_briefs + brief_action_items -> Daily Brief UI`.

## Daily Brief Action Center Flow
1. `/briefs` reads `ai_daily_briefs` and `brief_action_items`.
2. The latest selected brief is compared with the previous brief.
3. UI displays new alerts, repeated alerts, resolved/no-longer-appearing alerts, payment total change, outstanding balance change, and lot count change when comparable values are available.
4. Open action items are grouped as Missing receipt numbers, Missing transfer proof, Missing signed contracts, Lot conflicts, Overdue accounts, and Other.
5. Super Admin/Admin users can manually mark action items Done or Dismissed.
6. Action Center mutations update only `brief_action_items`; payments, contracts, applications, lots, customers, balances, and emails are not changed.

Workflow: `Daily Brief recommended_actions -> stable source_key -> brief_action_items -> Open Items / Carryover -> manual Done or Dismissed`.

## Customer Account Summary Flow
1. Admin opens `/customers/:id` and selects the AI Summary tab.
2. Customer profile loads customer, originating application, contracts, parcel/lot, transactions, payment documents, payment requests, and existing `customer_ai_summaries`.
3. Super Admin/Admin/Staff users with existing operational write permission can generate or regenerate a summary. Read Only users can view only.
4. Frontend invokes `generate-customer-summary` with `customer_id`.
5. Edge Function validates internal admin access and loads approved account records using server-side credentials.
6. Function calculates account status, balance summary, payment summary, collections flags, missing items, recommended actions, and a draft follow-up message.
7. If `ai_settings.is_enabled` and `collections_assistant_enabled` are true, provider is Gemini, and the server-side key exists, Gemini can produce the structured JSON output.
8. If Gemini is disabled, unavailable, or returns invalid JSON, deterministic fallback generates the summary.
9. Function upserts `customer_ai_summaries` and returns it to the Customer AI Summary tab.

Workflow: `Customer + contract + payments + requests + documents -> Generate Customer Summary -> Edge Function -> Gemini or fallback -> customer_ai_summaries -> Customer AI Summary tab`.

## Settings and AI Feature Flags
1. Super Admin/Admin users open `/settings`.
2. Settings sections read and update configuration tables according to role boundaries.
3. `ai_settings` controls `is_enabled`, `daily_brief_enabled`, `application_summary_enabled`, `collections_assistant_enabled`, provider, model, and notes.
4. AI Edge Functions read `ai_settings` before calling Gemini.
5. Gemini credentials stay server-side in `GEMINI_API_KEY` or `GOOGLE_API_KEY`; the browser never receives the key.
6. Frontend AI actions call Edge Functions; Edge Functions use the Supabase service role only to read needed records and write approved AI tables (`application_ai_reviews`, `ai_daily_briefs`, `customer_ai_summaries`).

## Email Center / Notification Outbox Flow
1. Super Admin/Admin opens `/emails`.
2. Email Center reads `email_notifications` and groups by Pending, Sent, Failed, and Cancelled.
3. Admin can queue a Test Email, preview a selected notification, send one pending email, process pending emails, or retry a failed email.
4. Frontend invokes `send-notification-email`.
5. Edge Function validates Super Admin/Admin role and reads server-side secrets:
   - `RESEND_API_KEY`
   - `EMAIL_FROM_ADDRESS`
   - `EMAIL_FROM_NAME`
   - optional `EMAIL_REPLY_TO`
   - optional `NOTIFICATION_ADMIN_EMAIL`
6. Edge Function sends through Resend and updates only `email_notifications` status, `sent_at`, and `error_message`.
7. No Resend API key or email provider credential is exposed to frontend code.

Workflow: `Email Center -> email_notifications -> send-notification-email -> Resend -> Sent/Failed status`.

## Developer Feedback Flow
1. Internal user clicks Send Feedback in the admin layout.
2. Modal captures feedback type, priority, message, and current page URL.
3. Frontend invokes `submit-developer-feedback`.
4. Edge Function validates internal admin profile and inserts `developer_feedback`.
5. Function checks `DEVELOPER_FEEDBACK_EMAIL` first, then `notification_settings` for Developer Feedback.
6. If a recipient is configured, the function queues an `email_notifications` row with status Pending.
7. The queued email is not sent until Super Admin/Admin processes it from Email Center.

Workflow: `Admin layout feedback modal -> submit-developer-feedback -> developer_feedback -> optional email_notifications -> Email Center manual send`.

## Payment and Document Flow
1. Admin logs payments into `transactions`.
2. Manual receipt metadata is stored on `transactions`.
3. Uploaded payment proof is stored through `payment_documents` and Supabase Storage.
4. `generate-receipts` can generate receipt documents and update transaction receipt file metadata.
5. Reports, Collections, Daily Brief, and Customer AI Summary read missing receipt numbers and missing payment proof as operational follow-up items.

## Key Dependencies
- `src/lib/supabase.ts`: Centralized frontend Supabase client.
- `src/types/database.ts`: TypeScript schema definitions.
- Supabase RLS helper functions: `is_super_admin_user()`, `is_admin_user()`, `is_internal_user()`, `can_write_admin_data()`.
- Server-side Edge Function secrets: `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`, optional `EMAIL_REPLY_TO`, optional `NOTIFICATION_ADMIN_EMAIL`, optional `DEVELOPER_FEEDBACK_EMAIL`.
