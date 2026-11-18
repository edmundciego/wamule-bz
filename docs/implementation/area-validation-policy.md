# Area-validation policy contract

The OCR pipeline previously defaulted to an 8% area tolerance while the
correction model defaulted to 15%. Both implicit values are removed. A pass or
outlier verdict now requires the same approved, versioned policy record; an
absent or pending policy produces an `unavailable` area signal and cannot
qualify a bulk proposal.

Tenant packages initialize the record at
`evidence/area-validation-policy.json` with `status: "pending"` and all
approval fields null. That file is private review evidence and is fingerprinted
in each tenant build manifest. No tolerance, approver, approval date, basis, or
source reference has been selected for Hopkins.

An approved record has `schema_version: 1`, `status: "approved"`, a stable
`policy_id`, positive integer `policy_version`, numeric
`tolerance_fraction` from 0 inclusive to 1 exclusive, `approved_by`, an
ISO-8601 `approved_at` with timezone, a written `basis`, and an
`evidence_reference` to the approval record/source revision.

Changing the tolerance or its basis requires incrementing `policy_version` and
retaining the prior record as review history. A pending or malformed record is
never promoted implicitly. The Python stage independently validates the
record; the tenant builder validates it before execution and records the file
fingerprint. The correction model requires the same typed values at runtime.

This contract does not approve map scale. Scale still requires independently
reviewed calibration from the source map, and comparison figures still require
register/human provenance. Those inputs remain separate gates.

## Correction-area semantics

In the correction model, `slot.area` is a mutable working-copy value in square
metres, initially seeded from OCR and editable during review. It is not a
measurement. `slot.ocr_area` preserves the original OCR value as an immutable
ingest snapshot. Editing either value cannot satisfy the measured-area gate.

The measurement is calculated from the lot polygon: shoelace area in plan
percentage-squared (`polygonAreaPct2`) multiplied by the independently
reviewed scale in square-metres per percentage-squared
(`ScaleRef.sqmPerPct2`). That measured square-metre value is compared with a
separately supplied, provenance-bearing `reviewed_area.area_sqm`. Until scale,
reviewed area evidence and this approved policy are all valid, the signal is
`unavailable`; no OCR or working-copy area is substituted. The model and
regression coverage live in `supabase/functions/_shared/correction/model.ts`,
`supabase/functions/_shared/correction/types.ts` and
`test/bulk-accept-slice16.test.mjs`.
