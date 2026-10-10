import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Slice 1.6 bypass test: the publish path MUST refuse when gates fail, even
// when the caller tries to skip them. Imports the edge-function's pure module
// (which itself imports the single canonical src/lib/correction module).
const publish = await import("../supabase/functions/publish-draft/publish.ts");
const lib = await import("../src/lib/correction/index.ts");

function square(x, y, s = 10) {
  return [
    { x, y },
    { x: x + s, y },
    { x: x + s, y: y + s },
    { x, y: y + s },
  ];
}

function blockedState() {
  const s = lib.createInitialState({
    lots: [
      { id: "a", lot_number: "L-001", polygon_pct: square(0, 0), tier_key: "s" },
      { id: "b", lot_number: "L-002", polygon_pct: square(20, 0), tier_key: "s" },
    ],
    tiers: { s: { label: "S", color: "#ffffff", price: 100, sellable: true } },
    units: {
      // b has no unit -> uncertain -> correct-stage gate blocks
      a: { number: "101", area_sqm: 1000, suspect: [] },
    },
    actor: "alice",
    tenant: "t1",
    project: "p1",
  });
  s.stage = "correct";
  return s;
}

test("publish refuses blocked gates (no bypass flag exists)", () => {
  const s = blockedState();
  assert.throws(
    () => publish.enforcePublish({ state: s, existing: [], actor: "alice" }),
    (e) => e instanceof publish.GateBypassError && /stage correct/.test(e.message),
  );
  // The pure module exposes no skip/force escape hatch.
  assert.equal(publish.enforcePublish.length, 1);
  assert.ok(!("skipGates" in publish.enforcePublish));
});

test("publish without gates: direct stage mutation is NOT a publish", () => {
  const s = blockedState();
  // Attacker sets stage directly, skipping evaluation — then calls publish.
  // enforcePublish re-evaluates from lots, so the manual stage value is
  // irrelevant: it still refuses (and would advance from the REAL stage).
  s.stage = "live";
  assert.throws(() => publish.enforcePublish({ state: s, existing: [], actor: "alice" }), publish.GateBypassError);
});

test("publish refuses overlap even when gates would pass", () => {
  const s = blockedState();
  // Waive the uncertain lot so gates pass; overlap must still refuse.
  lib.addWaiver(s, { actor: "alice", scope: "lot", target: "a", reason: "checked" });
  lib.addWaiver(s, { actor: "alice", scope: "lot", target: "b", reason: "checked" });
  assert.throws(
    () =>
      publish.enforcePublish({
        state: s,
        existing: [{ id: "ext", lot_number: "EXT", polygon: square(15, -5, 20) }],
        actor: "alice",
      }),
    (e) => e instanceof publish.GateBypassError && /overlap/.test(e.message),
  );
});

test("edge function imports the single canonical TS module (no fork)", () => {
  const pureSrc = readFileSync(new URL("../supabase/functions/publish-draft/publish.ts", import.meta.url), "utf8");
  const indexSrc = readFileSync(new URL("../supabase/functions/publish-draft/index.ts", import.meta.url), "utf8");
  // Pure module re-exports the canonical verdict, which lives INSIDE the
  // deploy packager root (slice 1.7 bundle check).
  assert.match(pureSrc, /from "\.\.\/_shared\/correction\/publish\.ts"/);
  assert.match(pureSrc, /enforcePublish/);
  // No forked re-implementation of the verdict logic.
  assert.doesNotMatch(pureSrc, /function enforcePublish/);
  assert.doesNotMatch(pureSrc, /function matchPublish/);
  assert.doesNotMatch(pureSrc, /function evaluateStageGate/);
  assert.doesNotMatch(pureSrc, /polygonsOverlap\(/);
  // Entry imports the pure module (chain preserves single implementation).
  assert.match(indexSrc, /from "\.\/publish\.ts"/);
  assert.match(indexSrc, /enforcePublish/);
});

test("src/lib/correction shims are pure re-exports (single implementation)", async () => {
  const { readdirSync } = await import("node:fs");
  const dir = new URL("../src/lib/correction/", import.meta.url);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts")) continue;
    const src = readFileSync(new URL(f, dir), "utf8");
    const lines = src.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"));
    assert.equal(lines.length, 1, `${f} must be a one-line re-export`);
    assert.match(lines[0], /^export \* from "\.\.\/\.\.\/\.\.\/supabase\/functions\/_shared\/correction\/.*\.ts";$/);
  }
  // Canonical logic lives under _shared (not in src).
  const canon = readFileSync(new URL("../supabase/functions/_shared/correction/publish.ts", import.meta.url), "utf8");
  assert.match(canon, /function enforcePublish/);
});

test("anonymous publish is rejected (actor binding)", () => {
  const s = blockedState();
  lib.addWaiver(s, { actor: "alice", scope: "lot", target: "a", reason: "checked" });
  lib.addWaiver(s, { actor: "alice", scope: "lot", target: "b", reason: "checked" });
  assert.throws(() => publish.enforcePublish({ state: s, existing: [], actor: "  " }), /actor is required/);
});

test("save cannot relabel stage (bypass via save refused)", () => {
  const store = new lib.DraftStore();
  const s = blockedState();
  store.create({ tenant: "t1", project: "p1", state: s, actor: "alice" });
  const doc = store.load("t1", "p1", "t1");
  doc.state.stage = "live";
  assert.throws(
    () => store.save({ tenant: "t1", project: "p1", requesterTenant: "t1", baseRev: doc.rev, state: doc.state, actor: "alice" }),
    lib.GateBypassError,
  );
});
