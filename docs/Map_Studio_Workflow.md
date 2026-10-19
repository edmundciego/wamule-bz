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

- Extraction fixtures: **6/6 passed**, covering DXF, unknown units, ambiguous
  numbers, vector PDF, raster input and the DWG export requirement.
- PostgreSQL/WASM lifecycle rehearsal: **13/13 passed**, including scoped plot
  inquiries and retry deduplication in a sales project. Its generated CAD drawing
  is a test fixture, not Wamule or Hopkins evidence.
- Full Node suite: **318 passed, 5 failed, 4 skipped**. The five failures are
  pre-existing native PostgreSQL harness tests that cannot load `pgserver` in
  this execution environment. They were not removed or silently skipped.
- Typecheck, standalone Studio build, application build, public-build guard,
  brand check and changed-file lint passed. Repository-wide lint retains the
  existing `no-explicit-any` error in `_shared/workspace-auth.ts:6`.
- The local extraction HTTP adapter returned a valid three-outline DXF package;
  its cross-origin request check returned 403.

No browser walkthrough or real owner CAD file has been validated in this pass.
No hosted migration, function deployment, frontend deployment, tenant import,
DNS change or outbound message was performed. Existing hosted maps and records
remain outside this local implementation's write scope. Before staging release,
review the additive migration and exercise import, editing, publication and the
embed in a browser against the intended staging backend.
