# Production inquiry confirmation containment

This branch is based on main `da45769a4037ff1e35729dd7ea210ec45c6b59d1`, but its inquiry function starts from the actual production `submit-public-inquiry` version 1, not the newer source on main. Its large diff against main is intentional: merging it into main would replace newer intake behavior and must be reconciled before merging. The production frontend baseline is `90b3c86901c346f43b6a3cbbf918685eda9c7a67` (Netlify deploy `6aa8c6f00bf61a0008fb7deb`).

Production migration ledger was inspected through `20260715055626`; relevant inquiry, quota, and rate objects and signatures were inspected before creating the standalone migration. No matching quota table or function existed. The lead, activity, and follow-up columns used by version 1 exist in production. This migration must be applied alone; do not replay pending repository migrations or repair historical records.

The connected Supabase plugin has no secret-name listing operation; the CLI name-only lookup returned 403. The presence of `RESEND_API_KEY` and `EMAIL_FROM_ADDRESS` is unknown, not evidence that sending is disabled. No secret values were inspected.

Production release: PR #7, deployed function source commit `bf98b0d` (the function file is unchanged by subsequent release-record commits), hosted migration `20261120002343`, and `submit-public-inquiry` version 2. The deployed function source was read back and matched the reviewed file byte for byte. The migration filename was aligned to the actual hosted ledger version after the plugin assigned it; no historical ledger records were repaired. Read-only verification confirmed the new signature, RLS, and role grants. One owner-authorized controlled production submission returned HTTP 200 with `emailSent: false`; read-only checks found one lead, one open follow-up, and one suppressed-email activity. Rollback target: captured version 1.

The post-release security advisor reported no policy on the new RLS-protected table; that is intentional because only the server role has table privileges and bypasses RLS. It also reported other existing security findings outside this hotfix, including security-definer views and callable security-definer functions; see the project's Supabase security advisor before treating those as remediated.

## Behavior and limits

The existing request and success response shape are preserved. A successfully saved lead and follow-up still return success if email is suppressed. The greeting is `Hello,` and the recipient is the plain normalized email address. Once a trustworthy requester IP is available, the database reserves at most one attempt per normalized recipient and ten attempts per IP in a rolling 24 hours before the provider request. A failed or timed-out provider request consumes its reservation. Quota failures suppress the email. Storage contains pseudonymous SHA-256 digests, accessible only to the server role; expired rows are removed on the next valid reservation.

The managed Edge Function gateway's anti-spoofing guarantees for client IP headers have not been established. Therefore the handler currently considers every IP unknown, saves the inquiry and suppresses every confirmation. Do not enable a header without verifying its provenance, bypass routes, and canonicalization. Full intake rate limits and bot protection belong to slice B.

## Disposable Postgres verification

The quota migration can be checked against a disposable local Postgres cluster with independent concurrent connections. Install `embedded-postgres` outside the repository, then point the test at its module entry point; no production dependency or hosted database is used. For example:

```sh
npm install --prefix /tmp/wamule-quota-test embedded-postgres@18.7.0-beta.19
WAMULE_EMBEDDED_POSTGRES_MODULE=/tmp/wamule-quota-test/node_modules/embedded-postgres/dist/index.js node test/production-inquiry-quota-postgres.mjs
```

The script creates a temporary cluster with a generated password, applies only this migration, checks role restrictions and rolling limits, exercises simultaneous connections and deletes the cluster when finished. Use a non-root account and an available localhost port. It does not prove compatibility with production schema or gateway IP provenance.

## Release and rollback

Review the exact migration and production-based function, test against an isolated Postgres instance with independent concurrent connections, and recheck the production ledger, function version, and frontend deployment immediately before release. Apply only this migration, record its actual hosted ledger version, and deploy only `submit-public-inquiry` with the existing JWT verification setting. Record the actual deployed version and code SHA. Do not deploy the frontend or unrelated functions.

After deployment, verify with one owner-specified controlled email address; record the response and verify lead and follow-up persistence without recording personal details. Current fail-closed behavior should report `emailSent: false`. Do not send a production inquiry until the owner supplies the controlled address.

The rollback target is the captured deployed version 1 source. Redeploying it restores the old unbounded, name-personalized confirmation behavior, so use it only with that consequence understood. Leave the quota table and function in place during an emergency function rollback; any later removal must be a separate reviewed forward migration. Record the actual rollback function version if used.
