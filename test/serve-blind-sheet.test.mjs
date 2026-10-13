import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repo = new URL("..", import.meta.url);
const repoPath = decodeURIComponent(repo.pathname);

function makeReviewRoot() {
  const root = mkdtempSync(join(tmpdir(), "blind-review-server-"));
  const crops = join(root, "sheet-crops");
  mkdirSync(crops);
  writeFileSync(join(root, "label.html"), "blind label page");
  writeFileSync(join(root, "benchmark-manifest.json"), "public crop coordinates only");
  writeFileSync(join(root, "measure-roads.html"), "road measurement page");
  writeFileSync(join(root, "masterplan_background.webp"), "private map image");
  writeFileSync(join(root, "lots.json"), "private lot identities");
  writeFileSync(join(root, "ocr.json"), "private OCR output");
  writeFileSync(join(root, "ocr-qa.html"), "private QA viewer");
  writeFileSync(join(crops, "S001.png"), "crop one");
  writeFileSync(join(crops, "S060.png"), "crop sixty");
  writeFileSync(join(crops, "S061.png"), "out of range");
  writeFileSync(join(crops, "S100.png"), "crop one hundred");
  symlinkSync(join(root, "lots.json"), join(crops, "S002.png"));
  return root;
}

function startServer(root, mode) {
  const child = spawn("python3", [
    "scripts/serve-blind-sheet.py",
    "--directory", root,
    "--mode", mode,
    "--port", "0",
  ], { cwd: repo.pathname, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), 5000);
    const scan = () => {
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      scan();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited before startup (${code}): ${stderr}`));
    });
  });
  return { child, ready };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("labels mode exposes only the blind page and numbered crops", async () => {
  const root = makeReviewRoot();
  const { child, ready } = startServer(root, "labels");
  try {
    const base = await ready;
    const rootResponse = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(rootResponse.status, 302);
    assert.equal(rootResponse.headers.get("location"), "/label.html");
    assert.equal(await (await fetch(`${base}/label.html`)).text(), "blind label page");
    assert.equal(await (await fetch(`${base}/sheet-crops/S001.png`)).text(), "crop one");
    assert.equal(await (await fetch(`${base}/sheet-crops/S100.png`)).text(), "crop one hundred");

    for (const path of [
      "/lots.json", "/ocr.json", "/ocr-qa.html", "/measure-roads.html",
      "/masterplan_background.webp", "/sheet-crops/S002.png", "/sheet-crops/S101.png",
      "/%2e%2e/lots.json", "/sheet-crops/../../lots.json",
    ]) {
      const response = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.equal(response.status, 404, `${path} must remain unavailable`);
    }
    const privateHead = await fetch(`${base}/ocr.json`, { method: "HEAD" });
    assert.equal(privateHead.status, 404);
  } finally {
    await stopServer(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("roads mode exposes the measurement page and image without exposing OCR or lot data", async () => {
  const root = makeReviewRoot();
  const { child, ready } = startServer(root, "roads");
  try {
    const base = await ready;
    const rootResponse = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(rootResponse.status, 302);
    assert.equal(rootResponse.headers.get("location"), "/measure-roads.html");
    assert.equal(await (await fetch(`${base}/measure-roads.html`)).text(), "road measurement page");
    assert.equal(await (await fetch(`${base}/masterplan_background.webp`)).text(), "private map image");

    for (const path of [
      "/lots.json", "/ocr.json", "/ocr-qa.html", "/label.html", "/sheet-crops/S001.png",
    ]) {
      const response = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.equal(response.status, 404, `${path} must remain unavailable`);
    }
  } finally {
    await stopServer(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("benchmark mode exposes only the reviewer, source-bound manifest, and 60 crops", async () => {
  const root = makeReviewRoot();
  const { child, ready } = startServer(root, "benchmark");
  try {
    const base = await ready;
    const rootResponse = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(rootResponse.status, 302);
    assert.equal(rootResponse.headers.get("location"), "/label.html");
    assert.equal(await (await fetch(`${base}/label.html`)).text(), "blind label page");
    assert.equal(await (await fetch(`${base}/benchmark-manifest.json`)).text(), "public crop coordinates only");
    assert.equal(await (await fetch(`${base}/sheet-crops/S001.png`)).text(), "crop one");
    assert.equal(await (await fetch(`${base}/sheet-crops/S060.png`)).text(), "crop sixty");

    for (const path of [
      "/lots.json", "/ocr.json", "/ocr-qa.html", "/masterplan_background.webp",
      "/hopkins-lot-number-benchmark-v1-mapping.json",
      "/hopkins-lot-number-benchmark-v1-selection-evidence.json",
      "/sheet-crops/S002.png", "/sheet-crops/S061.png", "/sheet-crops/S100.png",
      "/measure-roads.html", "/labels_template.csv",
    ]) {
      const response = await fetch(`${base}${path}`, { redirect: "manual" });
      assert.equal(response.status, 404, `${path} must remain unavailable`);
    }
  } finally {
    await stopServer(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("current private Hopkins review pack runs in both restricted modes", async (t) => {
  const root = join(repoPath, "out", "hopkins-ocr");
  if (!existsSync(join(root, "label.html")) || !existsSync(join(root, "sheet-crops", "S100.png"))) {
    t.skip("private Hopkins review assets are not present in this checkout");
    return;
  }

  const labelsServer = startServer(root, "labels");
  try {
    const base = await labelsServer.ready;
    assert.equal((await fetch(`${base}/label.html`)).status, 200);
    assert.equal((await fetch(`${base}/sheet-crops/S100.png`)).status, 200);
    assert.equal((await fetch(`${base}/ocr.json`)).status, 404);
    assert.equal((await fetch(`${base}/lots.json`)).status, 404);
    assert.equal((await fetch(`${base}/masterplan_background.webp`)).status, 404);
  } finally {
    await stopServer(labelsServer.child);
  }

  const roadsServer = startServer(root, "roads");
  try {
    const base = await roadsServer.ready;
    assert.equal((await fetch(`${base}/measure-roads.html`)).status, 200);
    assert.equal((await fetch(`${base}/masterplan_background.webp`)).status, 200);
    assert.equal((await fetch(`${base}/ocr.json`)).status, 404);
    assert.equal((await fetch(`${base}/lots.json`)).status, 404);
    assert.equal((await fetch(`${base}/label.html`)).status, 404);
  } finally {
    await stopServer(roadsServer.child);
  }
});
