# Inquiry containment reconciliation

This branch carries the confirmation-email containment deployed in production function v2 into the newer inquiry handler on main and restores buyer confirmations behind Cloudflare Turnstile verification and send quotas. It retains main's tenant, project, and active-phase resolution, published-map and public-lot checks, scoped persistence RPC, and retry behavior. A deduplicated request does not send an email or add another email activity.

Confirmation text uses a neutral greeting and a plain recipient address. Before any provider request, `reserve_inquiry_confirmation_quota` atomically permits at most one attempt per normalized recipient and ten attempts per IP in a rolling 24 hours. Reservations remain consumed when the provider fails or times out. A quota failure suppresses the email without undoing the saved inquiry and follow-up. This is temporary confirmation containment; full intake rate limits and bot protection remain slice B.

The handler checks Turnstile server-side and requires its hostname to match the request origin and its action to be `public_inquiry`. It reads only the single `cf-connecting-ip` address and rejects malformed values; it never uses `x-forwarded-for`. Confirmation sends also require `PUBLIC_INQUIRY_CONFIRMATIONS_ENABLED=true`, with `SUPPRESS_OUTBOUND_EMAILS` as an independent kill switch. Keep the feature flag off until staging verifies that a forged incoming `cf-connecting-ip` is overwritten by Supabase's managed ingress and confirms the quotas against real requests.

`20261120002343_inquiry_confirmation_email_quota.sql` is the exact migration already applied in production and has been copied without changes. It uses a fixed search path and grants access only to the server role. Its production ledger identity must remain unchanged; inspect each environment's ledger and schema before any future staging or production release. Do not repair history or apply unrelated pending migrations as part of this reconciliation.

For disposable local quota verification, install `embedded-postgres@18.7.0-beta.19` outside the repository and set `WAMULE_EMBEDDED_POSTGRES_MODULE` to its `dist/index.js` path when running `node scripts/production-inquiry-quota-postgres.mjs`. This script creates and removes a temporary local database; it requires no hosted connection and is not part of the default test suite.

## Slice B implementation status

The current source branch contains the Turnstile gate and both public inquiry forms request a fresh challenge for each submission attempt. The new runtime tests cover invalid/missing challenges, one successful confirmation across retries, quota denial, and provider failure with the lead and follow-up left saved. These are local mocked tests only; the changes have not been deployed to staging or production.

Staging acceptance requires a site key at `VITE_TURNSTILE_SITE_KEY`, its matching Edge Function secret at `TURNSTILE_SECRET_KEY`, a controlled inbox, and `RESEND_API_KEY` plus sender configuration. Keep `PUBLIC_INQUIRY_CONFIRMATIONS_ENABLED` false until the ingress spoof test passes. Do not change the production quota migration or production secrets as part of this slice.

## Acceptance still required

Before a staged release, capture staging's current function version, schema and migration ledger; then test scoped submissions, active phases and published lots, rejected scope and publication cases, retry deduplication and conflicts, persistence of the lead and follow-up, and fail-closed suppression with forged IP headers. Capture the staging version and evidence. The disposable Postgres quota test uses independent connections to exercise the actual migration locally; it is not hosted acceptance. Production promotion remains a separate decision with an explicit production baseline and verification plan. Slice B remains incomplete until its hosted checks pass.
