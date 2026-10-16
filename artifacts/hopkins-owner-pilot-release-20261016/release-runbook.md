# Hopkins owner-operated pilot — production release package

Prepared 2026-10-16. This is a release candidate for owner review. No production migration, database write, function deployment, Netlify deployment, DNS update, or paid resource was used. Staging received the reviewed template RPC migration and public site-experience Edge Function for regression; no staging business rows were changed.

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
- A fresh read-only check found **zero rows in production `vault.secrets`**. `supabase_vault` 0.3.1 and `pgcrypto` 1.3 are installed; `pgsodium` is not installed, and a scan found no business-defined SQL routines calling pgcrypto encryption/decryption, pgsodium, or Vault. The Vault root key was not exported. With no existing secret rows, root-key export is not a current data-recovery blocker; see `production-extensions.json` for future-secret and local-extension limitations.
- Production's current schema is still the legacy, non-tenant-scoped schema; `organizations` was absent in the earlier live catalog comparison. The new tenant migrations have not been applied.
- No query result with row contents, password, secret key, or applicant PII is part of the release package.

## Backup and rehearsal status: blocking

A restorable **production** PostgreSQL archive was not captured or restored. The protected production database connection/password is not present in this execution environment, and the available Supabase connector offers read-only queries, not a downloadable backup. Do not use the staging credential for production.

The earlier staging recovery artifacts prove that a native PostgreSQL 17 workflow was prepared and used in a prior execution context: `2026-10-15/staging-postgres-20261015T060209Z.dump.manifest.json` records `pg_dump 17.3`, a 944,975-byte custom archive, and SHA-256 `99aebb894a1f8fd1c65c2dc7442e20c8f263d3a7402577b48b1c9f52c27b48bc`. Its restore validation records PostgreSQL 17.11 from Postgres.app and a successful 44-public-table / 803-row staging restore with no row mismatches. That validation explicitly excluded the Vault schema and `supabase_vault` extension and is not a production restore. The old manifest does not record the executable paths.

The current task shell is a different/unprepared tool context: no PostgreSQL commands resolve on `PATH`; the only discovered native executables are bundled under Python `pgserver` and report PostgreSQL 16.2. A filesystem search in this context did not find the previously used Postgres.app PG17 binaries; their exact executable paths were not preserved in the earlier manifest. This is a current-session path/environment discrepancy, not evidence that PG17 tools were never prepared. The staging archive and successful restore evidence remain in the off-repository recovery directory.

The exact 23-file production chain and ledger reconciliation have **not** been rehearsed against a disposable restore of production. The no-Docker embedded fixture rehearsal and the earlier staging restore are useful evidence, but neither is a production backup restore. Staging now has the new modular-experience migration recorded as remote version `20261016065252`; the local file uses that same version. The earlier staging `inventory_selection_provenance_guard` entry was recorded by the connector as `20261016001216`, while the repository file remains `20261015210000_inventory_selection_provenance_guard.sql`. See `staging-regression.json`; do not silently repair or rewrite applied history. Production's ledger was read-only and does not contain either staging alias.

Vault and other encryption dependencies were checked separately. Production has zero current Vault rows, and the reviewed tenant seed leaves the legacy Gemini key unset. The secret-isolation migration calls `vault.create_secret` only when a legacy organization key is nonblank. However, the current local PostgreSQL bundle does not include the Supabase Vault extension; the successful staging restore excluded Vault explicitly. Therefore a local restore that omits Vault cannot validate Vault extension behavior, and the full restore/rehearsal must record that managed-service limitation. Recheck production Vault row count immediately before/after migration rehearsal; if nonzero, stop until the owner-approved key recovery and compatible extension path is available. Do not claim complete Supabase recovery from an excluded extension or partial restore.

Before cutover, make the protected production TLS connection available to the backup process and run the backup/restore from the execution environment where the already-prepared PostgreSQL 17 tools were used, or locate that existing binary directory before attempting the restore here. Do not substitute PostgreSQL 16 or install Docker. Keep credentials in the protected local environment, not CLI arguments, repository, or chat. Then:

1. Capture a custom-format production dump into an owner-controlled encrypted directory outside Git; record SHA-256 and byte size. Use TLS, stop if the backup command exits nonzero, and do not include secrets in logs.
2. Repeat the independent Storage object inventory immediately before cutover. If still empty, record zero objects/bytes. Otherwise download every object through the Storage API/S3-compatible route, retain bucket metadata separately, and verify each exported byte count and SHA-256.
3. Restore the untouched archive into a fresh disposable native PostgreSQL 17 server. Keep the original archive immutable. Compare core table counts and all 40 rowset fingerprints. Record Auth, Storage, Vault, and other managed-extension exclusions; do not skip a restore or migration error. Rehearse the exact migration sequence only after the restore is usable, and stop on any ownership conflict, migration error, changed Wamule business value, extension error, or unexplained rowcount difference.
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

Production records the existing Information Centre migration name at version `20260715055626`; the repository version is `20260715050000`. Earlier live catalog comparison found the same four Information Centre tables and matching core definitions. Preserve the remote ledger row. After fresh pre-cutover catalog comparison, and only if the equivalence still holds, reconcile the local alias by marking `20260715050000` applied with `supabase migration repair 20260715050000 --status applied --db-url "$PRODUCTION_DATABASE_URL"`. This records the already-present change under the repository version; it must not replay that seed migration. Then run `supabase migration list --db-url "$PRODUCTION_DATABASE_URL"` and `supabase db push --dry-run --db-url "$PRODUCTION_DATABASE_URL"`; the pending list must match the 23 versions above exactly. Any difference blocks release.

The whole 23-file chain is not yet restore-rehearsed. Production migration apply is blocked until backup and exact restore-based rehearsal pass. The tenant migration/backfill must preserve each legacy row and assign only to Wamule where ownership is established; any conflicting or ambiguous ownership must stop the release. No manual edits to Wamule records to force expected counts are permitted.

## Modular public-site architecture in this candidate

The candidate formalizes the current Wamule and Hopkins public layouts as `wamule-classic` and `hopkins-project`. Shared routing, map rendering, public-site configuration lookup, form presentation, and submission transport remain common. Tenant/project/phase configuration chooses the presentation template and enables public modules (`map`, `inquiry`, `application`, `pricing`); branding/content remain scoped to the existing project settings. The authorized settings selector previews both templates and saves through admin-only RPCs. The RPCs validate profile role and tenant/project relationship, use a fixed empty search path, and update only nested `tenant_theme.site_experience`. They do not read or modify application requirements, roles, permissions, tenant membership, or public submission scope. The public endpoint resolves the requested tenant/project/phase relationship and returns only the presentation template/module flags. The application component and server-side submission endpoint continue to resolve their own project/phase and requirements independently.

Staging applied `20261016065252_modular_public_site_experience.sql` as remote migration `20261016065252` and deployed `get-public-site-experience` version 1 with JWT verification disabled. Anonymous GETs for Wamule `wamule/wamule/default` and Hopkins `hopkins-grove/hopkins-grove/initial` both returned HTTP 200 and the expected separate template defaults. Both RPCs are security-definer with an empty search path, require an authenticated Admin/Super Admin profile, grant execution to `authenticated`, and deny `anon`. Wamule parcel, masterplan-version, project-settings, and Storage metadata fingerprints matched the pre-migration values; Hopkins still has one active published snapshot with 775 distinct feature identities. Detailed hashes and the connector-generated staging ledger alias are in `staging-regression.json`. The separate report that 89 groups matched is supplied prior-chat evidence, not recaptured here. The current frontend was not deployed to staging from this worktree, so this package does not claim a live authenticated browser test of the selector.

Local release checks: `npm run build` passed; `npm test` passed 295 tests with 3 opt-in live staging tests skipped. The skipped tests can create inquiry/submission records and were not enabled. No synthetic application or inquiry was submitted in this pass. The live staging check covered the anonymous site-experience endpoint; it did not claim a browser UI test.

## Exact cutover sequence after blockers clear

1. Freeze unrelated deployments. Confirm the reviewed revision hash, artifact hashes, production project ref, 40-group pre-cutover baseline, storage inventory, and owner-controlled encrypted backup. Confirm the restored copy and exact migration rehearsal have passed.
2. In a detached worktree of the reviewed release revision, use the production-targeted Supabase config in this package (copy it to that worktree's `supabase/config.toml`). Keep the primary checkout and its staging-linked config unchanged. Set production credentials only from the protected production secret store.
3. Re-read the remote migration ledger and catalog. Reconcile only the verified Information Centre alias. Confirm the `db push --dry-run` output exactly matches the ordered 23-file manifest.
4. Apply migrations in two isolated CLI workdirs. The workflow migration `20261016054341_hopkins_project_application_workflow.sql` deliberately fails unless Hopkins tenant/project/phase already exists. Prepare the first view with `node scripts/prepare-hopkins-production-migration-phase.mjs --through-version 20261015100000`, run its printed `supabase db push --db-url "$PRODUCTION_DATABASE_URL"` command, and stop if its pending ledger differs from the first 19 entries in this manifest. This introduces the atomic onboarding RPC before calling it. Do not run schema reset, `db pull`, broad SQL repair, or unrelated data maintenance.
5. Recheck the 40 legacy fingerprints and Wamule row counts/relationships. Confirm all original parcels and sales records remain Wamule-owned; no Hopkins scope contains legacy Wamule rows. Check Vault requirements/secrets and extension availability explicitly. Document unavailable Supabase-managed extensions rather than ignoring errors. Stop on any mismatch.
6. Read-only lookup of `ed-admin@wamuledevelopment.com` must resolve exactly one active, confirmed production Auth account whose existing profile role is `Super Admin`. Run the guarded `tenant:onboard-hopkins-production --dry-run` first. Then run its apply command with `--defer-public-settings`; this calls the atomic scope bootstrap while public-application settings are still outside the schema constraint. The existing Super Admin keeps the same profile tenant and role; only the Hopkins project membership is added. Do not create another tenant if `hopkins-grove` exists; refuse conflicts.
7. Prepare the full migration view with `node scripts/prepare-hopkins-production-migration-phase.mjs --through-version 20261016065252` and apply it with `supabase db push --db-url "$PRODUCTION_DATABASE_URL"`. The 4 remaining migrations now include the scoped workspace changes, provenance guard, application workflow, and modular public presentation RPCs. The application workflow seeds Hopkins public application settings and requires the previously bootstrapped scope; the final migration adds only the site template/module RPCs.
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
# Apply migration phases through 20261015100000, bootstrap scope, then through 20261016065252.
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

Use the existing Netlify site `wamule-bz`; do not create another site. Adding `hopkinsgrove.ceiba.bz` to `wamule-bz` means both hostnames share the same Netlify site, deployment, frontend bundle, and site-level build environment. Host-based routing can select the Hopkins layout and data, but this is not an independent Ceiba deployment. Keep domain attachment separate from this release preparation. In Netlify, select the existing site's domain management and add `hopkinsgrove.ceiba.bz` as an additional custom domain. Use the exact CNAME/ALIAS target and DNS verification instructions Netlify presents for this site. Do not make a DNS change until the owner approves the final cutover. Leave `wamuledevelopment.com` attached and unchanged. Configure the three frontend variables from `frontend-production.env.example` in the site's production context; the anon key is public but must be read from the production project, while service-role credentials must never be set in frontend variables. After the domain is connected and TLS is issued, verify host-based routing in a fresh anonymous browser.

## Rollback

- If a migration or preservation check fails before frontend deploy, stop all steps. Do not attempt compensating tenant/ownership edits. Restore the immutable pre-cutover DB backup to the isolated rehearsal target first and diagnose there.
- If production is in a failed state, use the owner-approved restore plan with the verified database archive and the separately captured Storage objects/metadata. A logical PostgreSQL restore alone is not complete Supabase recovery; Auth/platform settings and Storage object bytes need separate restoration or verification.
- Redeploy the exact prior Netlify production deploy. Redeploy the prior Edge Function source revision with the same explicit function config. Keep DNS unchanged unless the owner separately decides to remove the new alias.
- Because the importer keeps new map rows inactive until activation, an import failure before activation leaves the existing Hopkins/Wamule public map unchanged. If already activated, use the prior verified map snapshot/version through the existing activation process or restore the complete pre-cutover backup; do not delete or rewrite Wamule records.
- New files are under the Hopkins project prefix in `project-map-public`. Preserve them during diagnosis. If rollback later removes the new prefix, verify it contains only this release's package-hash object and remove it through the Storage API, never by deleting `storage.objects` rows.
- Recompute the 40 rowset fingerprints and Storage inventory after recovery; record recovery time and any managed-service limitation. Do not claim recovery success until those checks match.

## Remaining blockers

1. No protected production database TLS connection/password is available to this task, so no production archive has been captured. The previously prepared PostgreSQL 17.3/17.11 staging toolchain is documented in the recovery artifacts, but its binary paths are absent from that record and the current shell only exposes PostgreSQL 16.2 binaries.
2. The production restore and exact 23-migration rehearsal remain incomplete. The current local bundle lacks `supabase_vault`; the prior staging restore explicitly excluded that extension and Vault schema. Production currently has zero Vault secret rows, so no existing Vault ciphertext is missing, but the migration/extension behavior must be documented and any nonzero pre-cutover inventory blocks a complete restore claim.
3. Production Auth admin config returned HTTP 404, so the Site URL and redirect allowlist remain unverified. Review them in the production Auth dashboard before cutover.
4. No production migration, onboarding, map import, function/frontend deployment, domain attachment, or DNS change has occurred. The Ceiba domain remains unconfigured; attaching it later to `wamule-bz` shares that site's deployment as described above.
Exact next action: make the production TLS database connection available through the protected local environment and run the capture from the execution environment that has the previously prepared PostgreSQL 17.3/17.11 tools, or locate their existing binary directory for this shell. Capture and verify the production archive, then perform the fresh restore and exact 23-migration rehearsal. Do not send credentials in chat.
