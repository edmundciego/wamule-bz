# M1 Source Audit (verified 11 Oct 2026)

**Method:** `scripts/pdf-source-audit.py` — `pdfinfo` + `pdfimages -list` + `pdftotext` (structure/text layers only; no raster decode, no PPM dump). Raw evidence: `source-audit.json` (same directory).

## Hypotheses vs observations — 8/8 confirmed

| Hypothesis | Observed | Verdict |
|---|---|---|
| %PDF magic header | `%PDF-1.4` | confirmed |
| ~1.4GB single plat export | 1,395,476,715 bytes | confirmed |
| 1 page | `Pages: 1` | confirmed |
| 547.2 x 460.8 pt | `Page size: 547.2 x 460.8 pts` | confirmed |
| Creator Civil 3D 2024 | `Autodesk Civil 3D 2024 - English 2024 (24.3s (LMS Tech))` | confirmed |
| Producer Photoshop | `Adobe Photoshop for Windows` | confirmed |
| 17 embedded 5700x4800 rasters | 17 images, all 5700x4800, ICC RGB, ~78.3MB each @750ppi | confirmed |
| No selectable text | 0 chars extracted | confirmed |

**Implications (recorded, not yet implemented):** the 17 full-page rasters explain the file size (17 × ~78MB) and why `pdfimages -j` must never be used (fills disk with PPMs); the single-image extract in `detect-lots.py` is the correct approach. No text/vector layer exists, so the raster OCR path is the only machine-reading option — benchmark + human labels remain mandatory.

## Not audited (blocked / out of scope)

- Which of the 17 rasters the detector's "first embedded raster" actually is (needs pipeline cross-check, M1 follow-up).
- Native dimensions/orientation/transforms beyond MediaBox (needs owner drawing/survey context).
- Checksum manifest (deferred: whole-file hash on 1.4GB is a deliberate run, not part of this slice).
