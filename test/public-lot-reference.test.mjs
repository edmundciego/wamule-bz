import assert from "node:assert/strict";
import test from "node:test";
import {
  assignPublicLotReferences,
  createPublicLotReference,
  parsePublicLotReference,
} from "../supabase/functions/_shared/public-lot-reference.ts";

test("public lot references are versioned, project-scoped, and round-trip printed lot numbers", () => {
  const reference = createPublicLotReference("phase-two", "Lot: 17 / B");
  assert.equal(typeof reference, "string");
  assert.deepEqual(parsePublicLotReference(reference), {
    projectSlug: "phase-two",
    lotNumber: "Lot: 17 / B",
  });
  assert.notEqual(reference, createPublicLotReference("main", "Lot: 17 / B"));
});

test("reference parser rejects malformed, oversized, and unsupported values", () => {
  for (const value of [null, 17, "", "plr2:main:17", "plr1:main", "plr1:main:%", `plr1:main:${"x".repeat(513)}`]) {
    assert.equal(parsePublicLotReference(value), null, String(value));
  }
  assert.equal(createPublicLotReference("../other", "17"), null);
  assert.equal(createPublicLotReference("main", " 17"), null);
});

test("ambiguous or projectless lot labels receive no public reference", () => {
  assert.deepEqual(assignPublicLotReferences("main", ["17", "17", null, "18"]), [null, null, null, "plr1:main:18"]);
  assert.deepEqual(assignPublicLotReferences(null, ["17", "18"]), [null, null]);
});
