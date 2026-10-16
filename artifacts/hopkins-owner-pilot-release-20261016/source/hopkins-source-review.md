# Hopkins source accuracy review

Source raster: `2026 Hopkins Map.pdf`, 5700 × 4800 px, SHA-256 `d82e5880371e8de7821650cf0d1c1e70e5dfac6091cca2db73a8de085f3241be`.

## Printed-number cross-check

The 82 staging features marked as unique OCR candidates were visually compared with their highlighted outline on the source raster. The accompanying `number-crosswalk.csv` records the generated map reference, stable map-feature identity, original OCR suggestion, source-image reading, and result. This is a source-image visual cross-check; it is not an independent survey/legal identity approval and it does not establish sale eligibility.

- 58 OCR suggestions matched the source reading.
- 22 OCR suggestions were corrected to the visibly printed source number.
- 2 outlines contain multiple printed lots and remain without a single assigned number: Plot 387 encloses 724, 701, 723, and 702; Plot 044 encloses 997, 994, and 988.
- The other 693 outlines remain without a unique source-number assignment: 8 duplicate-token conflicts, 80 split-child cases, and 605 detections with no unique match. Their generated `Plot NNN` references remain a separate field.

## Source-tier cross-check

The 775 active outline colors were compared with fills in the source raster. 771 matched the assigned source class. Three clear discrepancies were corrected: Plot 167 and Plot 168 map to the pale-yellow Standard Interior fill; Plot 383 maps to the bright-green Premium Boulevard fill. Plot 033 crosses road hatching/unfilled space and does not have one defensible fill class, so its source tier and associated plan price are left unassigned. The corresponding visual crops are included here.

After those corrections, 774 outlines have a single source-tier mapping and one outline remains explicitly ambiguous. This source tier mapping is separate from geometry approval, inventory status, and sales availability. No polygons, feature IDs, project/phase assignments, inventory rows, settings, prices, or memberships were changed.

## Pricing facts read from the PDF

The accessible legend reproduces the plan's `$` symbol without guessing a currency code. Residential prices are per 1/4 acre; the two differently colored Access Road entries are each per 1/2 acre; the Highway Front acreage basis is not specified. The corner mark adds `$2,500`. The source card's “In-House Financing Available” note is attributed to the plan and is not represented as a currently verified offer.
