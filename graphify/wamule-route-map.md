# Wamule Route Map

| Path | Component | Auth Required | Role Boundary | Description |
| :--- | :--- | :--- | :--- | :--- |
| `/` | `ApplicationPage` | No | Public | Public intake form. |
| `/apply` | `ApplicationPage` | No | Public | Public intake form alias. |
| `/login` | `LoginPage` | No | Public | Admin login. |
| `/logout` | `LogoutPage` | Yes | Internal admin profile | Ends admin session. |
| `/documents/:kind/:id` | `DocumentPage` | Yes | Internal admin profile + storage RLS | Protected document access. |
| `/admin` | Redirect | Yes | Internal admin profile | Redirects to `/dashboard`. |
| `/dashboard` | `DashboardPage` | Yes | Internal admin profile | Admin overview. |
| `/briefs` | `DailyBriefsPage` | Yes | Internal can view; Super Admin/Admin can generate and manage action items | AI Daily Brief page with latest brief, comparison to previous brief, open/carryover action items, alerts, recommended actions, previous briefs, copy action, and disabled email placeholder. |
| `/emails` | `EmailsPage` | Yes | Super Admin/Admin only | Email Center notification outbox with pending/sent/failed/cancelled views, preview, send selected, process pending, retry failed, and queue test email with Simple Test or Customer Update starter styles. |
| `/lots` | `LotsPage` | Yes | Internal; writes follow existing policies | Lot board and lot management. |
| `/applications` | `ApplicationsPage` | Yes | Internal; Super Admin/Admin generate AI review | Intake kanban, approval controls, and AI Application Review section. |
| `/customers` | `CustomersPage` | Yes | Internal | Customer list. |
| `/customers/:id` | `CustomerDetailPage` | Yes | Internal; Super Admin/Admin/Staff can generate AI summary; Read Only can view | Customer detail, contracts, payments, documents, requests, statement, and AI Summary tab. |
| `/contracts` | `ContractsPage` | Yes | Internal; writes follow existing policies | Contract management. |
| `/contracts/:id` | `ContractsPage` | Yes | Internal; writes follow existing policies | Contract-focused route. |
| `/payments` | `PaymentsPage` | Yes | Internal; writes follow existing policies | Payment ledger, manual receipt tracking, and payment document upload links. |
| `/collections` | `CollectionsPage` | Yes | Internal | Due accounts, overdue accounts, missing receipts, missing payment proof, and signed-contract queues. |
| `/reports` | `ReportsPage` | Yes | Internal | Reports, missing items, balances, lots, applications, payments, and CSV exports. |
| `/settings` | `SettingsPage` | Yes | Internal view; Super Admin/Admin manage config; Super Admin manages AI/user controls | Business configuration and admin controls. |

## Settings Sections
- **Company Profile:** Business identity, logo, contact, location, and public copy.
- **Payment Methods:** Cash, bank transfer, and other payment method configuration.
- **Installment Plans:** Reservation fee, initial deposit, purchase price, term, monthly payment, active/sort controls.
- **Lot Sizes:** Standardized lot size definitions and default prices.
- **Fee Types:** Garbage, road maintenance, and other fee configuration.
- **AI Settings:** Gemini provider, model, feature flags, notes, provider health check.
- **Users & Roles:** Super Admin controlled admin profile and role management.

Payment methods, installment plans, lot sizes, and fee types are configurable data records. They are no longer treated as hardcoded application constants.

## AI Admin Areas
- **Applications AI Review:** Located inside `/applications`; generate action is limited to Super Admin/Admin.
- **Daily Brief:** Located at `/briefs`; page is protected, internal roles can read through RLS, generation is limited to Super Admin/Admin.
- **Customer AI Summary:** Located inside `/customers/:id` as the AI Summary tab; internal users can view, while Super Admin/Admin/Staff can generate if existing operational write rules allow.
- **AI Settings:** Located inside `/settings`; AI configuration, feature flags, and provider health check are role-protected.
- **Users & Roles:** Located inside `/settings`; Super Admin-only user and role management area.

## Notification and Feedback Areas
- **Email Center:** Located at `/emails`; Super Admin/Admin only. Stores and previews editable plain-text `email_notifications`, then sends manually through `send-notification-email`, which applies the branded HTML wrapper and optional Company Profile logo at send time.
- **Daily Brief Action Center:** Located inside `/briefs`; shows brief-to-brief comparison and open carryover items from `brief_action_items`. Super Admin/Admin can mark items Done or Dismissed.
- **Developer Feedback:** Global Send Feedback button in `AdminLayout`; available to internal admin users. Submits through `submit-developer-feedback`, stores `developer_feedback`, and optionally queues a Developer Feedback email notification.
