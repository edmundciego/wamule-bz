import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyPublicBuild } from "../scripts/verify-public-build.mjs";

const PRIVATE_INDEX = '<!doctype html><html><head><meta name="robots" content="noindex,nofollow" /></head></html>';

function makeBuild(t) {
  const root = mkdtempSync(join(tmpdir(), "wamule-public-build-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), PRIVATE_INDEX);
  writeFileSync(join(root, "assets", "app.js"), "const appReady = true;");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("public build verifier accepts a private-indexed bundle without dev fixtures", (t) => {
  const report = verifyPublicBuild(makeBuild(t));
  assert.equal(report.filesScanned, 2);
  assert.equal(report.textBytesScanned > 0, true);
  assert.deepEqual(report.errors, []);
});

test("public Hopkins route code and favicon are allowed without publishing source assets", (t) => {
  const root = makeBuild(t);
  writeFileSync(join(root, "assets", "HopkinsPublicPage-a1B2c3.js"), "export const publicRoute = true;");
  mkdirSync(join(root, "favicon"));
  writeFileSync(join(root, "favicon", "hopkins-grove.svg"), "<svg></svg>");
  assert.deepEqual(verifyPublicBuild(root).errors, []);

  writeFileSync(join(root, "assets", "hopkins-775-outline-snapshot.json"), "{}");
  assert.ok(verifyPublicBuild(root).errors.some((error) => error.includes("private source/tenant artifact")));
});

test("public build verifier requires noindex metadata", (t) => {
  const root = makeBuild(t);
  writeFileSync(join(root, "index.html"), "<!doctype html><html><head></head></html>");
  const report = verifyPublicBuild(root);
  assert.ok(report.errors.some((error) => error.includes("noindex,nofollow")));
});

test("public build verifier rejects development-only map fixture markers", (t) => {
  const root = makeBuild(t);
  writeFileSync(join(root, "assets", "app.js"), 'const fixture = "/demo-map";');
  const report = verifyPublicBuild(root);
  assert.ok(report.errors.some((error) => error.includes("development map fixture route")));

  writeFileSync(join(root, "assets", "app.js"), 'fetch("/correction-review/hopkins/benchmark/benchmark-manifest.json");');
  const privateRouteReport = verifyPublicBuild(root);
  assert.ok(privateRouteReport.errors.some((error) => error.includes("development map fixture route")));
});

test("public build verifier does not mistake a CSS map aspect token for a fixture route", (t) => {
  const root = makeBuild(t);
  writeFileSync(join(root, "assets", "app.css"), ".preview{aspect-ratio:var(--demo-map-aspect)}");
  const report = verifyPublicBuild(root);
  assert.deepEqual(report.errors, []);
});

test("public build verifier rejects private map fixtures and source PDFs", (t) => {
  const root = makeBuild(t);
  writeFileSync(join(root, "assets", "lots.json"), "[]");
  writeFileSync(join(root, "assets", "map.pdf"), "not a real PDF");
  const report = verifyPublicBuild(root);
  assert.ok(report.errors.some((error) => error.includes("private map fixture file")));
  assert.ok(report.errors.some((error) => error.includes(".pdf")));
});

test("public build verifier detects a PDF renamed to a non-PDF extension", (t) => {
  const root = makeBuild(t);
  writeFileSync(join(root, "assets", "source.dat"), Buffer.from("prefix\n%PDF-1.7\nprivate source"));
  const report = verifyPublicBuild(root);
  assert.ok(report.errors.some((error) => error.includes("PDF-signature source artifact")));
});

test("public build verifier refuses symlinks that could hide outside files", (t) => {
  const root = makeBuild(t);
  const outside = join(root, "outside.js");
  writeFileSync(outside, "const privateData = true;");
  symlinkSync(outside, join(root, "assets", "linked.js"));
  const report = verifyPublicBuild(root);
  assert.ok(report.errors.some((error) => error.includes("symlink is not allowed")));
});


test("staging public build requires noindex response headers", (t) => {
  const root = makeBuild(t);
  assert.ok(verifyPublicBuild(root, { staging: true }).errors.some((error) => error.includes("_headers file is missing")));
  writeFileSync(join(root, "_headers"), "/*\n  X-Robots-Tag: noindex, nofollow\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Content-Type-Options: nosniff\n");
  assert.deepEqual(verifyPublicBuild(root, { staging: true }).errors, []);
});

test("public build rejects obsolete pipeline labels in the public route bundle", (t) => {
  const root = makeBuild(t);
  const publicRoute = join(root, "assets", "HopkinsPublicPage-a1B2c3.js");
  for (const label of ["Generated map reference", "Source tier", "Source price colors", "Printed-number OCR candidate"]) {
    writeFileSync(publicRoute, `const label = ${JSON.stringify(label)};`);
    assert.ok(verifyPublicBuild(root).errors.some((error) => error.includes("obsolete pipeline wording")), `accepted public label: ${label}`);
  }
});
