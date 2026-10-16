# Hopkins owner-operated pilot — production release package

Prepared 2026-10-16. This is a release candidate for owner review. No production migration, database write, function deployment, Netlify deployment, DNS update, or paid resource was used during preparation.

## Target and current release state

- Supabase production: `Wamule`, ref `mtjlvzrtihslcftxnlso`, `us-west-2`, PostgreSQL `17.6.1.155`.
- Existing Netlify site: `wamule-bz`, site ID `d4091452-ceb8-40a6-9d3d-4068e91a0d09`, current primary domain `wamuledevelopment.com`.
- Hopkins host prepared for that same site: `hopkinsgrove.ceiba.bz`.
- Staging source: `kvocwmrcuhiaezlcgzjf`; the package contains the approved, staging-derived 775-outline geometry snapshot and the reviewed PDF-source metadata. It contains no staging applicants, inquiries, leads, tasks, or Auth users.
- Candidate snapshot SHA-256: `d9243c9b8cbe140df365f569c85246c4f738f881be528fe524e515c82cfc321a`.
- Source map snapshot fingerprint: `13c4eb7731bd0ee9fe5e988b5b904a848c2791dc5255c78e9b9a2cbf75a32e06`.
- Number/source comparison: 80 printed-number reads visually reviewed against source; two outlines remain explicitly ambiguous because each outline contains multiple printed lot numbers. Generated `Plot NNN` references remain separate from printed numbers. The geometry import does not create inventory, assign sale eligibility, or add prices.
- Tiers: standard 169, creek 23, premium 358, boulevard 174, purple 18, orange 26, red 6, and one unassigned-source-fill outline. See `source/hopkins-source-comparison.md` and `source/number-crosswalk.csv`.
- Outbound notices are disabled in the packaged Hopkins application settings.

## Production baseline recorded read-only

See `production-baseline.json` for all 40 table counts and SHA-256 rowset fingerprints, complete migration ledger, Auth summary, Storage bucket configuration and policy inventory. Fingerprints contain no row contents; they are preservation evidence, not a database backup.

- The production ledger has 29 entries and ends at `20260715055626 information_centre_foundation`.
- The existing production business data includes 24 parcels, 4 leads, 4 applications, 3 admin profiles, 5 business-setting rows, 2 customers, 2 contracts, 2 transactions, and 1 reservation. Full counts and rowset fingerprints are in the baseline file.
- Auth read-only state: 4 users, 3 email-confirmed, none banned/deleted; signups enabled; email and phone auto-confirm disabled; email is the only active external provider.
- The Auth public settings endpoint returned HTTP 200. The available admin config endpoint returned HTTP 404, so Auth Site URL and redirect allowlist were not verified. Review those values in the production Auth dashboard before cutover, and add the new admin login redirect only if the owner needs it.
- Storage baseline: five buckets, zero objects, zero object bytes, 145 policies. `storage-backup-manifest.json` records this separately. Since no objects existed, the object-byte backup is an empty inventory, not a non-empty archive.
- The production extension inventory reports `supabase_vault` 0.3.1 and `pgcrypto` 1.3 installed. See `production-extensions.json`. The Vault encryption root key was not exported.
- Production's current schema is still the legacy, non-tenant-scoped schema; `organizations` was absent in the earlier live catalog comparison. The new tenant migrations have not been applied.
- No query result with row contents, password, secret key, or applicant PII is part of the release package.

## Backup and rehearsal status: blocking

A restorable production PostgreSQL archive was **not** captured or restored. No production database password/direct connection URI is configured in the local environment. Native `pg_dump`, `pg_restore`, `psql`, `postgres`, `initdb`, and `pg_ctl` are not installed in the inspected native tool locations. The local Supabase CLI cannot supply its missing `pg_dump` dependency, and the available connector exposes read-only queries rather than a downloadable database backup. Do not substitute the staging database credential.

The exact migration chain and ledger reconciliation have therefore **not** been rehearsed against a disposable restore of production. The no-Docker embedded PostgreSQL fixture rehearsal passed 14/14 checks for scoped onboarding/import and fixture dump/restore, but that is not a production backup restore and does not validate all 22 migrations against Wamule's actual rows. Do not treat it as cutover approval.

There is a second, independent restore limitation: Supabase Vault secrets use a per-project encryption root key held by Supabase. A plain PostgreSQL dump does not carry that key; a local PostgreSQL restore without the compatible Vault extension and matching key cannot be called complete or prove that Vault secrets decrypt. Supabase's Vault restore guidance says manual dump/restore to another project requires moving the project root key through the Management API. The key was not read or saved here. A native fixture may test the migration's SQL control flow with synthetic secrets, but it cannot validate production secret recovery. See [Supabase Vault](https://supabase.com/docs/guides/database/vault) and [Backup and Restore using the CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).

Before cutover, provision only the missing existing tools and secure connection through the local secret store: the production PostgreSQL connection information/password and PostgreSQL 17-compatible `pg_dump`/`pg_restore` plus local server utilities (`initdb`, `pg_ctl`, `postgres`, `psql`). Separately confirm the owner-approved Vault root-key recovery procedure and whether an extension-compatible local restore is available without adding paid resources. Keep all credentials/root keys in a protected local secret store, not CLI arguments, repository, or chat. Then:

1. Capture a custom-format production dump into an owner-controlled encrypted directory outside Git; record SHA-256 and byte size. Use TLS, stop if the backup command exits nonzero, and do not include secrets in logs.
2. Repeat the independent Storage object inventory immediately before cutover. If it is still empty, record zero objects/bytes. If it is no longer empty, download every object through the Storage API/S3-compatible route, retain bucket metadata separately, and verify every exported byte count and SHA-256. PostgreSQL backup does not contain Storage object bytes.
3. Restore the untouched archive into a fresh disposable local PostgreSQL 17 server. Keep the original archive immutable. Compare core table counts and the 40 rowset fingerprints; record managed Supabase/Auth/Storage/Vault limitations. Do not claim Vault completeness unless the compatible extension and matching encryption root key can decrypt a synthetic verification secret and authorized production Vault records. Then rehearse the exact pending migrations and Hopkins bootstrap/import on that restored copy. Stop on any ownership conflict, migration error, changed Wamule business value, extension error, or unexplained rowcount difference.

Supabase-managed Auth and platform services are not recreated by a plain PostgreSQL logical restore. Storage object bytes also require a separate copy. A successful SQL restore alone is not complete Supabase disaster recovery. Supabase documents that DB backups exclude Storage object files and directs users to separately download/migrate Storage objects; see [Database Backups](https://supabase.com/docs/guides/platform/backups) and [Download Objects](https://supabase.com/docs/guides/storage/management/download-objects).

## Migration manifest and ledger reconciliation

`migration-manifest.json` records the SHA-256 of every candidate SQL file. The ordered production candidate after the legacy Information Centre ledger alias is:

1. `20260915000000_multi_tenant_foundation.sql`
2. `20260916000000_tenant_default_trigger_and_vision.sql`
3. `20260917000000_seed_wamule_tenant.sql`
4. `20260918000000_masterplan_image_storage.sql`
5. `20260919000000_masterplan_versioning.sql`
6. `20260920000000_security_hardening_audit.sql`
7. `20260921000000_lot_tiers_and_parcel_extensions.sql`
8. `20260922000000_inquiry_idempotency.sql`
9. `20260923000000_brand_spelling.sql`
10. `20260924000000_tenant_projects.sql`
11. `20260924010000_wamule_default_project_backfill.sql`
12. `20260925000000_correction_slice15.sql`
13. `20261011000000_public_lot_identity_lockdown.sql`
14. `20261012020651_project_scoped_public_maps.sql`
15. `20261014000000_project_phase_hosted_pilot.sql`
16. `20261014005000_wamule_default_phase_name.sql`
17. `20261014010000_scoped_public_inquiry_rpc.sql`
18. `20261015022233_tenant_rpc_secret_application_document_isolation.sql`
19. `20261015100000_hopkins_super_admin_workspace_onboarding.sql`
20. `20261015195458_parcel_board_workspace_scope.sql`
21. `20261015210000_inventory_selection_provenance_guard.sql`
22. `20261016054341_hopkins_project_application_workflow.sql`

Production records the existing Information Centre migration name at version `20260715055626`; the repository version is `20260715050000`. Earlier live catalog comparison found the same four Information Centre tables and matching core definitions. Preserve the remote ledger row. After fresh pre-cutover catalog comparison, and only if the equivalence still holds, reconcile the local alias by marking `20260715050000` applied with `supabase migration repair 20260715050000 --status applied --db-url "$PRODUCTION_DATABASE_URL"`. This records the already-present change under the repository version; it must not replay that seed migration. Then run `supabase migration list --db-url "$PRODUCTION_DATABASE_URL"` and `supabase db push --dry-run --db-url "$PRODUCTION_DATABASE_URL"`; the pending list must match the 22 versions above exactly. Any difference blocks release.

The whole 22-file chain is not yet restore-rehearsed. Production migration apply is blocked until backup and exact restore-based rehearsal pass. The tenant migration/backfill must preserve each legacy row and assign only to Wamule where ownership is established; any conflicting or ambiguous ownership must stop the release. No manual edits to Wamule records to force expected counts are permitted.

## Exact cutover sequence after blockers clear

1. Freeze unrelated deployments. Confirm the reviewed revision hash, artifact hashes, production project ref, 40-group pre-cutover baseline, storage inventory, and owner-controlled encrypted backup. Confirm the restored copy and exact migration rehearsal have passed.
2. In a detached worktree of the reviewed release revision, use the production-targeted Supabase config in this package (copy it to that worktree's `supabase/config.toml`). Keep the primary checkout and its staging-linked config unchanged. Set production credentials only from the protected production secret store.
3. Re-read the remote migration ledger and catalog. Reconcile only the verified Information Centre alias. Confirm the `db push --dry-run` output exactly matches the ordered 22-file manifest.
4. Apply migrations in two isolated CLI workdirs. The final workflow migration `20261016054341_hopkins_project_application_workflow.sql` deliberately fails unless Hopkins tenant/project/phase already exists. Prepare the first view with `node scripts/prepare-hopkins-production-migration-phase.mjs --through-version 20261015100000`, run its printed `supabase db push --db-url "$PRODUCTION_DATABASE_URL"` command, and stop if its pending ledger differs from the first 19 entries in this manifest. This introduces the atomic onboarding RPC before calling it. Do not run schema reset, `db pull`, broad SQL repair, or unrelated data maintenance.
5. Recheck the 40 legacy fingerprints and Wamule row counts/relationships. Confirm all original parcels and sales records remain Wamule-owned; no Hopkins scope contains legacy Wamule rows. Check Vault requirements/secrets and extension availability explicitly. Document unavailable Supabase-managed extensions rather than ignoring errors. Stop on any mismatch.
6. Read-only lookup of `ed-admin@wamuledevelopment.com` must resolve exactly one active, confirmed production Auth account whose existing profile role is `Super Admin`. Run the guarded `tenant:onboard-hopkins-production --dry-run` first. Then run its apply command with `--defer-public-settings`; this calls the atomic scope bootstrap while public-application settings are still outside the schema constraint. The existing Super Admin keeps the same profile tenant and role; only the Hopkins project membership is added. Do not create another tenant if `hopkins-grove` exists; refuse conflicts.
7. Prepare the full migration view with `node scripts/prepare-hopkins-production-migration-phase.mjs --through-version 20261016054341` and apply it with `supabase db push --db-url "$PRODUCTION_DATABASE_URL"`. The 3 remaining migrations now include the scoped workspace changes, provenance guard, and application workflow. The last migration seeds the Hopkins public application settings and requires the previously bootstrapped scope.
8. Rerun `tenant:onboard-hopkins-production --dry-run` and then the idempotent apply without `--defer-public-settings`. Verify tenant `hopkins-grove`, project `hopkins-grove`, phase `initial`, demo map mode, theme/company profile, and exact packaged `public_application` settings with outbound notifications disabled. Confirm there are no Wamule payment terms or availability values. A differing pre-existing setting is preserved and blocks the release.
9. Run the production map importer first without activation. It verifies all package hashes, scope, settings, 775 unique feature keys, geometry validity, 80 source reads and two ambiguities; it upserts stable identities and the geometry-only map snapshot, then uploads the checked raster to `project-map-public`. Confirm counts, identity stability, source hashes, tier metadata, Storage path and no duplicate rows. Repeat the identical import and verify unchanged identity IDs and feature count.
10. Only after full map and public-setting review, invoke the importer's separately gated `--activate`. The activation RPC switches the Hopkins demo snapshot and image version atomically. It does not change `parcels`, prices, sale status, or Wamule map rows.
11. Deploy only the functions listed in `function-deploy-manifest.json` with explicit `--project-ref mtjlvzrtihslcftxnlso`; preserve JWT verification settings from `supabase.production.toml`; never use `--prune`. Deploy the frontend to the existing Netlify `wamule-bz` site from this exact revision, after setting `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_HOPKINS_PUBLIC_HOST` in the site's production build environment. Keep existing Wamule host branding and routing intact.
12. Verify without login: Wamule homepage/form, Hopkins homepage/application, the existing Hopkins embed route, background and 775 selectable outlines, details, source labels/tiers, reload, application preferences, anonymous retry deduplication, and no assignment/availability invention. Run Super Admin workspace Wamule → Hopkins → Wamule, verify Wamule records/settings match baseline, and confirm admin routes remain protected. Staff testing remains deferred. Use synthetic applicants only if a production-safe test policy is separately approved; outbound messages stay disabled.
13. Compare all 40 baseline table counts/fingerprints, Wamule profile/settings, Auth configuration and Storage inventory. The only allowed data delta is the explicitly reviewed Hopkins tenant/project/phase/settings/membership, geometry snapshot/identities/features, and Hopkins display raster. Preserve the post-cutover evidence and request separate owner approval before any production release is called complete.

## Production import commands prepared

Run only from the reviewed release worktree after a separate production cutover approval. These commands are gated; they were not run during preparation.

```sh
node scripts/tenant-onboard-production.mjs --dry-run --expected-project-ref mtjlvzrtihslcftxnlso
node scripts/tenant-onboard-production.mjs --apply --allow-production --defer-public-settings --expected-project-ref mtjlvzrtihslcftxnlso --ack-production-text "I understand this creates the Hopkins workspace in Wamule production"
# Apply migration phases through 20261015100000, bootstrap scope, then through 20261016054341.
node scripts/tenant-onboard-production.mjs --dry-run --expected-project-ref mtjlvzrtihslcftxnlso
node scripts/tenant-onboard-production.mjs --apply --allow-production --expected-project-ref mtjlvzrtihslcftxnlso --ack-production-text "I understand this creates the Hopkins workspace in Wamule production"
node scripts/import-hopkins-production-snapshot.mjs --dry-run --expected-project-ref mtjlvzrtihslcftxnlso
node scripts/import-hopkins-production-snapshot.mjs --apply --allow-production --expected-project-ref mtjlvzrtihslcftxnlso --ack-production-text "I understand this writes the Hopkins map to Wamule production"
# Repeat the identical --apply command and confirm the same 775 identities/features.
# Activate only after separate hosted checks:
node scripts/import-hopkins-production-snapshot.mjs --apply --allow-production --activate --expected-project-ref mtjlvzrtihslcftxnlso --ack-production-text "I understand this writes the Hopkins map to Wamule production"
```

Both scripts read credentials from the protected environment, never command-line arguments, and print no keys or Auth UUIDs. The first command requires the production service-role environment to perform read-only Auth/profile checks. The import command refuses any other Supabase host, validates the entire packaged snapshot, and does not activate unless `--activate` is explicitly passed.

## Netlify and Ceiba domain preparation

Use the existing Netlify site `wamule-bz`; do not create another site. In Netlify, select the existing site's domain management and add `hopkinsgrove.ceiba.bz` as an additional custom domain. Use the exact CNAME/ALIAS target and DNS verification instructions Netlify presents for this site. Do not make a DNS change until the owner approves the final cutover. Leave `wamuledevelopment.com` attached and unchanged. Configure the three frontend variables from `frontend-production.env.example` in the site's production context; the anon key is public but must be read from the production project, while service-role credentials must never be set in frontend variables. After the domain is connected and TLS is issued, verify host-based routing in a fresh anonymous browser.

## Rollback

- If a migration or preservation check fails before frontend deploy, stop all steps. Do not attempt compensating tenant/ownership edits. Restore the immutable pre-cutover DB backup to the isolated rehearsal target first and diagnose there.
- If production is in a failed state, use the owner-approved restore plan with the verified database archive and the separately captured Storage objects/metadata. A logical PostgreSQL restore alone is not complete Supabase recovery; Auth/platform settings and Storage object bytes need separate restoration or verification.
- Redeploy the exact prior Netlify production deploy. Redeploy the prior Edge Function source revision with the same explicit function config. Keep DNS unchanged unless the owner separately decides to remove the new alias.
- Because the importer keeps new map rows inactive until activation, an import failure before activation leaves the existing Hopkins/Wamule public map unchanged. If already activated, use the prior verified map snapshot/version through the existing activation process or restore the complete pre-cutover backup; do not delete or rewrite Wamule records.
- New files are under the Hopkins project prefix in `project-map-public`. Preserve them during diagnosis. If rollback later removes the new prefix, verify it contains only this release's package-hash object and remove it through the Storage API, never by deleting `storage.objects` rows.
- Recompute the 40 rowset fingerprints and Storage inventory after recovery; record recovery time and any managed-service limitation. Do not claim recovery success until those checks match.

## Remaining blockers

1. Production database credential/direct TLS connection and native PostgreSQL 17 backup/restore/server tools are unavailable locally; therefore no restorable production dump or restore validation exists.
2. The local workstation does not contain the Supabase-managed Vault extension/root key combination; full local Vault secret recovery is unproven, even after the native PostgreSQL utilities are available.
3. Exact 22-migration chain and ledger alias reconciliation remain unrehearsed against a fresh production restore. The 14/14 embedded fixture pass is useful but insufficient.
4. Auth admin Site URL/redirect allowlist could not be read through the exposed endpoint; verify it in the production dashboard.
5. No production migration, workspace onboarding, map import, function/frontend deploy, domain attachment, DNS change, or production hosted verification has been performed.

Exact next action: provide the production database connection through the local protected environment and make PostgreSQL 17-compatible `pg_dump`, `pg_restore`, `postgres`, `initdb`, `pg_ctl`, and `psql` available on the workstation. Then create and restore the production archive and rerun the exact rehearsal. Do not send credentials in chat.
