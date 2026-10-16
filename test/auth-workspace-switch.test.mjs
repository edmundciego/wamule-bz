import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const root = new URL("..", import.meta.url);

async function loadAuthScopeHelper() {
  const source = await readFile(new URL("src/lib/authWorkspaceCache.ts", root), "utf8");
  const javascript = ts.transpile(source, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 });
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

test("changing or signing out an authenticated tenant account invalidates cached workspace data", async () => {
  const { didAuthIdentityChange } = await loadAuthScopeHelper();
  assert.equal(didAuthIdentityChange(undefined, "tenant-a-user"), false, "initial session should not clear a fresh cache");
  assert.equal(didAuthIdentityChange("tenant-a-user", "tenant-a-user"), false, "token refresh for the same account should not clear cache");
  assert.equal(didAuthIdentityChange("tenant-a-user", null), true, "sign-out must clear tenant data");
  assert.equal(didAuthIdentityChange(null, "tenant-b-user"), true, "sign-in to another tenant account must clear stale data");
});

test("the authenticated app wraps routes with account cache invalidation and mounts the workspace selector", async () => {
  const [main, boundary, layout] = await Promise.all([
    readFile(new URL("src/main.tsx", root), "utf8"),
    readFile(new URL("src/components/auth/AuthQueryCacheBoundary.tsx", root), "utf8"),
    readFile(new URL("src/components/layout/AdminLayout.tsx", root), "utf8"),
  ]);
  assert.match(main, /<AuthQueryCacheBoundary>/);
  assert.match(boundary, /supabase\.auth\.onAuthStateChange/);
  assert.match(boundary, /queryClient\.clear\(\)/);
  assert.match(layout, /<WorkspaceScopeProvider profile=\{sessionProfile\?\.profile \?\? null\}/);
  assert.match(layout, /<WorkspaceSelector \/>/);
  assert.match(layout, />\s*Sign out\s*</);
});
