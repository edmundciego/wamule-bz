# Signed reviewer-link operator run

Use this script only with the disposable PostgreSQL 17 Supabase stack and synthetic tenant. The automated five-stage workflow provisions Auth, Storage, the database, and Edge Functions; it also generates a local-only `MAP_REVIEW_LINK_SIGNING_SECRET`. No staging or production project is part of this run.

## Operator script

1. **Map:** Sign in as the synthetic Admin, import the reviewed Studio package, and confirm the background loads from the private `project-map-packages` bucket and the outline IDs match the package.
2. **Configure:** Set the intended phase to reference-only with intake closed. Confirm the other phase cannot load the map or intake.
3. **Preview and sign off:** Sign in as phase-assigned Staff, select an outline, record the snapshot and reviewed settings, then complete Admin sign-off. In **Map Review**, choose an expiry and select **Create reviewer link**. Copy the link while the one-time token is displayed.
4. **Review signed out:** Open the copied link in a fresh private browser with no Wamule session. Confirm the background and approved revision load, select an outline, and inspect the matching read-only form preview. Confirm the link cannot open another phase, Admin, or a submit control. Create a separate revocation link and one-minute expiry link. Revoke the first and verify subsequent data and asset requests fail; after one minute, verify a fresh page load with the second link fails. CI separately tests a two-second expiry.
5. **Go public:** Only after reviewer sign-off, publish the intended phase and open intake through the existing phase gate. On the disposable tenant, submit one clearly marked synthetic application and retry with the same reference. Confirm exactly one application and linked lead, the Admin workspace/phase/outline link, the other phase stays closed, and there are no outbound messages, payments, reservations, or other side effects.

Record stage time while the operator performs the steps. Use a clock or timer for hands-on activity and separately for waits. For every wait, name the system and the event being awaited, such as “Storage upload finished” or “review page loaded.” Do not infer human time from CI machine runtime. Manual SQL, DNS changes, or tenant-specific deployments fail the run.

## Blank timing sheet

Operator: ____________________  Date/time and timezone: ____________________

Application build/commit: ____________________  PostgreSQL image/tag and digest: ____________________

Migration baseline and overlays: ____________________  Cleanup result: ____________________

| Workflow stage | Hands-on minutes | Waiting minutes | Reason for each wait | Notes / pass or fail |
|---|---:|---:|---|---|
| Map import and Storage check |  |  |  |  |
| Configure reference-only phase |  |  |  |  |
| Staff preview, sign-off, and Admin link creation |  |  |  |  |
| Signed-out reviewer, expiry, and revocation checks |  |  |  |  |
| Go public and synthetic form retry |  |  |  |  |
| **Total** |  |  |  |  |

Failure evidence or blocker: ____________________________________________________________

__________________________________________________________________________________________

The shareable link is a bearer capability. Do not paste its URL or token into logs, screenshots, tickets, or the timing sheet. A later hosted rollout must configure the global Edge Function secret through its separate release authorization; this local run does not set hosted secrets or publish a frontend.
