import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("release quality brand guard and metadata use the canonical name", async () => {
  const [manifest, index, packageJson, brandGuard] = await Promise.all([
    read("public/favicon/site.webmanifest"), read("index.html"), read("package.json"), read("scripts/check-brand.mjs"),
  ]);
  assert.match(manifest, /"name": "Wamule Development"/);
  assert.match(manifest, /"short_name": "Wamule"/);
  assert.match(index, /<title>Wamule Development<\/title>/);
  assert.match(packageJson, /"check:brand"/);
  assert.match(brandGuard, /wamuale/i);
});

test("retired purge migration and application control cannot delete operational history", async () => {
  const [migration, panel] = await Promise.all([
    read("supabase/migrations/20260714074603_release_quality_data_management.sql"),
    read("src/components/settings/DataManagementPanel.tsx"),
  ]);
  assert.match(migration, /NO-OP/);
  assert.doesNotMatch(migration, /create or replace function/i);
  assert.doesNotMatch(migration, /delete from public\./i);
  assert.match(panel, /Permanent purge is unavailable in the application/);
  assert.doesNotMatch(panel, /purge-contact-record/);
});
