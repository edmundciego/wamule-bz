# Admin Map Review acceptance captures

Captured 2026-11-21 with the local Vite app in Chromium: Playwright Desktop Chrome (1280×720) and Pixel 7 (412×915). The test uses a controlled Admin session and mocked Supabase/PostgREST responses. It made no writes to staging.

The scope and selected outline were grounded in a read-only staging inspection of Hopkins Grove’s Initial phase: tenant `2cefb56f-b834-4d44-9177-e8abd8abc1c6`, project `dde17305-2a89-4d58-8d59-c756880eba6b`, phase `fbc1ae08-ef46-4d80-85f5-8e3a8d049116`, active snapshot `3269255a-646e-56a1-a776-ecc2ddebc389`, package `9db38ced-822f-5c48-9688-cc82c8a5956e`. Staging showed 775 published outlines, zero parcel links, and Plot 775 with printed label `Plot 775`, reviewed status, and no linked lot. The fixture uses the observed Plot 775 identity and polygon; the other 774 outlines are generated fixture shapes.

## Screen captures

| Screen | Desktop | Phone |
| --- | --- | --- |
| Search Plot 775, select with keyboard, and show details | [PNG](desktop/plot-775-search-results.png) | [PNG](phone/plot-775-search-results.png) |
| Select Plot 775 directly on the map, show details, and zoom | [PNG](desktop/plot-775-map-selection.png) | [PNG](phone/plot-775-map-selection.png) |
| Exact reviewed package in the existing publish confirmation | [PNG](desktop/publish-confirmation.png) | [PNG](phone/publish-confirmation.png) |
| Public phase preview after mocked publication | [PNG](desktop/public-phase-preview.png) | [PNG](phone/public-phase-preview.png) |

## Actions and observed changes

1. Search `Plot 775`: the result count changed to `1 of 775 outlines match`; the paginated list showed the matching outline.
2. Press Tab and Enter on the result: the selected-plot panel showed `Plot 775`, `Reviewed`, and `No linked lot`.
3. Clear search and click the Plot 775 map polygon: the polygon became selected and the same details appeared immediately. `Zoom to plot` changed the map view box; `Show full map` became available.
4. Focus a map outline and use Enter/arrow keys: map keyboard selection updated the details panel and returned to Plot 775.
5. Select the empty phase: Map Review displayed an accessible-phase selector. Opening the accessible Initial phase returned to its published map.
6. Select the local Draft phase and continue from review: Maps locked the selection to package revision 5 and displayed the Hopkins Grove tenant, project, and Draft phase. The confirmation showed the exact target revision.
7. Confirm in the local mock: the RPC payload contained package `package-draft-snapshot`, expected active snapshot `draft-phase-live`, and `p_replace_current: true`. The mock advanced the active snapshot to `draft-snapshot`; the UI showed “Revision 5 is now published for Draft phase.”
8. Open Preview map: the new tab used `/p/hopkins-grove/hopkins-grove/map?phase=draft-phase`; mocked `get-public-lots` requests resolved that phase to active snapshot `draft-snapshot`.

The last two steps prove the exact package and active-revision handoff in the local test fixture. They are not a hosted staging publication or a live staging public-map check. The local public preview has no published background image; no map package was published to Hopkins Grove staging.
