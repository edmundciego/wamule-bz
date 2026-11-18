# Owner Review Pack & Measure Workflow (M1 inputs)

Two owner tasks unblock the benchmark and the scale. Both run locally in a browser; nothing leaves the machine.

## Road-click page source and provenance

The road-width page is now reproducibly generated from
`scripts/templates/measure-roads.html` by
`scripts/build-road-measurement-tool.py`. It fingerprints the exact background
and disables clicks if the served file differs, translates browser CSS
coordinates back to native image pixels, and omits speculative road-location
and lot-area heuristics. The candidate recorder requires the exported image
SHA-256 to match the supplied source image; it also rejects repeated endpoint
pairs within 2 native pixels.

The existing private `out/hopkins-ocr/measure-roads.html` is an older
hand-maintained artifact. Do not overwrite it or regenerate the blind sheet
just to refresh the road tool: that could replace crops/page files while
browser-local label work is unverified. For the reproducible page, choose a
fresh private directory and copy only the exact background into it:

```sh
mkdir out/hopkins-road-review-new
cp out/hopkins-ocr/masterplan_background.webp out/hopkins-road-review-new/
python3 scripts/build-road-measurement-tool.py \
  --image out/hopkins-road-review-new/masterplan_background.webp \
  --out out/hopkins-road-review-new/measure-roads.html
```

The generator refuses to overwrite an existing page. Serve only that isolated
directory with `scripts/serve-blind-sheet.py --directory
out/hopkins-road-review-new --mode roads`; the allowlist exposes only the
measurement page and its one fingerprinted background.

## Actual-source browser smoke check — 12 October 2026

Generated the page from the current 5700×4800 Hopkins background (1,868,498
bytes; SHA-256
`d82e5880371e8de7821650cf0d1c1e70e5dfac6091cca2db73a8de085f3241be`) into an
isolated temporary directory. In Chromium at 390×844, the page reported
`Source verified` for that exact image. The only browser requests were the
review page and `masterplan_background.webp`; no OCR, lot-identity, or API
resources were requested. This verifies page/source loading only: no road
clicks were recorded, no calibration was produced, and no scale was accepted.

## Task 1 — label 100 crops (~20 min)

1. If the crop folder and `out/hopkins-ocr-mapping.json` are already present, use them. Otherwise generate the sheet once, before labeling starts. The mapping is kept outside the served directory; do not serve the parent `out/` directory:
   `python3 scripts/blind-sheet.py --lots out/hopkins-ocr/lots.json --image out/hopkins-ocr/masterplan_background.webp --out out/hopkins-ocr --n 100 --seed 7`
   This writes the private mapping to `out/hopkins-ocr-mapping.json`, the blank CSV, and `label.html` from the checked-in `scripts/templates/blind-label.html` source. The page's local-storage key is namespaced to the generated crop image fingerprint. Regenerating replaces crop images, labels, and the page; do not regenerate after labeling starts unless you are intentionally starting a separate review.
2. Serve the private review directory through the allowlisted loopback server:
   `python3 scripts/serve-blind-sheet.py --directory out/hopkins-ocr`
   It binds only to `127.0.0.1` and serves `/label.html` plus
   `/sheet-crops/S001.png`–`S100.png`; it returns 404 for `lots.json`, `ocr.json`,
   the QA viewer, other package files, traversal paths, and symlinks. This
   matters because `out/hopkins-ocr/` also contains the private OCR and geometry
   artifacts; do not use Python's general-purpose static file server here.
3. Open `http://localhost:8000/label.html`. The 100 blind crops (`sheet-crops/S001…S100.png`) contain no lot numbers or OCR text. The private mapping is not served with them.
4. Per crop type the printed lot number and printed area (digits/decimals only), or mark Unreadable (U) / Ambiguous (B). Those statuses are mutually exclusive; unreadable crops export blank printed values with `unreadable=1`. A row with all values and statuses blank remains unreviewed. Work autosaves to browser localStorage.
5. Export `labels.csv` from the page. Before scoring, regenerate both OCR predictions against the current image and lot polygons from the repository root:
   `python3 scripts/ocr-match.py --dir out/hopkins-ocr --engines both --stage ocr`
   This refreshes `ocr.json` with engine versions and image/geometry fingerprints; the OCR-only stage does not patch `lots.json` or run matching/scale gates. It replaces the prior `ocr.json`, so copy that file first if you need to retain the previous run as evidence.
6. Score from the repository root:
   `python3 scripts/score-labels.py --mapping out/hopkins-ocr-mapping.json --lots out/hopkins-ocr/lots.json --labels <path-to-labels.csv> --ocr out/hopkins-ocr/ocr.json`
   The scorer verifies that OCR predictions match the current source image and lot geometry, attributes token centers using the actual lot polygon (not only its bounding box), reports exact token accuracy separately from normalized Levenshtein character accuracy, and records fingerprints for labels, mapping, OCR output, engine environment and both scoring code files. Ambiguous and explicitly unreadable rows are excluded from scoring while remaining separately counted in coverage; unmarked blanks do not count as reviewed. It also rejects duplicate/unknown crop IDs, values outside the label format, duplicate lot identities, and mappings that do not resolve to the current polygons. Older OCR output without fingerprints must be regenerated before it can be scored.

State: pack prepared, labels pending (owner). Benchmark gates stay at defaults until scored; Hopkins bulk accept stays disabled.

The private package build on 11 Oct regenerated the same 719 lot
numbers, tier keys, and polygon vertices as the source used by this crop pack.
The 100-crop mapping remains aligned to that geometry; this does not supply
human labels or approve OCR, scale, or clickable coverage. See
`m1-build-run.md` for the manifest, measurement results, and replay limitation.

## Task 2 — click road widths (~10 min)

1. Stop the labels-mode server with Ctrl+C, generate the source-bound road
   page as above, then start roads mode against that isolated directory:
   `python3 scripts/serve-blind-sheet.py --directory out/hopkins-road-review-new --mode roads`
   Open `http://127.0.0.1:8000/measure-roads.html`. This mode serves only that page and `masterplan_background.webp`; OCR and lot-identity files remain inaccessible.
2. Follow the on-page guide: click edge-to-edge perpendicular to centerline, mid-block, ≥3 segments each for 60ft (green) and 40ft (blue) roads. Built-in cross-check (median-lot estimate ≈44px/≈29px) flags >5% disagreement — flag, don't fit.
3. Export `road-measurements.json`. Keep the untouched export as raw evidence. The tool must be opened against the exact `masterplan_background.webp` that is passed below.
4. After the clicks are checked against an approved drawing/survey, create a candidate evidence record (replace the source/reviewer/uncertainty values with the actual review details):
   `python3 scripts/record-road-calibration.py --measurements <path-to-road-measurements.json> --image out/hopkins-ocr/masterplan_background.webp --reference-source "<approved drawing or survey, revision, page/feature>" --reviewer "<reviewer name>" --endpoint-uncertainty-px <estimated-click-uncertainty> --reference-width-uncertainty-ft <stated-dimension-uncertainty-ft> --out <path-to-road-calibration.json>`
5. The recorder verifies source dimensions, source-image SHA-256, and click geometry; fingerprints the source and raw export; records the display scale and recorder versions; requires at least three measurements per stated width and click orientation; rejects repeated endpoint pairs within 2 native pixels; checks the 60:40 ratio/orientation agreement; and holds 40ft measurements out of the fit as a scale check. It writes a new file only and refuses to overwrite evidence. Reported click/reference uncertainty is only the input contribution; the candidate also reports observed 60ft fit spread, and neither includes unknown systematic map/reference error. A `ready_for_owner_review` result is still only a candidate: the owner/reviewer must inspect the approved references, observed spread, and uncertainty before scale is accepted. Any failed check leaves scale `unavailable`.

State: click-and-record workflow ready, clicks pending (owner). Until the candidate is reviewed and accepted, scale-area signal stays "unavailable" (by design, never a pass).
