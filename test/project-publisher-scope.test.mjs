import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("lot publisher resolves and filters one project before diff or writes", async () => {
  const source = await read("scripts/publish-lots.mjs");
  assert.match(source, /requestedProject \? projectQuery\.eq\("slug", requestedProject\) : projectQuery\.eq\("is_default", true\)/);
  assert.match(source, /existingQuery = existingQuery\.eq\("project_id", projectId\)/);
  assert.match(source, /versionQuery = versionQuery\.eq\("project_id", projectId\)/);
  assert.match(source, /project_id: projectId/);
  assert.match(source, /update = update\.eq\("project_id", projectId\)/);
  assert.match(source, /project-scoped map migration is incomplete; refusing before writes/);
});

test("tenant publisher never bulk-stamps legacy rows and publishes a single project map version", async () => {
  const source = await read("scripts/tenant-publish.mjs");
  assert.match(source, /publishArgs\.push\("--project", projectSlug\)/);
  assert.match(source, /project_lot_tiers/);
  assert.match(source, /project_settings/);
  assert.match(source, /preview_url: previewUrl/);
  assert.match(source, /project_id: projectId/);
  assert.match(source, /project-specific overrides\.css is not supported yet/);
  assert.doesNotMatch(source, /update\(\{\s*project_id:\s*projectId\s*\}\)[\s\S]{0,120}is\("project_id", null\)/);
  assert.doesNotMatch(source, /for \(const \[local, suffix, mime\]/);
});
