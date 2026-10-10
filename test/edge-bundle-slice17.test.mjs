import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Slice 1.7: the publish-draft edge function must bundle for
// `supabase functions serve/deploy` — every local import of its entry must
// stay inside supabase/functions/ (no Deno/CLI on this box, so the static
// equivalent check in scripts/slice17-bundle-check.mjs is the proof).
test("publish-draft edge function bundles (no escapes from supabase/functions/)", () => {
  const out = execFileSync("node", ["scripts/slice17-bundle-check.mjs"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(out, /BUNDLE PASS/);
});
