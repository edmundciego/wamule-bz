#!/usr/bin/env node
/**
 * Tenant package initializer — Stage 0 of the tenant package workflow.
 *
 *   npm run tenant:init -- --slug <org-slug> --name "Display Name"
 *
 * Creates tenants/<slug>/ with tenant.json, tiers.json, theme.json,
 * overrides.css, source/, build/ (source/ + build/ are private working
 * areas: gitignored, never committed, never served) plus a README.
 * The package slug is the organizations.slug; tenant.json is the source of
 * truth for the tenant:* scripts (map-input/developments.json stays the
 * registry for the legacy map:* pipeline scripts).
 *
 * Exit codes: 0 ok, 2 bad usage / already exists.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function usage() {
  return `Usage:
  node scripts/tenant-init.mjs --slug <org-slug> --name "Display Name"

  Slug rules: lowercase letters, digits, hyphens (matches organizations.slug).
  Refuses when tenants/<slug>/ already exists.`;
}

function fail(message) {
  console.error(`error: ${message}\n${usage()}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "help" || key === "h") {
      console.log(usage());
      process.exit(0);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${arg}`);
    out[key] = value;
    i++;
  }
  return out;
}

function defaultTiers() {
  // label/price/legend drive the map UI; fill/tolerance drive detection
  // (detect-lots.py requires label, price, fill — legend defaults to fill).
  const tier = (label, price, hex) => ({ label, price, legend: hex, fill: hex, tolerance: 60 });
  return {
    tiers: {
      standard: tier("Standard", 20000, "#4ade80"),
      premium: tier("Premium", 30000, "#60a5fa"),
      estate: tier("Estate", 45000, "#fbbf24"),
      reserve: tier("Reserve", 60000, "#2dd4bf"),
    },
  };
}

function defaultTheme(slug) {
  return {
    tokens: {
      primary: "#173f2d",
      background: "#fffdf8",
      card: "#ffffff",
      accent: "#8a5a35",
      text: "#2d2317",
      muted: "#6b6259",
    },
    card: {
      showTier: true,
      showArea: true,
      showPrice: true,
      inquireText: "Inquire About Lot {lot}",
      waitlistText: "Join Waitlist for Lot {lot}",
      zoomText: "Zoom to Lot {lot}",
    },
    _notes: "tokens become --lotmap-* CSS variables. overrides.css selectors must all start with the scope class below. No per-tenant JS is ever loaded.",
    scopeClass: `.lotmap-t-${slug}`,
  };
}

function starterCss(slug, name) {
  return `/* ${name} embed overrides.
 * Every selector MUST start with .lotmap-t-${slug} (enforced by the
 * validator + tenant:publish, which fails closed). No @import, no external
 * url(), no expression(). Delete this file to ship without overrides.
 */
.lotmap-t-${slug} {
  /* Example: uncomment to tune the card.
  --lotmap-primary: #173f2d;
  */
}
`;
}

function readme(slug, name) {
  return `# ${name} tenant package (\`${slug}\`)

Private working area for this tenant's interactive lot map. Committed:
\`tenant.json\`, \`tiers.json\`, \`theme.json\`, \`overrides.css\`, this file.
Private (gitignored, never served): \`source/\` (input plats), \`build/\`
(pipeline output + snapshots).

## Workflow

1. Drop the plat into \`source/\` (PDF or raster — never commit it).
2. \`npm run tenant:build -- --slug ${slug} --source source/<file>\`
   Stages run into \`build/\` only. Stages not built yet (OCR number/area
   reading, area validation, paint-out, tiles) are listed as NOT IMPLEMENTED
   in \`build/ingest-report.json\`, never silently skipped.
3. Review \`build/poc.html\` (QA viewer).
4. \`npm run tenant:publish -- --slug ${slug} --dry-run\` then \`--apply\`.
   Snapshot first, drafts never public, activation gated behind \`--activate\`.

## Theming

Edit \`theme.json\` tokens (become \`--lotmap-*\` CSS variables on the embed
root) and card text/flags. Optional \`overrides.css\` must keep every
selector prefixed with \`.lotmap-t-${slug}\`; publish validates and refuses
otherwise. No per-tenant JS.
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const slug = ((args.slug || "").trim() || "").toLowerCase();
  const name = (args.name || "").trim();
  if (!/^[a-z0-9-]+$/.test(slug)) fail("--slug must be lowercase letters, digits, hyphens (organizations.slug)");
  if (!name) fail("--name is required");
  const dir = resolve(join("tenants", slug));
  if (existsSync(dir)) fail(`tenants/${slug}/ already exists — slugs are immutable, create a new package instead`);
  mkdirSync(join(dir, "source"), { recursive: true });
  mkdirSync(join(dir, "build"), { recursive: true });
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ slug, name, created: new Date().toISOString() }, null, 2) + "\n");
  writeFileSync(join(dir, "tiers.json"), JSON.stringify(defaultTiers(), null, 2) + "\n");
  writeFileSync(join(dir, "theme.json"), JSON.stringify(defaultTheme(slug), null, 2) + "\n");
  writeFileSync(join(dir, "overrides.css"), starterCss(slug, name));
  writeFileSync(join(dir, "README.md"), readme(slug, name));
  console.log(`[tenant:init] created tenants/${slug}/ (tenant.json, tiers.json, theme.json, overrides.css, source/, build/, README.md)`);
}

main();
