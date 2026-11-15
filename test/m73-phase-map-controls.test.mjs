import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("map upload, history, removal and activation carry exact tenant/project/phase scope", async () => {
  const [upload, gallery, preview, settings] = await Promise.all([
    read("src/components/admin/settings/MasterplanUpload.tsx"),
    read("src/components/admin/settings/MasterplanVersionGallery.tsx"),
    read("src/components/admin/settings/MasterplanPreviewModal.tsx"),
    read("src/pages/SettingsPage.tsx"),
  ]);

  assert.match(settings, /phaseId=\{workspace\?\.phaseId \?\? null\}/);
  assert.match(upload, /const path = `\$\{tenantId\}\/\$\{projectId\}\/\$\{phaseId\}\//);
  assert.match(upload, /phase_id: phaseId/);
  assert.match(upload, /\.eq\("project_id", projectId\)\s*\.eq\("phase_id", phaseId\)/);
  assert.match(gallery, /\.eq\("tenant_id", tenantId\)[\s\S]*?\.eq\("project_id", projectId\)[\s\S]*?\.eq\("phase_id", phaseId\)/);
  assert.match(gallery, /\.eq\("id", version\.id\)[\s\S]*?\.eq\("tenant_id", tenantId\)[\s\S]*?\.eq\("project_id", projectId\)[\s\S]*?\.eq\("phase_id", phaseId\)/);
  assert.match(preview, /\.eq\("tenant_id", tenantId\)\.eq\("project_id", projectId\)\.eq\("phase_id", phaseId\)/);
  assert.match(preview, /phase_id: phaseId/);
});

test("changing workspace drops stale map history and preview state", async () => {
  const gallery = await read("src/components/admin/settings/MasterplanVersionGallery.tsx");
  assert.match(gallery, /const requestId = \+\+requestIdRef\.current/);
  assert.match(gallery, /requestId !== requestIdRef\.current/);
  assert.match(gallery, /setVersions\(\[\]\)/);
  assert.match(gallery, /setPreviewVersion\(null\)/);
});

test("phase publisher UI and generated embed retain the selected public scope", async () => {
  const [panel, lots, snippet] = await Promise.all([
    read("src/components/admin/parcels/BulkIngestPanel.tsx"),
    read("src/pages/LotsPage.tsx"),
    read("src/components/admin/settings/WordPressEmbedSnippet.tsx"),
  ]);
  assert.match(lots, /tenantSlug=\{workspace\.tenantSlug\}/);
  assert.match(lots, /projectSlug=\{workspace\.projectSlug\}/);
  assert.match(lots, /phaseSlug=\{workspace\.phaseSlug\}/);
  assert.match(panel, /--tenant \$\{tenantSlug\} --project \$\{projectSlug\} --phase \$\{phaseSlug\}/);
  assert.match(snippet, /\?phase=\$\{phasePath\}&filter=\$\{filter\}/);
  assert.match(snippet, /resolution\.scope\.tenantSlug === tenantSlug/);
  assert.match(snippet, /resolution\.scope\.projectSlug === projectSlug/);
  assert.match(snippet, /hostReady/);
});

test("an active map snapshot is not advertised as public unless its scoped package is published", async () => {
  const [lots, types] = await Promise.all([
    read("src/pages/LotsPage.tsx"),
    read("src/types/database.ts"),
  ]);
  assert.match(lots, /from\("project_map_packages"\)/);
  assert.match(lots, /\.eq\("snapshot_id", snapshot\.id\)\.not\("published_at", "is", null\)/);
  assert.match(lots, /mapPublished && mapOutlineCount > 0/);
  assert.match(lots, /active draft map[\s\S]*?no published map package/i);
  assert.match(types, /project_map_packages: \{/);
});
