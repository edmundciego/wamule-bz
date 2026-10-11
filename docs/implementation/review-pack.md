# Owner Review Pack & Measure Workflow (M1 inputs)

Two owner tasks unblock the benchmark and the scale. Both run locally in a browser; nothing leaves the machine.

## Task 1 — label 100 crops (~20 min)

1. Serve the sheet (any static server; `file://` also works):
   `python3 -m http.server 8000 --directory out/hopkins-ocr`
2. Open `http://localhost:8000/label.html`. 100 blind crops (`sheet-crops/S001…S100.png`, no lot numbers, no OCR text).
3. Per crop type the printed lot number and printed area (digits/decimals only), or mark Unreadable (U) / Ambiguous (B). Work autosaves to browser localStorage.
4. Export `labels.csv` from the page, then score:
   `python3 scripts/score-labels.py --sheet out/hopkins-ocr/sheet-crops --lots out/hopkins-ocr/lots.json --labels labels.csv --ocr out/hopkins-ocr/ocr.json`
5. To regenerate a fresh sheet instead:
   `python3 scripts/blind-sheet.py --lots out/hopkins-ocr/lots.json --image out/hopkins-ocr/masterplan_background.webp --out <sheet-dir> --n 100 --seed 7`

State: pack prepared, labels pending (owner). Benchmark gates stay at defaults until scored; Hopkins bulk accept stays disabled.

## Task 2 — click road widths (~10 min)

1. Same server as above; open `http://localhost:8000/measure-roads.html` (loads `masterplan_background.webp` from the same directory).
2. Follow the on-page guide: click edge-to-edge perpendicular to centerline, mid-block, ≥3 segments each for 60ft (green) and 40ft (blue) roads. Built-in cross-check (median-lot estimate ≈44px/≈29px) flags >5% disagreement — flag, don't fit.
3. Export `road-measurements.json`. Acceptance: 60:40 ratio ≈ 1.5 within 10%.

State: workflow ready, clicks pending (owner). Until recorded, scale-area signal stays "unavailable" (by design, never a pass).
