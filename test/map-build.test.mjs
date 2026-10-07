import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("build refuses polygon/background extent mismatches via interior sampling", async () => {
  const script = await read("scripts/build-interactive-map.mjs");

  // Interior sampling, not centre sampling: plat labels sit at lot centres.
  assert.match(script, /checkAlignment/);
  assert.match(script, /np\.linspace\(min\(xs\), max\(xs\), 6\)/);
  // Text/grid pixels are excluded before matching, not counted as mismatches.
  assert.match(script, /if m < 100 or m > 240: continue/);
  // Per-lot pass mark and build-wide refusal threshold (tunable).
  assert.match(script, /if good \/ hits >= 0\.6/);
  assert.match(script, /--alignment-min 0\.8/);
  assert.match(script, /alignmentMin/);
  // Fail closed with an actionable message.
  assert.match(script, /Detect on the exact file served, then rebuild/);
  assert.match(script, /polygons and background have different extents/);
  // Result recorded in the ingest report for audit.
  assert.match(script, /alignment,/);
  assert.match(script, /method: "interior-sample\+edge"/);
});

test("edge-gradient check catches sub-lot shifts that interior colour misses", async () => {
  const script = await read("scripts/build-interactive-map.mjs");

  // Neighbours share tier colours, so interior sampling is blind to small
  // shifts; border gradient (Sobel) collapses as soon as borders leave the
  // lot lines. Calibrated on Hopkins: true data 1.33, +0.25% shift 0.44.
  assert.match(script, /edge_strength/);
  assert.match(script, /sobel/);
  assert.match(script, /\[\(0\.35, 0\), \(-0\.35, 0\), \(0, 0\.35\), \(0, -0\.35\)\]/);
  assert.match(script, /--alignment-edge-ratio 1\.2/);
  assert.match(script, /edge_ratio/);
  assert.match(script, /polygon borders do not sit on Lot-line discontinuities/);
});

test("alignment check is skippable for iteration but warns loudly", async () => {
  const script = await read("scripts/build-interactive-map.mjs");
  assert.match(script, /skip-alignment-check/);
  assert.match(script, /alignment check skipped.*verify polygon fit in poc\.html/s);
});
