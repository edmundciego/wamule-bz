# Project-scoped public map implementation

**Status:** implemented in the local worktree only. No hosted migration, function, storage, or application writes were made.

## Contract

- `project_id` is the scope for parcel identity, map revisions, public presentation settings, and tier prices. A display lot number may repeat in a different project, but not within the same project and tenant.
- Existing unassigned parcels and map versions are migrated to the tenant's default project when one exists. New tenant-level map-version inserts also resolve to that default project; NULL remains the legacy scope when no default exists.
- Project map versions own both the background `image_url` and optional `preview_url`; activating one revision only deactivates the previous active revision in that project.
- Non-default projects read only their project settings and tier catalogue. The default project may use the old tenant-level settings/catalogue as a compatibility fallback. Publisher writes mirror default-project theme/tier values to the old tables for older admin readers.
- Project theme tokens/card copy are scoped per embed. Custom `overrides.css` remains tenant-wrapper-scoped, so non-default project publishing refuses it and the public endpoint will not load it; project-specific CSS waits for a project wrapper scope.
- `project_settings` and `project_lot_tiers` have RLS enabled and no direct anon/authenticated grants. The public Edge Function reads them as service role and emits only the existing public allowlist.
- `tenant-publish` and `publish-lots` resolve a project under the selected tenant, preflight project schema before writes, query/diff/update only that project's parcels, and never bulk-assign legacy NULL rows to the selected project.

## Local verification

- `node --test test/get-public-lots.test.mjs test/public-theme-url.test.mjs test/project-publisher-scope.test.mjs`: 16 tests passed.
- `python3 scripts/project-scope-db-harness.py --pgdata <disposable-temp-dir> --reset`: 6 database invariants pass on embedded Postgres. (The Node wrapper is `test/project-scoped-public-maps-db.test.mjs`.)
- `npm test`: the latest local run completed 238 tests/suites: 235 passed, 0 failed, and 3 live-staging checks skipped by default. The browser smoke suite is recorded separately in `polish-check.md` because its unrelated correction-app bulk-accept fixture fails with a zero-lot proposal.
- `npm run typecheck`, `npm run lint`, and `npm run build`: passed after adding project table and map-version types. That initial build had the ~1.22 MB shared-chunk warning; the local route split described below breaks the entry into page-specific chunks.
- The original unsplit build emitted one 1,219.42 kB minified / 332.47 kB-gzip JavaScript chunk shared by the public map and admin pages; that is the before measurement, not the current build.
- Route-level lazy loading is now implemented locally in `src/App.tsx`. The fresh production build emits a 271.14 kB minified / 86.21 kB-gzip entry chunk. The recursive manifest dependency closure for `/embed/:tenant` contains eight JavaScript assets totaling 164,164 gzip bytes; the application-wide CSS is 10,374 gzip bytes. Admin route chunks are not in the embed's dependency closure. These are build-asset gzip sizes, not a browser network trace, and exclude the background and lot payload.
- A fresh isolated `vite build --manifest` reproduced that embed closure at 174,538 gzip bytes including CSS (606,090 raw bytes). For a byte-budget model only, 719 candidate polygons (3,965 vertices) were paired with anonymized identifiers and synthetic public field values: 279,440 JSON bytes raw, 24,672 gzip, or 19,154 Brotli. Adding the current 311,168-byte mobile preview and 471-byte gzipped HTML gives a modeled core mobile transfer of 510,849 bytes; using the 804,702-byte full background gives 1,004,383 bytes on desktop. This indicates the modeled assets fit the proposed 2–3 MB transfer aim, but it is not an approved register/API payload or browser/device measurement; headers, branding assets and actual hosting behavior are excluded.
- Added `scripts/verify-public-build.mjs` and `npm run verify:public-build`; the full `npm run verify` flow now runs this guard after the production build. It requires `noindex,nofollow`, scans text assets for dev fixture markers, rejects known private map files, PDFs by extension or header signature, and symlinks, and reports counts without printing bundle content. Six negative/positive tests pass. This is static artifact evidence only, not proof of hosting access control or a production sample route.
- A serial Chromium Vite-dev probe after splitting, under the same cache-disabled 50 ms RTT / 12 Mbps down / 6 Mbps up / 4× CPU profile, measured useful-map-ready at 3.75 s and 4.32 MB same-origin transfer (prior probe: 6.70–6.74 s and 9.11 MB). A fresh repeat measured 3.72 s, 4,318,373 bytes total same-origin transfer, and 1.67 s FCP. This is synthetic-fixture development evidence only: useful-map-ready still misses the proposed 3 s target, and no phone, production sample-route, hosted-payload, or sustained-frame-rate result is claimed.
- The latest isolated production-bundle probe built into a disposable directory and served a gzip API fixture plus WebP assets over loopback. The 12 October recheck rendered all 719 private Hopkins candidate polygons (3,965 vertices) in Chromium at 412×839/DPR 2.625, cache disabled, 50 ms RTT, 12 Mbps down, 6 Mbps up and 4× CPU: **1.387 s useful-map-ready**, **0.496 s FCP**, and **515,833 bytes total browser transfer**. The gzip API payload was 22,384 bytes and the 311,168-byte mobile preview was the only map image requested; no full-resolution background was fetched. The browser made one local API request and one local preview request, contacted zero external origins, and reported zero page/console errors. This is a local, network-throttled production-bundle simulation using private Hopkins geometry with anonymized labels and synthetic/absent public fields. It is not a physical phone, sustained-frame-rate, approved-payload, Edge Runtime, or hosted-route result; the 3-second aim remains provisional.
- `npm run build` and `npm run lint` pass after route splitting. Focused preview-safety E2E passes in Chromium, Pixel emulation, and WebKit/iPhone emulation. The broader 44-test Chromium E2E run had 40 passes, 3 skips, and one unrelated correction-workspace failure: its bulk-accept test expected at least two sample buttons, but the fixture produced a zero-lot proposal. That failure is tracked honestly; the test was not weakened.
- `node --check scripts/tenant-publish.mjs` and `node --check scripts/publish-lots.mjs`: passed.
- Static bundle of `get-public-lots` with its local imports: passed; Edge Runtime execution remains unverified.

## Current local recheck — 12 October 2026

- The latest `npm run verify` passed brand, typecheck, lint, and all unit tests before the E2E smoke phase. `npm run tenant:verify -- --slug hopkins-grove` independently rechecked the private candidate manifest: 15 required inputs, 2 hashed technical-evidence files (`source-audit.json` and `area-validation-policy.json`, not human labels/calibration) and 8 output hashes pass on this workstation. This is not an independent-operator replay.
- The installed Supabase CLI is 2.105.0. Its local `status` check cannot reach a Docker daemon (`docker` and `deno` CLIs are not present), so no Edge Runtime request was run. The official [Edge Functions quickstart](https://supabase.com/docs/guides/functions/quickstart) requires Docker for local function serving. Unit tests, static bundling and the disposable Postgres harness remain useful but do not substitute for this runtime proof.
- No `supabase start`, remote API request, hosted migration, function deploy, storage upload or business write was performed.

The live staging checks in `test/e2e-public-embed.test.mjs` now require the deliberate `WAMULE_RUN_LIVE_E2E=1` opt-in; the inquiry roundtrip uses a unique run key and only cleans up that exact row. The suite was verified with this opt-in unset.

## Still open

- Scope/register/reviewer, sellable/common-area and public-field decisions remain owner inputs in M0; nothing in this packet infers them.
- No map labels, road calibration clicks or tier/register approval are supplied by this schema work.
- The Edge Runtime and hosted API have not been exercised. Migration ordering, fresh-bootstrap history, backup and hosted approval remain gates; do not run `db push`, function deploy, storage upload, or release commands as part of this local packet.
- The authenticated admin gallery is not a project switcher. Multi-project authoring UX and scoped admin access remain later M4/M6 work.
