import assert from "node:assert/strict";
import test from "node:test";

// Slice 1.5 server-rule tests. The DraftStore below is exercised as the
// server: optimistic locking, session-actor binding, tenant isolation,
// overlap refusal and gate enforcement all live in it (src/lib/correction).
// The Supabase migration mirrors the same rules at the DB layer; it is
// written but unapplied locally (no local DB), so DB parity is by review.
const lib = await import("../src/lib/correction/index.ts").catch(() => null);

test("TS lib is importable in node (framework-free enforcement layer)", () => {
  assert.ok(lib, "src/lib/correction must load without DOM/bundler");
});

const {
  LOT_STATUS,
  DraftStore,
  StaleRevisionError,
  TenantIsolationError,
  GateBypassError,
  applyDetection,
  applyEdit,
  bulkConfirmRest,
  confirmLot,
  createInitialState,
  evaluateStageGate,
  matchPublish,
  polygonsOverlap,
  proposeBulkAccept,
  renumberLot,
  undoLast,
} = lib ?? {};

function square(x, y, s = 10) {
  return [
    { x, y },
    { x: x + s, y },
    { x: x + s, y: y + s },
    { x, y: y + s },
  ];
}

function demoState() {
  return createInitialState({
    lots: [
      { id: "a", lot_number: "L-001", polygon_pct: square(0, 0), tier_key: "s" },
      { id: "b", lot_number: "L-002", polygon_pct: square(20, 0), tier_key: "s" },
      { id: "c", lot_number: "L-003", polygon_pct: square(40, 0), tier_key: null },
    ],
    tiers: { s: { label: "S", color: "#ffffff", price: 100, sellable: true } },
    units: {
      a: { number: "101", area_sqm: 1011.9, suspect: [] },
      b: { number: "102", area_sqm: 1011.9, suspect: [] },
    },
    actor: "tester",
    tenant: "t1",
    project: "p1",
  });
}

test("renumber keeps the stable id; publish still matches on id", () => {
  const s = demoState();
  const entry = renumberLot(s, { actor: "tester", id: "a", newNumber: "L-101" });
  assert.equal(entry.before, "L-001");
  assert.equal(entry.after, "L-101");
  assert.equal(s.lots.a.id, "a"); // id never moves
  assert.equal(s.lots.a.lot_number, "L-101");
  const plan = matchPublish(
    [{ id: "a", lot_number: "L-001", polygon: square(0, 0) }],
    [{ id: "a", lot_number: "L-101", polygon: square(0, 0), status: "confirmed" }],
  );
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.matched, [{ id: "a", changes: ["renumber L-001 -> L-101"] }]);
});

test("renumber rejects duplicate targets and unknown ids", () => {
  const s = demoState();
  assert.throws(() => renumberLot(s, { actor: "tester", id: "a", newNumber: "L-002" }), /already used/);
  assert.throws(() => renumberLot(s, { actor: "tester", id: "zzz", newNumber: "L-009" }), /unknown lot/);
  assert.throws(() => renumberLot(s, { actor: "", id: "a", newNumber: "L-009" }), /actor is required/);
});

test("publish refuses lots overlapping an existing parcel; shared edges pass", () => {
  // Strict overlap: draft square sits inside existing.
  const bad = matchPublish(
    [{ id: "e1", lot_number: "E-1", polygon: square(0, 0, 20) }],
    [{ id: "n1", lot_number: "N-1", polygon: square(5, 5), status: "suggested" }],
  );
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.conflicts, [{ draftId: "n1", existingId: "e1", kind: "overlap" }]);
  // Shared edge only: adjacent squares touch at x=10, no strict overlap.
  assert.equal(polygonsOverlap(square(0, 0), square(10, 0)), false);
  const edge = matchPublish(
    [{ id: "e1", lot_number: "E-1", polygon: square(0, 0) }],
    [{ id: "n1", lot_number: "N-1", polygon: square(10, 0), status: "suggested" }],
  );
  assert.equal(edge.ok, true);
  assert.deepEqual(edge.created, ["n1"]);
  // Disjoint: fine.
  assert.equal(polygonsOverlap(square(0, 0), square(50, 50)), false);
  // Vertex strictly inside: conflict.
  assert.equal(polygonsOverlap([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 20 }], square(9, 1, 2)), true);
});

test("draft concurrency: stale revision rejected, winner visible, loser retries", () => {
  const store = new DraftStore();
  store.create({ tenant: "t1", project: "p1", state: demoState(), actor: "alice" });
  const aView = store.load("t1", "p1", "t1");
  const bView = store.load("t1", "p1", "t1");
  assert.equal(aView.rev, 0);
  aView.state.lots.a.number = "111";
  const aSaved = store.save({ tenant: "t1", project: "p1", requesterTenant: "t1", baseRev: aView.rev, state: aView.state, actor: "alice" });
  assert.equal(aSaved.rev, 1);
  assert.equal(aSaved.updated_by, "alice");
  bView.state.lots.a.number = "222";
  assert.throws(
    () => store.save({ tenant: "t1", project: "p1", requesterTenant: "t1", baseRev: bView.rev, state: bView.state, actor: "bob" }),
    (e) => e instanceof StaleRevisionError && e.currentRev === 1,
  );
  // Loser reloads (sees alice's rev 1 value) and retries cleanly.
  const bFresh = store.load("t1", "p1", "t1");
  assert.equal(bFresh.state.lots.a.number, "111");
  bFresh.state.lots.b.number = "222";
  const bSaved = store.save({ tenant: "t1", project: "p1", requesterTenant: "t1", baseRev: bFresh.rev, state: bFresh.state, actor: "bob" });
  assert.equal(bSaved.rev, 2);
  assert.equal(bSaved.state.lots.a.number, "111");
  assert.equal(bSaved.state.lots.b.number, "222");
  // Anonymous saves rejected (server-session actor binding).
  assert.throws(
    () => store.save({ tenant: "t1", project: "p1", requesterTenant: "t1", baseRev: 2, state: bSaved.state, actor: " " }),
    /actor is required/,
  );
});

test("two tenants are isolated (reads and writes)", () => {
  const store = new DraftStore();
  store.create({ tenant: "t1", project: "p1", state: demoState(), actor: "alice" });
  assert.throws(() => store.load("t1", "p1", "t2"), TenantIsolationError);
  assert.throws(
    () => store.save({ tenant: "t1", project: "p1", requesterTenant: "t2", baseRev: 0, state: demoState(), actor: "mallory" }),
    TenantIsolationError,
  );
  assert.throws(
    () => store.publish({ tenant: "t1", project: "p1", requesterTenant: "t2", actor: "mallory", existing: [] }),
    TenantIsolationError,
  );
  // Same project slug under another tenant is a separate draft.
  const other = demoState();
  other.tenant = "t2";
  store.create({ tenant: "t2", project: "p1", state: other, actor: "bob" });
  assert.equal(store.load("t2", "p1", "t2").rev, 0);
  assert.equal(store.load("t1", "p1", "t1").rev, 0);
});

test("gate bypass refused; waivers with reason pass", () => {
  const store = new DraftStore();
  const s = demoState();
  s.stage = "correct";
  store.create({ tenant: "t1", project: "p1", state: s, actor: "alice" });
  // Uncertain lots (c has no unit) + duplicate-free but unreviewed -> blocked.
  assert.throws(() => store.publish({ tenant: "t1", project: "p1", requesterTenant: "t1", actor: "alice", existing: [] }), GateBypassError);
  // Waiver without reason is rejected at the model layer.
  assert.throws(() => lib.addWaiver(s, { actor: "alice", scope: "lot", target: "c", reason: "  " }), /reason is required/);
  // Direct stage skip is refused too.
  assert.throws(() => lib.advanceStage(s, "alice"), /gate bypass refused/);
  // Cover every uncertain lot with a reasoned waiver -> publish proceeds.
  const doc = store.load("t1", "p1", "t1");
  for (const id of ["a", "b", "c"]) {
    lib.addWaiver(doc.state, { actor: "alice", scope: "lot", target: id, reason: `reviewed on plan (${id})` });
  }
  store.save({ tenant: "t1", project: "p1", requesterTenant: "t1", baseRev: doc.rev, state: doc.state, actor: "alice" });
  const out = store.publish({ tenant: "t1", project: "p1", requesterTenant: "t1", actor: "alice", existing: [] });
  assert.equal(out.stage, "validate");
});

test("publish refuses on overlap even when gates pass", () => {
  const store = new DraftStore();
  const s = demoState();
  s.stage = "validate"; // gates for validate need drift inputs; use correct with waivers instead
  s.stage = "correct";
  for (const id of ["a", "b", "c"]) {
    lib.addWaiver(s, { actor: "alice", scope: "lot", target: id, reason: "ok" });
  }
  store.create({ tenant: "t1", project: "p1", state: s, actor: "alice" });
  assert.throws(
    () =>
      store.publish({
        tenant: "t1",
        project: "p1",
        requesterTenant: "t1",
        actor: "alice",
        existing: [{ id: "ext", lot_number: "EXT", polygon: square(15, -5, 20) }],
      }),
    (e) => e instanceof GateBypassError && /overlap/.test(e.message),
  );
});

test("re-run preserves confirmed/locked (model + store round-trip)", () => {
  const s = demoState();
  confirmLot(s, { actor: "alice", id: "a" });
  assert.equal(s.lots.a.status, LOT_STATUS.CONFIRMED);
  assert.deepEqual(s.lots.a.confirmed_by?.signals, ["detection", "human"]);
  assert.equal(s.lots.a.confirmed_by?.method, "manual");
  s.lots.b.status = LOT_STATUS.LOCKED;
  const { applied, skipped } = applyDetection(s, {
    actor: "rerun",
    detected: {
      a: { number: "999", area_sqm: 1 },
      b: { number: "888", area_sqm: 1 },
      c: { number: "103", area_sqm: 1000 },
    },
  });
  assert.equal(s.lots.a.number, "101");
  assert.equal(s.lots.b.number, "102");
  assert.equal(s.lots.c.number, "103");
  assert.deepEqual(skipped.map((x) => x.lot).sort(), ["a", "b"]);
  assert.ok(applied.includes("c"));
  // And through the store: save, reload, re-run still preserves.
  const store = new DraftStore();
  store.create({ tenant: "t1", project: "p1", state: s, actor: "alice" });
  const doc = store.load("t1", "p1", "t1");
  applyDetection(doc.state, { actor: "rerun", detected: { a: { number: "000", area_sqm: 0 } } });
  store.save({ tenant: "t1", project: "p1", requesterTenant: "t1", baseRev: doc.rev, state: doc.state, actor: "rerun" });
  assert.equal(store.load("t1", "p1", "t1").state.lots.a.number, "101");
});

test("two-signal rule + bulk-accept sample review", () => {
  const s = createInitialState({
    lots: Array.from({ length: 20 }, (_, i) => ({
      id: `l${i}`,
      lot_number: `L-${i}`,
      polygon_pct: square(i * 12, 0),
      tier_key: "s",
    })),
    tiers: { s: { label: "S", color: "#fff", price: 1, sellable: true } },
    units: Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`l${i}`, { number: String(200 + i), area_sqm: 1000 + i, suspect: [] }]),
    ),
    actor: "alice",
  });
  // Manual confirm without detection signal is refused.
  s.lots.l0.hasUnit = false;
  s.lots.l0.suspect = ["no-unit"];
  assert.throws(() => confirmLot(s, { actor: "alice", id: "l0" }), /two-signal rule/);
  s.lots.l0.hasUnit = true;
  s.lots.l0.suspect = [];
  confirmLot(s, { actor: "alice", id: "l0" });
  // Bulk flow: proposal excludes l0 (now confirmed); sample is deterministic.
  // Slice 1.6 rule: <20 qualifying lots -> sample is ALL of the proposal
  // (larger stratified >=20 flows live in bulk-accept-slice16.test.mjs).
  const { proposal, sample } = proposeBulkAccept(s, 7);
  assert.equal(proposal.length, 19);
  assert.deepEqual(proposeBulkAccept(s, 7).sample, sample); // seeded
  assert.deepEqual(sample, proposal);
  // Confirming the rest before the sample is refused.
  assert.throws(() => bulkConfirmRest(s, { actor: "alice", proposal, sample }), /not manually confirmed/);
  for (const id of sample) confirmLot(s, { actor: "alice", id });
  const rest = bulkConfirmRest(s, { actor: "alice", proposal, sample });
  assert.equal(rest.length, 0); // sample was all; nothing remains
  const marker = s.lots[sample[0]].confirmed_by;
  assert.equal(marker?.method, "manual");
});

test("undo reverts batches; log survives (pointer semantics)", () => {
  const s = demoState();
  applyEdit(s, { actor: "a", lot: "a", field: "number", before: "101", after: "111" });
  const n = s.log.length;
  const r = undoLast(s);
  assert.equal(r.length, 1);
  assert.equal(s.lots.a.number, "101");
  assert.equal(s.log.length, n); // log intact; pointer moved back
  assert.equal(s.pointer, n - 1);
});

test("~2,000-lot scale budgets", () => {
  const N = 2000;
  const t0 = Date.now();
  const s = createInitialState({
    lots: Array.from({ length: N }, (_, i) => ({
      id: `lot-${i}`,
      lot_number: `L-${i}`,
      polygon_pct: square((i % 50) * 20, Math.floor(i / 50) * 20),
      tier_key: i % 7 === 0 ? null : `t${i % 5}`,
    })),
    tiers: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`t${i}`, { label: `T${i}`, color: "#fff", price: i, sellable: true }])),
    units: Object.fromEntries(
      Array.from({ length: N }, (_, i) => [`lot-${i}`, { number: String(1000 + (i % 1900)), area_sqm: 1000, suspect: [] }]),
    ),
    actor: "scale",
  });
  const tInit = Date.now() - t0;
  const t1 = Date.now();
  const dups = lib.findDuplicates(s);
  const tDup = Date.now() - t1;
  const t2 = Date.now();
  const gaps = lib.findGaps(s);
  const tGap = Date.now() - t2;
  const t3 = Date.now();
  const legend = lib.buildLegend(s);
  const tLegend = Date.now() - t3;
  const t4 = Date.now();
  const { applied } = applyDetection(s, {
    actor: "rerun",
    detected: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`lot-${i}`, { number: `9${i}`, area_sqm: 1001 }])),
  });
  const tMerge = Date.now() - t4;
  const t5 = Date.now();
  const q = lib.uncertainQueue(s);
  const tQueue = Date.now() - t5;
  assert.equal(Object.keys(s.lots).length, N);
  assert.ok(Object.keys(dups).length > 0); // i%1900 over 2000 lots forces dupes
  assert.ok(gaps.length >= 0);
  assert.equal(legend.total, N);
  assert.equal(applied.length, 200);
  assert.equal(q.length, N);
  console.log(`scale budgets ms: init=${tInit} dups=${tDup} gaps=${tGap} legend=${tLegend} merge=${tMerge} queue=${tQueue}`);
  assert.ok(tInit < 5000, `init ${tInit}ms`);
  assert.ok(tDup < 2000, `dups ${tDup}ms`);
  assert.ok(tGap < 2000, `gaps ${tGap}ms`);
  assert.ok(tLegend < 1000, `legend ${tLegend}ms`);
  assert.ok(tMerge < 2000, `merge ${tMerge}ms`);
  assert.ok(tQueue < 2000, `queue ${tQueue}ms`);
});

test("gate evaluation surfaces waivable vs blocking failures", () => {
  const s = demoState();
  s.stage = "correct";
  const g0 = evaluateStageGate(s);
  assert.equal(g0.pass, false);
  assert.ok(g0.blocking.length > 0);
  assert.deepEqual(g0.waived, []);
  // Waive one lot; the rest still block.
  lib.addWaiver(s, { actor: "alice", scope: "lot", target: "c", reason: "checked" });
  const g1 = evaluateStageGate(s);
  assert.ok(!g1.blocking.some((f) => f.waivableAs?.scope === "lot" && f.waivableAs?.target === "c"));
});
