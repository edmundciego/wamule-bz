#!/usr/bin/env node
import { closeSync, lstatSync, openSync, readFileSync, readdirSync, readSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".map", ".mjs", ".svg", ".webmanifest"]);
const PRIVATE_FIXTURE_BASENAMES = new Set([
  "lots.json",
  "tiers.json",
  "ocr.json",
  "masterplan_background.webp",
  "masterplan_preview.webp",
]);
const FORBIDDEN_BUNDLE_MARKERS = [
  ["development map fixture route", /demo-map/i],
  ["development fixture loader", /loadDemo/],
  ["synthetic E2E fixture marker", /synthetic-e2e/i],
  ["development-only demo query", /demo=1/i],
];

function hasPdfHeader(path) {
  const fd = openSync(path, "r");
  const header = Buffer.alloc(1024);
  try {
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    return header.subarray(0, bytesRead).includes(Buffer.from("%PDF-"));
  } finally {
    closeSync(fd);
  }
}

function collectFiles(root, directory, files, errors) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    errors.push(`cannot read ${relative(root, directory) || "."}: ${error.message}`);
    return;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    const rel = relative(root, path);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      errors.push(`cannot inspect ${rel}: ${error.message}`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      errors.push(`symlink is not allowed in the public build: ${rel}`);
      continue;
    }
    if (stat.isDirectory()) {
      collectFiles(root, path, files, errors);
      continue;
    }
    if (!stat.isFile()) {
      errors.push(`non-regular file is not allowed in the public build: ${rel}`);
      continue;
    }
    files.push({ path, relativePath: rel, bytes: stat.size });

    const lowerName = basename(path).toLowerCase();
    if (PRIVATE_FIXTURE_BASENAMES.has(lowerName)) {
      errors.push(`private map fixture file is present: ${rel}`);
    }
    const isPdfByName = extname(path).toLowerCase() === ".pdf";
    if (/hopkins/i.test(rel) || isPdfByName) {
      errors.push(`private source/tenant artifact is present: ${rel}`);
    } else {
      try {
        if (hasPdfHeader(path)) errors.push(`PDF-signature source artifact is present: ${rel}`);
      } catch (error) {
        errors.push(`cannot inspect file signature for ${rel}: ${error.message}`);
      }
    }
  }
}

export function verifyPublicBuild(directory = "dist") {
  const root = resolve(directory);
  const errors = [];
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    return { directory: root, filesScanned: 0, textBytesScanned: 0, errors: [`build directory is unavailable: ${error.message}`] };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { directory: root, filesScanned: 0, textBytesScanned: 0, errors: ["build path must be a real directory"] };
  }

  const files = [];
  collectFiles(root, root, files, errors);
  const index = files.find((file) => file.relativePath === "index.html");
  if (!index) {
    errors.push("index.html is missing from the public build");
  } else {
    const html = readFileSync(index.path, "utf8");
    if (!/<meta\s+name="robots"\s+content="noindex,nofollow"\s*\/?>/i.test(html)) {
      errors.push("index.html must retain the noindex,nofollow directive");
    }
  }

  let textBytesScanned = 0;
  for (const file of files) {
    if (!TEXT_EXTENSIONS.has(extname(file.path).toLowerCase())) continue;
    const contents = readFileSync(file.path, "utf8");
    textBytesScanned += file.bytes;
    for (const [description, pattern] of FORBIDDEN_BUNDLE_MARKERS) {
      if (pattern.test(contents)) errors.push(`${description} is present in ${file.relativePath}`);
    }
  }

  return {
    directory: root,
    filesScanned: files.length,
    textBytesScanned,
    errors,
  };
}

function parseArgs(argv) {
  if (argv.length === 0) return "dist";
  if (argv.length === 2 && argv[0] === "--dir" && argv[1].trim()) return argv[1];
  throw new Error("Usage: node scripts/verify-public-build.mjs [--dir <build-directory>]");
}

function main() {
  try {
    const result = verifyPublicBuild(parseArgs(process.argv.slice(2)));
    if (result.errors.length > 0) {
      for (const error of result.errors) console.error(`[public-build:verify] FAIL: ${error}`);
      console.error(`[public-build:verify] scanned ${result.filesScanned} files in ${result.directory}`);
      process.exitCode = 1;
    } else {
      console.log(`[public-build:verify] PASS: ${result.filesScanned} files, ${result.textBytesScanned} text bytes scanned; no dev map fixtures or private source artifacts in ${result.directory}`);
    }
  } catch (error) {
    console.error(`[public-build:verify] ${error.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
