# Wamule System Map

Wamule Development is an admin-first land development platform for public application intake, lot management, customer records, contracts, payment tracking, collections follow-up, reports, configurable business settings, and read-only AI operational guidance.

## Tech Stack
- **Framework:** React + Vite + TypeScript
- **Styling:** Tailwind CSS with local UI primitives
- **Backend/Database:** Supabase Postgres, Auth, Storage, Row Level Security, and Edge Functions
- **AI Provider:** Gemini through server-side Edge Functions only

## Primary Modules
- **Public Intake:** `/` and `/apply` expose the public land application form.
- **Admin Shell:** Auth-protected app layout with Dashboard, Daily Brief, Email Center, Lots, Applications, Customers, Contracts, Payments, Collections, Reports, Settings, and a sidebar Developer Feedback modal.
- **Configuration:** Settings tabs manage Company Profile, Payment Methods, Installment Plans, Lot Sizes, Fee Types, AI Settings, and Users & Roles. Payment methods, installment plans, lot sizes, and fee types are configurable records rather than hardcoded options.
- **AI Guidance:** Applications can receive read-only AI completeness reviews. Admins can generate read-only Daily Briefs and customer account summaries for collections preparation.
- **Action Center:** Daily Brief recommendations are converted into `brief_action_items` so admins can track carryover work, compare brief-to-brief changes, and manually mark items Done or Dismissed.
- **Email Center:** Admin-controlled notification outbox at `/emails` stores, previews, and manually sends `email_notifications` through Resend. It includes starter message styles for test/customer-update emails, keeps outbox body text editable, and applies a branded HTML wrapper at send time. It is not a full inbox and does not send automatically.
- **Developer Feedback:** Internal users can submit bugs, questions, feature requests, data issues, and other feedback from the admin layout. Feedback is stored and can queue a developer notification email.
- **Reports and Collections:** Operational reporting, missing-item queues, due accounts, outstanding balances, and CSV exports.

## Roles and Boundaries
- **Super Admin:** Added to `app_role`. Can manage users, settings, AI configuration, payment methods, installment plans, lot sizes, and fee types.
- **Admin:** Can perform admin operations, generate/manage AI guidance records where policies/functions allow, manage Daily Brief action items, and process Email Center notifications.
- **Staff:** Internal operational role with write access where existing `can_write_admin_data()` policies allow.
- **Read Only:** Internal view role where `is_internal_user()` policies allow reads.
- **Public users:** Can submit public applications only. They cannot access protected admin routes or AI records.
- **Super Admin-only Settings areas:** Users & Roles and high-trust AI/configuration controls are gated so lower roles cannot manage users or Super Admin-only controls.

## Core Data Entities
- **Identity and roles:** `admin_profiles`, Supabase `auth.users`, `app_role`
- **Land and intake:** `parcels`, `lot_sizes`, `applications`, `application_ai_reviews`
- **Customers and contracts:** `customers`, `contracts`
- **Payments and documents:** `transactions`, `payment_documents`, storage buckets for receipts/contracts/payment documents/application documents
- **Collections:** `payment_requests`, `customer_balance_view`, `customer_ai_summaries`
- **Configuration:** `business_settings`, `payment_methods`, `installment_plans`, `fee_types`, `ai_settings`
- **AI briefs and action tracking:** `ai_daily_briefs`, `brief_action_items`
- **Notifications and feedback:** `email_notifications`, `notification_settings`, `developer_feedback`

## AI Foundation
- **`ai_settings`:** Stores provider, model, global AI enablement, and feature flags for Application Review, Daily Brief, and Collections Assistant behavior.
- **Gemini provider:** Supported through Supabase Edge Functions only.
- **Server-side secrets:** `GEMINI_API_KEY` or `GOOGLE_API_KEY` are read only inside Edge Functions. API keys are not stored in application tables and are not exposed in frontend code.
- **Provider health:** Settings can invoke `ai-provider-health-check` to validate Gemini connectivity.
- **Feature flags and roles:** AI functions check both `ai_settings` flags and the caller's admin role before generation.

## Edge Functions
- **`generate-receipts`:** Generates payment receipt documents.
- **`manage-admin-user`:** Super Admin user/role management helper.
- **`ai-provider-health-check`:** Admin-protected Gemini provider status check from Settings.
- **`generate-application-review`:** Super Admin/Admin protected application review generator with deterministic fallback.
- **`generate-daily-brief`:** Super Admin/Admin protected daily operational brief generator with deterministic fallback.
- **`generate-customer-summary`:** Internal admin collections summary generator with Gemini or deterministic fallback, writing only to `customer_ai_summaries`.
- **`send-notification-email`:** Super Admin/Admin protected Resend sender for pending `email_notifications`. Uses server-side email secrets only, loads Company Profile branding from `business_settings`, sends both plain text and branded HTML, and can include the uploaded/public logo when the logo URL is absolute or resolvable through `PUBLIC_SITE_URL`/`SITE_URL`.
- **`submit-developer-feedback`:** Internal-user feedback submission helper. Writes `developer_feedback` and queues an `email_notifications` row if a developer recipient is configured.

## AI Safety Model
AI features are read-only operational guidance. They may summarize records, flag issues, recommend human actions, draft follow-up text, insert/update AI review, daily brief, customer summary records, and create/update Daily Brief action tracking records. They must not approve or decline applications, reserve lots, mark lots sold, create customers, create contracts, log payments, edit balances, edit receipt numbers, mark payment requests paid, send emails automatically, delete records, or otherwise mutate business records.

## Notification Safety Model
The Email Center is an outbox foundation, not an inbox or automated campaign tool. It may create, preview, send, retry, cancel, and status-track `email_notifications` through explicit Super Admin/Admin action. Resend API keys and sender configuration stay in Supabase Edge Function secrets. No frontend code receives `RESEND_API_KEY`, and no cron or automatic Daily Brief delivery is built.

## Email Branding Model
- The outbox stores editable plain-text `email_notifications.body` content.
- `EmailsPage` can queue starter styles such as Simple Test and Customer Update.
- `send-notification-email` renders the sent email with a simple HTML shell: branded header, optional Company Profile logo, subject, message body, and footer.
- Company name, logo URL, contact email, and address are read from the `company_profile` value in `business_settings`.
- Public/absolute logo URLs are used directly. Relative logo URLs require `PUBLIC_SITE_URL` or `SITE_URL` as a Supabase secret so the Edge Function can render an absolute image URL.
- The function also sends a plain-text fallback for email clients that do not render HTML.
