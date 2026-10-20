# Map Studio → Project Admin → Website embed

This is the repeatable map workflow. Map Studio is a separate local application.
Project Admin is the Wamule application backed by Supabase. The public map is
served by the existing frontend and reads only the published project/phase.
Questions about published Studio plots route to that project's inquiry queue
in either sales or demo mode, without creating or allocating inventory.

## Where to find each part

| Part | Open it here | Purpose |
| --- | --- | --- |
| Map Studio | Run `npm run studio`, then open `http://127.0.0.1:5340` | Extract, review, edit, export |
| Project maps | Admin → **Maps**, `/maps` | Compare, import drafts, edit plot data, publish |
| Inventory | Admin → **Lots**, `/lots` | Existing sellable records and sales status |
| Public map | `/embed/{tenant}/{project}?phase={phase}` | Published map, details and inquiries |
| Earlier correction tools | Admin → **Correct**, `/lots/correct` | Existing correction/proposal workflow; retained |
| Earlier raster import preview | Lots → **Bulk Ingest** | Legacy `lots.json` preview; use Maps for Studio packages |

Studio has no Supabase dependency or credentials. A project is chosen when the
package reaches Admin. Preparing a drawing does not require onboarding a tenant.

## First-time local setup

From the repository root:

```sh
npm ci
python3 -m venv .venv-map-studio
. .venv-map-studio/bin/activate
python3 -m pip install -r scripts/map-studio/requirements.txt
npm run studio
```

Keep that terminal open. The extraction worker uses its `python3` environment.
The source upload is to a loopback worker on this computer, not a hosted service.
The worker removes its temporary source copies after processing. Export a package
to save work; editing state is otherwise in memory. Reopen that package to resume.
`npm run studio:build` checks and builds the standalone UI; it does not provide a
hosted extraction service. The supported local command is `npm run studio`.

## When Wamule sends an AutoCAD drawing

1. Obtain the original DWG and a **DXF export**. Ask for a reference PDF, drawing
   units and any plot/area/price spreadsheet. The original file remains evidence.
2. Open the DXF in Studio. Its closed plot boundaries and usable text are read
   directly. Select the plot layer and extract again to exclude non-plot shapes.
3. Check that the intended phase is represented. Confirm the phase against the
   owner's register; the extractor does not force Wamule's count to 20, 23 or 24.
4. Review numbers and boundaries. Unknown units leave area blank. Known CAD units
   allow a calculated area; entering an area from a register marks it recorded.
5. Add categories, colors, default prices, currency and price basis. Use the plot
   inspector for individual overrides or download/import the plot CSV.
6. For boundary edits, enable **Edit boundary vertices**. Drag or enter coordinates,
   optionally snap to a display grid, and use **Restore original boundary** if
   needed. These edits leave area and original geometry unchanged. Review again.
7. Mark the inspected boundaries reviewed and **Export map package**.
8. Open Admin → Maps. Select the correct tenant/project/phase at the top. Open the
   package, read the comparison and choose **Import as draft**.
9. Link outlines to existing inventory records where appropriate. The server
   checks all four IDs belong to the same scope. Existing inventory supplies the
   linked record's public number, dimensions and price. The import itself does
   not create saleable inventory, change sales status or allocate a lot.
10. Preview the imported version, edit plot/category content, review boundaries,
    then **Publish map**. Copy the URL or iframe from **Website embed**.

For a revised drawing, open the previous package first and explicitly select
**Use the next source as a revision**. Dataset identity plus each source plot key
is the stable match. A freshly opened unrelated source starts a separate dataset.
CAD handles may change when a drawing is rebuilt: inspect the new/matched counts;
the tool does not silently guess a match across unrelated entity identifiers.

## Other source formats

| Source | Implemented extraction | Operator action |
| --- | --- | --- |
| DXF | Closed 2D polylines, flattened curved edges, usable text and supported block contents | Choose layers, confirm units, review matches |
| Vector PDF | Supported closed straight paths and text on the selected page | Review shapes; supply actual land areas separately |
| Raster PDF / PNG / JPEG / WebP | Existing color-based lot detector, display WebP | Add category fill colors first; review detections; assign numbers manually or by CSV |
| Studio JSON package | Full local draft recovery | Continue editing or import in Admin |
| DWG | No direct reader | Export DXF from the CAD application |

Open linework, complex Civil 3D/proxy entities, arbitrary vector-PDF curves and
automatic split/merge repair are not supported by this first adapter. Unsupported
CAD entity counts are reported. Raster extraction does not assert official plot
numbers or surveyed areas. There is no external AI provider or API charge.

## Package and import behavior

A `.wamule-map.json` contains schema version, dataset ID, revision, source
checksum, canvas proportions, optional embedded image, categories and plot data.
Plot data includes stable key, number, kind, current and original display
boundary, retained source coordinates, area/unit/basis, dimensions and price.
There are no tenant IDs, credentials, sales statuses or buyer records in it.

Files are limited to 24 MB, display images to 10 MB, and outlines to 5,000 with
3–200 display vertices each. Duplicate keys/numbers, invalid coordinates and
crossed/zero-area boundaries are refused. Background bytes are checksum checked.
Recorded area is never recalculated from percentage-based display coordinates.

Imports are transactional and scoped. An identical package reuses one snapshot.
Geometry revisions reuse identities and preserve Admin's existing plot/category
details. Absent identities stay in history. Drafts do not change the public map.
Publishing changes only this phase's displayed snapshot; previous versions remain
available to select and republish. A stale publish or stale plot save is refused.

Category codes identify a project-wide catalogue entry. The comparison lists
conflicting names, colors and prices before import; existing Admin values win.
Rename the code in Studio to create a distinct category, or deliberately edit
the shared category in Admin. Renaming in Studio updates that draft's plot links.

Admin category edits update the package map's HTML category guide and plot colors;
plot edits update its details. These reads use live records, without regenerating
SVG assets. Hopkins's existing homepage category cards also read the active package
catalogue once one is published. Until then they use the current source guide.
The existing Hopkins snapshot is not automatically converted or republished.

## Hosted deployment boundary

The Map Studio Admin workflow is deployed to the existing `wamule-staging` site
and staging Supabase project. The additive
`map_studio_packages_and_project_plot_content` migration is present in the
staging ledger; `get-public-lots` and `submit-public-inquiry` serve the package
workflow. Production has not been changed.

The migration adds project map packages and plot content to the existing feature
identity/snapshot model. Display images use a private Storage bucket. Only the
public API signs images belonging to the active published package. Browser users
cannot directly mutate snapshots or overwrite/delete their images. Admin actions
verify tenant, project and phase and preserve existing inventory and leads.

Staging builds keep `VITE_PUBLIC_DEMO_MODE=true`. The optional
`VITE_PUBLIC_STAGING_SUBMISSION_SCOPES` setting allows server-backed form tests
for exact `tenant-slug/project-slug` pairs. All other demo submissions stay in
the browser. The only configured QA pair is
`map-studio-workflow-test/map-studio-import-qa`; its project remains in `demo`
mode, and the hosted inquiry function suppresses email for that mode.

The embed generator uses `VITE_PUBLIC_EMBED_BASE_URL` when configured, otherwise
the current frontend origin. It always includes project and phase. A tenant can
paste the iframe into WordPress, Webflow or another website; separate tenant
hosting is not needed for an embed. A local URL is only useful on that computer.

## Verification commands and limits

```sh
npm run studio:test
node --test test/map-package.test.mjs
npm run studio:verify-db
npm run typecheck
npm run studio:build
npm run build
npm run verify:public-build
```

The database rehearsal executes the real additive migration in PostgreSQL compiled
to WebAssembly (PGlite), with simulated tenant sessions and a generated CAD fixture.
It exercises extraction → validation → import → review → publication, idempotence,
price edits, stale actions, inventory links, isolation, retention and Storage SQL
policies. It is not hosted Supabase Auth/Storage, a concurrency test, production
recovery evidence, or verification of a new Wamule drawing. It needs no Docker.

## Local checkpoint — 19 October 2026

This checkpoint was verified on `codex/map-studio-workflow` from a synthetic
three-plot DXF fixture. It is not evidence about a new Wamule or Hopkins drawing.

- Node 24.19.0 dependencies installed from the lockfile; Python 3.12's dedicated
  `.venv-map-studio` has the pinned extraction requirements.
- Extraction fixtures: **6/6 passed**, covering DXF, unknown units, ambiguous
  numbers, vector PDF, raster input and the DWG export requirement.
- Portable package tests: **11/11 passed**. Vite configuration regression test:
  **1/1 passed**.
- PostgreSQL/WASM lifecycle rehearsal: **13/13 passed**, including scoped plot
  inquiries and retry deduplication. It uses a local synthetic CAD drawing and
  simulated tenant sessions, not hosted Supabase Auth or Storage.
- Full Node suite: **324 passed, 0 failed, 4 skipped**. Skips require staging
  secrets/database tools or private Hopkins review assets that are not in this
  checkout.
- Typecheck, standalone Studio build, application build, public-build guard,
  brand check and changed-file lint passed. Repository-wide lint still reports
  the unrelated `no-explicit-any` in `supabase/functions/_shared/workspace-auth.ts:6`.
- A headless browser exercised the local extraction endpoint and Studio at
  `http://127.0.0.1:5340`, with the main app on `http://127.0.0.1:5180`. The DXF
  produced printed labels 101–103 using the PLOTS layer and metre units. Search,
  selection, zoom/reset, plot/category metadata, CSV export/import, package
  export/reopen, and revision identity were checked. Editing and restoring a
  boundary retained the original polygon and recorded 150 m² area.
- At 390px and 320px, Studio had no horizontal overflow. Browser console errors
  were clear after adding an empty data favicon. Native-size screenshots are in
  `/private/tmp/wamule-map-studio-visual-evidence/` for this session.
- The Admin page could not connect to a local or authenticated Supabase backend:
  the isolated checkout has no protected `VITE_SUPABASE_URL` or
  `VITE_SUPABASE_ANON_KEY` configuration. The database rehearsal verifies the
  SQL lifecycle and RLS predicates, but the Admin comparison/editor/version/embed
  journey still needs a later authenticated staging browser session.

Running both Vite apps together initially exposed a React hook failure because
their prebundled React dependencies shared an optimizer cache. Map Studio now
uses its own ignored cache directory and deduplicates React/React DOM; a runtime
configuration regression test protects this setup.

## Current workstation recheck — 19 October 2026 (local only)

This recheck ran on `codex/map-studio-workflow` after the patch commit. It used
only a generated three-plot DXF; it did not connect to staging or change hosted
maps, records, functions, migrations, or deployments.

- Node dependencies already present in this checkout passed `npm ls --depth=0`.
  The shell default is Node 18.18.2, so checks used the available bundled Node
  24.19.0 runtime. Python 3.12's ignored `.venv-map-studio` imports `ezdxf`.
- Studio extraction tests: **6/6**. Map-package tests: **12/12**. The local
  PostgreSQL/WASM map lifecycle rehearsal: **13/13**, with no hosted writes.
- A browser upload extracted the `PLOTS` layer, metre units and labels 101–103.
  Search, outline selection, zoom/reset, vertex edit/restore, plot and category
  edits, CSV export/import, package export/reopen and a new geometry revision
  worked. The revision retained its dataset ID and all three CAD source keys.
  Restoring a changed boundary left the recorded area at 150 m².
- At 1440px, 390px and 320px, the Studio page had no horizontal overflow. The
  browser reported no console errors. Native-size captures are in
  `/private/tmp/wamule-map-studio-local-evidence/` (`studio-source-1440.png`,
  `studio-source-390.png`, `studio-source-320.png`, plus edited-data captures).
- Typecheck, standalone Studio build, application build, public-build scan,
  brand check and changed-source lint passed. The public-build scan checked 81
  files and found no development map fixtures or private source artifacts.
  Repository-wide lint still fails only on the unrelated
  `no-explicit-any` at `supabase/functions/_shared/workspace-auth.ts:6`.
- The full Node suite reported **332 tests: 323 passed, 5 failed, 4 skipped**.
  Each failure requires the unavailable Python `pgserver` module for a separate
  native-PostgreSQL harness; the Map Studio PGlite lifecycle test passed. The
  five blocked tests are slice 1.6, slice 1.7, migration bootstrap, and the
  project-scoped map migration checks. No tests were removed or skipped to get
  a passing result. A stale public-submission assertion was updated to verify
  the exact scoped demo allowlist behavior.
- The local `/maps` route displays that `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY` are missing. This checkout has no local Admin backend
  configuration. The browser Admin import/editor/version/embed journey could
  not be run locally; the SQL workflow was checked through the local WASM
  harness instead. Docker was not used.

The staging Admin pilot recorded below predates this recheck. No staging changes
were made during this local-only pass.

## Staging Admin pilot — 19 October 2026

The hosted Admin milestone was exercised against the existing staging project
using a synthetic three-plot DXF. The test workspace is explicitly labeled
`[TEST] Map Studio Workflow` → `[TEST] Map Studio Admin Import QA` → `Default`.
Its project mode is `demo` and it contains no parcel inventory.

- Staging applied migration ledger version `20261019225217`,
  `map_studio_packages_and_project_plot_content`.
- Staging Edge Functions are active at `get-public-lots` v19 and
  `submit-public-inquiry` v16; both retain `verify_jwt=false` for their public
  routes. The inquiry function suppresses all email for demo projects.
- The Map Studio package has dataset ID
  `f9864f56-03c7-47ea-b478-d020dcfcf921`. Revision 1 imported as a draft. Studio
  then reopened it, extracted revision 2 from a revised DXF, and retained the
  same three source keys (`cad/31`, `cad/33`, `cad/35`). Admin reported **3 stable
  matches, 0 new references**, and imported the revised geometry as snapshot 2.
- Admin changed the first outline to `QA-101-ADMIN`, **177.5 m²**, category
  `QA Premium`, **USD 1,375 per plot**. After the geometry reimport, those Admin
  values remained attached to the same feature identity. The QA project has 3
  identities and 3 published outlines; version 2 is active and version 1 remains
  in history.
- The published embed is
  `https://wamule-staging.netlify.app/embed/map-studio-workflow-test/map-studio-import-qa?phase=default`.
  It loaded all 3 outlines, search and selection, plot details, category pricing,
  and the revised geometry. Reload retained a selected feature through the URL.
- A synthetic inquiry submitted through the hosted map created one lead scoped
  to the QA tenant/project/phase. It stored the map-feature reference, left the
  parcel reference null, and recorded `email_suppressed=true` and
  `email_sent=false`. No message was sent. The public page was opened in a new
  in-app-browser tab; that browser uses the user's existing browser session.
- Staging currently reports Wamule's 20 manual Default plots, 719 raster
  detections (179 `needs_review=false`, 540 `needs_review=true`), and 4 manual
  Legacy Review rows. Wamule still has 0 leads. Hopkins retains the same active
  snapshot ID from the prechange baseline, with 775 active and visible outlines,
  0 parcel inventory records, and its original 9 leads. Storage still has 6
  existing objects across `business-assets` and `project-map-public` (6,341,794
  bytes); the new `project-map-packages` bucket has no stored image objects.
- Netlify deploy `6ad6b30dacb516ad8ab8b2bb` is ready on the existing
  `wamule-staging` site. The site is Git-connected to the `staging` branch, so a
  later branch push can replace this manual publish. No push was made.
- Focused tests passed **24/24**, the local PostgreSQL/WASM lifecycle rehearsal
  passed **13/13**, typecheck and changed-file lint passed, and the staging
  public-build scan passed (**82 files**, no development fixtures or private
  source artifacts).

The off-repository prechange fingerprints and Storage copy are retained. A new
full PostgreSQL archive was not available: the same-day dump attempt produced a
zero-byte file. The newest full archive with completed native PostgreSQL restore
validation is dated 15 October 2026; it is older than this staging migration.
The current migration, test-project rows and inquiry therefore have hosted
verification but not a fresh full-database restore rehearsal. No production
migration, production deployment, DNS change, Git push or outbound message was
performed.

## Authenticated Admin import walkthrough — 19 October 2026

The Map Studio Admin workflow was then exercised against the existing staging
backend from the isolated `codex/map-studio-workflow` checkout at
`23163e086e95ed6381f14483747758f024240fd7`. Its ignored, mode-0600
`.env.local` contained only the protected staging `VITE_SUPABASE_URL` and
browser-safe anon key; the URL and anon JWT both resolved to project
`kvocwmrcuhiaezlcgzjf`. No database password or service-role key was put in the
frontend configuration. The authenticated browser used the existing Super
Admin session. The migration ledger already included
`20261019225217 map_studio_packages_and_project_plot_content`; deployed
`get-public-lots` v19 and `submit-public-inquiry` v16 were verified read-only.
Nothing was replayed or redeployed.

All writes were confined to the existing `[TEST] Map Studio Workflow` tenant,
`[TEST] Map Studio Admin Import QA` project, and `Default` phase. A synthetic
package revision 3 was imported, edited and published. A second synthetic
geometry revision reused the same dataset and three source keys. Admin
comparison reported **3 stable matches and 0 new references**. Deliberate
package-category conflicts were shown in the preview; the existing project
category catalogue remained authoritative. The first feature's Admin content
survived the geometry reimport and page reload:

- Map reference `QA-101-REV3`; 181.25 m²; dimensions `10 x 18.125 m`.
- Category `QA Standard Admin`; USD 1,392 per plot.
- Inventory link remained **Map reference only**; no parcel was created.

Revision 4 was published in the QA project. The database now has four retained
snapshots, three stable identities, three content records, four package rows,
and zero parcels. Snapshot 4
(`9659aa0e-e3ae-491e-b254-b3cd29f665dc`) is active and contains 3/3 public
outlines; versions 1–3 remain in history. The local Admin page showed revision
4 as Published and the edited fields after reload. The public embed was opened
on the existing hosted staging site and reloaded with the selected feature
restored:

`https://wamule-staging.netlify.app/embed/map-studio-workflow-test/map-studio-import-qa?phase=default&lot=ecc446ee-afd5-411f-9320-70559f4a5dac`

The anonymous hosted page displayed **3 mapped outlines**, the selected
`QA-101-REV3` detail, its edited area/dimensions/price, and the project category
guide. Browser screenshots of the local Admin editor and hosted embed were
captured during the walkthrough.

One synthetic inquiry was submitted from this public embed and the identical
request was retried. The first response was HTTP 200 with one lead and one
follow-up created; the retry was HTTP 200 and deduplicated without creating a
second lead. Both responses reported email suppressed and not sent. A read-only
query found exactly one new scoped lead (`source=public_inquiry`) associated
with map feature `ecc446ee-afd5-411f-9320-70559f4a5dac`, no parcel ID, and one
follow-up. The test project has two leads/two follow-ups including its earlier
synthetic baseline row. No outbound message was sent.

Post-walkthrough read-only counts remain: Wamule Default has 20 manual plots
and 719 `raster-auto` records (179 `needs_review=false`, 540 true); its Legacy
Review phase has 4 manual rows and Wamule has 0 leads. Hopkins has 0 parcel
inventory rows, 9 leads, and 775 outlines on active snapshot
`4d6d24f2-c31c-4854-b097-3b32e5c09d19`. The Admin imports and inquiry targeted
only the named QA tenant/project/phase; no Wamule or Hopkins write was issued.

Checks on the isolated local checkout passed: typecheck, focused lint, 12/12
portable-package tests, 6/6 extraction tests, 13/13 local PostgreSQL/WASM
lifecycle checks, the standalone Map Studio build, and the staging frontend
build. The staging public-build scan passed for 82 files with no development
fixtures or private source artifacts. The application build retains a
non-blocking large-chunk warning for its 541.76 kB main JavaScript bundle.
This walkthrough verified a local Admin frontend connected to staging plus the
already-hosted staging embed. It did not push the branch or deploy a frontend;
the hosted site continues to serve its existing frontend deployment.
