# M3 Polish Check — Demo A private surface (verified 11 Oct 2026)

**Candidate surfaces inspected:** `Hopkins Grove – Interactive Lot Map (PoC).html` (tracked standalone, likely private link) and `out/hopkins-grove/poc.html` (generated QA viewer, gitignored). React `PublicLotMap` checked for paint discipline + states.

## Criterion results

| Criterion | Verdict | Evidence |
|---|---|---|
| Crisp at 4x on large screen | **Fail** | Standalone embeds 1000×842 JPEG bg; native raster is 5700×4800 (`masterplan_background.webp`, 1.8MB). Fix = regenerate with higher-res bg (next packet, asset-size decision). |
| No double labels | **Pass** | Zero SVG `<text>` lot labels in standalone; React path is hover-only per aaf495b. |
| Legend from tier catalogue | **Partial** | Generator `buildQaHtml` builds chips from `tiers.json` ✓; standalone has hardcoded `TIERS` snapshot (values match catalogue today — drift risk recorded). |
| Designed lot card (printed number/area/tier/price/status) | **Partial** | Card shows id/tier/price/status/geometry flag + honest placeholder note; printed number, printed area, corner flag, project name missing (needs register + M2 linking). |
| Phone perf (3s visible, 30fps, no console errors) | **Blocked** | No Playwright browsers or device lab on this box. Next packet: install Chromium + measure on emulated midrange-4G, then a real phone. |
| Intentional loading/empty/error states | **N/A (standalone)** / gap (React) | Standalone inlines DATA (no fetch by construction); empty-dataset path unverified. React `PublicLotMap` (60KB): no loading/empty/retry states found — recorded for M3/M5. |
| Paint-out gate | **Held** | Match rate 0.1196 → gate not met → outline/dot kept. React path complies (outlines-only + centroid dots, aaf495b). Standalone still paints translucent fills + **seeded-random statuses** — must be frozen to a reviewed sample datasource before any share (next packet). |
| Private link hygiene | **Fixed this slice** | Added `noindex,nofollow` to generator template, standalone, and generated copy. Standalone header now reads “Proof of concept, sample data” + “traced from sales plat”. Unlisted distribution is an owner action, not code. |

## Changed this slice (local, feature branch)

- `scripts/build-interactive-map.mjs`: noindex in QA template (rebuilds keep it).
- `Hopkins Grove – Interactive Lot Map (PoC).html`: noindex + exact M0 labels.
- `out/hopkins-grove/poc.html`: noindex (generated copy, gitignored).

## Next dependency-ready packet

Freeze the Demo A surface: regenerate standalone with ≥2x bg (or bless a frozen-sample React demo route), frozen reviewed statuses, full M0 card fields, then device perf + empty-state proof. Depends on: labeled benchmark + scale (owner), scope decision (full vs reviewed blocks).
