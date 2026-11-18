import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const file = (path) => readFile(new URL(path, root), "utf8");

test("review-link records are database-private and bound to phase and snapshot scope", async () => {
  const migration = await file("supabase/migrations/20261113050506_shareable_map_reviewer_links.sql");
  assert.match(migration, /CREATE TABLE public\.project_map_review_links/);
  assert.match(migration, /settings_snapshot jsonb NOT NULL/);
  assert.match(migration, /package_digest text NOT NULL/);
  assert.match(migration, /snapshot_fingerprint text NOT NULL/);
  assert.match(migration, /expires_at timestamptz NOT NULL/);
  assert.match(migration, /revoked_at timestamptz/);
  assert.match(migration, /FOREIGN KEY \(phase_id, project_id, tenant_id\)[\s\S]*development_phases/);
  assert.match(migration, /FOREIGN KEY \(snapshot_id, tenant_id, project_id, phase_id\)[\s\S]*map_feature_snapshots/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.project_map_review_links FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT ALL ON TABLE public\.project_map_review_links TO service_role/);
  assert.doesNotMatch(migration, /GRANT .* TO anon|GRANT .* TO authenticated/);
});

test("Edge Function signs scoped links and revalidates expiry, revocation, package, and revision", async () => {
  const source = await file("supabase/functions/project-map-review-link/index.ts");
  assert.match(source, /MAP_REVIEW_LINK_SIGNING_SECRET/);
  assert.match(source, /crypto\.subtle\.sign\("HMAC"/);
  assert.match(source, /crypto\.subtle\.verify\(/);
  assert.match(source, /encodeBase64Url\(bytes\) !== value/);
  assert.match(source, /authorizeWorkspaceActivePhase\(/);
  assert.match(source, /\["Super Admin", "Admin"\]/);
  assert.match(source, /feature\.provenance\)\.reviewed !== true/);
  assert.match(source, /row\.revoked_at/);
  assert.match(source, /Date\.now\(\) >= Date\.parse\(row\.expires_at\)/);
  assert.match(source, /packageRow\.package_digest !== row\.package_digest/);
  assert.match(source, /snapshot\.snapshot_fingerprint !== row\.snapshot_fingerprint/);
  assert.match(source, /function streamReviewedBackground[\s\S]*verifiedLink/);
  assert.match(source, /project-map-packages"\)\.download\(path\)/);
  assert.match(source, /X-Robots-Tag/);
  assert.match(source, /Cache-Control.*no-store/);
  assert.doesNotMatch(source, /createSignedUrl\(/, "private assets stay revocable through the proxy");
});

test("review surface is signed-out, no-index, revision-bound, and has no submission handler", async () => {
  const page = await file("src/pages/MapReviewerLinkPage.tsx");
  const adminPage = await file("src/pages/MapPackagePreviewPage.tsx");
  const app = await file("src/App.tsx");
  const headers = await file("public/_headers");
  assert.match(app, /<Route path="\/review" element={<MapReviewerLinkPage \/>}\s*\/>/);
  assert.match(page, /window\.location\.hash\.slice\(1\)/);
  assert.match(page, /ensureMeta\("robots", "noindex, nofollow, noarchive, nosnippet"\)/);
  assert.match(page, /ensureMeta\("referrer", "no-referrer"\)/);
  assert.match(page, /Read-only application form preview/);
  assert.match(page, /<fieldset disabled/);
  assert.doesNotMatch(page, /onSubmit|Submit project application|Submit application/);
  assert.match(page, /reviewerRequest<ReviewerMap>\("resolve", token\)/);
  assert.match(page, /JSON\.stringify\(\{ action: "asset", token \}\)/);
  assert.match(adminPage, /<option value="60">In 1 minute<\/option>/);
  assert.match(headers, /X-Robots-Tag: noindex, nofollow, noarchive, nosnippet/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
});

test("walkthrough tests reviewer denial, expiry, revocation, and post-publication revision lock", async () => {
  const script = await file("scripts/run-tenant-walkthrough.mjs");
  const baseline = await file("scripts/verify-admin-launch-baseline.mjs");
  const workflow = await file(".github/workflows/admin-launch-controls-replay.yml");
  assert.match(baseline, /migration_inventory_count: 73/);
  assert.match(baseline, /project_map_packages/);
  assert.match(script, /other_phase_status: crossPhaseAttempt\.status/);
  assert.match(script, /other_phase_asset_status: crossPhaseAssetAttempt\.status/);
  assert.match(script, /unsupported_link_submit_action_status: unsupportedReviewSubmit\.status/);
  assert.match(script, /revoked_data_status: revokedResolve\.status/);
  assert.match(script, /expired_data_status: expiredResolve\.status/);
  assert.match(script, /applications_before_after_submit/);
  assert.match(script, /reviewerAfterPublication\.body\.revision\?\.snapshot_id === imported\.snapshotId/);
  assert.match(script, /reviewerAfterRevoke\.status === 410/);
  assert.match(script, /expiry_wait_reason:/);
  assert.match(script, /getByRole\("button", \{ name: `Select outline \$\{selectedFeature\.demo_label\}`, exact: true \}\)\.last\(\)\.click\(\)/);
  assert.match(script, /intended_phase_submission_status: intendedClosedResponse\.status/);
  assert.match(script, /blockedReviewerSubmission\.status === 400/);
  assert.match(script, /unsupportedReviewSubmit\.status === 401/);
  assert.match(workflow, /MAP_REVIEW_LINK_SIGNING_SECRET=%s/);
  assert.match(workflow, /tenant-walkthrough-shared-map-link\.png/);
  assert.match(workflow, /WALKTHROUGH_EVIDENCE_PATH/);
  assert.match(workflow, /Stop and remove the disposable stack/);
});
