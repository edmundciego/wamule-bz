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
