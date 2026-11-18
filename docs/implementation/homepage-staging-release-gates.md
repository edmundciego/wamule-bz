# Homepage staging release gates

Staging acceptance remains on hold pending a current database inventory, publication of the verified release, and the authenticated Hopkins settings save.

## October migration decisions

These are the 12 numbered files on the archived October staging line at `968e74449135006d1962e9f5352339270a7dbf76` that were missing from `351dc529997f5b100d0e3e621493526782cc1003`.

| October staging file | Decision | Reason |
|---|---|---|
| `20260924010000_wamule_default_project_backfill.sql` | Ported to the bootstrap archive | Reproduces Wamule's original default project and scoped legacy inventory in a blank database. |
| `20261014000000_project_phase_hosted_pilot.sql` | Ported to the bootstrap archive | Supplies phases, memberships, and map snapshots before the existing Hopkins and November migrations run. |
| `20261014005000_wamule_default_phase_name.sql` | Ported to the bootstrap archive | Preserves the reviewed default phase display name in the legacy Wamule seed. |
| `20261014010000_scoped_public_inquiry_rpc.sql` | Superseded by `20261019194346_map_studio_packages_and_project_plot_content.sql` | The Map Studio migration creates the active scoped inquiry RPC with published-map references. |
| `20261015022233_tenant_rpc_secret_application_document_isolation.sql` | Ported to the bootstrap archive. The key lookup is also reconciled by `20261118170937_restore_tenant_storage_and_inventory_contracts.sql`. | The private document policies and composite application key precede the November integrity migration. The forward migration restores the service-only Vault lookup and handles legacy credential storage. |
| `20261015100000_hopkins_super_admin_workspace_onboarding.sql` | Superseded by `20261107000300_verified_audit_attribution.sql` and `20261114054243_onboarding_postgrest_role_claims.sql` | The current lineage creates the authorized, audited onboarding RPC. |
| `20261015195458_parcel_board_workspace_scope.sql` | Ported to the bootstrap archive | Adds tenant, project, and phase scope to the invoker-secured parcel inventory view. |
| `20261015210000_inventory_selection_provenance_guard.sql` | Ported forward in `20261118170937_restore_tenant_storage_and_inventory_contracts.sql` | Requires available, manually recorded parcels with a clear review flag when an application is approved. The captured staging ledger records the original body under `20261016001216`. |
| `20261016065252_modular_public_site_experience.sql` | Superseded by `20261118170926_reconcile_project_homepage_settings.sql` | The forward migration installs one save signature and preserves project theme settings. |
| `20261016070858_tenant_scoped_ai_settings_singleton.sql` | Ported to the bootstrap archive using the captured applied SQL | Enforces one AI settings row per tenant without creating a Hopkins-specific configuration. |
| `20261016185842_public_template_default_independent_of_scope.sql` | Superseded by `20261118170926_reconcile_project_homepage_settings.sql` | Regular is the consistent default for an unset layout. |
| `20261017090000_public_site_ui_restriction_flag.sql` | Superseded by `20261118170926_reconcile_project_homepage_settings.sql` | The single save RPC accepts the legacy flag argument. An omitted argument preserves its stored value. |

The bootstrap SQL in `supabase/migrations_archive/bootstrap/` runs only in the branch schema replay. The active homepage and inventory fixes are the two November 18 migrations in `supabase/migrations/`.

## Database evidence

The branch replay builds an empty PostgreSQL 17 database from the repository's foundation, archived prerequisites, numbered migrations, and synthetic Hopkins fixture. The RPC CI job checks each frontend and Edge Function call against the replayed catalog. It also tests settings, Vault access, and approval provenance. See [Supabase RPC contract](../../.github/workflows/supabase-rpc-contract.yml).

Local verification used PostgreSQL 17.11 and local Auth, Storage, and Vault fixtures. Regular and Showcase saved and reloaded for two projects in separate authenticated sessions. The forward migration passed against the reconciled staging snapshot, the original five-argument October function, and both old overloads together. All 43 source RPC calls resolved to a single signature after the fresh replay.

The [GitHub Actions RPC contract run](https://github.com/edmundciego/wamule-bz/actions/runs/44359033532) passed for `fc7872decf962c5b643e8ec5ec0510acd0310b9f`.

The [recorded 73-version baseline](../../evidence/admin-launch-controls-staging-inventory-73-reconciled.json) ends at `20261114054243` and omits `20261017090000`. It describes prior replay evidence. The live staging ledger and signatures are pending because Supabase denied the read-only requests for `kvocwmrcuhiaezlcgzjf`.

Run the following read-only check on staging before a migration push, and retain the output with the deploy record.

```sql
SELECT version, name
FROM supabase_migrations.schema_migrations
ORDER BY version;

SELECT p.proname,
       pg_get_function_arguments(p.oid) AS arguments,
       pg_get_function_result(p.oid) AS returns
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('get_project_site_experience', 'save_project_site_experience')
ORDER BY p.proname, p.pronargs;
```

## Staging migration dry run and apply

Run the release script with Python 3.10 or later and the repository's Supabase CLI from `npm ci`. Use an authenticated Supabase CLI session with access to `kvocwmrcuhiaezlcgzjf`.

```sh
python3 scripts/release-homepage-staging-db.py --record-dir /path/to/deploy-record/db-dry-run
```

The script reads the live ledger and function signatures, records them, and generates a temporary CLI work directory that matches the recorded staging versions. The known Map Studio version alias comes from the 73-version inventory. The script copies the two November 18 migrations from `fc7872decf962c5b643e8ec5ec0510acd0310b9f`, and includes the November 15 project application settings migration if staging still needs it. Keep `live-ledger-before.json` and `cli-dry-run.log` with the deploy record.

The disposable PostgreSQL rehearsal used the recorded 73 versions plus the October 17 legacy save function. The CLI dry run listed the three candidate files and left the ledger unchanged. The apply succeeded, a retry found no pending files, and the database assertions for homepage settings, Vault lookup, and inventory approval passed.

After reviewing that dry run, apply from the same script with a new record directory. The apply step repeats the live checks and the CLI dry run, then records the applied history and the final homepage function signatures.

```sh
python3 scripts/release-homepage-staging-db.py --apply --record-dir /path/to/deploy-record/db-apply
```

Staging uses its existing migration ledger for this release. The production baseline and migration history consolidation follow staging acceptance.

## Staging acceptance

| Comparison | Before | After |
|---|---|---|
| Netlify deploy | [`6afa9cc1b69e9e99aad413d0`](https://app.netlify.com/sites/dcdae9fc-32a2-4290-82d4-e3d02466d36f/deploys/6afa9cc1b69e9e99aad413d0) | Pending publication |
| Source commit | [`f52eb1d001aac90f73607daf358aadfc64724908`](https://github.com/edmundciego/wamule-bz/commit/f52eb1d001aac90f73607daf358aadfc64724908), matched to five published homepage assets | Record the full SHA from the published release |
| Wamule Development | [Staging homepage](https://wamule-staging.netlify.app/p/wamule/wamule?phase=default) | Verify Regular on desktop and phone |
| Hopkins Grove | [Staging homepage](https://ceiba-test.wamuledevelopment.com/hopkins?phase=initial) | Verify Showcase on desktop and phone |

After the reviewed schema upgrade, publish the frontend and `get-public-site-experience` together from a clean checkout of `fc7872decf962c5b643e8ec5ec0510acd0310b9f`. Include the full commit SHA in the Netlify deploy message. On Hopkins Grove, the Super Admin selects **Showcase** and enters **A place to put down roots.** under **Settings → Company Profile → Public homepage**. Save both values together and reload to verify persistence. The headline falls back to the project name on any project with an empty field.

Open the signed-out Hopkins homepage and select outline 559. Confirm **BZD 30,000 per quarter acre** appears on the map and carries through **Apply with this plot** into the application. Capture the desktop and phone comparison after these checks pass.
