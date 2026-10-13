import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { safeTenantThemeCssUrl } from "../supabase/functions/get-public-lots/public-theme.mjs";

const tenantId = "tenant-123";
const base = "https://project.supabase.co";
const valid = `${base}/storage/v1/object/public/business-assets/${tenantId}/theme-1760184000000.css`;

test("public theme accepts only this tenant's published CSS object", () => {
  assert.equal(safeTenantThemeCssUrl(valid, base, tenantId), valid);
  assert.equal(safeTenantThemeCssUrl(`${base}/storage/v1/object/public/business-assets/other-tenant/theme-1.css`, base, tenantId), null);
  assert.equal(safeTenantThemeCssUrl(`${base}/storage/v1/object/public/other-bucket/${tenantId}/theme-1.css`, base, tenantId), null);
  assert.equal(safeTenantThemeCssUrl(`${base}/storage/v1/object/public/business-assets/${tenantId}/custom.css`, base, tenantId), null);
});

test("public theme rejects external, insecure, credentialed, and parameterized URLs", () => {
  for (const url of [
    "https://evil.example/theme-1.css",
    valid.replace("https:", "http:"),
    valid.replace("https://", "https://attacker@"),
    `${valid}?token=secret`,
    `${valid}#fragment`,
    "javascript:alert(1)",
  ]) {
    assert.equal(safeTenantThemeCssUrl(url, base, tenantId), null, url);
  }
});

test("local storage URLs are accepted only for loopback development endpoints", () => {
  const local = "http://127.0.0.1:54321/storage/v1/object/public/business-assets/tenant-123/theme-1.css";
  assert.equal(safeTenantThemeCssUrl(local, "http://127.0.0.1:54321", tenantId), local);
  assert.equal(safeTenantThemeCssUrl(local, "http://storage.internal:54321", tenantId), null);
});

test("public endpoint reads the published camelCase URL and validates it", async () => {
  const endpoint = await readFile(new URL("../supabase/functions/get-public-lots/index.ts", import.meta.url), "utf8");
  assert.match(endpoint, /value\?\.cssUrl/);
  assert.match(endpoint, /safeTenantThemeCssUrl\(storedCssUrl, supabaseUrl, tenantId\)/);
});
