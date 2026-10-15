# M1 Source Audit (verified 11 Oct 2026)

**Method:** `scripts/pdf-source-audit.py` — `pdfinfo` + `pdfimages -list` + `pdftotext` + pypdfium2 page/object geometry (metadata only; no raster decode, no PPM dump). Raw evidence: `source-audit.json` (same directory).

**Source identity:** `2026 Hopkins Map.pdf`, 1,395,476,715 bytes; SHA-256 `fa50eb70248a43776201726db62ab2f6adfd93d92c0749e3a4e77b1f3bd529dc` (streamed in 1 MiB chunks).

**Toolchain/limits:** Poppler 25.11.0 (`pdfinfo`, `pdfimages`, `pdftotext`), pypdfium2 4.30.0, Python version and processing limits are recorded in `source-audit.json`. Hashing uses a fixed 1 MiB buffer; external PDF commands time out after 300 seconds; no raster bytes are decoded by this audit.

**Page objects and geometry:** pypdfium2 reports one landscape page at 547.2 × 460.8 pt, rotation 0°, containing 17 image objects and no non-image page objects. `pdfinfo -box` reports all page boxes equal the full page at the origin. The detector's image index 0 is 5700 × 4800 px and its transform covers that page. This confirms the first-object extraction path; it does not establish survey scale or georeferencing. The PDF exposes no selectable text or vector drawing objects through these checks, and its 750 ppi raster metadata is image resolution—not ground control.

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

**Build implications:** the 17 full-page rasters explain the file size (17 × ~78MB) and why `pdfimages -j` must never be used (fills disk with PPMs). The detector's first-image extraction is confirmed as full-page. No text/vector layer or survey coordinate system was identified, so raster OCR is the only machine-reading option; benchmark + human labels and owner-provided scale references remain mandatory.

## Not audited (blocked / out of scope)

- Survey coordinates, ground scale, and georeferencing (need owner-approved drawing/survey references and road clicks).
