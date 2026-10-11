# Wamule Implementation Plan

**Purpose:** finish the interactive map first, connect it to the application and a stable embed URL, then complete tenant onboarding and hosting.

**Prepared for:** Edmund Ciego  
**Date:** 10 October 2026  
**Companion:** Wamule Product Roadmap  
**Reviewed baseline:** `edmundciego/wamule-bz`, `staging`, commit `3c368d22dd25695ea57c3c236d436cc94b2c91b2`  
**Status:** proposed implementation work; unchecked tasks are not claims of completed or deployed behavior.

## 1. Execution contract

- Default to local implementation and verification. The earlier working scope was local only, with no commits, pushes, deployments or hosted migration applies. Perform hosted release actions only when the current session authorizes them.
- Before editing, read the current repository instructions, inspect the working tree and compare the current code with this baseline. Preserve unrelated work; do not reset the checkout.
- Implement the next dependency-ready packet. Do not attempt the entire roadmap in one unreviewable change.
- Reuse the existing React/Vite application, Supabase backend, public map and correction workspace. Keep the editor at `/lots/correct` in the same application and login.
- Use one correction implementation under `supabase/functions/_shared/correction/`. Frontend re-export shims may reference it; do not create a second gate implementation.
- Preserve stable parcel IDs, contracts, reservations, customers, payments, price overrides and audit history during map updates.
- Do not treat `lots.json`, a local export, a passing static import check or a simulated publish as a hosted business transaction.
- If source files, reviewer decisions or hosted access are missing, finish independent local work and report the specific blocker. Do not invent measurements or mark blocked checks as passed.
- Before implementing Supabase APIs or migrations, check the current official documentation and installed CLI help. Use supported migration generation commands rather than guessing filenames or flags.

### Completion reporting

For each packet, report:

1. Behavior implemented and files changed.
2. Checks actually executed, with outcomes.
3. Database/runtime/hosted checks not executed and the reason.
4. Remaining local-only or stubbed behavior.
5. Evidence locations and the next dependency-ready packet.

Use **implemented locally**, **verified locally**, **verified on staging**, and **released** as separate states. Never collapse them into one "done" label.

## 2. Release gates and order

| Packet | Product outcome | Dependencies | Planning effort |
|---|---|---|---|
| M0 | Agreed scope, canonical lot identity, owners and environments | None | 0.5-1 day |
| M1 | Audited source, OCR benchmark, measured scale and repeatable output | M0 | 2-4 days |
| M2 | Complete reviewed links, corrections and quality gates | M1 | 2-4 days |
| M3 | Polished public map and read-only sample demo | M2 | 2-3 days |
| M4 | Shared drafts and authenticated atomic publishing | M0 schema contract; M2 gates; M3 public map | 4-7 days |
| M5 | Stable embed and correctly routed inquiry | M4; safety audit of reachable demo APIs | 1-2 days |
| M6 | Complete tenant isolation and repeatable onboarding | M4; schema and privileged-path audit | 4-7 days |
| M7 | Hosting, domains, migration rehearsal and restore | M6 | 2-4 days |
| M8 | Complete the agreed application and sales workflow | M5-M7 | 3-6 days |
| M9 | Operator pilot and release acceptance | M8 | 2-3 days |

Estimates are focused engineering days, excluding waits for reviewer input or account access. Reestimate after M1 and M4. Approximately 5-9 working weeks is a planning range, not a delivery commitment.

### Demo A: map only

- [ ] M0-M3 pass for the declared launch scope.
- [ ] Use an approved frozen public payload with a visible sample-data label.
- [ ] No business writes or unsafe business API calls are reachable through this demo path.
- [ ] The link works in a fresh browser and on a phone.

This can be sent before the complete CRM or shared editor is ready. Initial planning range: 7-12 working days.

### Demo B: connected sandbox

- [ ] M4-M5 pass.
- [ ] Shared editing, authenticated publish, outside iframe and inquiry routing are proven in a sandbox.
- [ ] Reachable functions, views and private file paths have passed the relevant isolation checks.
- [ ] Notifications use configured test recipients and synthetic customers.

Initial planning range: 12-21 elapsed engineering days. Hiding unfinished navigation does not disable an unsafe endpoint.

### Pilot C: tenant-ready hosting

- [ ] M6-M7 pass with two real JWT accounts and separate organizations.
- [ ] A second organization can be onboarded without copying the application.
- [ ] Domain resolution, private files, project switching and restore are verified.

Initial planning range: 18-32 elapsed engineering days. Complete M8-M9 before declaring the business process operationally finished.

## 3. Baseline and known gaps

Reconfirm these observations against the current checkout before changing code.

| Area | Existing implementation to reuse | Gap to close |
|---|---|---|
| Admin entry | `/lots` has an Edit link to `/lots/correct` | Confirm project context and permission flow |
| Correction workspace | Correction logic, gate UI, waivers and local export | Shared draft loading/restoration, evidence and server publishing |
| Local draft behavior | `localStorage` writes | Current path does not restore those writes on reopen |
| Public map | Routes, filters, lot interaction, zoom/pan, mobile selection and fullscreen | Complete-dataset validation, performance, project scope and real iframe proof |
| PDF pipeline | Extraction, detection, OCR helpers, validation, QA output and preview generation | Actual source audit, labels, scale and register reconciliation |
| Shared correction library | Implementation under Edge `_shared` | Actual runtime invocation; static containment is not runtime proof |
| Database hardening | Local SQL and database harnesses | Reviewed deployment track and exact-version gate binding |
| Publish endpoint | Shared verdict call and draft/stage metadata writes | Authentication, server-loaded inputs, atomic parcel/version writes and conflict detection |
| Tenant foundation | Organizations, tenant columns and basic projects | Project policies, scoped views/functions/files/secrets/settings and invitations |
| Business application | Leads, applications, contracts, customers, payments and report pages | End-to-end process and permission acceptance |

Specific observations from the reviewed baseline:

- `publish-draft` accepts client actor, tenant and existing-parcel inputs while using service-role access. Comments do not establish authorization.
- Missing authoritative stage can fall back to client-influenced draft stage; change this to fail closed.
- A revision-filtered update can return success with zero affected rows; require proof that the expected row changed.
- The local activation trigger checks a passing result for the tenant, rather than the exact map version and content.
- The correction workspace uses a default project string and loads no calibration/OCR units evidence in its authenticated path.
- Public project resolution returns `is_default` while downstream code checks `isDefault`; legacy project-null lots may disappear.
- The public endpoint's theme import still leaves the functions tree. Verify every function needed for the demo, not only `publish-draft`.
- The architecture brief describes future domain mappings and marketplace modes. Those descriptions are not proof of implementation.

The original 1.4 GB PDF was not inspected during the roadmap review. Hosted database state, deployed functions, accounts and DNS were not audited. Earlier review results were build/lint/static containment passes; 141 of 146 tests passed, two database harnesses were environment-blocked and three hosted checks were skipped. Edmund's earlier 146/146 result is separate local evidence from that environment.

## 4. Data and authorization contract

### Canonical hierarchy

`Organization -> Project -> optional Phase -> Parcel`

Map versions represent an explicitly declared project/phase scope. Detected polygons remain candidate visual features until approved and linked to canonical parcels.

- [ ] Use stable UUIDs for organizations, projects, parcels, drafts and map versions.
- [ ] Define legal lot identity using project, phase and block where the approved register requires them.
- [ ] Permit the same displayed lot number in different projects without mixing records.
- [ ] Enforce organization/project parent consistency at database level, including privileged writes.
- [ ] Scope map versions, tiers, project contacts and project-specific pricing appropriately.
- [ ] Keep public configuration separate from server-only credentials and private business data.
- [ ] Preserve original inquiry and document context even if labels or map geometry later change.
- [ ] Define and enforce suspended-organization behavior on the server.

### Authority rules

| Value | Authority |
|---|---|
| User and actor | Verified authentication/session identity |
| Staff organization/project access | Server/database membership and permission records |
| Canonical lot identity | Approved lot register linked to stable parcel ID |
| Public project selection | Validated published slug/domain resolution |
| Protected stage | Server-managed database record |
| Scale | Reviewed reference dimensions and recorded calibration |
| Gate approval | Server-written exact version/revision/content decision |
| Published map | Committed active version in the declared scope |

Browser-selected context is a request to validate, not proof of access. Website Host resolution must not authorize administrative requests; the Supabase API host is different from the website host.

## 5. M0 Scope and release contract

**Owner:** Edmund for scope and reviewer assignment; engineer for schema/environment inventory.  
**Backlog:** R01; preparation for R06-R07.

### Implement or document

- [ ] Choose Hopkins full-project or explicit-phase launch scope.
- [ ] Obtain the approved register with legal lot identifier, area/unit, tier, price source and status source.
- [ ] Name the person who can resolve register/drawing disagreements.
- [ ] Identify sellable lots, roads, creek, boulevard and other common areas.
- [ ] Approve the fields permitted in the public payload.
- [ ] Define editor, publisher, tenant administrator and platform administrator permissions.
- [ ] Inventory active migrations, archived/root SQL, manual schema setup and enabled functions.
- [ ] Choose a reproducible fresh bootstrap or an incremental upgrade strategy; protect existing Wamule business records.
- [ ] Define development, sandbox/staging and production environments.
- [ ] Assign engineering, map review and release operations responsibilities.

### Acceptance

- [ ] A release brief names project scope, register revision, reviewer, roles, public fields and demo finish line.
- [ ] The lot identity and project contract is explicit enough to implement without guessing.
- [ ] The next tasks have owners and dependencies.

**Evidence:** release brief, register manifest, migration inventory and environment matrix. Reviewer-dependent decisions may remain explicitly pending while independent engineering preparation continues.

## 6. M1 Source audit and measurement

**Owner:** engineer and assigned map reviewer.  
**Backlog:** R02-R03.  
**Inspect:** `scripts/tenant-build.mjs`, `scripts/build-interactive-map.mjs`, `scripts/ocr-match.py`, detector/scoring scripts and the map input registry.

### Source and processing

- [ ] Inspect pages, dimensions, embedded images, selectable text, vectors, layers and coordinate metadata in the actual PDF.
- [ ] Compare any usable text/vector output with the current raster path on the same map region.
- [ ] Fix the classifier to read a bounded header instead of loading the full file to inspect 16 bytes.
- [ ] Use bounded or streaming handling for checksums and other whole-source operations where appropriate.
- [ ] Record source checksum, source size, page, native dimensions, orientation, transforms, tool versions and build version.
- [ ] Define processing memory/time limits and a useful failure report.
- [ ] Preserve original source, reference image, detection output, OCR evidence, calibration, validation report and manifest.
- [ ] Keep the PDF out of the public app bundle and visitor downloads.
- [ ] Reuse the existing smaller WebP preview generation. Tune image delivery against M3 budgets before adding tiles.

### Human review and calibration

- [ ] Provide the 100 representative crop review pack with an explicit uncertain label.
- [ ] Obtain human labels and benchmark both configured OCR engines.
- [ ] Report token/character scores, ambiguous cases and performance across text/tier conditions.
- [ ] Treat the existing 95% token and 98% character defaults as benchmark candidates, not achieved scores.
- [ ] Obtain clicked endpoints for known reference distances from an approved drawing/survey.
- [ ] Do not infer scale from OCR area medians or an assumed typical road width.
- [ ] Use multiple distributed references, including different orientations where possible, and held-out scale checks.
- [ ] Convert percentage coordinates through native width/height before measuring distances and area.
- [ ] Record actual dimension, unit, source, reviewer, timestamp and uncertainty.
- [ ] Resolve inconsistent scale or unsupported distorted regions explicitly.
- [ ] Unify the pipeline's 8% and correction model's 15% area tolerance into one reviewed, versioned policy.

### Acceptance

- [ ] Another operator can reproduce output from the manifest.
- [ ] Crop labels and calibration are reviewed and stored as evidence.
- [ ] Register-to-detection reconciliation classifies matched, ambiguous, missing and non-sellable features.
- [ ] No unavailable measurement is displayed as a pass.

**Evidence:** source audit, benchmark report, calibration record and reconciliation report. Road clicks and labels are required product inputs; their earlier 10-minute and 20-minute estimates are approximate, not guarantees.

## 7. M2 Corrections and quality gates

**Owner:** engineer implements; reviewer accepts data.  
**Backlog:** R04.  
**Inspect:** `src/pages/CorrectionWorkspacePage.tsx` and `supabase/functions/_shared/correction/`.

### Workspace and linking

- [ ] Carry crops, OCR snapshots, polygons, calibration and register matches into the authenticated workspace.
- [ ] Show unmatched register lots separately from unmatched polygons.
- [ ] Provide queues for duplicates, ambiguous labels, missing figures, unavailable scale and conflicting tiers.
- [ ] Support manual polygon-to-parcel linking without requiring JSON edits.
- [ ] Preserve stable parcel identity through renumbering.
- [ ] Show a proposed diff and undo/history before batch acceptance.
- [ ] Require a strict stratified sample; one wrong sample blocks the proposed bulk batch.
- [ ] Keep Hopkins bulk acceptance disabled until the explicit review/calibration policy passes.

### Signal contract

| Signal | Meaning | Independence and gating |
|---|---|---|
| OCR agreement | Working number still agrees with OCR | OCR-dependent; cannot establish correctness alone |
| Spatial contiguity | Numerical neighbor is physically nearby in a plausible street run | Partly independent: numbers are OCR-derived, geometry is separate |
| Measured area | Polygon area at reviewed scale agrees with an independently reviewed comparison figure | Unavailable without calibration and verified figure; partly independent if comparison remains unreviewed OCR |

- [ ] Document `slot.area` as a mutable working-copy area seeded from OCR, and `ocr_area` as the original OCR snapshot.
- [ ] Use polygon geometry as the measurement, with explicit area units.
- [ ] Validate the numerical +/-1 neighbor in the same tier using spatial adjacency.
- [ ] Review the current approximately 1.5-lot-width heuristic for image aspect ratio, rotated lots, parallel streets and barriers such as creek crossings.
- [ ] Use appropriate native-pixel or measured distances rather than uncorrected percentage distances.
- [ ] Require verified printed/register area before describing measured-area comparison as independent of OCR.
- [ ] Keep unavailable scale visible, and prevent it from satisfying a required measured-area gate.

### Overlaps and completeness

- [ ] Review the 14 Hopkins overlap pairs previously reported; recompute on current data rather than assuming the count is unchanged.
- [ ] Classify common areas before treating every detected shape as a sellable parcel.
- [ ] Block `correct -> validate` for each unresolved within-draft overlap.
- [ ] Bind a waiver to the exact pair, reason, actor, time and relevant revision/geometry.
- [ ] Invalidate waivers when affected geometry changes.
- [ ] For a full launch, link every in-scope sellable register lot to exactly one approved polygon.
- [ ] Prevent one polygon from representing multiple sellable lots.
- [ ] For a partial launch, record the approved phase/scope and show it publicly.

### Required checks

- [ ] A numerical neighbor across the map fails the adjacency signal.
- [ ] Missing scale yields unavailable; incorrect measured area fails when calibration exists.
- [ ] A wrong reviewed sample blocks the bulk batch.
- [ ] An unresolved overlap blocks advancement; a valid specific waiver allows only the approved exception.
- [ ] Changes to a waived pair force renewed review.
- [ ] Coverage totals balance against the declared register scope.

**Evidence:** correction diff, sample review, gate report, overlap decisions and coverage report.

## 8. M3 Public map and Demo A

**Owner:** engineer; Edmund rehearses the buyer journey.  
**Backlog:** R05; public-project scoping portion of R06.  
**Inspect:** public map/embedding components, `supabase/functions/get-public-lots/`, iframe snippet generation and existing map tests.

### Public experience

- [ ] Verify image/polygon alignment at different zoom levels and display aspect ratios.
- [ ] Test search, tier filters, available-only filter, selected-lot links and pan/zoom reset.
- [ ] Prevent accidental lot selection during panning.
- [ ] Test phone touch selection, fullscreen entry/exit and return from inquiry.
- [ ] Show correct project/phase, lot identifier, verified area/unit, price basis and status.
- [ ] Provide useful loading, empty, failure and retry states.
- [ ] Provide keyboard access, visible focus, readable contrast and a list/search path to lot details.
- [ ] Fix the `is_default`/`isDefault` mismatch and explicitly scope project selection.
- [ ] Resolve active map and appropriate project settings by project, not accidental tenant-wide defaults.
- [ ] Filter at the server query boundary rather than retrieving every tenant parcel and filtering in the browser.

### Performance targets to measure

| Measure | Proposed first-release target |
|---|---|
| Useful map visible | Within 3 seconds on a documented midrange phone/good-4G profile |
| Initial transfer | Aim for 2-3 MB of critical assets and public payload |
| Desktop pan | At least 30 FPS on the agreed reference device with launch data |
| Inventory freshness | Defined behavior; start with updates visible within 60 seconds |
| Reliability | No console errors on the demo path; refresh and deep links work |

These are targets, not baseline measurements. Load higher-resolution imagery on demand. Implement tiles or paint-out only if measured readability/performance requires them; preserve original evidence and boundaries.

### Sample demo delivery

- [ ] Add a production-compatible frozen sample datasource/route using approved public fields.
- [ ] Label sample availability and the declared map scope.
- [ ] Do not depend on development-only `?demo=1` behavior for the hosted presentation.
- [ ] Ensure sample mode does not call unsafe business APIs or perform business writes.
- [ ] Test the public link from a fresh/incognito browser and a phone.

**Acceptance:** complete declared map scope is reviewed, controls work, budgets are measured and the sample demo is honestly labelled. **Evidence:** device results, screenshots, trace and working link.

## 9. M4 Shared drafts and secure publishing

**Owner:** engineer.  
**Backlog:** R06-R10 and the Demo B safety portion of R11.  
**Inspect:** `src/pages/CorrectionWorkspacePage.tsx`, `supabase/functions/publish-draft/index.ts`, `publish.ts`, shared correction modules, `scripts/slice17-db-hardening.sql` and the database harnesses.

### 9.1 Deployable database track

- [ ] Build a reviewed migration track that can recreate the required schema in a clean local/sandbox database.
- [ ] Preserve the local hardening script as local evidence; do not blindly relocate or run it against hosted business data.
- [ ] Add appropriate project/phase scope and parent constraints to drafts, versions, stage records, gates and nonces.
- [ ] Enable RLS on exposed tables and grant only the operations needed by the intended role.
- [ ] Revoke direct authenticated writes to protected stages and gate results.
- [ ] Ensure broad table grants or inherited grants do not undermine column-scoped protection.
- [ ] Protect published geometry/version fields from direct staff edits that bypass the publish process.
- [ ] Separate permitted business status/price operations from protected map-field changes.
- [ ] Define one authoritative stage record, or transactionally consistent protected copies; never trust client JSON stage as authority.
- [ ] Bind approvals to exact map version ID, draft revision, content hash and gate-policy version.
- [ ] Invalidate relevant approvals when evidence, scope, calibration or geometry changes.
- [ ] Require the exact recorded pass before activation, including service-role activation.
- [ ] Enforce one active version per declared map scope at database level.

Schema names can follow the existing repository conventions. The required relationships and permissions matter more than inventing a new table name. Generate actual migration files with the supported installed CLI workflow and inspect the resulting SQL.

### 9.2 Draft persistence

- [ ] Load the existing server draft before initializing a new draft from live parcels.
- [ ] Replace the hardcoded default context with validated organization/project/phase identifiers.
- [ ] Persist correction evidence, immutable OCR snapshots and calibration references.
- [ ] Save with a base revision and return success only when the expected row changes.
- [ ] Show saving, saved, unsaved, failed-save and conflict states.
- [ ] On conflict, preserve the unsaved proposal and present a deliberate reload/merge path.
- [ ] Derive write actor from authenticated identity; sanitize client-controlled protected fields.
- [ ] If retaining a development local preview, restore its saved state honestly and keep it separate from the shared path.
- [ ] Remove the local-drafts banner only when the actual server-backed path passes acceptance. Keep it for remaining local paths.

### 9.3 Endpoint authentication and server authority

- [ ] Validate the bearer user JWT and resolve the authenticated identity.
- [ ] Verify active organization membership, project access and publish permission.
- [ ] Do not authorize from user-editable metadata, request-body actor or an unvalidated tenant selection.
- [ ] Load draft, protected stage, existing parcels, register scope and measurement evidence from trusted server/database sources.
- [ ] Reject absent authoritative stage rather than falling back to a browser-influenced stage.
- [ ] Reject unknown projects, suspended organizations, cross-parent references and stale revisions.
- [ ] Keep service/secret keys out of frontend code and public payloads.
- [ ] Return useful authentication, authorization, validation and conflict outcomes without private-row disclosure.

### 9.4 Publish transaction

The approved publish must operate against one exact snapshot:

1. Authenticate and authorize the caller; derive actor, scope, request ID and idempotency key.
2. Load the authoritative inputs and evaluate the canonical shared gate implementation.
3. Enter a restricted database transaction; lock the draft/version/scope and recheck every revision/hash the verdict depended on.
4. Refuse the operation if the draft or relevant referenced evidence/live inputs changed between evaluation and commit.
5. Record the exact passing decision and approved snapshot/diff.
6. Update map geometry/version links using existing stable parcel IDs; preserve business fields and history.
7. Activate only the approved version in this project/phase scope; deactivate only the predecessor in that scope.
8. Stamp protected stage consistently and append the audit event.
9. Commit, then invalidate the scoped public cache and return committed IDs/revision.

If the shared JavaScript verdict is evaluated before the database transaction, the transaction must verify its complete input snapshot; do not leave a check-then-write race. Do not solve this by creating an unrelated second verdict implementation.

- [ ] Any database failure rolls back all publish writes and leaves the prior public version active.
- [ ] A duplicate successful request resolves to the same committed result.
- [ ] An old tenant-wide gate cannot activate a new version.
- [ ] Register lots are not silently created/deleted from OCR candidates.
- [ ] Store the previous approved map snapshot and provide an audited restore action.
- [ ] Map rollback does not roll back unrelated customer/payment history.

### 9.5 Database nonces

- [ ] Issue bulk-review seeds through a trusted server path.
- [ ] Bind the nonce to organization, project, actor, draft revision, proposal hash and expiry.
- [ ] Consume once through an atomic compare-and-swap/database operation.
- [ ] Couple consumption to the intended batch mutation, or provide a defined idempotent retry result; avoid half-applied batches.
- [ ] Reject unknown, expired, replayed, wrong-actor, wrong-scope and changed-proposal requests.
- [ ] Keep process-memory seeds as a development mirror only.

### 9.6 Runtime proof and checks

- [ ] Discover installed Supabase/Deno commands through help; serve or perform a supported actual bundle/runtime check.
- [ ] Invoke the function, not only inspect its import paths.
- [ ] Verify imports for all demo functions; move other escaping shared modules under functions `_shared` when required.
- [ ] Prove staff direct stage insert/update and direct activation are refused.
- [ ] Prove staff cannot fabricate a gate result or directly alter protected map fields.
- [ ] Prove activation without a valid exact-version gate fails for staff and service role.
- [ ] Prove old approvals fail after relevant changes.
- [ ] Prove stale save/publish returns conflict rather than false success.
- [ ] Prove concurrent nonce consumers have one winner.
- [ ] Prove failed publish leaves the previous public map unchanged.
- [ ] Prove publish preserves a fixture's contract, reservation, price override and payment links.
- [ ] Prove two authorized browser sessions restore the same shared draft and see committed updates.

**Evidence:** migration rehearsal, direct database negative tests, runtime invocation, two-browser recording, publish diff and rollback result.

### Demo B safety prerequisite

- [ ] Audit every reachable demo API, view and private-file path.
- [ ] Fix or disable unscoped privileged functions before connected demonstration use.
- [ ] Remove readable organization secrets and verify safe public projections.
- [ ] Do not treat a hidden button as an endpoint control.

M6 completes platform-wide isolation. This minimum reachable-path safety work cannot wait until after Demo B.

## 10. M5 Embed and inquiry integration

**Owner:** engineer; Edmund provides the outside-site rehearsal.  
**Backlog:** R12.  
**Inspect:** embed routes/page, `WordPressEmbedSnippet`, public-lots resolver and inquiry intake.

### URL and iframe contract

Standard public URL shape:

```text
https://<platform-domain>/embed/<tenant-slug>/<project-slug>
```

The domain above is a placeholder. Choose and verify the real domain; do not assume the architecture brief's proposed name is deployed.

- [ ] Generate snippets using a configured canonical embed base URL for the environment.
- [ ] Select an existing authorized project instead of accepting an unchecked free-text project slug.
- [ ] Keep the public URL stable across map version changes.
- [ ] Validate any phase/selected-lot parameters and document their behavior.
- [ ] Expose the committed public version/update time for freshness checks.
- [ ] Test responsive iframe size, fullscreen permissions, refresh and selected-lot navigation on plain HTML and the intended WordPress site.
- [ ] Test browser privacy restrictions; public iframe usage must not require admin authentication.
- [ ] Provide a full-page fallback that preserves selected-lot context.

### Inquiry contract

- [ ] Resolve and validate public project context on the server.
- [ ] Require the selected parcel to belong to that published project.
- [ ] Reject forged tenant/project/parcel combinations.
- [ ] Save buyer contact, selected lot, source/attribution and appropriate consent information.
- [ ] Use idempotency so retries produce one inquiry and a useful confirmation.
- [ ] Validate fields and apply a suitable anonymous submission abuse limit.
- [ ] Make the saved inquiry visible in the correct organization/project lead queue.
- [ ] Start with an assigned/default project owner before adding advanced routing.
- [ ] Keep notification retries separate from durable inquiry creation.
- [ ] Clearly distinguish inquiry from reservation; recheck availability at the reservation/application step.

### Acceptance

- [ ] A fresh buyer session submits from an outside iframe.
- [ ] Exactly one lead appears in the correct sandbox project with its parcel/source.
- [ ] Another tenant cannot access that inquiry.
- [ ] Duplicate submission and message failure are handled honestly.
- [ ] A published map update appears within the defined freshness target without changing the URL.

**Evidence:** outside-site link, tested snippet, scoped inquiry record and failure-case results.

## 11. M6 Complete tenant isolation and onboarding

**Owner:** engineer and release operator.  
**Backlog:** R11, R13-R14.

### Identity, projects and context

- [ ] Add appropriate RLS/grants to projects and any phases, memberships, domains and version tables.
- [ ] Enforce valid organization/project relationships with database constraints.
- [ ] Keep one organization per staff login initially if adequate; implement multiple-organization membership when required by a real user journey.
- [ ] Make project permission explicit for editors, publishers and business operators.
- [ ] Fix staff invitation/provisioning to create correct tenant/project access. The baseline admin-user upsert omits non-super-admin tenant assignment.
- [ ] Add a project switcher and explicit platform-admin tenant context.
- [ ] Scope queries and cache keys by organization/project; invalidate sensitive cached state on context change.
- [ ] Scope settings, price/tier lookups, singleton queries and upsert conflict keys.
- [ ] Match duplicate customers within the authorized business scope, not across unrelated organizations.
- [ ] Remove silent default-tenant fallbacks from new flows.
- [ ] Enforce organization suspension on every relevant server path.

### Database and privileged paths

- [ ] Audit `parcel_board_view` and `public_parcel_options`, including joined customer fields.
- [ ] Use supported security-invoker views with correct grants where appropriate, or revoke direct exposure and provide an authorized alternative.
- [ ] Separate organization credentials from readable/public configuration.
- [ ] Audit `SECURITY DEFINER` functions, execution grants, authorization checks and fixed safe search paths.
- [ ] Verify the application-approval RPC against another tenant's known application ID.
- [ ] Scope enabled summary, receipt, notification and other service-role functions by authorized organization/project.
- [ ] Scope scheduled jobs, log context and notification recipients.
- [ ] Disable uncompleted privileged paths at the API boundary.

### Private files

- [ ] Use tenant/project object prefixes or an equivalent enforced ownership model for contracts, receipts, applications and payments.
- [ ] Authorize the business record and file path before creating a signed download.
- [ ] Cover list, upload, update/upsert, signing and deletion as appropriate.
- [ ] Test known object paths from the wrong tenant.
- [ ] Keep intentionally public logos/map assets free of private data.

### Onboarding rehearsal

- [ ] Create organization, owner access, project and optional phase.
- [ ] Configure approved branding, contact details and pricing.
- [ ] Import canonical register, process source and review/link the map.
- [ ] Invite staff, generate the public URL and submit a sandbox inquiry.
- [ ] Run the isolation matrix below.
- [ ] Repeat for the second organization through the same process, without changing app code.

**Acceptance:** real JWT accounts and two organizations pass database/API/file checks; two projects within one organization maintain separate maps/settings; the second setup is repeatable. **Evidence:** role matrix, isolation results and onboarding checklist with scoped IDs.

## 12. Tenant acceptance matrix

Run database tests locally first. Repeat hosted HTTP/account tests with two real accounts after the reviewed staging migration/runtime deployment is authorized and completed. Synthetic identity tests do not replace real JWT verification.

| Actor / attempt | Required outcome |
|---|---|
| Anonymous map visitor | Only requested active published project and allowlisted public fields |
| Anonymous forged inquiry | Cross-project/tenant parcel rejected |
| Tenant A staff reads tenant B | Tables, views, known IDs, functions and private files reveal no B private records |
| Tenant A staff writes tenant B | Direct writes, RPCs, invitations and cross-parent references refused |
| Project A1 user accesses A2 | Access follows explicit project permission; no stale cached data |
| Editor without publish permission | Can save allowed corrections; cannot change stage/gates/published geometry/activation |
| Authorized publisher | Only current approved exact revision can publish |
| Platform administrator | Explicit tenant/project context and audit event required |
| Bulk nonce consumers | Wrong scope/actor/revision/proposal, expiry and replay refused; concurrent use has one winner |
| Suspended organization | Documented server-side access/public behavior enforced |
| Private storage access | Wrong tenant cannot list/sign/read/update/delete private objects |
| Service/background worker | Input rows and output recipient stay within the verified scope |

Additional mandatory checks:

- [ ] The same displayed lot number in two projects resolves to different correct parcels.
- [ ] A privileged cross-parent insert is refused by the database.
- [ ] Publishing project A does not activate/deactivate project B's version.
- [ ] An old gate or waiver fails after relevant content changes.
- [ ] Authorized fixture owners can access the same records that the wrong tenant is denied.

For each result, retain actor/role, scope, operation, expected/actual outcome, code/schema/function version and a redacted request ID. A missing fixture or skipped check is not a passing isolation result.

## 13. M7 Hosting, domains and restore

**Owner:** release operator and engineer.  
**Backlog:** R14-R15.

### Hosting contract

- [ ] Keep one frontend codebase; do not create an app fork per tenant.
- [ ] Keep demo/staging isolated from production business data and notification recipients.
- [ ] Confirm the current frontend provider and requirements before choosing a provider change.
- [ ] Use a central admin login host with explicit organization/project context first.
- [ ] Start with path-based public embed URLs; add custom domains/subdomains through verified mappings.
- [ ] Keep heavy PDF ingestion in a controlled local/dedicated worker process, not a short-lived Edge request.
- [ ] Select hosting/backend capacity and backup options from measured needs; a branded frontend embed does not itself require a custom backend API domain.

### Domain and browser behavior

- [ ] Bind normalized hostnames to organization/project in a domain-mapping record.
- [ ] Verify ownership and TLS before serving a custom domain.
- [ ] Reject unknown hosts rather than choosing a default tenant.
- [ ] Verify the hosting provider preserves the intended host routing and does not redirect every tenant alias to the wrong project.
- [ ] Configure SPA rewrites and test direct refresh of admin/embed URLs.
- [ ] Keep admin framing restricted; allow the intended public embed on approved sites.
- [ ] Validate origins for any postMessage behavior.
- [ ] Configure CORS for intended API usage without treating it as authorization.
- [ ] Scope cache keys/invalidation by tenant, project, map version and inventory revision.

### Migration and recovery runbook

1. Inventory target schema, migration history, extensions, functions, policies, views, buckets and manual prerequisites.
2. Rehearse the chosen bootstrap/upgrade against a clean or sanitized database.
3. Create backup/restore evidence before applying hosted changes.
4. Review the exact migration dry run, reconciliation and permission matrix.
5. Apply only the authorized staging release, deploy compatible functions/frontend and repeat real-account tests.
6. Prepare a production manifest and concrete cutover/rollback steps before the separately authorized production release.
7. Verify public map, iframe, login/context, private-file access and inquiry routing after release.

- [ ] Back up Storage object bytes separately from database metadata.
- [ ] Restore records and verify that private documents/map assets actually open.
- [ ] Rehearse frontend rollback, prior-map restore and database/file recovery separately.
- [ ] Record measured recovery duration and responsible operator.
- [ ] Keep existing Wamule parcel/business IDs intact during any new-platform migration.

**Acceptance:** stable links, verified host resolution, reproducible environment, passing real-account checks and demonstrated restore. **Evidence:** code/function/schema manifest, DNS/TLS/header checks and restore report.

## 14. M8 Application and sales process

**Owner:** business process owner defines actions; engineer verifies controls.  
**Backlog:** R16.

Complete the agreed path using existing modules:

| Step | Implementation acceptance |
|---|---|
| Inquiry | One scoped lead, selected lot/source retained, operator assigned |
| Application | Validated intake, private uploads, durable submitted state and safe retries |
| Review | Authorized tenant/project decision, actor/time/reason recorded |
| Reservation | Database-controlled transition; conflicting concurrent reservations refused |
| Customer/contract | Stable parcel/customer references and approved price/terms snapshot |
| Payment/receipt | Exact currency values, idempotent retry, correct allocation and private evidence |
| Reporting | Balances reconcile to underlying records within selected scope |
| Messages | Approved recipients/templates; business action survives notification failure |

- [ ] Run outside inquiry -> application -> decision -> reservation/contract -> payment -> receipt.
- [ ] Test invalid upload, duplicate submission, wrong-tenant approval ID, reservation race, payment retry and notification outage.
- [ ] Publish a revised map after a contract exists and prove business links/status/balances remain intact.
- [ ] Separate map editing/publishing from application approval and payment permissions.
- [ ] Defer unfinished marketplace, AI, campaign and customer-portal modules; disable unsafe endpoints.

**Evidence:** operator script, permission/failure results, synthetic sample documents and reconciled ledger totals. Do not invent contract or collection policy; use the approved business process/templates.

## 15. M9 Pilot and release acceptance

**Owner:** Edmund, assigned operator and engineer.  
**Backlog:** final acceptance for R16.

- [ ] Rehearse buyer, editor, publisher and business operator roles using synthetic data.
- [ ] Onboard one approved pilot project through the same repeatable process.
- [ ] Observe an operator restore a draft, correct, resolve a gate and publish without developer coaching.
- [ ] Have the reviewer verify difficult lot labels, area/unit, tiers and overlap decisions.
- [ ] Test outside-site inquiry on a phone and follow it through the agreed admin workflow.
- [ ] Rehearse stale-edit conflict, lost access, notification failure and map rollback.
- [ ] Assign support owners for map correctness, access, inquiry failures, business questions and infrastructure incidents.
- [ ] Resolve critical parcel correctness, tenant isolation and core workflow defects before broader rollout.
- [ ] Keep an honest capability list: available in this demo, available in pilot, planned.
- [ ] Prepare a short hosted recording, tested public link, iframe snippet and feedback route.

**Release evidence:** exact build/schema/function versions, accepted map/register/calibration, isolation matrix, integration results, operating guide, performance trace and restore report.

## 16. Prioritized backlog

P0 is release-blocking correctness/security. P1 is required first-release experience. P2 is conditional/later work. IDs are proposed labels, not existing GitHub issues.

| ID | Priority | Task | Packet |
|---|---|---|---|
| R01 | P1 | Approve Hopkins register, scope and reviewer | M0 |
| R02 | P1 | Audit PDF; bounded header reading; reproducible manifest | M1 |
| R03 | P1 | Label 100 crops; calibrate references; benchmark | M1 |
| R04 | P0 | Reconcile/link lots; correct signals; enforce overlap/sample gates | M2 |
| R05 | P1 | Polish public map; measure budgets; frozen sample demo | M3 |
| R06 | P0 | Project keys, scope, version relationships and parent constraints | M0 contract; M3-M4 implementation |
| R07 | P0 | Deterministic migrations and shared draft restore/conflicts | M4 |
| R08 | P0 | Authenticated publish and authoritative server inputs | M4 |
| R09 | P0 | Exact-version approval, atomic activation and rollback | M4 |
| R10 | P0 | Database-bound nonces and actual served-runtime proof | M4 |
| R11 | P0 | Views, secrets, RPC, private files and worker isolation | Before Demo B; complete in M6 |
| R12 | P1 | Canonical embed URL and scoped idempotent inquiry | M5 |
| R13 | P0 | Membership, invitations, context/cache and real-account matrix | M6 |
| R14 | P1 | Second-tenant onboarding and verified domain mapping | M6-M7 |
| R15 | P0 | Hosting rehearsal, stable routing, rollback and restore | M7 |
| R16 | P1 | Application process, exceptions and pilot acceptance | M8-M9 |
| R17 | P2 | Tiles, paint-out and queued uploads if measurements justify them | After core-loop evidence |

## 17. Evidence and verification rules

- Run checks appropriate to each change and the repository's required build/type/lint/test workflow.
- Inspect actual package scripts and installed CLI help before choosing commands.
- For database changes, use real Postgres with authenticated-role behavior and explicit fixtures in both tenants.
- For runtime proof, serve/invoke the actual function. Static import checks supplement this evidence.
- For shared editing, use two browser sessions and reload/reopen, not only an in-memory store.
- For embed proof, use another origin and a fresh buyer session.
- For hosted tenancy, use real accounts/JWTs and direct API attempts in addition to UI checks.
- Record a skipped/environment-blocked check as skipped/blocked. Do not fabricate an all-pass total.
- Retain redacted evidence tied to the exact version; never put credentials or real customer details in a report.

Suggested repository evidence structure, if consistent with existing conventions:

```text
docs/implementation/
  status.md
  release-scope.md
  source-audit.md
  schema-contract.md
  migration-rehearsal.md
  tenant-isolation-results.md
  release-runbook.md
  demo-script.md
```

These paths are proposed future deliverables, not files created by this Markdown handoff. Preserve existing conventions where they already meet the need.

Packet completion template:

```markdown
### Packet <M-number> status

- Baseline commit:
- Implemented behavior:
- Files changed:
- Checks executed and results:
- Checks blocked/skipped and why:
- Evidence:
- Local-only/stubbed behavior:
- Hosted changes performed under session authorization:
- Next dependency-ready packet:
```

## 18. Copy-ready prompt for the next coding slice

```text
Implement the next local map-readiness slice using Wamule_Implementation_Plan.md.
Start with M0 and M1; inspect the current repository instructions and working tree.
Preserve unrelated changes. Keep this slice local only: no commits, push, deploy,
hosted database migration apply or business notification sends.

1. Inventory the approved register, project/phase identity, PDF availability and
   reviewer inputs. Record missing decisions without inventing lot identities.
2. Inspect the actual PDF if it is available; compare useful text/vector/metadata
   against the existing raster pipeline. Record the source and coordinate contract.
3. Replace whole-file header probing with bounded reads; add a reproducible manifest
   and clear processing failure reports using existing pipeline conventions.
4. Prepare the 100-crop review pack and road-calibration evidence workflow.
   Without reviewed labels/dimensions, retain unavailable scale and keep Hopkins
   bulk acceptance disabled. Complete independent work while those inputs wait.
5. Produce a register-to-polygon reconciliation report. Classify sellable lots and
   common areas separately; do not create canonical lots from unchecked OCR.
6. Inventory the migration track and outline server draft/publish dependencies.
   Keep the local-drafts banner until the shared path is actually proven.
7. Run appropriate checks. Report built versus verified versus blocked, exact
   results, evidence locations and the next smallest dependency-ready packet.
```

After M0/M1 are accepted, request M2 using its checklist. Advance packet by packet; a new prompt does not waive prior quality or tenant gates.

## 19. Reference baseline

- [Pinned repository baseline](https://github.com/edmundciego/wamule-bz/tree/3c368d22dd25695ea57c3c236d436cc94b2c91b2)
- `Wamule_Product_Roadmap.docx`, current saved roadmap read on 10 October 2026.
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Securing Edge Functions](https://supabase.com/docs/guides/functions/auth)
- [Supabase Database Backups](https://supabase.com/docs/guides/platform/backups)
- [Supabase Custom Domains](https://supabase.com/docs/guides/platform/custom-domains)
- [Netlify Manage Multiple Domains](https://docs.netlify.com/manage/domains/manage-domains/manage-multiple-domains/)

The Markdown document is an implementation handoff derived from the reviewed roadmap. It does not apply migrations, deploy code or establish that hosted acceptance gates have passed. Reconfirm repository and platform versions when implementation begins.
