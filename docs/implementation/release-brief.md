# M0 Release Brief — Demo A (private polish)

**Target:** Demo A only: a private, polished map link. Not shared with Ceiba; no Ceiba contact yet.
**Date:** 11 October 2026. **Owner (scope/conflicts):** Edmund (owner resolves register/drawing disagreements).
**Baseline:** `staging` at `3c368d2`. Local-only slice: no push, deploy, hosted migration, or notification sends.

## Decisions (locked for Demo A)

- **Release target:** Demo A, private polish. No public launch, no Ceiba sharing.
- **PoC source of truth:** the plan's printed numbers/areas and legend prices — not OCR output, not detection medians.
- **Status label:** sample data, visibly labeled **"Proof of concept, sample data"**.
- **Provenance label:** **"traced from sales plat"**.
- **Scope:** full Hopkins plan visible; interactive (clickable) coverage decided after the labeled benchmark. Fallback: a few fully reviewed blocks.
- **Common areas** (roads, creek, boulevard, non-lot shapes): non-sellable, never purchasable.
- **Conflict resolver:** owner.
- **Public fields (allowlist):** lot number, tier name/color, status, effective price, area m² and sq ft, corner flag, project name, legend.
- **Never in public:** confidence, review flags, override reasons, editor names, notes, internal IDs.
- **Roles:** editor, publisher, tenant admin, platform admin (permission matrix per release-plan §5; enforced in M4/M6, documented here).
- **Private link:** unlisted URL + `noindex,nofollow`. No Ceiba data in any public bundle.

## Open inputs (block M1/M2, not Demo A polish)

- Approved register (legal lot identity, area/unit, tier, price/status sources).
- 100-crop human labels + road-calibration clicks (owner workflows in `review-pack.md`).
- Measured scale (until then: scale-area signal stays "unavailable", Hopkins bulk accept stays disabled).

## Acceptance for this slice

- [x] Decisions recorded here and referenced by downstream docs.
- [ ] Migration inventory + bootstrap recommendation (`migration-inventory.md`).
- [ ] Source audit against stated PDF hypotheses (`source-audit.md`).
- [ ] Review pack + measure workflow ready for owner (`review-pack.md`).
- [ ] M3 polish criteria verified on the private PoC (`polish-check.md`).
