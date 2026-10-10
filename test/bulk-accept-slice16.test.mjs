import assert from "node:assert/strict";
import test from "node:test";

// Slice 1.7 bulk-accept: OCR number + street-run/adjacency + scale-area
// (unavailable until a scale is provided), >=20 stratified sample,
// wrong-sample blocks, server-generated single-use seed.
const lib = await import("../src/lib/correction/index.ts");

function square(x, y, s = 10) {
  return [
    { x, y },
    { x: x + s, y },
    { x: x + s, y: y + s },
    { x, y: y + s },
  ];
}

// 10x10 lots on a 12-unit stride: neighbours are adjacent
// (12 <= 1.5*10) but never overlapping (12 > 10).
function bigState() {
  const lots = [];
  const units = {};
  const tiers = {
    a: { label: "A", color: "#ffffff", price: 100, sellable: true },
    b: { label: "B", color: "#ff0000", price: 200, sellable: true },
    c: { label: "C", color: "#00ff00", price: 300, sellable: true },
  };
  const tierOf = (i) => (i < 25 ? "a" : i < 50 ? "b" : "c");
  const baseNum = (i) => (i < 25 ? 100 + i : i < 50 ? 200 + (i - 25) : 300 + (i - 50));
  for (let i = 0; i < 75; i++) {
    const id = `l${i}`;
    const tier = tierOf(i);
    const x = (i % 25) * 12;
    const y = tier === "a" ? 0 : tier === "b" ? 100 : 200;
    lots.push({ id, lot_number: `L-${i}`, polygon_pct: square(x, y), tier_key: tier });
    units[id] = { number: String(baseNum(i)), area_sqm: 1000 + (i % 5), suspect: [] };
  }
  return lib.createInitialState({ lots, tiers, units, actor: "alice", tenant: "t1", project: "p1" });
}

// 10x10 plan-% squares are 100 pct²; ocr areas are ~1000sqm, so a scale of
// 10 sqm/pct² measures 1000sqm (pass) and 20 measures 2000sqm (fail).
const SCALE_PASS = { sqmPerPct2: 10, source: "test" };
const SCALE_FAIL = { sqmPerPct2: 20, source: "test" };

test("independent signals: exact computation", () => {
  const s = bigState();
  const id = "l0"; // tier a, number 100, ocr_area 1000
  const slot = s.lots[id];
  // 1. OCR number: working copy equals immutable ingest read.
  assert.equal(lib.ocrNumberSignal(slot), true);
  // 2. Street-run + adjacency: 101 sits 12 units away (<= 1.5*10).
  assert.equal(lib.streetRunSignal(slot, s), true);
  // 3. Scale-area: unavailable until a scale is provided (never gates).
  assert.equal(lib.areaScaleSignal(slot, null), "unavailable");
  assert.equal(lib.areaScaleSignal(slot, SCALE_PASS), "pass");
  assert.equal(lib.areaScaleSignal(slot, SCALE_FAIL), "fail");
  assert.deepEqual(lib.bulkSignals(slot, s), { ocr: true, streetRun: true, areaScale: "unavailable", all: true });
  assert.equal(lib.bulkSignals(slot, s, SCALE_PASS).all, true);
  assert.equal(lib.bulkSignals(slot, s, SCALE_FAIL).all, false);

  // Wrong number breaks OCR + street-run (9999: no neighbour, not the read).
  slot.number = "9999";
  assert.equal(lib.ocrNumberSignal(slot), false);
  assert.equal(lib.streetRunSignal(slot, s), false);
  assert.equal(lib.bulkSignals(slot, s).all, false);
  slot.number = slot.ocr_number;

  // Numerical neighbour across the map breaks adjacency only.
  const far = lib.createInitialState({
    lots: [
      { id: "a", lot_number: "A", polygon_pct: square(0, 0), tier_key: "s" },
      { id: "b", lot_number: "B", polygon_pct: square(100, 0), tier_key: "s" },
    ],
    tiers: { s: { label: "S", color: "#fff", price: 1, sellable: true } },
    units: { a: { number: "50", area_sqm: 1000, suspect: [] }, b: { number: "51", area_sqm: 1000, suspect: [] } },
    actor: "alice",
  });
  assert.equal(lib.ocrNumberSignal(far.lots.a), true);
  assert.equal(lib.streetRunSignal(far.lots.a, far), false); // 100 units away, limit 15
});

test("proposal requires gating signals; sample >=20 stratified by tier/block", () => {
  const s = bigState();
  const { proposal, sample } = lib.proposeBulkAccept(s, 42);
  assert.equal(proposal.length, 75);
  assert.ok(sample.length >= 20, `sample ${sample.length} < 20`);
  const tiersInSample = new Set(sample.map((id) => s.lots[id].tier_key));
  assert.deepEqual([...tiersInSample].sort(), ["a", "b", "c"]);
  const strata = new Set(proposal.map((id) => lib.lotStratum(s.lots[id])));
  const sampleStrata = new Set(sample.map((id) => lib.lotStratum(s.lots[id])));
  assert.ok(sampleStrata.size >= 3, `strata ${sampleStrata.size}`);
  assert.ok(sampleStrata.size <= strata.size);
  assert.deepEqual(lib.proposeBulkAccept(s, 42).sample, sample);
  // A scale that fails the area check empties the proposal (fail gates).
  assert.equal(lib.proposeBulkAccept(s, 42, 20, SCALE_FAIL).proposal.length, 0);
});

test("sample is ALL when fewer than 20 qualify", () => {
  const s = lib.createInitialState({
    lots: Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      lot_number: `S-${i}`,
      polygon_pct: square(i * 12, 0),
      tier_key: "a",
    })),
    tiers: { a: { label: "A", color: "#fff", price: 1, sellable: true } },
    units: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`s${i}`, { number: String(500 + i), area_sqm: 1000, suspect: [] }])),
    actor: "alice",
  });
  const { proposal, sample } = lib.proposeBulkAccept(s, 1);
  assert.equal(proposal.length, 5);
  assert.deepEqual(sample, proposal);
});

test("any wrong sample blocks the bulk accept", () => {
  const s = bigState();
  const { proposal, sample } = lib.proposeBulkAccept(s, 11);
  for (const id of sample) lib.confirmLot(s, { actor: "alice", id });
  // Corrupt one confirmed sample lot (wrong number: breaks OCR + street-run).
  const victim = sample[0];
  s.lots[victim].number = "9999";
  assert.throws(
    () => lib.bulkConfirmRest(s, { actor: "alice", proposal, sample }),
    /bulk sample .* is wrong.*signal failed/,
  );
  // Unconfirmed sample also blocks.
  const s2 = bigState();
  const p2 = lib.proposeBulkAccept(s2, 11);
  assert.throws(() => lib.bulkConfirmRest(s2, { actor: "alice", proposal: p2.proposal, sample: p2.sample }), /not manually confirmed/);
  // With a failing scale, the confirmed sample blocks on area-scale.
  const s3 = bigState();
  const p3 = lib.proposeBulkAccept(s3, 11);
  for (const id of p3.sample) lib.confirmLot(s3, { actor: "alice", id });
  assert.throws(
    () => lib.bulkConfirmRest(s3, { actor: "alice", proposal: p3.proposal, sample: p3.sample, scale: SCALE_FAIL }),
    /area-scale/,
  );
});

test("server-generated single-use seed", () => {
  const store = new lib.DraftStore();
  store.create({ tenant: "t1", project: "p1", state: bigState(), actor: "alice" });
  const issued = store.issueBulkSeed({ tenant: "t1", project: "p1", requesterTenant: "t1", actor: "alice" });
  assert.ok(issued.seedId);
  assert.ok(Number.isInteger(issued.seed));
  assert.ok(issued.sample.length >= 20);
  const issued2 = store.issueBulkSeed({ tenant: "t1", project: "p1", requesterTenant: "t1", actor: "alice" });
  assert.notEqual(issued.seedId, issued2.seedId);
  assert.throws(
    () => store.bulkConfirmWithSeed({ tenant: "t1", project: "p1", requesterTenant: "t1", actor: "alice", seedId: "nope" }),
    /unknown or cross-tenant bulk seed/,
  );
  const doc = store.load("t1", "p1", "t1");
  for (const id of issued.sample) lib.confirmLot(doc.state, { actor: "alice", id });
  store.save({ tenant: "t1", project: "p1", requesterTenant: "t1", baseRev: doc.rev, state: doc.state, actor: "alice" });
  const rest = store.bulkConfirmWithSeed({ tenant: "t1", project: "p1", requesterTenant: "t1", actor: "alice", seedId: issued.seedId });
  assert.equal(rest.length, issued.proposal.length - issued.sample.length);
  assert.throws(
    () => store.bulkConfirmWithSeed({ tenant: "t1", project: "p1", requesterTenant: "t1", actor: "alice", seedId: issued.seedId }),
    /already used/,
  );
});
