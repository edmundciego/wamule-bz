# Register-to-polygon reconciliation (M1/M2 preparation)

`scripts/reconcile-register.mjs` produces a local, report-only reconciliation. It never edits `lots.json`, derives legal identity from OCR, or grants release approval. The current Hopkins detections use generated identifiers (`L-001`-style); treat those only as `detection_id` values.

## Inputs

`approved-register.json` is the owner-approved project/phase register. It must carry:

- `schema_version: 1`, `project: {id, name}`, `scope: {id, name}`, and a `revision`; project/scope IDs, revision, legal IDs, display numbers, and detection IDs must not have leading or trailing whitespace;
- `approval: {status: "approved", approved_by, approved_at, source}`;
- `sources` entries for `legal_identity`, `area_unit`, `tier`, `price`, and `status`, each with `document`, `revision`, and `locator`;
- `lots[]` rows with `legal_lot_id`, `display_lot_number`, `area_value`, `area_unit`, `tier_key`, `price_amount`, `price_currency`, `status`, and boolean `in_scope`. Legal IDs must be unique; displayed lot numbers may repeat across blocks/phases and remain separate by legal ID.

Area units currently accepted for discrepancy comparison are m², ft², acres, and hectares. The conversion must remain finite and positive. Prices and statuses are carried from the register; no defaults are inferred.

`map-review.json` contains explicit human decisions. Its `project_id` and `scope_id` must match the approved register. Each `links[]` row has `detection_id`, `legal_lot_id`, `decision` (`approved`, `ambiguous`, or `rejected`), `reviewer`, timezone-qualified ISO-8601 `reviewed_at` (`YYYY-MM-DDTHH:mm:ss[.sss](Z|±HH:mm)`), and `source`; unresolved rows also need a `note`. Each `dispositions[]` row has `detection_id`, `disposition` (`sellable`, `common_area`, `out_of_scope`, or `ambiguous`), `feature_type`, reviewer, timestamp and source; ambiguous rows need a note. A sellable polygon is not a legal lot link until a reviewer adds an approved link.

## Fill-in templates

- [`approved-register.template.json`](approved-register.template.json) lists the required register fields and source citations. Replace its blank example row with one row per legal lot; do not derive canonical identity, scope, area, tier, price, or status from OCR.
- [`map-review.template.json`](map-review.template.json) lists the link and feature-disposition fields. Replace each pending row only with a decision grounded in a human review; include reviewer, timestamp, and source.

These are field templates, not Hopkins data or approval evidence. Their blank values and `pending` decisions are intentionally rejected by the reconciler. Do not run them as-is or treat them as satisfying the owner gates. Completed owner inputs must be approved and source-bound before reconciliation.

## Run

```sh
node scripts/reconcile-register.mjs \
  --register <approved-register.json> \
  --review <map-review.json> \
  --lots out/hopkins-ocr/lots.json \
  --out out/hopkins-register-reconciliation.json
```

The output records SHA-256 fingerprints for all three inputs, register coverage, detection dispositions, one-to-one link conflicts, and OCR/tier/area discrepancies. OCR is discrepancy evidence only: even an exact printed-number match remains `missing`/`sellable_unlinked` until a reviewed link is supplied. A complete report is `reconciled_pending_owner_acceptance`; `release_approval` remains false. The output path is create-only so an existing report is never overwritten.

Unknown or repeated CLI options fail before reading or writing evidence, so a typo cannot silently fall back to the default output path.

## Hopkins status

No approved register, map reviewer decisions, or feature-level sellable/common-area sign-off is present yet. Therefore this tool has not been run on Hopkins and no canonical lot rows or reconciliation report have been created. The current OCR/detection output remains untrusted working evidence.
