# Wamule Workflow Map

## Core Workflows

1. **Public Intake**
   - Public user submits `/apply`.
   - System creates an `applications` record.

2. **Admin Review**
   - Internal user views `/applications`.
   - Admin reviews applicant information, preferred lots, acknowledgements, and status.
   - Super Admin/Admin can generate a read-only AI Application Review.

3. **AI Application Review**
   - `/applications` invokes `generate-application-review`.
   - Edge Function reads the application, preferred lots, related lot availability, and `ai_settings`.
   - Gemini is used only when AI is enabled, application review is enabled, provider settings allow it, and a server-side key exists.
   - Deterministic fallback produces review output when Gemini cannot be used.
   - Output is stored in `application_ai_reviews`: summary, completeness status, missing fields, risk flags, recommended admin actions, model, generated_by.
   - Review content is guidance only and does not approve, decline, reserve, or update operational records.

4. **Approval and Customer Creation**
   - Admin selects an available lot and approves manually.
   - Database approval logic creates/links customer records and reserves the lot.
   - Declines and approvals remain human/admin actions, not AI actions.

5. **Contract Creation**
   - Admin creates `contracts` for customers and lots.
   - Contract records track final purchase price, initial deposit, term, monthly payment, start date, due day, active status, and signed contract upload path.

6. **Payment Logging**
   - Admin logs `transactions`.
   - Payments can include manual receipt number metadata, bank reference, receipt notes, and uploaded proof through `payment_documents`.
   - Duplicate/missing bank references, missing receipt numbers, and missing proof are surfaced in reports, collections, and Daily Briefs.

7. **Receipt Processing**
   - `generate-receipts` handles receipt document generation.
   - Generated receipt metadata is associated back to payment/transaction records according to the current receipt implementation.

8. **Collections**
   - `/collections` reads active contracts, transactions, payment documents, and payment requests.
   - It identifies customers due today, due this week, overdue accounts, outstanding land balance, missing signed contracts, missing receipt numbers, and missing transfer proof.

9. **Reports and Exports**
   - `/reports` reads payments, balances, applications, lots, and missing item queues.
   - CSV export is client-side from the displayed report rows.

10. **Settings and Role Management**
   - `/settings` controls Company Profile, Payment Methods, Installment Plans, Lot Sizes, Fee Types, AI Settings, and Users & Roles.
   - Super Admin can manage users and high-trust configuration.
   - Admin/Staff/Read Only boundaries are enforced through UI gating, Edge Function role checks, and RLS.

11. **AI Daily Brief**
   - Super Admin/Admin opens `/briefs` and generates today or custom-period brief.
   - `generate-daily-brief` reads applications, lots, payments, contracts, collections, payment requests, and AI settings.
   - Function generates structured sections for Applications, Lots, Payments, Contracts, Collections, Alerts, and Recommended Actions.
   - Gemini can generate the final structured JSON when enabled and healthy enough.
   - Deterministic fallback inserts a complete brief when AI is disabled or unavailable.
   - Output is stored in `ai_daily_briefs`.
   - Recommended actions are converted into `brief_action_items` using stable `source_key` values when possible.
   - Repeated open actions update `last_seen_on` instead of creating duplicate carryover work.
   - Page displays latest brief, comparison to previous brief, open carryover action items, previous briefs, alerts, recommended actions checklist, copy brief, and a disabled Email Brief placeholder.

12. **AI Customer Account Summary / Collections Assistant**
   - Internal user opens `/customers/:id` and selects AI Summary.
   - Super Admin/Admin/Staff can generate or regenerate when existing operational write rules allow; Read Only can view only.
   - `generate-customer-summary` reads customer, originating application, parcel/lot, contract, payments, payment documents, payment requests, payment methods, fee types, and AI settings.
   - Function calculates account status, balance summary, payment summary, collections flags, missing items, recommended actions, and draft follow-up message.
   - Gemini can produce structured JSON when AI is enabled, Collections Assistant is enabled, provider is Gemini, and the server-side key exists.
   - Deterministic fallback produces a usable summary when Gemini is disabled, unavailable, or invalid.
   - Output is upserted into `customer_ai_summaries`.
   - Customer AI Summary tab displays account status badge, summary, balance/payment summaries, collections flags, missing items, recommended actions, draft follow-up message, model, generated date, generated_by, and Copy Follow-Up Message.

13. **Daily Brief Action Center**
   - `/briefs` compares the selected brief with the previous brief.
   - UI shows new alerts, repeated alerts, resolved/no-longer-appearing alerts, outstanding balance change, payment total change, and lot count change where values are detectable.
   - Open `brief_action_items` are grouped by missing receipt numbers, missing transfer proof, missing signed contracts, lot conflicts, overdue accounts, and other items.
   - Super Admin/Admin users can manually mark items Done or Dismissed.
   - Action Center updates only `brief_action_items`; it does not update payments, contracts, applications, lots, customer balances, or send emails.

14. **Email Center / Notification Outbox**
   - Super Admin/Admin opens `/emails`.
   - Page reads `email_notifications` and filters by Pending, Sent, Failed, and Cancelled.
   - Admin can create a Test Email from Simple Test or Customer Update starter styles, preview an email, send selected pending email, process pending emails, or retry failed email.
   - The outbox stores editable plain-text body copy. The UI preview shows that plain text.
   - `send-notification-email` validates Super Admin/Admin role, reads Resend and sender secrets server-side, reads Company Profile branding from `business_settings`, sends plain text plus branded HTML through Resend, and marks `email_notifications` Sent or Failed.
   - The branded HTML wrapper includes company name, optional logo, subject, body, and footer. Public/absolute logo URLs work directly; relative logo URLs require `PUBLIC_SITE_URL` or `SITE_URL` as an Edge Function secret.
   - No automatic cron, inbox, reply handling, campaign client, or customer-facing preferences are built.

15. **Developer Feedback**
   - Internal user clicks Send Feedback in the admin sidebar area.
   - Modal captures feedback type, priority, message, and current page URL.
   - `submit-developer-feedback` validates internal admin access and inserts `developer_feedback`.
   - If `DEVELOPER_FEEDBACK_EMAIL` or Developer Feedback `notification_settings.admin_email` is configured, the function queues an `email_notifications` row.
   - Developer feedback email is not sent automatically; Super Admin/Admin must process it from Email Center.

## AI Safety Rules

AI features may only:
- summarize records
- flag issues
- recommend actions for humans
- draft follow-up text for admin review
- insert AI review records into `application_ai_reviews`
- insert AI brief records into `ai_daily_briefs`
- insert/update customer summary records into `customer_ai_summaries`
- insert/update Daily Brief action tracking records in `brief_action_items`

AI features must not:
- approve applications
- decline applications
- reserve lots
- mark lots sold
- create customers
- create contracts
- log payments
- edit balances
- edit receipt numbers
- mark payment requests paid
- send emails automatically
- delete records

## Notification Safety Rules

Notification features may:
- create and preview `email_notifications`
- queue starter notification copy for simple test and customer update messages
- send selected or pending email notifications only after explicit Super Admin/Admin action
- render branded HTML email wrappers from Company Profile settings
- mark email notifications `Sent` or `Failed`
- store developer feedback and queue developer feedback notifications

Notification features must not:
- expose Resend API keys in frontend code
- send emails automatically from AI generation
- run cron/scheduled delivery
- handle replies or behave like a full inbox/client
- mutate operational records when sending notifications
