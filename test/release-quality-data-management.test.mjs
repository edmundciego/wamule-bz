import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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
  const [migration, panel, edgeFunction] = await Promise.all([
    read("supabase/migrations/20260714220603_20260714074603_release_quality_data_management.sql"),
    read("src/components/settings/DataManagementPanel.tsx"),
    read("supabase/functions/purge-contact-record/index.ts"),
  ]);
  assert.match(migration, /NO-OP/);
  assert.doesNotMatch(migration, /create or replace function/i);
  assert.doesNotMatch(migration, /delete from public\./i);
  assert.match(panel, /Permanent purge is disabled until an approved database foundation exists/);
  assert.doesNotMatch(panel, /purge-contact-record/);
  assert.match(edgeFunction, /Deliberately disabled/);
  assert.match(edgeFunction, /status: 503/);
  assert.doesNotMatch(edgeFunction, /\.rpc\(/);
  assert.doesNotMatch(edgeFunction, /service_role|SUPABASE_SERVICE_ROLE_KEY|supabase\.from\(/i);
});

test("disabled purge function has no unresolved database dependencies", async () => {
  const edgeFunction = await read("supabase/functions/purge-contact-record/index.ts");
  const migrationNames = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"));
  const migrationFiles = await Promise.all(migrationNames.map((name) => read(`supabase/migrations/${name}`)));
  const rpcNames = [...edgeFunction.matchAll(/\.rpc\("([^"]+)"/g)].map((match) => match[1]);
  const migrationSql = migrationFiles.join("\n");
  for (const rpcName of rpcNames) assert.match(migrationSql, new RegExp(`function public\\.${rpcName}\\b`));
  assert.equal(rpcNames.length, 0, "the disabled function must not call database RPCs");
});
