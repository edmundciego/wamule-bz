# Shared tenant homepage

Both public tenants now render through `PublicHomepage`, which selects a
registered layout from the public template setting. Wamule Classic remains the
single available layout. Its shared frame owns the header, hero and fact cards,
preferences panel, information request, notice, map section, application area
and footer. The existing Wamule Classic styling is retained.

`ApplicationPage` and `HopkinsPublicPage` supply content and workflow slots.
They no longer assemble their own headers, heroes, notices or footers.
Different content can produce different card heights; shared layout does not
mean copying Wamule's availability, dimensions or purchase terms into Hopkins.

| Concern | Wamule | Hopkins |
| --- | --- | --- |
| Public scope | wamule / wamule / default | hopkins-grove / hopkins-grove / initial |
| Preference content | Available parcel records | Category prices and optional map references |
| Application | Existing five-step purchase form, including payment preference | Existing five-step project-review form, without parcel allocation or Wamule payment terms |
| Map placement | Homepage and preferred-lot step | Homepage and map-preference step |
| Submission and validation | Existing purchase endpoint and contract | Existing project-review endpoint and contract |

## Routes and settings

The root hostname route, `/apply`, `/hopkins`, `/hopkins/apply` and
`/hopkins/application` all use `PublicExperienceRoute`. It loads the exact
tenant/project/phase site settings before rendering a page adapter. Failed or
mismatched settings show an unavailable state rather than default-enabled forms.
The legacy UI-only restriction remains explicitly identified as incomplete;
this refactor does not introduce server-side access enforcement.

The template ID reaches the actual layout registry. Unknown and retired IDs
fall back to the registered Classic layout without changing ownership or form
requirements. Admin's existing public-site settings now expose that layout
selection and accurately describe separate project application rules.

Pricing flags apply to source-plan category cards and Admin category cards as
well as maps. Disabling the inquiry module also disables inquiry buttons in the
Hopkins maps. Public map copy says **Mapped outlines**, avoiding an implication
that the outlines themselves are approved saleable lots.

Wamule's legacy settings, installment plans and payment methods are filtered to
the repository's existing `DEFAULT_TENANT_ID`; their cache keys include that
tenant. Its public inventory request and both maps carry explicit project and
phase selectors. This uses the existing seeded Wamule identity, not a browser's
current Admin workspace. No stored values or inventory counts are rewritten.

## Extension boundary

A future tenant can supply a scoped content model and workflow to this frame
without writing another homepage layout. The two existing data adapters and
their backend contracts remain in place: in particular, the current
`get-public-project-page` source is Hopkins-specific. Automatic onboarding of
arbitrary public routes or a universal profile endpoint is not implemented by
this frontend refactor. Application eligibility and RLS remain server concerns.

Crawler-facing initial HTML/social-preview metadata is also a separate task.
The existing client-side document-title behavior is retained.

## Local reconciliation and validation

The attached patch was reviewed against the workstation's later Map Studio
branch and reconciled in the isolated branch
`codex/shared-tenant-homepage-review`, based on `codex/map-studio-workflow` at
`a6ee024`. It was not applied to the dirty primary worktree. The newer CSV
round-trip fix and separate Vite optimizer cache remain intact.

The shared homepage and workflow tests passed **42/42**. Typecheck,
changed-file lint, brand check, application build, and the public-build scan
passed. The public-build scan found **81 files** and 1,531,657 text bytes. The
production bundle still reports the existing approximately 541 kB entry-chunk
advisory.

The full Node suite completed with **326 passed, 7 failed, 4 skipped**. The
seven failures are environment dependencies: two alignment tests need SciPy,
which is not installed in the bundled Python runtime, and five local database
harness checks need the unavailable Python `pgserver` module. Four tests were
skipped, including live-environment cases. These failures were not introduced
by the homepage changes and were not suppressed.

The isolated Playwright suite passed **9/9**. It exercised both tenant homepages
at 1440, 390 and 320 CSS pixels; application map steps at all three sizes;
public module switches; failed-settings behavior; and map-selection preference
persistence. It checked for horizontal overflow on every homepage route and
both application map steps. Before screenshots were captured from the
unmodified `a6ee024` checkout using the same fixtures, and after screenshots
were captured from this branch. Both sets are under `test-results/` in
`shared-public-homepage-before/` and `shared-public-homepage/`, respectively.
The automated suite intercepted API traffic with synthetic fixtures and sent
no writes. Its synthetic Hopkins fixture intentionally has no published raster
image, so those screenshots show layout and controls only.

A second isolated browser pass loaded this local branch against the existing
staging public-read configuration from the protected `.env.staging` file. The
Vite server used `VITE_PUBLIC_DEMO_MODE=true`; browser requests were restricted
to GET/HEAD/OPTIONS and the guard observed **zero** write attempts. All observed
`get-public-site-experience`, `get-public-project-page`, and `get-public-lots`
responses returned HTTP 200. The Wamule homepage showed 20 available inventory
records in its preference cards and 719 review/display map features. Hopkins
showed 775 mapped outlines on both the homepage and application map. Wamule →
Hopkins → Wamule navigation returned the expected tenant heading each time.
At 1440, 390 and 320 CSS pixels, document width matched viewport width on both
homepages and Hopkins's application map. These are local frontend results using
staging public reads; they are not a deployment or hosted-frontend check.
Additional captures are in `test-results/staging-readonly-review/`.

The synthetic test server configuration uses `http://127.0.0.1:5382/` and
`http://127.0.0.1:5382/hopkins`. The currently running local review server at
those same URLs uses the staging public-read settings and local demo submission
suppression. It will stop when this workspace session ends.

No migration or Edge Function changes are included. No hosted data write,
deployment, DNS change, push, paid resource or Docker operation was performed.
The review changes are committed only on the isolated local branch; staging
remains unchanged.
