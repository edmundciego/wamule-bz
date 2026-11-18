---
name: plat-digitizer
description: Propose source-aligned subdivision-lot polygons and printed-number candidates from plat imagery for review in Wamule's correction workflow. Use for local plat digitization; never treat proposals as approved parcel data.
---

# Plat Digitizer

Use this skill to turn a selected source-image region or existing detection into
an evidence-bound, human-reviewable geometry proposal. Computer vision may
segment or trace visible boundaries; OCR may suggest printed numbers. Neither
may invent coordinates, canonical identities, prices, availability, or sale
status.

## Wamule invariants

- Preserve the source PDF, source raster, existing detection set, human edits,
  and browser-local review state. Never clear browser storage or overwrite an
  existing correction. Before touching the live editor, preserve any unfinished
  trace from its current session; an unconfirmed React trace may be volatile.
- Keep generated geometry in the existing image-relative percentage
  coordinates (0–100) used by src/lib/mapGeometry.ts. Record native source
  pixels too, along with source-image and detection fingerprints.
- Save proposals as a separate, recoverable artifact. New children always have
  stable draft IDs and unreviewed status. An operator must explicitly Accept,
  Edit, or Reject each proposal in the existing correction workspace; do not
  silently apply it to source detections or canonical parcels.
- Keep the 60-case blind benchmark unchanged. OCR/AI output must remain hidden
  from a benchmark reviewer until their independent decision is recorded.
- Do not upload proprietary source images, PDFs, or crops to an external
  provider unless the user explicitly authorizes that upload for the specific
  source and purpose. The default workflow is local-only. Never look for,
  print, or hardcode API credentials.
- Reuse Wamule detection files, OCR artifacts, correction evidence, geometry
  validators, and editor architecture. Do not create a second buyer map or
  modify buyer inventory behavior.

## Local prototype command

The first implementation supports line-separated, saturated color-filled
parcels. It masks a selected detection or source-pixel rectangle, finds
connected color regions with OpenCV, simplifies each contour, maps the vertices
back into Wamule source percentages, and checks proposal topology and coverage.
This is a proposal mechanism, not a general survey-vectorizer.

Example using the local Hopkins files:

    python3 .agents/skills/plat-digitizer/scripts/plat_digitize.py \
      --image out/hopkins-ocr/masterplan_background.webp \
      --source-pdf "2026 hopkins map.pdf" \
      --detections out/hopkins-ocr/lots.json \
      --parent-id L-683 \
      --ocr-results out/hopkins-ocr/lot-ocr.json \
      --output-dir out/plat-digitizer/L-683-cv02

To process an explicit raster-pixel rectangle instead, pass
--region-px x0,y0,x1,y1 and omit --parent-id. A region without a known parent
must not be represented as a correction to a detected parcel.

The output directory contains proposal.json, comparison.png, overlay.png,
report.md, and manifest.json. Re-running with identical inputs is idempotent.
If an output differs, the command refuses to overwrite it; choose a new output
directory after preserving the prior artifact.
Each report states whether the optional source PDF was fingerprinted in that
run; when omitted, it identifies the source-bound raster as the only map input.

The correction workspace has a visible proposal-file importer that binds a
proposal to the loaded source image, detection file, and selected parent. Import
creates an unapproved review draft; the reviewer must inspect and correct or
reject it in the workspace. Never claim that writing a proposal artifact
represents an Accept/Edit/Reject decision.

Python dependencies are OpenCV, NumPy, Pillow, and Shapely. Tesseract is
optional; without it the command still proposes image-derived contours and
records that number reading was unavailable. No network or AI request is made.

## Review and failure policy

Read source hashes, component count, raw OCR evidence, geometry checks,
overlap/gap warnings, and unresolved flags before opening a proposal in the
editor. Inspect the original-versus-proposed overlay against the full source
drawing. A number candidate is only an OCR suggestion; neighboring sequence,
color tier, or existing detection ID is not evidence of a printed number.

If boundaries are not visibly closed, the region has no separable fills, a
contour is invalid, or a gap/overlap cannot be resolved from the source image,
stop automatic extraction and hand the original detection to manual vertex
editing/tracing. Do not force a contour count or repair invalid geometry
silently. Use the existing correction workspace for the visible Accept/Edit/
Reject decision and history. If it cannot import a proposal artifact yet,
record that as an integration blocker rather than pretending the artifact was
accepted.

For a different plat style, first inspect the source and choose/test a local
segmentation method on a small labeled region. Keep algorithm parameters,
tool versions, raw source evidence, and failure cases in the proposal. Do not
expand to a whole subdivision until a reviewer has checked this proof of
concept and boundary/number error rates are measured against independent human
labels.
