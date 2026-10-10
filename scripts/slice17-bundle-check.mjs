import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";

// Slice 1.7 equivalent bundle check for the publish-draft edge function.
//
// `supabase functions serve/deploy` packages the function directory plus
// `supabase/functions/_shared/`; relative imports escaping that root
// (e.g. ../../../src/...) do not travel reliably to the hosted runtime,
// so they FAIL this check even though plain `tsc`/vite resolve them fine.
// (No Deno or Supabase CLI on this box, hence this static equivalent.)
//
// Usage: node scripts/slice17-bundle-check.mjs [--strict]
// Exit 0 + "BUNDLE PASS" when every local import of the edge-function entry
// stays inside supabase/functions/; otherwise prints the escapes and exits 1.

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FUNCS_ROOT = resolve(ROOT, "supabase/functions");
const ENTRY = resolve(FUNCS_ROOT, "publish-draft/index.ts");
const strict = process.argv.includes("--strict");

const IMPORT_RE = /(?:import|export)[^'"]*from\s*["']([^"']+)["']|import\s*["']([^"']+)["']/g;

function localImports(file) {
  const src = readFileSync(file, "utf8");
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    if (spec.startsWith(".") && !spec.endsWith(".css")) out.push(spec);
  }
  return out;
}

function resolveImport(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, `${base}.mts`]) {
    if (existsSync(cand)) return cand;
  }
  return base; // unresolved: still report containment against the raw path
}

const seen = new Set();
const escapes = [];
const missing = [];
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  for (const spec of localImports(file)) {
    const target = resolveImport(file, spec);
    if (!existsSync(target)) {
      missing.push(`${relative(ROOT, file)} -> ${spec} (missing)`);
      continue;
    }
    const rel = relative(FUNCS_ROOT, target);
    if (rel.startsWith("..") || rel === "") {
      escapes.push(`${relative(ROOT, file)} -> ${spec} = ${relative(ROOT, target)}`);
    }
    if (target.endsWith(".ts")) walk(target);
  }
}

walk(ENTRY);

console.log(`# entry: ${relative(ROOT, ENTRY)}`);
console.log(`# files in graph: ${seen.size}`);
if (missing.length) {
  console.log("MISSING IMPORTS:");
  for (const m of missing) console.log(`  ${m}`);
}
if (escapes.length) {
  console.log("ESCAPES outside supabase/functions/:");
  for (const e of escapes) console.log(`  ${e}`);
  console.log("BUNDLE FAIL: edge function imports code that the deploy packager does not include.");
  console.log("Fix: move the shared module under supabase/functions/_shared/ (single implementation, re-exported).");
  process.exit(1);
}
console.log("BUNDLE PASS: all edge-function imports stay inside supabase/functions/.");
if (strict) {
  // Strict: also flag the pre-existing get-public-lots -> src escape (info only).
  console.log("# strict note: get-public-lots/index.ts imports ../../../src/lib/theme.ts (pre-existing, out of slice-1.7 scope).");
}
