# M1 local package build — 11 October 2026

Local-only candidate build; it does not approve the register, scale, map
coverage, tenant identity, or public fields. No publish command was run.

## Inputs and reproducibility evidence

- Package: ignored/private `tenants/hopkins-grove/`; tenant scale remains
  `null`.
- Source: `2026 Hopkins Map.pdf`, 1,395,476,715 bytes, SHA-256
  `fa50eb70248a43776201726db62ab2f6adfd93d92c0749e3a4e77b1f3bd529dc`.
  The private package source is a same-inode hard link to the original, so it
  added no second 1.4 GB copy.
- The build fingerprints `evidence/source-audit.json`, which records the page
  count, native 5700×4800 raster dimensions, landscape orientation, page
  rotation, image transform, and PDF inspection tool versions.
- Tool versions, source/config/detector/builder fingerprints, the source
  checksum, build outputs, and git commit are recorded in the private current
  `tenants/hopkins-grove/build/build-manifest.json`; earlier attempts remain
  intact under `tenants/hopkins-grove/build-history/`.

## Successful run results

Command: `node scripts/tenant-build.mjs --slug hopkins-grove --source 'source/2026 Hopkins Map.pdf'`

- 719 candidate polygons; 540 (75%) remain `needs_review`.
- Alignment check: 620 polygons checked, 97.1% interior agreement; edge ratio
  1.3274 against the 1.20 minimum. The strongest 0.35% probe is downward in Y,
  and the same direction wins in all four mean-vertex quadrants. Active-map
  aspect comparison is unmeasured; this probe is diagnostic and no geometry
  correction was applied.
- Background: 3000×2526, 804,702 bytes. Mobile preview: 1600×1347,
  311,168 bytes.
- Both configured OCR engines ran and their raw outputs are preserved. Human
  labels are still absent, so this is not an OCR benchmark and produces no
  token/character accuracy claim.
- Area validation is explicitly `NOT IMPLEMENTED` because scale is unset;
  paint-out and tiles remain `NOT IMPLEMENTED`. No reviewed-block fallback or
  clickable scope is accepted by this run.
- The OCR/correction tolerance mismatch is now guarded by a shared
  versioned-policy contract. No default tolerance is applied; the Hopkins
  policy remains pending, so area results and bulk proposals stay unavailable.
  See `area-validation-policy.md`.
- The 719 lot numbers, tier keys, and polygon vertices match the existing
  `out/hopkins-ocr/lots.json` exactly, so the prepared 100-crop mapping still
  addresses the same detected geometry.
- After extracting the alignment checker from the build script, rerunning it
  on the archived build produced exactly the recorded 97.1% interior rate and
  1.3274 edge ratio. Subsequent full builds fingerprint the extracted
  `scripts/check-lot-alignment.py` input.

## Replay attempt

An initial same-input replay archived the completed run intact, then failed
before detection: Python could not create a temporary file (`No usable
temporary directory`, `ENOSPC`). Its manifest and failure report remain
preserved in `build-history/`; all six outputs from the earlier successful
archive were re-hashed and matched that manifest.

## Low-space replay guard — 11 October 2026

The failed replay established a concrete disk-capacity precondition. The local
builder now checks both the package-output filesystem and OS temporary
filesystem before moving the current build into `build-history/`. Each must
have at least 1 GiB available by default; `WAMULE_BUILD_MIN_FREE_BYTES` can set
an explicit non-negative byte threshold for a known smaller workload. The
capacity-check module is fingerprinted in successful manifests. A regression
check reported 159,940,608 bytes free (about 153 MiB) and stopped before output
archival; hashes of the current build's failure report and manifest were
unchanged, and the existing history directory remained intact. This does not
prove the full Hopkins replay by itself; after disk availability recovered,
the guarded full replay was run successfully.

The latest local verification pass completed `npm test -- --test-reporter=spec`:
225 tests total, 222 passed, 0 failed, and 3 staging-only checks skipped by
default. This verifies the repository unit/database harnesses, not hosted
services or device behavior.

## Replay verification — 11 October 2026 (local)

With over 5.5 GB free, two consecutive full runs completed after the detector
report was made portable and its PDF extraction moved into a scoped temporary
directory. Both manifests record the same source SHA-256 and all six output
SHA-256 values are byte-identical across the runs: `lots.json`,
`ingest-report.json`, `ocr.json`, background WebP, preview WebP and `poc.html`.
The current successful manifest fingerprints the capacity preflight as an
input. The ingest report records the source basename and stable PDF image
metadata, not a machine-specific path or random temporary filename. This is
repeatability evidence on this workstation; another operator has not yet run
the package, so that acceptance item remains open. OCR ran with both configured
engines, but human labels, accepted scale and area validation remain pending.

## Manifest verification — 11 October 2026 (local)

Added `npm run tenant:verify -- --slug hopkins-grove` to validate a completed
private build without modifying it. It checks the manifest schema/tenant,
requires fingerprints for the build's input modules, streams hashes for all
repository-relative inputs and recorded outputs, and rejects missing or
unrecorded outputs, symlink/path escapes, and external-basename-only inputs it
cannot verify. The evidence-inventory module is now fingerprinted by the build
itself because it controls evidence collection and the manifest output list.

The verifier passed against the refreshed Hopkins package: **15 required inputs,
2 reviewer-evidence artifacts, and 6 outputs verified**. The six output hashes
are byte-identical to the immediately preceding archived build. This confirms
the manifest, reviewer evidence, and outputs match on this workstation;
independent-operator replay remains unverified.
The current manifest was refreshed after the benchmark matcher/character-metric
implementation changed; its six output hashes still match the immediately
preceding completed build, while its `ocr-stage` fingerprint records the new
code revision.

## Directional alignment diagnostics — 11 October 2026

The alignment checker now records all four probe scores and mean-vertex
quadrant summaries in `ingest-report.json`. A synthetic shifted-edge regression
confirms the reported probe direction and verifies that diagnostics do not
apply a geometry change.

The guarded full Hopkins rebuild reproduced 97.0968% interior agreement over
620 checked polygons and a 1.3274 global edge ratio. The best probe was
`dx=0.00%, dy=+0.35%`. Quadrant ratios were top-left 1.3045 (81 sampled lots),
top-right 1.3879 (9), bottom-left 1.2899 (43), and bottom-right 1.3216 (108);
all four also favored the +0.35% Y probe. This consistent direction suggests
a map-wide registration issue rather than one isolated quadrant, but the
gradient test is not authoritative enough to identify or approve a correction.
Owner/reviewer confirmation against source evidence and road clicks remains
required; the edge gate remains failed and no polygon was moved.

After the rebuild, `node scripts/verify-tenant-build.mjs --slug hopkins-grove`
passed with 15 required inputs, 2 reviewer-evidence artifacts, and 6 outputs
verified. Compared with the preserved prior build, `lots.json`, `ocr.json`,
both WebP images, and `poc.html` are byte-identical; only `ingest-report.json`
changed (4,860 → 6,724 bytes) to include the new diagnostic fields. The
preceding build remains intact in `build-history/`.

## Detection-stage snapshot guard — 12 October 2026

The completed OCR/matching stage enriches `lots.json` and
`ingest-report.json`, so reusing those final files for `--skip-detect` was not
safe. The tenant builder now saves manifest-fingerprinted
`detection-lots.json` and `detection-ingest-report.json` immediately after
detection, before OCR and matching. `--skip-detect` restores only these
snapshots; older completed manifests without them are refused. The direct map
builder also rejects lot files that already contain OCR/matching fields when
asked to skip detection. Focused reuse, manifest, and map-build regressions
pass.

The refreshed private package still contains 719 candidate polygons, with 540
flagged `needs_review`; it does not approve scope, source fit, scale, register,
or public fields. `npm run tenant:verify -- --slug hopkins-grove` now passes
with **15 required inputs, 2 hashed technical-evidence files, and 8 outputs**.
The two evidence files are `source-audit.json` and
`area-validation-policy.json`; they are not human labels or scale review. The
eight outputs are the two detection snapshots plus final lots/report, OCR
evidence, both WebP images, and the QA HTML. This verifies hashes on this
workstation only; independent-operator replay, human labels, accepted scale,
and area validation remain open.

## Current manifest and owner-input recheck — 12 October 2026

`npm run tenant:verify -- --slug hopkins-grove` was rerun read-only and passed:
15 required inputs, 2 hashed technical-evidence files (`source-audit.json` and
`area-validation-policy.json`), and all 8 output hashes match. Those two files
are provenance/policy records, not human review results. The private OCR
directory contains the blank label page, road-measurement page, and
`labels_template.csv`, not exported human labels or road clicks. No
`approved-register.json` or `map-review.json` was found under the expected local
package/output locations. Thus the evidence pack remains reproducible locally,
while the owner inputs and independent-operator replay remain outstanding.
Browser-local label progress, if any, is not verified by this filesystem check.
