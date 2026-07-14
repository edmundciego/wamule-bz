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

test("purge implementation keeps authorization, confirmation, transaction, and cleanup controls server-side", async () => {
  const [migration, functionSource, panel] = await Promise.all([
    read("supabase/migrations/20260714074603_release_quality_data_management.sql"),
    read("supabase/functions/purge-contact-record/index.ts"),
    read("src/components/settings/DataManagementPanel.tsx"),
  ]);
  for (const requirement of ["security definer", "Only Super Admin users can purge records", "purge_contact_preview", "purge_storage_cleanup_tasks", "delete from public.transactions", "delete from public.contracts", "delete from public.customers", "delete from public.applications", "delete from public.leads", "Purge Test or Incorrect Record completed"]) assert.match(migration, new RegExp(requirement, "i"));
  for (const requirement of ["Only Super Admin users can purge records", "PURGE FINANCIAL HISTORY", "cleanStorage", "deleteUser", "possibleRelatedRecords"]) assert.match(functionSource, new RegExp(requirement));
  assert.match(panel, /Possible related records requiring confirmation/);
  assert.match(panel, /Purge Test or Incorrect Record/);
});
