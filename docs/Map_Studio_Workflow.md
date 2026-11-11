# Wamule Map Workflow — v1

**Version:** 1.0 (frozen)  
**Date:** 11 November 2026  
**Status:** Approved execution order; implementation and acceptance evidence are tracked separately.

This version records the agreed sequence for the pitch rehearsal, the local
tenant platform path, CI database gates, and the later reviewer walkthrough.
Do not revise this document after the v1 commit. Record execution results in
linked evidence and release checklists.

## Execution order

### 1. Pitch rehearsal — two working days

Time-box the buyer-facing map rehearsal to **11–12 November 2026**. Keep the
existing React public map and its current staging source as the baseline.

**Day 1: sharing and map clarity**

- Give the embed a project-specific browser title and useful link-preview title,
  description and image. Verify crawler-visible metadata from the edge response,
  not only the title set after React renders.
- Measure blur using the highest-resolution approved source. Hopkins' retained
  source is 5700×4800; the phone preview is currently derived at no more than
  1600 pixels. Check the map at the largest supported zoom and inspect card text
  at its rendered size. Keep text as HTML where it is already readable instead
  of relying on rasterized legend text.
- Keep the current zoom cap unless the phone and laptop checks show that users
  need more. Generate image tiles only if the existing source and preview fail
  the measured sharpness check.

**Day 2: map-to-application interaction**

- On a phone and laptop, verify outline selection, the selected-lot detail and
  **Zoom to Lot**. Confirm the selected stable outline identity survives entry
  to the application flow.
- Capture fresh phone and laptop screenshots. Record specific pass/fail results
  and any remaining blur, text, selection or navigation issue. Prior screenshots
  are historical references, not results for this rehearsal.

Reusable focused browser command:

```sh
npx playwright test e2e/demo-recovery.spec.ts --project=chromium --project=mobile
```

The reviewed Hopkins correction flow also has a 775-outline check in
`e2e/hopkins-demo-corrections-applied.spec.ts`; it requires the retained local
OCR inputs and local preview server. Synthetic fixtures are identified as
sample data and never presented as approved saleable inventory.

### 2. Local five-stage synthetic-tenant walkthrough

Build the repeatable platform path on a local Supabase stack started with
`supabase start`. Use Auth, Storage, the local API gateway and the actual Edge
Function handlers. The database image must run PostgreSQL major **17**, matching
staging's PostgreSQL 17.6.1.155 major version. No hosted credentials are used.

The walkthrough owns all its test data and runs cleanup in a `finally` path. It
must fail if cleanup cannot prove that its Auth users, sessions, tenant records,
Storage objects, packages, applications, leads and related rows are gone.

1. **Provision:** create one synthetic company, projects, phases and validated
   default phases through the supported service path; record exact IDs.
2. **Assign staff:** create a local Auth identity, assign a phase-limited Staff
   membership, sign in through local Auth, and verify that the normal workspace
   lookup exposes only the assigned phase.
3. **Prepare and publish a map:** upload a synthetic source/package to local
   Storage, import and publish through the existing project workflow, and check
   stable outline IDs.
4. **Use the public flow:** open the local public map, select an outline, submit
   one synthetic application through the Edge Function, retry with the same
   reference, and verify one application and one linked lead in the expected
   phase. No payment, reservation, or outbound email is created.
5. **Review and clean up:** verify the scoped Admin record and map link, revoke
   the local session, and remove only resources created by this run. Confirm
   baseline counts are restored.

For each stage, report **hands-on minutes** separately from **machine-wait
minutes**. Capture these from the run itself; do not estimate them from CI wall
time. The run must be repeatable and must not require manual SQL, DNS changes,
or a tenant-specific deployment. Any of those is a failed rehearsal.

### 3. CI database gates

- Replay the reconciled migration baseline in CI using an official
  `supabase/postgres` database image whose reported PostgreSQL major is 17. Pin
  the verified image tag/digest, retain the baseline reconciliation manifest,
  and fail on migration errors or unexpected schema drift.
- Run the schema-versus-query contract check against that replayed catalog.
- Separately run the same check read-only against the target environment's live
  catalog. Use a dedicated read-only catalog credential in CI; never pass a
  service-role or write credential. If that credential is unavailable, report
  the target-catalog gate as unverified and block release acceptance.
- Report dynamic queries and unresolved scanner findings explicitly. Do not
  turn unresolved findings into passes by suppressing them.

The replay is based on the reconciled migration history, not a blind replay of
all root migration filenames. Local and hosted catalog results remain distinct.

### 4. Timed reviewer walkthrough

Run the timed walkthrough **only after a signed reviewer link exists**. That
link must resolve to the intended review surface and the reviewer must be able
to open it without a tenant-specific deployment. Use the cleaned synthetic
tenant flow from stage 2–5, measure hands-on and machine-wait minutes per stage,
and record the actual PostgreSQL/image, application build, migration baseline,
and cleanup result. A missing signed link means this stage is pending; do not
substitute a public staging URL or an unsigned local link.

## Safety and evidence rules

- Keep Wamule, Hopkins and the synthetic tenant records isolated. Stable map
  identities and prior revisions are preserved.
- Keep local simulation, local Supabase verification and hosted staging proof
  as separate evidence states. A build, mocked browser response or HTTP 200 is
  not proof of Auth, database, Storage or application behavior.
- Use no production credentials or production access in this workflow. Do not
  send email, create payment obligations, or reserve inventory.
- Local service keys are generated by the local Supabase stack, kept in the
  runner environment, redacted from logs, and never written to evidence or Git.
- Changes to staging, DNS, reviewer access, map publication and hosted intake
  remain subject to their separate approvals.

## Current implementation baseline at v1

Existing code includes the React map, map selection and Zoom-to-Lot behavior,
project map workflow, public application handlers, Hopkins source assets and
browser tests. The repository also contains a reusable embedded-PostgreSQL
tenant rehearsal, but that path uses PostgreSQL 16 and simulated Auth/Storage;
it does not satisfy the local Supabase/PostgreSQL 17 walkthrough above. CI
currently runs application checks but does not yet enforce the PostgreSQL 17
replay or the two schema-versus-query gates. These are implementation gaps, not
completed v1 acceptance claims.
