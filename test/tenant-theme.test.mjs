import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  allowlistTheme,
  applyCardText,
  buildThemeCssVars,
  DEFAULT_CARD_CONFIG,
  validateTenantCss,
} from "../src/lib/theme.ts";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("validator accepts scoped tenant CSS", () => {
  const errors = validateTenantCss(
    `.lotmap-t-wamule { --lotmap-primary: #111; }
     .lotmap-t-wamule .card, .lotmap-t-wamule button:hover { color: red; }
     @media (max-width: 640px) { .lotmap-t-wamule .card { padding: 0; } }`,
    ".lotmap-t-wamule",
  );
  assert.deepEqual(errors, []);
});

test("validator rejects imports, external urls, expressions, unscoped and foreign rules", () => {
  const cases = [
    [`@import url("https://evil.test/x.css"); .lotmap-t-a { color: red; }`, /@import/],
    [`.lotmap-t-a { background: url(https://evil.test/x.png); }`, /external url/],
    [`.lotmap-t-a { background: url(//evil.test/x.png); }`, /external url/],
    [`.lotmap-t-a { background: url(data:image/png;base64,xx); }`, /external url/],
    [`.lotmap-t-a { width: expression(alert(1)); }`, /expression/],
    [`.unscoped { color: red; }`, /unscoped/],
    [`.lotmap-t-b .card { color: red; }`, /unscoped/],
    [`@font-face { font-family: x; }`, /at-rule/],
    [`.lotmap-t-a { color: red; `, /unbalanced/],
  ];
  for (const [css, pattern] of cases) {
    const errors = validateTenantCss(css, ".lotmap-t-a");
    assert.ok(errors.some((message) => pattern.test(message)), `expected ${pattern} for ${css.slice(0, 60)}`);
  }
});

test("validator allows relative url() for storage-relative assets", () => {
  const errors = validateTenantCss(`.lotmap-t-a .hero { background: url(./hero.webp); }`, ".lotmap-t-a");
  assert.deepEqual(errors, []);
});

test("allowlist drops unknown keys, gates colors, strips markup", () => {
  const theme = allowlistTheme(
    {
      tokens: { primary: "#123456", background: "not-a-color", text: "<b>x</b>", extra: "drop me" },
      card: { showTier: "yes", inquireText: "<script>alert(1)</script> Hi {lot}", zoomText: "" },
      evil: true,
    },
    "https://cdn.test/a.css",
  );
  assert.equal(theme.tokens.primary, "#123456");
  assert.equal(theme.tokens.background, "#fffdf8");
  assert.equal(theme.tokens.text, "#2d2317");
  assert.equal(theme.card.showTier, true);
  // Angle brackets are stripped (no markup can form); text stays readable.
  assert.equal(theme.card.inquireText, "scriptalert(1)/script Hi {lot}");
  assert.ok(!/[<>]/.test(theme.card.inquireText));
  assert.equal(theme.card.zoomText, "Zoom to Lot {lot}");
  assert.equal(theme.cssUrl, "https://cdn.test/a.css");
  assert.ok(!("evil" in theme) && !("extra" in theme.tokens));
});

test("two tenants never share tokens, vars, or CSS scope", () => {
  const scopeA = ".lotmap-t-alpha";
  const scopeB = ".lotmap-t-beta";
  const themeA = allowlistTheme({ tokens: { primary: "#111111" } }, null);
  const themeB = allowlistTheme({ tokens: { primary: "#222222" } }, null);
  const varsA = buildThemeCssVars(themeA);
  const varsB = buildThemeCssVars(themeB);
  assert.equal(varsA["--lotmap-primary"], "#111111");
  assert.equal(varsB["--lotmap-primary"], "#222222");
  assert.notEqual(varsA, varsB);
  // Mutating one tenant's var map cannot affect the other's.
  varsA["--lotmap-primary"] = "#000000";
  assert.equal(buildThemeCssVars(themeA)["--lotmap-primary"], "#111111");
  assert.equal(buildThemeCssVars(themeB)["--lotmap-primary"], "#222222");
  // A file written for B is rejected under A's scope and vice versa.
  assert.ok(validateTenantCss(`${scopeB} .card { color: red; }`, scopeA).length > 0);
  assert.ok(validateTenantCss(`${scopeA} .card { color: red; }`, scopeB).length > 0);
  assert.deepEqual(validateTenantCss(`${scopeA} .card { color: red; }`, scopeA), []);
});

test("card text fills {lot} and leaves unknown tokens alone", () => {
  assert.equal(applyCardText("Inquire About Lot {lot}", "S-010"), "Inquire About Lot S-010");
  assert.equal(applyCardText("Zoom", "S-010"), "Zoom");
  assert.equal(applyCardText(DEFAULT_CARD_CONFIG.waitlistText, "L-001"), "Join Waitlist for Lot L-001");
});

test("public map consumes the shared theme contract", async () => {
  const [component, endpoint] = await Promise.all([
    read("src/components/public/PublicLotMap.tsx"),
    read("supabase/functions/get-public-lots/index.ts"),
  ]);
  assert.match(component, /from "\.\.\/\.\.\/lib\/theme"/);
  assert.match(component, /buildThemeCssVars/);
  assert.match(component, /applyCardText/);
  assert.match(endpoint, /tenant_theme/);
  assert.match(endpoint, /allowlistTheme/);
  assert.match(endpoint, /project/);
});
