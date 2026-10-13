# M0 Release Brief — Demo A (private polish)

**Target:** Demo A only: a private, polished map link. Not shared with Ceiba; no Ceiba contact yet.
**Date:** 11 October 2026. **Owner (scope/conflicts):** Edmund (owner resolves register/drawing disagreements).
**Baseline:** `staging` at `3c368d2`. Local-only slice: no push, deploy, hosted migration, or notification sends.

## Demo A contract

- **Release target:** Demo A, private polish. No public launch, no Ceiba sharing.
- **Buyer UI baseline:** phone-first, calm and platform-neutral; tenant theme tokens supply color/type; no platform wordmark, false urgency, or competing status/tier palettes. WCAG 2.2 AA is the target. Detailed personality, references and anti-references are in `PRODUCT.md`.
- **PoC source of truth:** the plan's printed numbers/areas and legend prices — not OCR output, not detection medians.
- **Status label:** sample data, visibly labeled **"Proof of concept, sample data"**.
- **Provenance label:** **"traced from sales plat"**.
- **Scope:** full Hopkins plan visible; interactive (clickable) coverage decided after the labeled benchmark. Fallback: a few fully reviewed blocks.
- **Common areas** (roads, creek, boulevard, non-lot shapes): non-sellable, never purchasable.
- **Conflict resolver:** owner.
- **Candidate public fields (owner sign-off pending):** lot number, tier name/color, status, effective price, area m² and sq ft, corner flag, project name, legend.
- **Never in public:** confidence, review flags, override reasons, editor names, notes, internal IDs.
- **Roles of work:** engineering, map review and release operations (work owners are not yet fully assigned). Permission-model role definitions/enforcement remain deferred to M4/M6.
- **Private link:** unlisted URL + `noindex,nofollow`. No Ceiba data in any public bundle.

## Open owner inputs (gates noted per item)

- Confirm interactive launch scope: full Hopkins or an explicitly named phase (M0/M1). The plan may remain visually complete; the reviewed-blocks fallback stays available after the benchmark.
- Approve the register (legal lot identity, area/unit, tier, price/status sources) (M0/M1).
- Configure `public_application.lot_map_tenant_slug` with the approved organization slug before enabling public application and inquiry submissions; these server-side writes now fail closed without it.
- Confirm sellable-vs-common-area classification for the actual map features and approve the candidate public-field allowlist above (M0/M3).
- Before public-field sign-off, deploy and smoke-test the locally implemented ID boundary: project-scoped public references now cover the map, inquiry and application flows; the local migration revokes the legacy view and direct anon insert. Internal IDs remain excluded from the public allowlist.
- Assign the map reviewer (M0; owner remains the conflict resolver).
- Provide 100-crop human labels + road-calibration clicks (M1; owner workflows in `review-pack.md`).
- Confirm measured scale from approved references (M1/M2; until then, scale-area signal stays "unavailable" and Hopkins bulk accept stays disabled).

## Acceptance for this slice

- [x] Settled decisions and unresolved owner inputs recorded here and referenced by downstream docs.
- [x] Migration inventory + bootstrap recommendation (`migration-inventory.md`).
- [x] Source audit against stated PDF hypotheses (`source-audit.md`, SHA-256 recorded).
- [x] Review pack + measure workflow ready for owner (`review-pack.md`).
- [ ] M3 polish criteria verified on the private PoC (`polish-check.md`).
