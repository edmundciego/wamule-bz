# Inquiry containment reconciliation

This branch carries the confirmation-email containment deployed in production function v2 into the newer inquiry handler on main. It retains main's tenant, project, and active-phase resolution, published-map and public-lot checks, scoped persistence RPC, and retry behavior. A deduplicated request does not send an email or add another email activity.

Confirmation text uses a neutral greeting and a plain recipient address. Before any provider request, `reserve_inquiry_confirmation_quota` atomically permits at most one attempt per normalized recipient and ten attempts per IP in a rolling 24 hours. Reservations remain consumed when the provider fails or times out. A quota failure suppresses the email without undoing the saved inquiry and follow-up. This is temporary confirmation containment; full intake rate limits and bot protection remain slice B.

There is no verified anti-spoofing guarantee for requester IP headers at the managed Edge Function gateway. The handler therefore treats every IP as untrusted and suppresses all confirmation email, regardless of client-supplied headers. Do not enable IP extraction until trusted gateway provenance, bypass routes, and IP canonicalization have been established and reviewed.

`20261120002343_inquiry_confirmation_email_quota.sql` is the exact migration already applied in production and has been copied without changes. It uses a fixed search path and grants access only to the server role. Its production ledger identity must remain unchanged; inspect each environment's ledger and schema before any future staging or production release. Do not repair history or apply unrelated pending migrations as part of this reconciliation.

For disposable local quota verification, install `embedded-postgres@18.7.0-beta.19` outside the repository and set `WAMULE_EMBEDDED_POSTGRES_MODULE` to its `dist/index.js` path when running `node scripts/production-inquiry-quota-postgres.mjs`. This script creates and removes a temporary local database; it requires no hosted connection and is not part of the default test suite.

## Acceptance still required

This branch has not been deployed to staging or production. Before proposing a staged release, capture staging's current function version, schema and migration ledger; then test scoped submissions, active phases and published lots, rejected scope and publication cases, retry deduplication and conflicts, persistence of the lead and follow-up, and fail-closed suppression with forged IP headers. Capture the staging version and evidence. The disposable Postgres quota test uses independent connections to exercise the actual migration locally; it is not hosted acceptance. Production promotion remains a separate decision with an explicit production baseline and verification plan. Slices A and B remain incomplete.
