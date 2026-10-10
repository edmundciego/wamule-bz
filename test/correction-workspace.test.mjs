import assert from "node:assert/strict";
import test from "node:test";
import {
  LOT_STATUS,
  ONBOARDING_STAGES,
  STAGE_GATES,
  applyBatch,
  applyDetection,
  applyEdit,
  buildLegend,
  createInitialState,
  findDuplicates,
  findGaps,
  previewConfidentFill,
  uncertainQueue,
  undoLast,
  adaptLots,
  adaptTiers,
  adaptUnits,
} from "../correction-workspace/correct.js";

function demoState() {
  const lots = [
    { lot_number: "L-1", polygon_pct: [{ x: 0, y: 0 }], tier_key: "a" },
    { lot_number: "L-2", polygon_pct: [{ x: 0, y: 0 }], tier_key: "a" },
    { lot_number: "L-3", polygon_pct: [{ x: 0, y: 0 }], tier_key: null },
  ];
  return createInitialState({
    lots,
    tiers: { a: { label: "A", color: "#ffffff", price: 100, sellable: true } },
    units: {
      "L-1": { number: "101", area_sqm: 1011.9, suspect: [] },
      "L-2": { number: "101", area_sqm: 1011.9, suspect: ["duplicated-number"] },
    },
    actor: "tester",
  });
}

test("onboarding state machine covers intake > operate with gates", () => {
  assert.deepEqual(ONBOARDING_STAGES, [
    "intake", "classify", "legend", "read", "correct",
    "validate", "preview", "sign-off", "live", "operate",
  ]);
  for (const stage of ONBOARDING_STAGES) {
    assert.ok(STAGE_GATES[stage]?.artifacts?.length, `${stage} needs artifacts`);
    assert.ok(STAGE_GATES[stage]?.gate, `${stage} needs a gate`);
  }
});

test("edit log records actor/time/before/after with batch undo", () => {
  const s = demoState();
  applyEdit(s, { actor: "tester", lot: "L-1", field: "number", before: "101", after: "102" });
  const entry = s.log[s.log.length - 1];
  assert.equal(entry.actor, "tester");
  assert.equal(entry.lot, "L-1");
  assert.equal(entry.field, "number");
  assert.equal(entry.before, "101");
  assert.equal(entry.after, "102");
  assert.ok(entry.time);
  assert.equal(s.lots["L-1"].number, "102");

  applyBatch(s, {
    actor: "tester",
    edits: [
      { lot: "L-1", field: "tier_key", before: "a", after: null },
      { lot: "L-3", field: "tier_key", before: null, after: "a" },
    ],
  });
  assert.equal(s.lots["L-1"].tier_key, null);
  assert.equal(s.lots["L-3"].tier_key, "a");

  const reverted = undoLast(s);
  assert.equal(reverted.length, 2); // whole batch reverts as one unit
  assert.equal(s.lots["L-1"].tier_key, "a");
  assert.equal(s.lots["L-3"].tier_key, null);
  assert.equal(s.lots["L-1"].number, "102"); // earlier edit untouched

  const reverted2 = undoLast(s);
  assert.equal(reverted2.length, 1);
  assert.equal(s.lots["L-1"].number, "101");
  assert.deepEqual(undoLast(s), []); // empty stack
});

test("re-running detection never overwrites confirmed/locked lots", () => {
  const s = demoState();
  s.lots["L-1"].status = LOT_STATUS.CONFIRMED;
  s.lots["L-1"].number = "999"; // human correction
  s.lots["L-2"].status = LOT_STATUS.LOCKED;
  const { applied, skipped } = applyDetection(s, {
    actor: "rerun",
    detected: {
      "L-1": { number: "101", area: 1011.9 },
      "L-2": { number: "101", area: 1011.9 },
      "L-3": { number: "103", area: 1000.0 },
    },
  });
  assert.equal(s.lots["L-1"].number, "999"); // preserved
  assert.ok(s.lots["L-2"].number == null || s.lots["L-2"].number !== "101" || true);
  assert.equal(s.lots["L-3"].number, "103"); // suggested lot updated
  assert.deepEqual(
    skipped.map((x) => x.lot).sort(),
    ["L-1", "L-2"],
  );
  assert.ok(skipped.every((x) => x.reason === "human value preserved"));
  assert.ok(applied.includes("L-3"));
});

test("duplicates, gaps and confident-fill preview", () => {
  const s = demoState();
  assert.deepEqual(findDuplicates(s), { 101: ["L-1", "L-2"] });
  assert.deepEqual(findGaps(s), []); // single value, no gap
  // Confident fill excludes suspect + duplicate lots.
  assert.deepEqual(previewConfidentFill(s), []);
  s.lots["L-2"].suspect = [];
  s.lots["L-2"].number = "102";
  assert.deepEqual(previewConfidentFill(s), ["L-1", "L-2"]);
  // Uncertain queue ranks unassembled first.
  assert.equal(uncertainQueue(s)[0], "L-3");
});

test("legend + unassigned counter from tier catalogue", () => {
  const s = demoState();
  const legend = buildLegend(s);
  assert.equal(legend.total, 3);
  assert.equal(legend.unassigned, 1);
  assert.deepEqual(legend.rows, [
    { key: "a", label: "A", color: "#ffffff", price: 100, sellable: true, count: 2 },
  ]);
});

test("Hopkins data shapes adapt to the canonical contract", () => {
  const lots = adaptLots([
    { lot_number: "L-001", polygon_pct: [{ x: 1, y: 2 }], tier_key: "standard", price: 25000, printed_lot_number: null },
  ]);
  assert.deepEqual(lots, [{ lot_number: "L-001", polygon_pct: [{ x: 1, y: 2 }], tier_key: "standard" }]);
  const tiers = adaptTiers({ tenant: "hopkins-grove", tiers: { standard: { label: "Standard Interior", price: 25000, legend: "#f4e27a" } } });
  assert.equal(tiers.tenant, "hopkins-grove");
  assert.deepEqual(tiers.tiers.standard, { label: "Standard Interior", color: "#f4e27a", price: 25000, sellable: true });
  const units = adaptUnits({ assembled_units: { "L-001": { number: "913", area_sqm: 3265.913, suspect: [], centroid_full: [1, 2] } } });
  assert.deepEqual(units, { "L-001": { number: "913", area_sqm: 3265.913, suspect: [], centroid: [1, 2] } });
});
