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

## Deployment boundary

The implementation is local on `codex/map-studio-workflow`. Enabling the hosted
Admin workflow requires the additive `map_studio_packages_and_project_plot_content`
migration, the updated `get-public-lots` function and the frontend from this branch.
Those deployment actions have not been performed by this implementation pass.

The migration adds project map packages and plot content to the existing feature
identity/snapshot model. Display images use a private Storage bucket. Only the
public API signs images belonging to the active published package. Browser users
cannot directly mutate snapshots or overwrite/delete their images. Admin actions
verify tenant, project and phase and preserve existing inventory and leads.

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

No hosted migration, function deployment, frontend deployment, tenant import,
DNS change or outbound message was performed. The later staging rollout must
apply the reviewed `20261019194346_map_studio_packages_and_project_plot_content.sql`
migration, deploy the updated `get-public-lots` Edge Function and frontend, then
exercise scoped Admin import/edit/review/publish and the tenant embed. Existing
hosted maps and records remain outside this local implementation's write scope.
