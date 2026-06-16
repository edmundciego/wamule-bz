# Wamule System Map

Wamule Development is an admin-first land development platform for public application intake, lot management, customer records, contracts, payment tracking, collections follow-up, reports, configurable business settings, and read-only AI operational guidance.

## Tech Stack
- **Framework:** React + Vite + TypeScript
- **Styling:** Tailwind CSS with local UI primitives
- **Backend/Database:** Supabase Postgres, Auth, Storage, Row Level Security, and Edge Functions
- **AI Provider:** Gemini through server-side Edge Functions only

## Primary Modules
- **Public Intake:** `/` and `/apply` expose the public land application form.
- **Admin Shell:** Auth-protected app layout with Dashboard, Daily Brief, Lots, Applications, Customers, Contracts, Payments, Collections, Reports, and Settings.
- **Configuration:** Settings tabs manage Company Profile, Payment Methods, Installment Plans, Lot Sizes, Fee Types, AI Settings, and Users & Roles. Payment methods, installment plans, lot sizes, and fee types are configurable records rather than hardcoded options.
- **AI Guidance:** Applications can receive read-only AI completeness reviews. Admins can generate read-only Daily Briefs and customer account summaries for collections preparation.
- **Reports and Collections:** Operational reporting, missing-item queues, due accounts, outstanding balances, and CSV exports.

## Roles and Boundaries
- **Super Admin:** Added to `app_role`. Can manage users, settings, AI configuration, payment methods, installment plans, lot sizes, and fee types.
- **Admin:** Can perform admin operations and generate/manage AI guidance records where policies/functions allow, but does not manage Super Admin-only user controls.
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
- **AI briefs:** `ai_daily_briefs`

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

## AI Safety Model
AI features are read-only operational guidance. They may summarize records, flag issues, recommend human actions, draft follow-up text, and insert/update AI review, daily brief, and customer summary records. They must not approve or decline applications, reserve lots, mark lots sold, create customers, create contracts, log payments, edit balances, edit receipt numbers, mark payment requests paid, send emails automatically, delete records, or otherwise mutate business records.
