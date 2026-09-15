import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("masterplan migration adds column, bucket, and tenant-scoped policies", async () => {
  const migration = await read("supabase/migrations/20260918000000_masterplan_image_storage.sql");
  assert.match(migration, /masterplan_image_url/);
  assert.match(migration, /alter table public\.organizations/);
  assert.match(
    migration,
    /INSERT INTO storage\.buckets \(id, name, public\) VALUES \('business-assets', 'business-assets', true\) ON CONFLICT \(id\) DO NOTHING/,
  );
  assert.match(migration, /Business assets readable publicly/);
  assert.match(migration, /to public/);
  assert.match(migration, /get_current_user_tenant_id/);
  assert.match(migration, /is_super_admin_user/);
  assert.match(migration, /foldername/);
  assert.match(migration, /set_tenant_masterplan/);
});

test("masterplan upload workflow uses tenant paths and versioned publishing", async () => {
  const [component, settings, versioningMigration] = await Promise.all([
    read("src/components/admin/settings/MasterplanUpload.tsx"),
    read("src/pages/SettingsPage.tsx"),
    read("supabase/migrations/20260919000000_masterplan_versioning.sql"),
  ]);
  assert.match(component, /image\/jpeg.*image\/png.*image\/webp/s);
  assert.match(component, /10 \* 1024 \* 1024/);
  assert.match(component, /masterplan-\$\{Date\.now\(\)\}/);
  assert.match(component, /from\("business-assets"\)/);
  assert.match(component, /getPublicUrl/);
  assert.match(component, /from\("masterplan_versions"\)/);
  assert.match(component, /is_active: false/);
  assert.match(component, /MasterplanVersionGallery/);
  assert.match(component, /MasterplanPreviewModal/);
  assert.match(component, /Upload New Map/);
  assert.match(component, /Remove Map/);
  // Tenant record sync moved into the activation trigger; remove path still
  // clears the tenant URL through the single-column RPC.
  assert.match(component, /set_tenant_masterplan/);
  assert.match(versioningMigration, /insert into public\.business_settings/);
  assert.match(settings, /MasterplanUpload/);
  assert.match(settings, /Site Masterplan Map/);
});

test("tenant masterplan url flows to lots board and parcel drawer", async () => {
  const [lots, drawer, types] = await Promise.all([
    read("src/pages/LotsPage.tsx"),
    read("src/components/admin/parcels/ParcelDrawer.tsx"),
    read("src/types/database.ts"),
  ]);
  assert.match(lots, /from\("organizations"\)/);
  assert.match(lots, /masterplan_image_url/);
  assert.match(lots, /lot-board-masterplan/);
  assert.match(lots, /masterplanImageUrl=\{masterplanImageUrl \?\? null\}/);
  assert.match(drawer, /masterplanImageUrl/);
  assert.match(types, /masterplan_image_url: string \| null/);
});

test("sibling parcels render subtly behind the active boundary", async () => {
  const canvas = await read("src/components/admin/parcels/ParcelMapCanvas.tsx");
  assert.match(canvas, /fillOpacity=\{isActive \? 0\.45 : 0\.15\}/);
});
