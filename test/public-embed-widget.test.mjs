import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("embed route mounts publicly without auth or admin chrome", async () => {
  const [app, page] = await Promise.all([
    read("src/App.tsx"),
    read("src/pages/public/EmbeddableMapPage.tsx"),
  ]);
  assert.match(app, /path="\/embed\/:tenant_slug"/);
  assert.match(app, /EmbeddableMapPage/);
  // Route sits with the other public routes, outside ProtectedRoute/AdminLayout.
  const embedIndex = app.indexOf("/embed/:tenant_slug");
  assert.ok(embedIndex < app.indexOf("<ProtectedRoute>"), "embed route must precede protected layout");
  assert.match(page, /useParams/);
  assert.match(page, /100vw/);
  assert.match(page, /100vh/);
  assert.doesNotMatch(page, /AdminLayout/);
  assert.doesNotMatch(page, /ProtectedRoute/);
  assert.doesNotMatch(page, /getSessionAndProfile|useCompanyProfile/);
});

test("embed polygons render responsively from percentage coordinates", async () => {
  const page = await read("src/pages/public/EmbeddableMapPage.tsx");
  assert.match(page, /viewBox="0 0 100 100"/);
  assert.match(page, /<polygon/);
  assert.match(page, /map_polygon/);
  assert.match(page, /#22c55e/);
  assert.match(page, /#f59e0b/);
  assert.match(page, /#ef4444/);
  assert.match(page, /All Lots/);
  assert.match(page, /Available Only/);
  assert.match(page, /get-public-lots\?tenant=/);
});

test("available lots open a tenant-tagged inquiry without leaving the iframe", async () => {
  const [modal, inquiryFunction] = await Promise.all([
    read("src/components/public/PublicInquiryModal.tsx"),
    read("supabase/functions/submit-public-inquiry/index.ts"),
  ]);
  assert.match(modal, /Inquire About Lot/);
  assert.match(modal, /Note \/ Message/);
  assert.match(modal, /I am interested in reserving Lot/);
  assert.match(modal, /submit-public-inquiry/);
  assert.match(modal, /tenant: tenantSlug/);
  assert.match(modal, /Inquiry Sent!/);
  assert.match(inquiryFunction, /tenant\?: unknown/);
  assert.match(inquiryFunction, /resolveTenantId/);
  assert.match(inquiryFunction, /tenant_id: tenantId/);
});

test("snippet generator emits the active tenant slug", async () => {
  const [snippet, settings] = await Promise.all([
    read("src/components/admin/settings/WordPressEmbedSnippet.tsx"),
    read("src/pages/SettingsPage.tsx"),
  ]);
  assert.match(snippet, /\/embed\//);
  assert.match(snippet, /\?filter=/);
  assert.match(snippet, /<iframe/);
  assert.match(snippet, /allowfullscreen/);
  assert.match(snippet, /Copy to Clipboard/);
  assert.match(snippet, /from\("organizations"\)/);
  assert.match(settings, /Website Integration & Embeds/);
  assert.match(settings, /WordPressEmbedSnippet/);
});
