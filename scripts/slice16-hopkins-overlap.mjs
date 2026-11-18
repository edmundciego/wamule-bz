import { readFileSync } from "node:fs";

// Slice 1.6: within-draft overlap counts on Hopkins (local only).
// Uses the SINGLE canonical implementation (src/lib/correction/overlap.ts).
const { adaptLots, polygonsOverlap, bboxOf } = await import("../src/lib/correction/index.ts");

const lotsRaw = JSON.parse(readFileSync(new URL("../out/hopkins-ocr/lots.json", import.meta.url), "utf8"));
const adapted = adaptLots(lotsRaw);
console.log(`# lots: ${adapted.length} (from out/hopkins-ocr/lots.json)`);

// Tier breakdown.
const byTier = new Map();
for (const l of adapted) byTier.set(l.tier_key ?? "null", (byTier.get(l.tier_key ?? "null") ?? 0) + 1);
console.log(`# by tier: ${JSON.stringify(Object.fromEntries(byTier))}`);

// Pairwise within-draft overlap (strict interior only; shared edges OK).
const boxes = adapted.map((l) => ({ id: l.id, tier: l.tier_key, box: bboxOf(l.polygon_pct), poly: l.polygon_pct }));
let checked = 0;
let bboxHits = 0;
const conflicts = [];
const t0 = Date.now();
for (let i = 0; i < boxes.length; i++) {
  for (let j = i + 1; j < boxes.length; j++) {
    checked += 1;
    const a = boxes[i].box, b = boxes[j].box;
    if (!(a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3])) continue;
    bboxHits += 1;
    if (polygonsOverlap(boxes[i].poly, boxes[j].poly)) {
      conflicts.push([boxes[i].id, boxes[j].id, boxes[i].tier, boxes[j].tier]);
    }
  }
}
const ms = Date.now() - t0;
console.log(`# pairs checked: ${checked}`);
console.log(`# bbox prefilter hits: ${bboxHits}`);
console.log(`# WITHIN-DRAFT strict overlaps: ${conflicts.length}`);
for (const [a, b, ta, tb] of conflicts.slice(0, 50)) {
  console.log(`overlap ${a} (${ta}) <-> ${b} (${tb})`);
}
if (conflicts.length > 50) console.log(`# ... +${conflicts.length - 50} more`);
console.log(`# ms: ${ms}`);

// NOTE for publish: matchPublish() refuses draft-vs-EXISTING overlaps; it
// does not check draft-vs-draft pairs. These within-draft counts are the QA
// input for the correct-stage review (overlapping drafts must be fixed or
// waived before publish), not an automatic publish refusal today.
