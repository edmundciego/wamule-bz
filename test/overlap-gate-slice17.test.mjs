import assert from "node:assert/strict";
import test from "node:test";

// Slice 1.7: unresolved within-draft overlaps block correct -> validate
// unless waived with reason/actor/time.
const lib = await import("../src/lib/correction/index.ts");

function square(x, y, s = 10) {
  return [
    { x, y },
    { x: x + s, y },
    { x: x + s, y: y + s },
    { x, y: y + s },
  ];
}

// Two confirmed, consecutive-numbered, non-duplicate lots whose polygons
// strictly overlap (shared edges alone would pass).
function overlappingState() {
  const s = lib.createInitialState({
    lots: [
      { id: "a", lot_number: "L-001", polygon_pct: square(0, 0), tier_key: "s" },
      { id: "b", lot_number: "L-002", polygon_pct: square(5, 5), tier_key: "s" },
    ],
    tiers: { s: { label: "S", color: "#ffffff", price: 100, sellable: true } },
    units: {
      a: { number: "101", area_sqm: 1000, suspect: [] },
      b: { number: "102", area_sqm: 1000, suspect: [] },
    },
    actor: "alice",
    tenant: "t1",
    project: "p1",
  });
  s.stage = "correct";
  lib.confirmLot(s, { actor: "alice", id: "a" });
  lib.confirmLot(s, { actor: "alice", id: "b" });
  return s;
}

test("overlap target keys are order-normalized", () => {
  assert.equal(lib.overlapTarget("L-021", "L-020"), "L-020<->L-021");
  assert.equal(lib.overlapTarget("L-020", "L-021"), "L-020<->L-021");
});

test("within-draft overlap blocks the correct gate", () => {
  const s = overlappingState();
  const found = lib.findWithinDraftOverlaps(s);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], { a: "a", b: "b", target: "a<->b" });
  const gate = lib.evaluateStageGate(s);
  assert.equal(gate.pass, false);
  const overlap = gate.blocking.filter((f) => f.code === "within-draft-overlap");
  assert.equal(overlap.length, 1);
  assert.deepEqual(overlap[0].waivableAs, { scope: "overlap", target: "a<->b" });
  // ...and nothing else blocks (uncertain/dups/gaps are clean).
  assert.equal(gate.blocking.length, 1);
  assert.throws(() => lib.advanceStage(s, "alice"), /gate bypass refused/);
});

test("overlap waiver needs reason/actor/time; then the gate passes", () => {
  const s = overlappingState();
  assert.throws(() => lib.addWaiver(s, { actor: "alice", scope: "overlap", target: "a<->b", reason: "  " }), /reason is required/);
  assert.throws(() => lib.addWaiver(s, { actor: "  ", scope: "overlap", target: "a<->b", reason: "shared wall" }), /actor is required/);
  const w = lib.addWaiver(s, { actor: "alice", scope: "overlap", target: "a<->b", reason: "shared wall confirmed on plan" });
  assert.ok(w.id && w.time);
  assert.equal(w.actor, "alice");
  const gate = lib.evaluateStageGate(s);
  assert.equal(gate.pass, true);
  assert.equal(gate.waived.length, 1);
  assert.equal(lib.advanceStage(s, "alice"), "validate");
});

test("publish from correct is refused on overlap, proceeds once waived", () => {
  const store = new lib.DraftStore();
  store.create({ tenant: "t1", project: "p1", state: overlappingState(), actor: "alice" });
  assert.throws(
    () => store.publish({ tenant: "t1", project: "p1", requesterTenant: "t1", actor: "alice", existing: [] }),
    (e) => e instanceof lib.GateBypassError && /overlaps/.test(e.message),
  );
  const doc = store.load("t1", "p1", "t1");
  lib.addWaiver(doc.state, { actor: "alice", scope: "overlap", target: "a<->b", reason: "shared wall confirmed on plan" });
  store.save({ tenant: "t1", project: "p1", requesterTenant: "t1", baseRev: doc.rev, state: doc.state, actor: "alice" });
  const out = store.publish({ tenant: "t1", project: "p1", requesterTenant: "t1", actor: "alice", existing: [] });
  assert.equal(out.stage, "validate");
});
