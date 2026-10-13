# Wamule Implementation Plan

**Purpose:** finish the interactive map first, connect it to the application and a stable embed URL, then complete tenant onboarding and hosting.

**Prepared for:** Edmund Ciego  

**Original planning date:** 10 October 2026  
**Plan reconciliation draft:** 12 October 2026  

**Companion:** Wamule Product Roadmap  

**Original reviewed baseline:** `edmundciego/wamule-bz`, `staging`, commit `3c368d22dd25695ea57c3c236d436cc94b2c91b2`  
**Most recent agent-reported working state:** `feature/m0-demo-a-brief-audit` at `e6f8aaf`, with uncommitted changes preserved. This has not been independently checked against the current repository in this document.  

**Status:** reconciled planning draft for product review; not a claim that current Git/hosted state has been reverified. Existing checkboxes and evidence references have been retained. Unchecked tasks are not claims of completed or deployed behavior. No repository edit, migration, deployment or implementation is authorized by this plan revision.

## 0. Product baseline, decision record and recovery notes (12 October 2026)

### What we are preserving

**Canonical buyer product:** the existing React/Vite map under `/embed/:tenant` and `PublicLotMap`, including the staging buyer experience at `https://wamule-staging.netlify.app/embed/wamule`. This is **not** the local synthetic fixture; it consumes the public-lots API. Extend this implementation, not a replacement map.

**Visual and interaction reference:** `Hopkins Grove – Interactive Lot Map (PoC).html`. It contains a well-presented, interactive standalone sample with 861 clickable polygons, but hardcoded tier/pricing content, seeded-random statuses, a local status editor, an embedded low-resolution source image and a placeholder inquiry action. Use its presentation as inspiration, **not** its invented values or a deployable substitute for the React map.

**Test-only surface:** development `?demo=1` with a deterministic synthetic 60-lot grid. It exists for hermetic, read-only automated tests and must not be confused with the product, treated as live inventory or used to approve the buyer design. Retain it for testing.

**Existing engineering safeguards:** source audit, reproducible build, blind crop review tooling, road calibration tooling, reconciliation, provenance, implemented overlap/sample safeguards, public reference scoping, build guards and paint-out hold stay intact. Unfinished tenant/publish safety controls must remain explicit blockers rather than being described as complete. The source review and plan work from the approximately 18-hour-50-minute paused run must not be thrown away.

### Why this note exists

The reported investigation found that commit `5af4cc0` introduced the **synthetic local test fixture**, rather than replacing the React staging buyer map. The original standalone HTML was added at `a6348a5` and retained. The staging map was reported to load 743 public-lots API records and render 719 unique lot IDs, with all observed API statuses `Available`. These numbers are **diagnostic observations, not approved inventory counts or a conclusion that the API is incorrect**. Investigate their definitions, filtering and identity mapping before public claims. No buyer-facing availability or price promise may be inferred from that observation.

### Settled working decisions (not automatic sign-offs)

| Decision | Working direction | Status |
|---|---|---|
| First shareable target | **Demo A**, a polished, read-only map using explicitly reviewed/frozen public data | Target selected; release gates open |
| UX baseline | **Existing React embed**, visually informed by original standalone PoC | Selected; visual acceptance open |
| Fixture handling | Synthetic `?demo=1` **test only** | Preserved; no product-demo substitution |
| First public project | Hopkins Grove; full-project versus named phase remains an explicit owner decision | Scope open |
| Register and public inventory | Approved register and allowlisted public fields are authoritative; OCR/detection is evidence, not approval | Inputs/sign-off open |
| Disagreements | Edmund is the named register/drawing conflict resolver | Recorded; does not replace register approval |
| Paint-out and tiling | Retain hold; use only when measured necessity and provenance permit | Deferred |
| Roles and environments | Define/enforce roles in M4/M6; detailed environment decisions in M7 | Not M0 release blockers |

### Milestone health snapshot

Statuses below interpret the existing checkboxes and the paused agent's report. They do **not** certify the current branch, staging schema or production deployment.

| Packet | Current reading | What prevents acceptance |
|---|---|---|
| **M0** | Decisions, inventory and owner notes partially recorded | Launch scope, real register, common areas, public fields, remaining responsibility assignment |
| **M1** | Source audit and engineering pipeline substantially implemented/locally tested | 100 human labels, reviewed distances/calibration, register reconciliation, independent reproduction |
| **M2** | Core correctness guards plus integrated local map-review UX implemented and locally exercised; release acceptance remains open | Human source labels, authenticated/server-backed review verification, linked/sellable coverage, 14 overlap dispositions, owner policy, gate acceptance |
| **M3** | Existing React interactions and accessibility have significant local tests | Real-source buyer visual approval, mobile presentation, authoritative details, release-grade sample route, actual-device/hosted checks |
| **M4–M9** | Planned work with existing supporting application code | Their individual integration, security, hosted and operating gates remain open |

**Non-negotiable separation:** local implementation, local functional verification, staging functional verification, visual acceptance, data approval and release authorization are different accomplishments.

### Work ordering without undermining release safety

The **M3 visual and interaction workstream may proceed in parallel with M1–M2 human data review**, using existing React code, safely labeled traceable sample geometry and non-authoritative data when appropriate. It must not change the public-data approval rules or permit sharing a release-grade Demo A until M0–M3 gates are satisfied. M2 remains a **Demo A release dependency**, not a reason to postpone useful UI improvement. Similarly, nothing in this plan authorizes M4 publishing or a hosted rollout.

### Review-first execution policy

Before a new autonomous coding run, reconcile the working tree, already checked evidence and this plan. Choose one small, dependency-ready packet/sub-packet with a visible deliverable. For UI work, require actual **React embed** desktop and mobile screenshots plus a human review checkpoint, not only a synthetic fixture test. Stop after the agreed scope (suggested 60–120 minutes per bounded pass), report incomplete work truthfully, and wait for feedback rather than continuing unattended for many hours. Do not rerun completed M1 source/tooling work merely to demonstrate activity.

## 1. Execution contract

- Default to local implementation and verification. The earlier working scope was local only, with no commits, pushes, deployments or hosted migration applies. Perform hosted release actions only when the current session authorizes them.

- Before editing, read the current repository instructions, inspect the working tree and compare the current code with this baseline. Preserve unrelated work; do not reset the checkout.

- Implement only an explicitly authorized, dependency-ready **sub-packet** from this plan. Do not attempt the entire roadmap in one unreviewable change. Reconcile existing work first; do not restart completed tasks or generate a new demo.

- Reuse the existing React/Vite application, Supabase backend, the actual React `/embed/:tenant` buyer map / `PublicLotMap`, and correction workspace. Keep the editor at `/lots/correct` in the same application and login. Use the standalone Hopkins PoC **only as a design reference** and keep `?demo=1` **only for tests**.

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

Use **implemented locally**, **verified locally**, **verified on staging**, **visually accepted by product owner**, **data/reviewer approved**, and **released** as separate states. Never collapse them into one "done" label. Include visual evidence links for buyer UI work and explain any difference between the synthetic fixture and the actual React embed.

## 2. Release gates and order

| Packet | Product outcome | Dependencies | Planning effort |
|---|---|---|---|
| M0 | Agreed scope, canonical lot identity, owners and environments | None | 0.5-1 day |
| M1 | Audited source, OCR benchmark, measured scale and repeatable output | M0 | 2-4 days |
| M2 | Complete reviewed links, corrections and quality gates | M1 | 2-4 days |
| M3 | Polish the **existing React buyer embed** and deliver a read-only approved sample demo | UI iteration can run alongside M1–M2; **Demo A release requires M0–M2 approval** | 2-3 days for original planning scope; reassess after UX review |
| M4 | Shared drafts and authenticated atomic publishing | M0 schema contract; M2 gates; M3 public map | 4-7 days |
| M5 | Stable embed and correctly routed inquiry | M4; safety audit of reachable demo APIs | 1-2 days |
| M6 | Complete tenant isolation and repeatable onboarding | M4; schema and privileged-path audit | 4-7 days |
| M7 | Hosting, domains, migration rehearsal and restore | M6 | 2-4 days |
| M8 | Complete the agreed application and sales workflow | M5-M7 | 3-6 days |
| M9 | Operator pilot and release acceptance | M8 | 2-3 days |

Estimates are focused engineering days, excluding waits for reviewer input or account access. Reestimate after M1 and M4. Approximately 5-9 working weeks is a planning range, not a delivery commitment.

### Demo A: map only

- [ ] M0–M3 release gates pass for the declared scope, **including product-owner visual acceptance of the real React embed** (not merely synthetic fixture tests).

- [ ] Use an approved frozen public payload with a visible sample-data label.

- [ ] No business writes or unsafe business API calls are reachable through this demo path.

- [ ] The link works in a fresh browser and on a phone; initial framing, lot readability, controls, detail presentation and inquiry expectations have been reviewed by the product owner.

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

### Demo surfaces and release distinctions

| Surface | Data and behavior | Allowed use |
|---|---|---|
| Original standalone HTML PoC | Rich presentation, 861 PoC polygons and illustrative/hardcoded values | Visual reference and historical prototype only |
| React `/embed/:tenant` on staging | Public-lots API, current Hopkins masterplan, selection, filters, inquiry | **Canonical product to polish**; staging observation does not certify live inventory or make it an approved Demo A |
| Local `?demo=1` | Synthetic 60-lot fixture with deterministic results | Automated testing only |
| Future Demo A release URL | Frozen, approved, allowlisted public sample with clear labels and no business writes | Shareable read-only demo **only after** sample/visual/release checks pass |

Do not call the existing connected staging embed an approved frozen Demo A, and do not replace it with the synthetic fixture to satisfy this release requirement.

## 3. Baseline and known gaps

Reconfirm these observations against the current checkout before changing code.

| Area | Existing implementation to reuse | Gap to close |
|---|---|---|
| Admin entry | `/lots` has an Edit link to `/lots/correct` | Confirm project context and permission flow |
| Correction workspace | Correction logic, gate UI, waivers and local export | Shared draft loading/restoration, evidence and server publishing |
| Local draft behavior | `localStorage` writes | Current path does not restore those writes on reopen |
| Public map | Real React staging embed at `/embed/:tenant` with public-lots API, route, filters, selection, zoom/pan, mobile selection and fullscreen | Recover premium standalone-PoC presentation **inside React**; reconcile reported 743 API/719 displayed IDs and `Available` statuses; verify authoritative data, real-device usability and iframe acceptance |
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

- [x] Permit the same displayed lot number in different projects without mixing records (project-local uniqueness and scoped public reads/publishers implemented locally; `project-scoped-public-map.md`).

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

- [x] Name the person who can resolve register/drawing disagreements (Edmund, recorded as owner/conflict resolver in `docs/implementation/release-brief.md`).

- [ ] Identify sellable lots, roads, creek, boulevard and other common areas.

- [ ] Approve the fields permitted in the public payload.

- [x] Record tracked migration sources, archived/root SQL, manual harness setup, and local function/config inventory; keep hosted applied/enabled state explicitly unknown (see `docs/implementation/migration-inventory.md`).

- [x] Choose a reconciled fresh-bootstrap track for new local/sandbox databases and incremental-only upgrades for existing Wamule environments; protect business records (strategy recorded in `docs/implementation/migration-inventory.md`; baseline reconciliation and clean rehearsal remain open).

- [ ] Assign engineering, map review and release operations responsibilities.

Intentionally deferred — non-blocking for M0 (reconciled 11 Oct 2026): role definitions ride with their enforcement in M4/M6 (§9, §11); development/sandbox/production environment definitions ride with hosting in M7 (§13). Neither gates M0–M3 progress.

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

- [x] Inspect pages, dimensions, embedded images, selectable text, vectors, layers and coordinate metadata in the actual PDF (8/8 source hypotheses verified; raster-only page structure recorded in `docs/implementation/source-audit.md`).

- [x] Compare any usable text/vector output with the current raster path on the same map region (no selectable text or non-image page objects exist; raster is the only machine-readable path).

- [x] Fix the classifier to read a bounded header instead of loading the full file to inspect 16 bytes (`scripts/tenant-build.mjs` reads at most 16 bytes).

- [x] Use bounded or streaming handling for checksums and other whole-source operations where appropriate (1 MiB streaming fingerprints in source audit and tenant build).

- [x] Record source checksum/size, page, native dimensions, orientation, transforms, tool versions and build identity (source-audit evidence is fingerprinted by the successful private tenant build manifest; see `docs/implementation/m1-build-run.md`).

- [x] Define processing memory/time limits and a stage-specific failure-report format (bounded audit/hash limits; an `ENOSPC` replay could not persist the report until it was reconstructed after recovery; see `docs/implementation/m1-build-run.md`).

- [x] Preflight free space on build-output and temporary filesystems before archiving the prior build; low-space runs stop without changing the archive (`scripts/tenant-build-capacity.mjs`; threshold is configurable with `WAMULE_BUILD_MIN_FREE_BYTES`).

- [x] Preserve non-empty prior tenant build outputs by moving them intact into private `build-history/<run-id>/` before a rerun; symlink escapes and build-sourced inputs are refused (`scripts/tenant-build-output.mjs`, unit-tested).

- [x] Preserve the original source, reference image, detection output, OCR evidence, validation report and manifest in the private package; fingerprint any reviewer files present in `evidence/` (verified by a completed build and archived manifest; actual label/calibration files are still pending owner input).

- [x] Keep the PDF out of the public app bundle and visitor downloads (verified no PDF is tracked or present under `public/`; the post-build guard also rejects PDF header signatures even if the file is renamed).

- [x] Reuse the existing smaller WebP preview generation (1600×1347, 311,168 bytes in the private build; see `docs/implementation/m1-build-run.md`).

- [ ] Tune total image/payload delivery against M3 network and device budgets before adding tiles (the 12 Oct isolated production-bundle recheck rendered all 719 candidates in 1.387 s at 412×839/DPR 2.625, with 0.496 s FCP and 515,833 bytes total transfer under the emulated 50 ms RTT / 12 Mbps down / 6 Mbps up / 4× CPU profile. It used verified local Hopkins geometry and preview imagery, but synthetic public fields; real-device, approved-payload and hosted timing remain open. No tiles are indicated by this measurement yet; see `docs/implementation/project-scoped-public-map.md`).

- [x] Implement a report-only register/polygon reconciler that requires an approved register and explicit reviewed links/dispositions; OCR alone never creates canonical links (`scripts/reconcile-register.mjs`; fail-closed blank input templates and regression test in `docs/implementation/register-reconciliation.md`; Hopkins run remains blocked on owner inputs).

### Human review and calibration

- [x] Provide the 100 representative crop review pack with explicit unreadable/ambiguous controls (local pack generated; labels remain pending).

- [x] Make review-crop generation fixed-seed reproducible, keep identity mapping outside the sheet, and reject impossible sample sizes before writing (`scripts/blind-sheet.py`; fixture-tested).

- [x] Harden benchmark scoring inputs and method: duplicate/unknown crop IDs, malformed values, and unresolved mappings now fail closed; OCR token attribution uses actual polygon containment (not only bounding boxes); exact token accuracy is separate from normalized Levenshtein character accuracy; output reports missing, ambiguous, unreadable, and unmarked-blank coverage (`scripts/score-labels.py`, `scripts/ocr-match.py`; regression-tested).

- [x] Serve reviewer tools through mode-specific localhost asset allowlists; blind labels cannot fetch OCR/lot files or the background, while road calibration can fetch only its page and background (`scripts/serve-blind-sheet.py`; HTTP regression-tested).

- [x] Preserve unreadable status in exported label evidence and keep the review-page source reproducible (`blind-sheet.py` generates `label.html` from `scripts/templates/blind-label.html`; CSV exports include mutually exclusive `ambiguous` and `unreadable` flags; the current private page was patched in place without replacing crops or browser-local review state).

- [x] Prepare an additive, prediction-blind, target-outlined 60-case Hopkins number-review benchmark (20 page/crop agreements, 20 disagreements and 20 difficult cases) without changing the existing 100-crop pack. The reviewer saves source/crop fingerprints and polygon IDs, resumes from browser-local progress, and exports versioned review JSON plus scorer-compatible CSV (`scripts/blind-sheet.py`, `scripts/templates/lot-number-benchmark.html`, `scripts/serve-blind-sheet.py`). All 60 cases remain unreviewed until a human labels them.

- [ ] Obtain human labels and benchmark both configured OCR engines.

**Lot-number extraction checkpoint (12 Oct 2026):** The source-bound Hopkins
raster is 5700×4800 and the existing polygon coordinates are percentages of
that same full-page raster; the crop generator converts them directly to
native pixels. No coordinate-transform mismatch is evidenced, and the source
audit confirms the detector image covers the PDF page. The current 100-crop
pack is stratified by tier, map quadrant and polygon aspect, but it has no
detected-polygon outline, contains neighboring printed annotations, and has
0/100 human-labeled rows. It is useful for blind reading, not yet a reliable
polygon-association benchmark; its selection also does not deliberately cover
OCR-confidence, label-competition or rotation failure cases. Keep it intact.

The unscored page-wide baseline has 2,413 Tesseract tokens (152 classified as
numbers, 8 as areas; median digit-box height 22 px, so the configured global
upscale did not run) and 40 RapidOCR tokens, all classified as other. Strict
confidence, number-pattern and token-centroid-inside-polygon gates produced
86 candidate matches, 15 duplicate/conflict cases and 618 unmatched polygons.
The strict geometry gate is deliberately conservative and suppresses unsafe
nearest-text guesses. Separate 3× per-polygon Tesseract crops yielded 662 raw
number reads and 681 readable crops, but select the earliest plausible digit
string from a padded bounding box; nearby labels and dimensions can compete,
and these counts have no measured accuracy. The area-anchored experiment
assembled 509 numbered polygon candidates (497 distinct values), flagged 144
units as suspect and left 29 units orphaned; it likewise has no human score or
retained per-candidate confidence. These results suggest crop framing and
association/filtering—not simply source resolution—drive the low safe-match
count, but the separate effects of small/faded text, rotation and OCR errors
cannot be ranked without ground truth. Among overlapping detection IDs, the
page-wide and per-polygon OCR candidates overlap on 80 lots: 37 strings agree
and 43 disagree. Page-wide and area-anchored candidates overlap on 62 lots: 44
agree and 18 disagree. These are method-disagreement counts, not accuracy.
No accuracy, coverage-quality or processing-cost claim is established.

**Target-outlined benchmark preparation (12 Oct 2026):** A separate local
pack now exists at `out/hopkins-lot-number-benchmark-v1/`, generated from the
5700×4800 reference image and current 719 detection geometries. Seed 7 selected
20 page/per-polygon-crop agreements, 20 disagreements, and 20 difficult cases
(5 each: duplicate/conflicting tokens, no candidate from any path,
narrow/irregular geometry, and crop-versus-area candidate conflict). The
reproducibility record is
`out/hopkins-lot-number-benchmark-v1-selection-evidence.json`; the served
manifest fingerprint is `fcf91a607225827c172983ff1188d5569a4987c5acc3f2b1236ba7a2a8e984c0`.
It records source and geometry hashes, native crop boxes, polygon coordinates,
and per-crop hashes. The local page checks both the manifest and the crop
fingerprint; OCR/AI values and selection strata are not served. No source or
crop was uploaded to an external AI provider.

The crops retain native pixels as lossless PNG, show the exact detection
boundary in white and magenta, and include surrounding drawing context. Visual
spot checks covered an ordinary parcel (S001), a multi-label/irregular region
(S003), a clustered outline (S013), and narrow shapes (S019/S045). Some current
detection outlines encompass multiple printed lot numbers or do not isolate a
single source parcel; reviewers must mark those ambiguous, not choose a nearby
number. This is an unresolved M2 geometry/association review item, not a basis
to alter polygons or infer a canonical identity. The benchmark currently has
0/60 human decisions. The existing 100-crop pack and browser state remain
untouched. Desktop reviewer evidence is captured at
`artifacts/lot-number-benchmark/benchmark-reviewer-desktop.png`.

The existing scorer evaluates full-image engine tokens against polygon-scoped
labels; it does not score the separate per-polygon crop guesses. The new
reviewer CSV uses the existing scorer fields and preserves skipped cases as
unresolved, but accuracy comparison of crop-specific OCR still needs a scorer
extension. Reading accuracy and polygon-association accuracy must be reported
separately; no OCR accuracy is established by this sampling pack.

Gemini is not benchmarked: current Google documentation identifies the
image-capable stable model as `gemini-3.5-flash-lite`, but this workspace has no
explicit authorization to upload proprietary Hopkins crops and no human labels
to score against. No request or upload was made; input-token usage and per-map
cost are therefore unmeasured. This remains an optional, blocked comparison,
not a reason to delay the local OCR benchmark.

- [ ] Report token/character scores, ambiguous cases and performance across text/tier conditions.

- [ ] Treat the existing 95% token and 98% character defaults as benchmark candidates, not achieved scores.

- [ ] Obtain clicked endpoints for known reference distances from an approved drawing/survey.

- [ ] Do not infer scale from OCR area medians or an assumed typical road width.

- [ ] Use multiple distributed references, including different orientations where possible, and held-out scale checks.

- [ ] Convert percentage coordinates through native width/height before measuring distances and area.

- [x] Add a provenance-bound road-click recorder with orientation checks, held-out reference-width checks and owner-review-only status (`scripts/record-road-calibration.py`; raw clicks and owner acceptance remain pending).

- [x] Make the road-click page reproducible and source-bound; its browser coordinates map to native pixels, the exact background fingerprint is checked in-browser and again by the recorder, and duplicate endpoint pairs are rejected (local generator, recorder, Chromium regressions, and actual-source load at 390×844 for the 5700×4800 Hopkins image; owner clicks remain pending).

- [x] Leave new tenant scale unset by default and reject malformed explicit scale bands; absent scale runs OCR/matching only, with area validation listed unavailable.

- [ ] Record actual dimension, unit, source, reviewer, timestamp and uncertainty.

- [ ] Resolve inconsistent scale or unsupported distorted regions explicitly.

- [x] Replace implicit 8%/15% defaults with one versioned approval contract shared by the OCR pipeline and correction model; absent/pending policy yields unavailable area results and no bulk proposal.

- [ ] Owner/reviewer approves a concrete tolerance, basis, and evidence reference in the versioned policy record; no tolerance has been selected in code or tenant evidence.

### Acceptance

- [ ] Another operator can reproduce output from the manifest (local `npm run tenant:verify -- --slug hopkins-grove` confirms 15 required inputs, 2 hashed technical-evidence files (`source-audit.json` and `area-validation-policy.json`; no human labels or scale review), and 8 output hashes on this workstation; an independent-operator replay remains open).

- [ ] Crop labels and calibration are reviewed and stored as evidence.

- [ ] Register-to-detection reconciliation classifies matched, ambiguous, missing and non-sellable features.

- [ ] No unavailable measurement is displayed as a pass.

**Evidence:** source audit, benchmark report, calibration record and reconciliation report. Road clicks and labels are required product inputs; their earlier 10-minute and 20-minute estimates are approximate, not guarantees.

## 7. M2 Corrections and quality gates

**Owner:** engineer implements; reviewer accepts data.  

**Backlog:** R04.  

**Inspect:** `src/pages/CorrectionWorkspacePage.tsx` and `supabase/functions/_shared/correction/`.

### Workspace and linking

**M2 visual-correction priority — Integrated Visual Map Editing (12 Oct 2026):** Extend the
existing authenticated `/lots/correct` correction workspace into a map-first
operator experience, with a visible `Lot number review` mode (deep-linkable as
`?mode=labels`). The current standalone `label.html` target-outlined crop page
is a useful diagnostic/benchmark utility, not the intended primary operator
workflow. Its 60-case benchmark is prepared (20 OCR-agreement, 20 disagreement,
20 difficult cases; source-bound manifest and outlined crops), but remains
**0/60 human-labeled**. Preserve its artifacts and browser-local progress.

The integrated mode must render the existing Hopkins reference image and
existing detection polygons in their original map coordinates, reuse the
correction workspace's polygon selection/edit history and the buyer map's
reliable image/geometry coordinate conventions, and keep the buyer embed
read-only. A reviewer selects a polygon on the development map, sees its
detection reference and a high-resolution, target-outlined source crop, and
records a source-drawing decision: exact printed number, ambiguous,
unreadable, or skip. OCR/AI suggestions stay hidden until a blind independent
decision has been saved. Geometry concerns are a separate review state; do
not silently reshape/split/merge/renumber. Where direct geometry editing is
not safe in this packet, provide a working handoff into the existing geometry
correction mode with the target preserved rather than a no-op Edit control.

**Dependency and authority chain:** Human source review creates evidence, not
canonical parcel identity. Reviewed visual labels may then be compared with
versioned extraction candidates and reconciled to the approved register under
M2; legal/register approval remains distinct from reading the drawing. M3A
may render a persistent buyer lot number only from a reviewed polygon-to-lot
mapping that has passed the applicable M2 reconciliation/public-field gates.
Until M4 shared-draft persistence is implemented and verified, this integrated
review must identify saving as browser-local, support resume/export, and make
no cross-device synchronization claim. Authenticated production edits and
publishing remain subject to M4 server authority and approval gates.

**Acceptance criteria (locally exercised; human/release acceptance open):** (1) direct map selection opens the
matching existing polygon and source-aligned crop; (2) pan, zoom, fit/reset,
neighbor navigation and selection remain distinct interactions; (3) a
reviewer can confirm/correct a printed number or mark ambiguous/unreadable/
skip without seeing OCR guesses first; (4) geometry can be flagged separately
and either safely previewed/edited with preserved original and history or
handed off to the existing geometry-correction mode with selection retained;
(5) reviewed, unresolved, ambiguous, unreadable, skipped and geometry-issue
progress is visible and filterable without being confused with sale status;
(6) local save/resume/export preserves benchmark IDs, reviewer, decision,
timestamps, source fingerprints and crop evidence; (7) screenshots and
interaction checks cover desktop 1440px and mobile 390px/320px; and (8) no
unreviewed mapping or local-only review is published as an authoritative
buyer label. Keep this M2 acceptance open until human visual review and the
required persistence/authorization boundaries are verified.

**Local implementation checkpoint (12 Oct 2026):** The visible `Lot number
review` mode is integrated into `CorrectionWorkspacePage.tsx` and uses
`PublicLotMap`'s existing SVG, viewport, image transform, pan/zoom/reset,
polygon hit-testing and selection primitives; this is not an iframe or a new
map engine. The local Hopkins review surface loads the exact 5700×4800,
source-fingerprinted benchmark raster and all 719 existing detection
polygons. Benchmark target polygons are matched against their original map
coordinates before number entry is enabled. Selecting a map polygon shows its
source crop with the target boundary outlined, and the 60-case queue remains
prediction-blind. Confirmed/ambiguous/unreadable/skipped progress is visibly
separate from sales state; number decisions are limited to the benchmark.
Repeated human-entered confirmed numbers surface a source-comparison warning;
they are not silently deduplicated or reconciled.

The reviewer can directly select a mapped detection, flag a geometry issue,
preview vertex adjustments on the same map, save them through the existing
correction edit log with the original geometry retained, and continue to the
next unresolved benchmark case. Versioned JSON and scorer CSV downloads retain
the benchmark/source fingerprints, target geometry, crop evidence, reviewer,
decision, timestamps and geometry-edit history. Existing standalone browser
state was not cleared or overwritten; import accepts a JSON export from the
same manifest. Browser-local storage is still per-origin/device and is not a
shared draft.

**Local verification:** `e2e/integrated-map-review.spec.ts` exercises the 719
polygons and 5700×4800 image, map click selection, crop outline, pan/zoom/reset,
prediction-blind decisions, browser-local resume, correction-log geometry
save, JSON/CSV export, and responsive controls at 320px. Desktop 1440px and
mobile 390px/320px screenshots are in
`artifacts/persistent-lot-labels-review/` (`integrated-map-*.png`). Automated
visual-state screenshots include a conspicuous QA-only banner; their sample
review/geometry flags are not human ground truth. Local typecheck, targeted
lint, the unit suite and integrated Playwright checks passed. Human visual
acceptance remains open.

**Still open:** the benchmark remains **0/60 human-labeled**; no OCR/AI
candidate is shown or approved, no detection reference becomes canonical
identity, and no buyer labels are enabled. Verify the authenticated route
against an authorized session and confirm a correct source image is available
for that tenant/project; this pass's browser run used the explicit
development-only preview. M4 server-backed persistence, cross-device resume,
authorization, legal-register reconciliation, geometry/sellable-area review,
and existing overlap/owner gates are not satisfied by local review. Human
visual approval is required before further M2/M3A work. Keep the standalone
crop reviewer as a diagnostic and import/export bridge, not the primary
operator workflow.

**Focused-editor isolation checkpoint (12 Oct 2026):** At that checkpoint no
editor files were staged, committed, or pushed. The local branch
`feature/integrated-visual-map-editor` then pointed at base
`e6f8aafe49f5a96591918c19402a7a0e9741c25a` and had no upstream. Isolation was
stopped after dependency inspection because `CorrectionWorkspacePage.tsx`
imports the editor layer from `PublicLotMap.tsx`, whose single component also
owns the changed public parcel identity/API model, buyer inquiry modal, map
controls, viewport transforms, polygon hit testing, and selection behavior.
The editor currently normalizes detections through that buyer parcel model;
staging the component with the editor would therefore include or depend on the
unfinished buyer/API refactor. No existing renderer module separates those
responsibilities. Safely resolving this requires extracting a shared,
buyer-contract-neutral map canvas/interaction primitive and adapting both
wrappers; that refactor was not attempted in this checkpoint.

The existing `e2e/integrated-map-review.spec.ts` is not portable to a clean
checkout: it currently expects ignored local Hopkins files under
`out/hopkins-ocr/` and `out/hopkins-lot-number-benchmark-v1/`. No committed
synthetic editor fixture or clean-checkout run exists yet. Prior local test
results recorded above apply only to the dirty checkout with those local
assets; they do not verify an isolated editor commit. No typecheck, lint, unit,
Playwright, or clean-checkout tests were run during this isolation review. No
Supabase, buyer/API, or other existing worktree changes were altered; only this
plan checkpoint note was appended. Next safe step:
extract the shared renderer behind neutral geometry and interaction types,
then add explicit synthetic-only editor fixtures and verify that editor and
buyer regression suites pass from a clean checkout before staging any editor
slice. M2/M3A visual and authenticated acceptance, M3 buyer/API work, and M4
shared-draft persistence remain open; no focused editor commit was created at
that checkpoint.

**Map First integration WIP checkpoint (12 Oct 2026):** Current related
development changes are being preserved together on
`feature/map-first-integration-wip`; this is not a release branch. The staged
WIP includes the M0–M4 plan/evidence templates and review tooling, M1 OCR,
source-audit and calibration code, M2 correction/reconciliation work, the
M3 buyer map and project-scoped public API refactor, and M4 correction-draft
contracts. The editor and buyer still share `PublicLotMap.tsx`; no architectural
separation has been performed. Planned next structural step is a shared,
buyer-contract-neutral canvas/coordinate/selection module consumed by both
buyer and editor wrappers. Add committed synthetic editor inputs so editor
selection, local save/resume, export, geometry review and controls can be
tested in a clean checkout without Hopkins assets.

The source PDF, its SHA-bearing source-audit files, generated Hopkins raster,
crop/review package, screenshots, ignored `out/` data, environment files and
local Supabase state are excluded and remain local. The integration checkpoint
contains migration and Edge Function source only: no migration was applied,
no Edge Function was deployed, and no hosted database was changed. Public lot
number mappings remain unapproved; the 60-case benchmark remains unlabeled;
the editor still saves locally; and the authenticated editor route has not
been verified against an authorized hosted session.

**WIP verification on the current worktree:** typecheck passed; lint passed;
`npm run build` passed; `npm test` passed 240 tests with 0 failures and 3
skipped (243 total). Targeted Chromium Playwright completed 41 passed, 8
failed and 3 skipped. Failures: correction bulk-accept queue expected sample
buttons but found none; demo proof-of-concept copy mismatch; buyer status/tier
legend and marker assertions; buyer heading assertion; selected outline stroke
assertion; persistent-label hover-clear assertion; Hopkins alignment expected
no tier legend. The integrated editor map/review/resume/export test and its
narrow-mobile test passed locally, but they still require ignored Hopkins
assets and are not clean-checkout verification. `npm run verify:public-build`
failed because dev-fixture route text remained in built JS/CSS. Staged-diff
whitespace checks also report trailing spaces in plan/audit text and blank
lines at EOF in two tenant tests. These are recorded, not repaired in this
preservation checkpoint. Human review, M1 mapping approval, M2 authenticated
and persistence acceptance, M3 buyer/API acceptance, M4 shared-draft restore,
and hosted migration review remain open.

- [ ] Carry crops, OCR snapshots, polygons, calibration and register matches into the authenticated workspace.

- [x] Add the minimum local benchmark reviewer: target-outlined source crops; exact-number, ambiguous, unreadable and skip decisions; progress/resume; source-bound versioned JSON and scorer CSV. This remains a blind local review tool, not the full authenticated correction queue; no suggestions are approved and no labels have been entered.

- [ ] Keep printed-number extraction suggestions in a versioned, source-fingerprinted evidence artifact separate from canonical lot identity. Each suggestion must retain detection ID, proposed number, polygon/source coordinates, crop reference, provider/model/version, raw text, confidence/ambiguity, competing candidates, duplicate/missing flags and reviewer status/correction provenance. New suggestions always start unreviewed.

- [ ] Provide an evidence-led review queue and integrated full-map editing mode as specified above; show the outlined detection polygon on its original-context crop, let the reviewer confirm/correct/mark ambiguous or unreadable, and surface duplicate/conflicting assignments before any reconciliation link is approved. The standalone benchmark crop page remains available as a diagnostic utility, not the primary operator workflow.

- [ ] Show unmatched register lots separately from unmatched polygons.

- [ ] Provide queues for duplicates, ambiguous labels, missing figures, unavailable scale and conflicting tiers.

- [ ] Support manual polygon-to-parcel linking without requiring JSON edits.

- [ ] Preserve stable parcel identity through renumbering.

- [ ] Show a proposed diff and undo/history before batch acceptance.

- [ ] Require a strict stratified sample; one wrong sample blocks the proposed bulk batch.

- [ ] Keep Hopkins bulk acceptance disabled until the explicit review/calibration policy passes. Domain and seed issuance now fail closed without scale + policy; visible UI disable state and owner-approved evidence remain pending.

### Signal contract

| Signal | Meaning | Independence and gating |
|---|---|---|
| OCR agreement | Working number still agrees with OCR | OCR-dependent; cannot establish correctness alone |
| Spatial contiguity | Numerical neighbor is physically nearby in a plausible street run | Partly independent: numbers are OCR-derived, geometry is separate |
| Measured area | Polygon area at reviewed scale agrees with an independently reviewed comparison figure | Unavailable without calibration and verified figure; correction model now refuses OCR/working-copy fallback |

- [x] Document `slot.area` as a mutable working-copy area seeded from OCR, and `ocr_area` as the original OCR snapshot (`docs/implementation/area-validation-policy.md`; correction types/model and regression tests agree).

- [x] Use polygon geometry as the measurement, with explicit area units (shoelace plan-area × reviewed scale yields square metres; approved register/human-reviewed area is the comparison value).

- [x] Validate the numerical +/-1 neighbor in the same tier using spatial adjacency (`streetRunSignal`; same-tier ±1 neighbor and centroid threshold are regression-tested).

- [ ] Review the current approximately 1.5-lot-width heuristic for image aspect ratio, rotated lots, parallel streets and barriers such as creek crossings.

- [ ] Use appropriate native-pixel or measured distances rather than uncorrected percentage distances.

- [x] Require separately supplied, provenance-bearing reviewed printed/register area before measured-area comparison can pass; OCR and editable working-copy areas remain unavailable (implemented in the correction model; owner register/review evidence remains pending).

- [x] Prevent unavailable scale/policy from satisfying measured-area or bulk-accept gates in the OCR report and correction domain model.

- [ ] Show the unavailable policy/calibration state in the correction workspace UI; UI copy and disabled-state remain pending.

### Overlaps and completeness

- [x] Recompute current Hopkins within-draft overlap pairs; the current report records 14 pairs (same count as the historical report).

- [ ] Human-review and disposition each reported pair after the sellable/common-area classification is approved; do not infer a waiver or common-area status from tier labels. See `docs/implementation/overlap-review.md`.

- [ ] Classify common areas before treating every detected shape as a sellable parcel.

- [x] Block `correct -> validate` for each unresolved within-draft overlap (shared stage/publish gate; regression-tested).

- [x] Bind overlap waivers to a normalized exact pair, non-empty reason, actor, timestamp, exact polygon snapshots and per-lot geometry revisions; legacy unbound waivers fail closed.

- [x] Invalidate waivers when affected geometry changes or is undone (geometry revisions are monotonic; regression-tested).

- [ ] Expose overlap-pair waiver authoring and stale-waiver status in the correction workspace UI; Hopkins-specific waiver decisions remain pending human review.

- [ ] For a full launch, link every in-scope sellable register lot to exactly one approved polygon.

- [ ] Prevent one polygon from representing multiple sellable lots.

- [ ] For a partial launch, record the approved phase/scope and show it publicly.

### Required checks

- [x] A numerical neighbor across the map fails the adjacency signal (`bulk-accept-slice16.test.mjs`).

- [x] Missing scale yields unavailable; incorrect measured area fails when calibration exists (`bulk-accept-slice16.test.mjs`).

- [x] A wrong reviewed sample blocks the bulk batch (bulk-accept regression test).

- [x] An unresolved overlap blocks advancement; a valid specific waiver allows only the approved exception (`overlap-gate-slice17.test.mjs`).

- [x] Changes to a waived pair force renewed review (`overlap-gate-slice17.test.mjs`; geometry edits and undo both invalidate the waiver).

- [ ] Coverage totals balance against the declared register scope.

**Evidence:** correction diff, sample review, gate report, overlap decisions and coverage report.

## 8. M3 Public map and Demo A

**Product baseline and scope:** This milestone polishes the already implemented React `PublicLotMap` and `/embed/:tenant`. It does not authorize a new map engine, a replacement static HTML buyer product, or presentation approval based on the local synthetic `?demo=1` grid. Compare the React experience with the visual standard set by the original Hopkins Grove standalone PoC.

**Two independent gates:** (1) **UX completion** may proceed in parallel with missing M1–M2 owner evidence; (2) **shareable Demo A release** still requires the approved register/declared scope, public-field allowlist, reviewed geometry, safe frozen payload and release review. Neither gate implies the other.

**Owner:** engineer; Edmund rehearses the buyer journey.  

**Backlog:** R05; public-project scoping portion of R06.  

**Inspect:** public map/embedding components, `supabase/functions/get-public-lots/`, iframe snippet generation and existing map tests.

### M3A: UX recovery and product-owner acceptance (prioritized next visual work)

- [ ] Review the **current actual React embed** against the original standalone PoC using screenshots; note which brand colors, map presentation, spacing, controls and detail hierarchy made the original appealing. Do not copy illustrative business values or placeholder actions.
- [ ] Make the actual project masterplan and lot geometry the hero of the React buyer experience. Fix excessive portrait letterboxing and unhelpful default framing without stretching, shifting, inventing or silently cropping mapped lot coordinates. Preserve pan/zoom access to the declared scope and maintain source-image/polygon alignment.
- [ ] Polish status/tier palette, quiet underlying map, selected-lot emphasis, search, filters, legend, loading/failure states, detail panel, and inquiry affordance. Prefer clean, purposeful controls and meaningful actions over adding decoration.
- [ ] Improve responsive layout: large usable map; selected-lot bottom sheet that does not obstruct essential map controls; readable lot information and usable touch targets at 1440px desktop, ~390px phone and ~320px narrow phone.
- [ ] Verify the actual buyer journey: open embed -> orient on development -> find/select a mapped lot -> inspect only source-supported/public-safe details -> open/complete expected inquiry (where the path is authorized) -> return to map. Explicitly distinguish a read-only demo inquiry preview from a connected sandbox submission.
- [ ] Show persistent, source-verified printed lot numbers inside their own polygons without requiring selection. Use an interior-point placement, viewport-aware collision/readability rules, and pointer-transparent labels; zooming/navigation must reveal additional labels while selection emphasizes the same label. **M2 dependency:** only render a number after its polygon-to-printed-lot association has review evidence; do not display generated detection IDs or unreviewed OCR matches as sale-lot numbers.
- [ ] Capture before/after desktop and mobile screenshots **of the real React map with Hopkins imagery**; record viewport size, build/revision and data provenance. Synthetic-grid screenshots cannot satisfy this gate.
- [ ] Obtain **Edmund's visual approval** of the buyer experience before M3A can be marked visually accepted. Passing Playwright, typecheck or local build alone is insufficient.
- [ ] Preserve existing functionality and all source/publication guards; avoid unrelated database, AI, payment, SaaS tenancy or new map implementation work in the UX sub-packet.

**Persistent-label verification note (12 Oct 2026):** A read-only GET of the staging public-lots feed returned 743 unique nonblank record identifiers: 719 drawable polygons and 24 records without drawable geometry. All 719 public polygon arrays exactly match the local Hopkins detection geometry, but those polygon rows are labeled `L-001`…`L-719` generated detection IDs, not independently verified printed/legal lot numbers. The local OCR build has 618 `unmatched`, 15 `duplicate`, and 86 `matched` detections; all 719 still have `needs_review: true`, and the 86 OCR values are not approved links. No approved register or reviewer-supplied map links/dispositions exist (`docs/implementation/register-reconciliation.md`). Consequently no polygon-to-lot-number association is currently trustworthy enough for persistent buyer labels; the labels were **not implemented or rendered** in this pass. The 24 geometryless records remain an explicit reconciliation item. Do not treat row-level uniqueness or OCR output as M2 approval. M3A label and visual acceptance remain open pending human review evidence and subsequent local visual review.

**Lot-number extraction dependency (12 Oct 2026):** The current 86 page-wide matches, 662 per-crop OCR reads and 509 area-anchored number candidates are extraction suggestions only; none has been independently verified against a human-labeled benchmark or approved register. The existing 100-crop sheet is blank and does not outline the target detection polygon, so it cannot establish polygon-association accuracy. Persistent buyer labels remain blocked until source-grounded human review and explicit M2 reconciliation links are available.

### M3B: public data, count and truth review

- [ ] Reconcile the reported staging observation: 743 API records, 719 displayed unique lot IDs and all observed API statuses `Available`. Explain record scope, duplicates, nonrenderable shapes, identifier normalization, optional project/phase filters and UI mapping without silently changing data.
- [ ] Cross-check React lot IDs and geometries against the approved register, source audit, intended sellable/common-area scope and reviewed map. The standalone's 861 sample polygons and local fixture's 60 synthetic lots are **not** authoritative denominators.
- [ ] Withhold unapproved counts, sale statuses, tier prices, area values, "selling fast" indicators and availability promises from public-facing presentations; use scoped provenance/disclosure where a visual PoC is permitted.
- [ ] For any live inquiry, validate that selected public lot reference resolves to the correct project and a supported state on the server; do not transform sample selection into a false reservation.

### Public experience

- [x] Verify image/polygon rendering alignment at different zoom levels and display aspect ratios (a local Hopkins-image E2E checks 719 detection polygons across three viewport ratios and 1×/1.5×/2× zoom in Chromium and WebKit/iPhone; source-boundary acceptance remains open at edge ratio 1.3274 vs 1.20, with the M1 diagnostic now showing the same +0.35% Y probe strongest in all quadrants—no geometry correction was applied; see `docs/implementation/polish-check.md`).

- [ ] Verify one-palette-per-view and quiet-base acceptance against the actual Hopkins raster **and the current React embed UX**, not only the neutral synthetic E2E fixture. The React buyer view applies display-only grayscale and 0.68 opacity to the raster, with the original and lot geometry unchanged. The actual-source E2E now checks all 719 anonymized overlays as Sold-square/red in status mode and uniform circles in the injected green tier palette, plus computed raster treatment and geometry across three viewport ratios and zoom levels; the forced Sold state is a deterministic visual fixture, not inventory. The raster's baked labels/branding remain dense and phone portrait leaves blank canvas, so quiet-base/source-fit reviewer acceptance is still open. Paint-out stays held; see `PRODUCT.md` and `docs/implementation/polish-check.md`.

- [x] Test search, tier filters, available-only filter, selected-lot links and pan/zoom reset (local Playwright functional coverage in Chromium and mobile viewport emulation; see `docs/implementation/polish-check.md`; no device/performance claim).

- [x] Prevent accidental lot selection during panning (local drag/pan regression passes in Chromium and mobile viewport emulation; see `e2e/lot-map.spec.ts`).

- [ ] Test phone touch selection, fullscreen entry/exit and return from inquiry (the exit/zoom control stack now lifts above an open bottom-sheet card even in fullscreen; a bounds-and-touch E2E passes in Pixel 7 and iPhone 13 WebKit emulation. The mocked inquiry flow moves focus to its confirmation action, then restores the inquiry trigger on close. No physical phone has been tested; see `polish-check.md`).

- [ ] Show correct project/phase, lot identifier, verified area/unit, price basis and status.

- [x] Provide useful loading, empty, failure and retry states (accessible states exist; synthetic browser tests now exercise empty data, service failure and retry recovery on Chromium and mobile viewport emulation; production-route and real-device verification remain open).

- [ ] Provide keyboard access, visible focus, readable contrast and a list/search path to lot details (search results and the SVG map listbox both work by keyboard: arrow keys move among map lots, Home/End jump to the visible-list endpoints, Enter/Space open details, and Escape returns to search. A high-contrast outline follows the active map option; status mode pairs color with circle/diamond/square cues, while tier mode keeps a uniform marker shape. The 12-check Chromium/Pixel 7/WebKit/iPhone 13 keyboard regression and five-project palette/shape checks pass. Keep this release gate open for approved-payload review, physical-device and screen-reader verification; see `docs/implementation/m3-accessibility-audit.md` and `docs/implementation/polish-check.md`).

- [x] Fix the `is_default`/`isDefault` mismatch and explicitly scope project selection; active-version lookup errors now fail closed (implemented locally; unit-tested; Edge Runtime verification pending).

- [x] Resolve active map, theme/profile settings and tier catalogue by project; only the default/legacy map may fall back to tenant-wide settings (local schema, endpoint and publisher implementation; Edge Runtime verification pending; see `docs/implementation/project-scoped-public-map.md`).

- [x] Filter at the server query boundary rather than retrieving every tenant parcel and filtering in the browser (project equality plus active-version NULL-or-match filter are serialized in the generated Supabase URL; local unit and disposable DB checks pass; Edge Runtime verification pending).

- [x] Read the theme URL spelling written by `tenant-publish` and accept only this tenant's published Storage CSS object (camelCase `cssUrl`; local URL validation tests pass).

- [x] Replace internal parcel IDs across public lot surfaces with project-scoped public references: `get-public-lots` omits row IDs; inquiry and application submissions resolve references server-side; browser selections use references/local-only keys; the legacy view and direct anonymous application insert are closed by a local additive migration. Static/unit coverage passes. Hosted migration/function rollout and live smoke verification remain pending before public-field sign-off; nothing was applied remotely.

### Performance targets to measure

| Measure | Proposed first-release target |
|---|---|
| Useful map visible | Within 3 seconds on a documented midrange phone/good-4G profile |
| Initial transfer | Aim for 2-3 MB of critical assets and public payload |
| Desktop pan | At least 30 FPS on the agreed reference device with launch data |
| Inventory freshness | Defined behavior; start with updates visible within 60 seconds |
| Reliability | No console errors on the demo path; refresh and deep links work |

These are targets, not baseline measurements. Load higher-resolution imagery on demand. Implement tiles or paint-out only if measured readability/performance requires them; preserve original evidence and boundaries.

### M3C: approved, sendable sample demo delivery

- [ ] Add a production-compatible frozen sample datasource/route using approved public fields.

- [ ] Label sample availability and the declared map scope (the development-only React preview now displays both M0 strings, “Proof of concept, sample data” and “traced from sales plat”; it does not state an approved launch scope and is not the required production-compatible frozen route).

- [ ] Do not depend on development-only `?demo=1` behavior for the hosted presentation (post-build `verify:public-build` guard now rejects the dev fixture route/loader markers and private source artifacts; a production-compatible approved sample route is still absent).

- [ ] Ensure sample mode does not call unsafe business APIs or perform business writes (the existing dev-only `?demo=1` fixture is verified read-only; this does not satisfy the still-missing production-compatible frozen sample route).

- [ ] Test the public link from a fresh/incognito browser and a phone.

**M3A UX acceptance:** actual React embed is visibly usable and polished at desktop, portrait mobile and narrow phone widths; core selection, navigation and information journey work; product-owner visual sign-off is recorded. This can happen **before** all register approvals but is not public-sales release approval.

**M3B data acceptance:** the observed public-record discrepancy and status semantics are explained, public fields and declared scope are approved, and lot identities/geometry are reconciled before factual inventory claims.

**M3C Demo A release acceptance:** a frozen, approved, read-only sample has a stable fresh-browser/phone URL, labels, no unsafe business writes, tested controls and measured budgets. The M0–M2 sign-offs and authorization are satisfied. **Evidence:** real React screenshots, mobile/device tests, owner sign-off, source/reconciliation report, performance trace and the working approved URL.

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
| R05 | P1 | Polish **existing React embed**, secure product-owner visual sign-off, reconcile public count/status presentation; measure budgets; deliver approved frozen demo | M3A–M3C |
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

### Cross-cutting scope boundaries for later milestones

M4–M9 remain part of this **same** implementation plan. Do not rewrite or accelerate them to address a visual UX defect. In particular, do not treat an appealing map as proof of secure shared drafts, exact-version publishing, tenant isolation or live business payment processing. Later Wamule Customer Portal, PlacetoPay, AI Operator and AI receipt intelligence are separate product roadmap opportunities, not authorization to expand the Map First release scope.

## 17. Evidence and verification rules

- Run checks appropriate to each change and the repository's required build/type/lint/test workflow.

- Inspect actual package scripts and installed CLI help before choosing commands.

- For database changes, use real Postgres with authenticated-role behavior and explicit fixtures in both tenants.

- For runtime proof, serve/invoke the actual function. Static import checks supplement this evidence.

- For shared editing, use two browser sessions and reload/reopen, not only an in-memory store.

- For embed proof, use another origin and a fresh buyer session. For M3 visual acceptance, always use the **actual React Hopkins embed**, not only a synthetic fixture; record desktop/mobile screenshots and product-owner review.

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

## 18. Plan-led execution handoff (next work is **not yet authorized**)

This section replaces the outdated "start with M0 and M1" prompt. Those engineering activities already have substantial implementation and test evidence; repeating them blindly would waste time. **First reconcile the current repository worktree, owner inputs and plan.** Do not start a new autonomous task until the product owner approves the revised plan and picks the next sub-packet.

### Review checkpoint before any implementation

1. Inspect the current checkout/dirty worktree and identify which original M0–M3 entries truly match code, test and evidence in the current branch; keep historical baseline and hosted state separate.
2. Confirm the canonical React staging embed and original standalone design reference are both accessible; do not substitute `?demo=1` for the actual buyer map.
3. Confirm the M0 inputs that **require a person**, especially launch scope, approved register, sellable/common-area classification and public-field allowlist. Record their owners rather than inventing answers.
4. Confirm the currently available M1 crop-label and road-calibration review tools and handoff needed to receive owner evidence. Do not require another long rebuild just to report outstanding approvals.
5. Review the 743/719 records and observed `Available` status as a diagnostic, without rewriting the data before understanding its definitions.
6. Agree on the next **single** bounded sub-packet and its acceptance evidence, with product-owner visual acceptance required for React UI work.

### Recommended next sub-packet after plan approval

**M3A — buyer UX recovery on the existing React embed**, while M0/M1/M2 reviewer inputs proceed independently. Deliver real desktop/mobile before-and-after screenshots, the updated local React preview, functional/visual evidence, and an explicit stop for Edmund's review. Do not change source-of-truth approval, migrate databases, deploy, overwrite the standalone PoC or create a new map.

### Single repeatable handoff rule for Codex

When a sub-packet is approved: **"Use `docs/Wamule_Map_First_Release_Plan.md` as the authority; inspect the current worktree and existing evidence; implement only [approved sub-packet]; preserve safety and user changes; do not deploy; stop at the agreed checkpoint; report implemented, tested, visually reviewed, blocked and not run separately."**

### Exit report (every sub-packet)

- Scope and plan checklist IDs addressed; no unexpected scope expansion.
- Files changed, without overwriting unrelated/uncommitted work.
- Real product behavior visible, including before/after screenshots and local URL for UI work.
- Checks passed; checks blocked/skipped; staging/runtime state actually verified versus assumed.
- Any discovered plan discrepancy and proposed checklist correction.
- Product-owner review requested; **do not autonomously advance** into the next milestone.

## 19. Reference baseline

- [Pinned repository baseline](https://github.com/edmundciego/wamule-bz/tree/3c368d22dd25695ea57c3c236d436cc94b2c91b2)

- `Wamule_Product_Roadmap.docx`, current saved roadmap read on 10 October 2026.

- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)

- [Supabase Securing Edge Functions](https://supabase.com/docs/guides/functions/auth)

- [Supabase Database Backups](https://supabase.com/docs/guides/platform/backups)

- [Supabase Custom Domains](https://supabase.com/docs/guides/platform/custom-domains)

- [Netlify Manage Multiple Domains](https://docs.netlify.com/manage/domains/manage-domains/manage-multiple-domains/)

The Markdown document is an implementation handoff derived from the reviewed roadmap. It does not apply migrations, deploy code or establish that hosted acceptance gates have passed. Reconfirm repository and platform versions when implementation begins.
