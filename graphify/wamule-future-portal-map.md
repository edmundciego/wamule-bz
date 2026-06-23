# Wamule Future Portal Map

Planned extensions for a dedicated customer-facing portal remain future work. Current AI features are admin-only, read-only guidance and do not create a customer assistant or public-facing recommendation system.

## Future Customer Portal Concepts
1. **Customer portal login:** Map customer records to Supabase Auth users or another identity mapping.
2. **Customer Dashboard:** Let customers view personal contract status, lot allocation, balances, due dates, and payment history.
3. **Customer payment proof upload:** Allow customers to submit payment references and upload proof, subject to admin verification.
4. **Customer document downloads:** Let customers download receipts, signed contracts, and other approved documents.
5. **Automated email/WhatsApp sending:** Future notification workflows for application, contract, payment, and collections events. The current Email Center is only an admin-controlled outbox with manual send, starter message styles, and a branded HTML wrapper.
6. **Scheduled/cron daily brief emails:** Future automatic delivery of Daily Briefs. The current Daily Brief has manual generation, action tracking, and a disabled Email Brief placeholder.
7. **Customer-facing notification preferences:** Future customer portal controls for email preferences, subscriptions, or opt-outs. Not currently built.

## Future AI Concepts Only
- **Customer-facing AI assistant:** Not built. Would require public/customer auth, strict data isolation, and scoped customer-only answers.
- **Public application assistant:** Not built. Would require public-form guardrails and no approval or reservation authority.
- **Lot recommendation engine:** Not built. Would require explicit business rules and must not reserve or allocate lots automatically.
- **Customer balance assistant:** Not built. Would require customer-scoped balance access and reconciliation safeguards.
- **Customer-facing collections assistant:** Not built. The completed Collections Assistant is admin-facing only and writes only `customer_ai_summaries`.
- **Customer-facing email assistant:** Not built. Current notification work is an admin outbox foundation, not an AI email writer or automated customer messaging tool.

## Current Boundary
The completed AI features are limited to admin Application Reviews, Daily Briefs, and Customer Account Summaries. They summarize, flag, recommend, draft follow-up text, and insert/update AI guidance records only. Daily Brief Action Center can track recommended work in `brief_action_items` but does not complete operational work automatically. Email Center can manually send queued notifications through explicit Super Admin/Admin action and applies company branding/logo to sent HTML emails, but it does not communicate automatically with customers.
