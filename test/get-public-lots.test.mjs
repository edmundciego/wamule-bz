import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("get-public-lots is an unauthenticated tenant-scoped public API", async () => {
  const source = await read("supabase/functions/get-public-lots/index.ts");
  assert.match(source, /tenant/);
  assert.match(source, /from\("organizations"\)/);
  assert.match(source, /eq\("slug", tenantParam\)/);
  assert.match(source, /eq\("is_active", true\)/);
  assert.match(source, /inbound_alias/);
  assert.match(source, /404/);
  // No caller auth required: no Bearer token gate.
  assert.doesNotMatch(source, /Missing authorization token/);
});

test("get-public-lots returns the public availability schema with CORS", async () => {
  const source = await read("supabase/functions/get-public-lots/index.ts");
  assert.match(source, /Access-Control-Allow-Origin/);
  assert.match(source, /\*.*WordPress|WordPress|external fetches/i);
  assert.match(source, /masterplan_image_url/);
  assert.match(source, /from\("parcels"\)/);
  assert.match(source, /map_polygon/);
  assert.match(source, /lot_number/);
  assert.match(source, /price/);
  assert.match(source, /sanitizePolygon/);
  // Only public-safe parcel fields leave the function.
  assert.doesNotMatch(source, /auth_user_id/);
  assert.doesNotMatch(source, /gemini_api_key/);
});
