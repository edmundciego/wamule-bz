# Hopkins within-draft overlap review queue — 11 October 2026

This is a local, report-only recomputation. It identifies geometry pairs for
human review; it does not classify parcels, approve common areas, waive
conflicts, or authorize publication.

## Reproducibility

- Run: `node scripts/slice16-hopkins-overlap.mjs`
- Input: `out/hopkins-ocr/lots.json` (719 candidate shapes)
- Input SHA-256: `f70084a8e7c9ba0ea2b0203bfbf4af678d3f09b60a712ec5b469f45ff08aafa0`
- Run time: 2026-10-11 21:30:36 UTC
- Repository HEAD: `e6f8aafe49f5a96591918c19402a7a0e9741c25a`
- Script SHA-256: `64dc1ec7305f11fad5daddc63d7adfc600f5cfb2de6fe95995cd0c6898d65c92`
- `src/lib/correction/overlap.ts` SHA-256:
  `6d389526a7f824674758f44e2895b4b51c6e0e42e974f7df9fd8708d0d1ce0bc`
- `src/lib/correction/index.ts` SHA-256:
  `809eeaec54b8aeeb35537920fcca44f616efca8d01553c25352041a20cc5c0f9`

The canonical overlap check tests strict polygon-interior intersection;
shared edges alone are not reported. It checked 258,121 pairs, with 697
bounding-box prefilter hits and 14 strict overlaps. The result matches the
historical count of 14, but the identities below are freshly computed from the
fingerprinted input.

## Pair queue

| Detection A | Tier | Detection B | Tier | Review status |
| --- | --- | --- | --- | --- |
| L-020 | standard | L-021 | premium | Pending human review |
| L-028 | creek | L-029 | premium | Pending human review |
| L-048 | standard | L-058 | creek | Pending human review |
| L-086 | creek | L-087 | premium | Pending human review |
| L-137 | standard | L-155 | creek | Pending human review |
| L-155 | creek | L-156 | standard | Pending human review |
| L-237 | premium | L-258 | creek | Pending human review |
| L-238 | premium | L-258 | creek | Pending human review |
| L-239 | boulevard | L-258 | creek | Pending human review |
| L-362 | creek | L-363 | boulevard | Pending human review |
| L-415 | premium | L-416 | creek | Pending human review |
| L-416 | creek | L-417 | premium | Pending human review |
| L-509 | premium | L-541 | creek | Pending human review |
| L-541 | creek | L-542 | premium | Pending human review |

Thirteen pairs include a detection tagged `creek`. That tier tag is not a
sellable/common-area decision and is not a conflict disposition. All 14 pairs
remain unresolved until a reviewer examines the source map and approved scope,
records an explicit pair-specific disposition, and any required geometry fix
or waiver is implemented and validated.

## Still pending

- Approved register and scope, including sellable versus common-area decisions.
- Reviewer identity and source-backed decision for each pair.
- Correction-workspace controls for selecting a detected pair, recording an
  overlap waiver and visibly flagging a waiver after geometry changes. The
  shared domain gate and waiver binding/invalidation are implemented and
  regression-tested; the UI remains pending design-context setup.
