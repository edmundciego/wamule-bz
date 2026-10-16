# Hopkins source comparison

This record compares the original Hopkins plan, `map-input/hopkins.tiers.json`, the reviewed source-number candidates, and the active 775-outline staging map. The plan’s prices and printed identifiers are source annotations; they do not establish approved geometry, inventory, or sale availability.

## Pricing and colors verified against the PDF

The one-page [2026 Hopkins Map.pdf](../2026%20Hopkins%20Map.pdf) is 5700 × 4800 px. Its SHA-256 is `d82e5880371e8de7821650cf0d1c1e70e5dfac6091cca2db73a8de085f3241be`.

| Group | Printed source label | Price | Basis printed in source | Source fill |
| --- | --- | ---: | --- | --- |
| Residential | Standard Interior | $25,000 | per 1/4 acre | `#fff798` |
| Residential | Premium Interior | $30,000 | per 1/4 acre | `#f6cabb` |
| Residential | Premium Boulevard | $35,000 | per 1/4 acre | `#12ff00` |
| Residential | Creekview / Reserve | $35,000 | per 1/4 acre | `#19d3e8` |
| Commercial | Access Road (1/2 Acre), orange fill | $60,000 | per 1/2 acre | `#ffa319` |
| Commercial | Access Road (1/2 Acre), purple fill | $50,000 | per 1/2 acre | `#a56ae6` |
| Commercial | Highway Front | $125,000 | not stated | `#e0241d` |

The two commercial road categories use the same printed label and are distinguished by their source color and price. The PDF prints `$` but does not identify a currency code. Its corner triangle carries a `$2,500` surcharge. The source card says “In-House Financing Available”; the guide attributes that note to the plan and says current terms and availability are not verified.

The live guide is accessible HTML, reflows for phone widths, and uses the catalogue’s source fills. It preserves the original names, prices, acreage bases, corner surcharge, and currency/basis caveats. It does not display the source raster’s blurry legend card. The underlying map image retains its source colors (`filter: none`, `opacity: 1`).

## Printed-number review

The 82 staging outlines carrying a unique OCR candidate were compared visually with their highlighted outline on the source raster. `artifacts/hopkins-source-accuracy-20261016/number-crosswalk.csv` records each generated reference, stable feature identity, OCR suggestion, source-image reading, and result.

- 58 OCR suggestions matched the visible source number.
- 22 OCR suggestions were corrected to the number visibly printed inside the matched outline.
- Two outlines contain multiple printed lots and have no single assigned number: **Plot 387** contains 724, 701, 723, and 702; **Plot 044** contains 997, 994, and 988.
- The remaining 693 outlines have no unique number assigned: 8 duplicate-token conflicts, 80 split-child cases, and 605 detections without a unique match.

The visual cross-check is not independent survey or legal-identity approval. Search and details keep generated `Plot NNN` references separate from printed numbers. A source-image match is not a canonical lot identity or sales approval. Ambiguous Plot 387 and Plot 044 remain unnumbered; their detail cards list their contained printed numbers. OCR candidates not cross-checked remain explicitly provisional.

## Source-tier review

The 775 active outlines were compared with the source raster and the approved tier catalogue. Three clear source-fill corrections were made: Plots 167 and 168 are Standard Interior; Plot 383 is Premium Boulevard. Plot 033 crosses hatching and unfilled space, so it has no single defensible fill class or price. After review, 774 outlines have one source-tier mapping and Plot 033 remains tier-ambiguous.

| Source class | Outline count |
| --- | ---: |
| Standard Interior | 169 |
| Premium Interior | 358 |
| Premium Boulevard | 174 |
| Creekview / Reserve | 23 |
| Access Road, orange | 26 |
| Access Road, purple | 18 |
| Highway Front | 6 |
| No single source fill (Plot 033) | 1 |
| **Total** | **775** |

Tier mapping is separate from geometry approval, inventory status, and sale availability. No polygon, feature identity, project/phase assignment, inventory row, Wamule setting, price, or membership was changed in this source-style pass. The only staging data update was the guarded provenance/price-tier crosswalk on the active Hopkins feature records; it wrote 86 source-review fields on Hopkins features.

## Hosted verification — 15 October 2026

Frontend deploy **`6ad1768d85a10e5ce39ae4e4`** is Published on the existing Netlify site **`wamule-staging`**, whose target is `wamule-staging.netlify.app`. The staging `get-public-lots` function is active at v17. Production site `wamule-bz` was not deployed or changed.

The public page was checked in a new Chromium context with zero cookies and zero local-storage keys:

- [Hopkins public map](https://wamule-staging.netlify.app/embed/hopkins-grove/hopkins-grove?phase=initial) stayed on the public route without a login redirect. Its staging API returned HTTP 200, and the page rendered 775 selectable outline options.
- Searching `715` returned **Plot 534 — source-image match 715** and a separate **Plot 715 — no unique printed-number match**. Selecting the first showed generated reference `Plot 534`, source-matched printed number 715, Premium Interior, and `$30,000 · per 1/4 acre`.
- Selection uses a white/dark double outline with transparent fill, leaving the source tier color visible. “Zoom to plot” moved from the initial zoom state to the lot-fit zoom state; printed plan labels are legible in the [zoomed source view](../artifacts/hopkins-source-accuracy-20261016/hosted/public-desktop-zoomed-715.png).
- Details survived reload at `?phase=initial&lot=Plot+534`; reload returned 775 options and restored the selected detail.
- The expanded HTML price guide showed all seven source classes, exact catalogue swatches, prices, units, and source caveats. The [desktop capture](../artifacts/hopkins-source-accuracy-20261016/hosted/public-desktop-selected-source-715.png) shows the colored plan, pricing guide, selected-outline indicator, and details.
- At 1440 px, the right sidebar measured 304 px. Pricing-guide text measured 6.01:1 for muted copy and 15.43:1 for primary copy against the white panel. The selected detail remains a scrollable compact panel.
- Hosted detail checks preserve ambiguity: Plot 387 lists 724, 701, 723, and 702 with no single number; Plot 044 lists 997, 994, and 988 with no single number; Plot 033 says “Ambiguous source color” and “no price assigned.”
- At 390 px and 320 px, document width equaled viewport width. The compact details panel and guide remained usable without horizontal scrolling: [390 px](../artifacts/hopkins-source-accuracy-20261016/hosted/public-mobile-390-final.png), [320 px](../artifacts/hopkins-source-accuracy-20261016/hosted/public-mobile-320-final.png).
- A separate anonymous request to `/dashboard` redirected to `/login` and displayed the sign-in form.

## Wamule preservation check

The post-deploy read-only staging check still found one Wamule tenant, all **743** parcel rows with **743** distinct IDs, comprising **24** manual legacy records and **719** raster detections. The full-row fingerprint remains `738fedbc40df0597ead2f58642a8c03c`, matching the pre-pass value. Storage metadata remained 5 `business-assets` objects / 4,473,296 bytes and 1 `project-map-public` object / 1,868,498 bytes. This visual/source update made no Wamule writes. The earlier supplied comparison of all 89 fingerprint groups and Storage metadata also matched.

## Evidence files

- Number crosswalk and source crops: [`artifacts/hopkins-source-accuracy-20261016/`](../artifacts/hopkins-source-accuracy-20261016/README.md)
- [Desktop selected map and guide](../artifacts/hopkins-source-accuracy-20261016/hosted/public-desktop-selected-source-715.png)
- [Desktop zoomed source labels](../artifacts/hopkins-source-accuracy-20261016/hosted/public-desktop-zoomed-715.png)
- [Mobile at 390 px](../artifacts/hopkins-source-accuracy-20261016/hosted/public-mobile-390-final.png)
- [Mobile at 320 px](../artifacts/hopkins-source-accuracy-20261016/hosted/public-mobile-320-final.png)
