# Internal Staging Verification — Batch 1

**Classification:** Internal operational record. Do not copy into client-facing
documentation or screenshots.

## Baseline review

Read-only inspection of the connected Wamule project on 2026-07-14 identified
the following legacy voided-contract/Sold-parcel cases. No customer names,
contacts, financial values, or documents are included here.

| Contract ID | Parcel ID | Required staging result |
| --- | --- | --- |
| `1` | `25` | One pending `contract_void_resolutions` record; parcel remains Sold. |
| `2` | `26` | One pending `contract_void_resolutions` record; parcel remains Sold. |

The Batch 1 migration must create these pending review records only when no
existing resolution for the contract exists. It must not release either parcel,
alter either contract, modify payments, or alter documents.

## Environment and migration-chain record

- Production Wamule project: `mtjlvzrtihslcftxnlso`
- Existing preview branches: none (CLI check on 2026-07-14)
- Retired migration `20260714203000_controlled_payment_removal.sql`: not in the
  Wamule migration history; converted to a timestamp-preserving no-op before
  staging.
- Batch 1 executable migration:
  `20260714210447_critical_correctness_batch_1.sql`

## Staging execution record

### 2026-07-14 — blocked before branch creation

- Requested branch name: `batch1-critical-correctness-staging-20260714`
- Requested parent project: `mtjlvzrtihslcftxnlso` (Wamule)
- Confirmed preview-branch estimate: `$0.01344/hour`
- Result: **not created**. Supabase returned `PaymentRequiredException` because
  database branching is supported only on the Pro plan or above.
- Branch lifetime and charge: `0`; no branch was provisioned and no migration,
  fixture, role test, Edge Function, or application build was applied.
- Production effect: none.

The safe migration sequence is therefore **not verified in staging**. Do not
apply it to production. The next approved path must be either an eligible
Supabase preview branch or a separately approved, isolated staging project.

When an isolated environment is available, record its ref, migration history,
notices, policy/function/view inspection, role checks, and fixture results here.
Do not record credentials, customer data, or document URLs.

### 2026-07-14 — Free staging-project availability check

- Organization: `edmundciego's Org` (`ztnkkukvnzmvsceligub`), plan `free`.
- Active Free projects: `Wamule` (`mtjlvzrtihslcftxnlso`) and
  `edmundciego's Project` (`kvgytiofjpvfroyvuben`).
- Requested project: `wamule-staging`; quoted project creation cost: `$0/month`.
- Result: **not created**. Supabase rejected creation because the account owner
  has reached the two-active-Free-project limit.
- The second project cannot be classified as safely pausable from this review:
  it has an unrelated populated schema and one stored form submission, despite
  having no Wamule migration history or Edge Functions. Do not pause it without
  the project owner's impact confirmation.
- Production effect: none. No plan, project, migration, data, credentials, or
  deployment was changed.

## Production release preflight — 2026-07-14

**Status: blocked before migration application.**

- The retired migration remains a timestamp-preserving no-op and is absent from
  the Wamule migration history.
- Wamule's current remote migration history ends at
  `20260625000200_lead_duplicate_detection`. The two older pending timestamps
  (`20260714074603_release_quality_data_management` and
  `20260714203000_controlled_payment_removal`) are documented no-ops and create
  no database objects. The only pending functional migration is
  `20260714210447_critical_correctness_batch_1`.
- A current logical/database backup could not be created or confirmed from this
  checkout. The project is on the Free plan, and no linked database credentials
  or Supabase backup control is available here. Do not apply the migration until
  an owner confirms a current restore-capable backup or provides an approved
  backup path outside this repository.
- The current Netlify deployment cannot be identified from this checkout: there
  is no checked-in Netlify project configuration or deployment credential. The
  working tree also contains uncommitted Batch 1 source changes, so a matching
  frontend release cannot be safely confirmed.
- The remote security advisor reports pre-existing external security findings,
  including SECURITY DEFINER views and executable SECURITY DEFINER functions.
  Batch 1 improves `customer_balance_view` and adds guarded new RPCs, but this
  pre-existing advisor state must be accepted or remediated before role-based
  production verification can be certified.

No migration, Edge Function, frontend deployment, test record, backup, or
production operational record was changed during this preflight.

### Local replay and backup preflight — blocked

- `supabase start` / `supabase db reset` were not run because Docker is not
  installed or its daemon is not available on this workstation
  (`docker_exit=127`; no Docker socket).
- Required local prerequisite: install and start Docker Desktop (or another
  compatible Docker daemon), then rerun `supabase start` and `supabase db reset`
  from this repository. Do not use `--linked` or a remote reset.
- `WAMULE_DB_URL` is absent from the secure process environment. Required
  production-backup prerequisite: place the Session Pooler URL, including the
  database password, in that environment variable without committing or printing
  it, then run the approved `supabase db dump` commands to a gitignored or
  external backup directory.
- No remote migration dry run, production migration, Edge Function deployment,
  frontend deployment, test record, or production data change was attempted.
