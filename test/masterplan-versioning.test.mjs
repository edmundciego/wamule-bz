import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("masterplan versions auto-number per tenant", async () => {
  const migration = await read("supabase/migrations/20260919000000_masterplan_versioning.sql");
  assert.match(migration, /create table if not exists public\.masterplan_versions/);
  assert.match(migration, /version_number integer not null/);
  assert.match(migration, /assign_masterplan_version_number/);
  assert.match(migration, /coalesce\(max\(version_number\), 0\) \+ 1/);
  assert.match(migration, /where tenant_id = new\.tenant_id/);
});

test("single active version trigger syncs tenant records", async () => {
  const migration = await read("supabase/migrations/20260919000000_masterplan_versioning.sql");
  assert.match(migration, /uniq_masterplan_versions_tenant_number/);
  assert.match(migration, /unique \(tenant_id, version_number\)/);
  assert.match(migration, /sync_active_masterplan/);
  assert.match(migration, /set is_active = false/);
  assert.match(migration, /update public\.organizations/);
  assert.match(migration, /masterplan_image_url/);
  assert.match(migration, /insert into public\.business_settings/);
  assert.match(migration, /tenant_isolation/);
  assert.match(migration, /user_has_tenant_access/);
});

test("version gallery and alignment preview gate publishing on review", async () => {
  const [gallery, modal, upload] = await Promise.all([
    read("src/components/admin/settings/MasterplanVersionGallery.tsx"),
    read("src/components/admin/settings/MasterplanPreviewModal.tsx"),
    read("src/components/admin/settings/MasterplanUpload.tsx"),
  ]);
  assert.match(gallery, /Version \{version\.version_number\}/);
  assert.match(gallery, /Active/);
  assert.match(gallery, /Activate/);
  assert.match(gallery, /Preview/);
  assert.match(gallery, /from\("masterplan_versions"\)/);
  assert.match(modal, /opacity/i);
  assert.match(modal, /type="range"/);
  assert.match(modal, /Compare with current active|Baseline/);
  assert.match(modal, /Publish & Activate Version/);
  assert.match(modal, /map_polygon/);
  assert.match(upload, /MasterplanVersionGallery/);
  assert.match(upload, /MasterplanPreviewModal/);
  assert.match(upload, /is_active: false/);
});

test("masterplan version types track tenant rows", async () => {
  const types = await read("src/types/database.ts");
  assert.match(types, /export type MasterplanVersion/);
  assert.match(types, /version_number: number/);
  assert.match(types, /masterplan_versions: \{/);
});
