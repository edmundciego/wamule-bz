import assert from "node:assert/strict";
import test from "node:test";
import { buildSyntheticPayload } from "../scripts/probe-production-map.mjs";

test("production performance fixture preserves only polygon geometry and anonymizes every business field", () => {
  const source = [
    {
      lot_number: "CONFIDENTIAL-LOT-71",
      tier_key: "private-tier",
      status: "Available",
      price: 72500,
      area_sqm: 650,
      confidence: 0.77,
      polygon_pct: [{ x: 1, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 8 }],
    },
    { lot_number: "NO-POLYGON", polygon_pct: [] },
  ];
  const { payload, renderedVertices } = buildSyntheticPayload(source, "http://127.0.0.1:4567");
  const parcel = payload.parcels[0];

  assert.equal(payload.parcels.length, 1);
  assert.equal(renderedVertices, 3);
  assert.equal(parcel.lot_number, "P-0001");
  assert.equal(parcel.status, "Sold");
  assert.equal(parcel.price, 0);
  assert.equal(parcel.area_sqm, null);
  assert.equal(parcel.tier_key, "synthetic-probe");
  assert.equal(parcel.public_ref, null);
  assert.deepEqual(parcel.map_polygon, source[0].polygon_pct);
  const serialized = JSON.stringify(payload);
  for (const privateValue of ["CONFIDENTIAL-LOT-71", "NO-POLYGON", "private-tier", "confidence", "72500", "650"]) {
    assert.equal(serialized.includes(privateValue), false, `${privateValue} must not be included in the wire fixture`);
  }
});

test("production performance fixture rejects malformed or out-of-range geometry", () => {
  assert.throws(
    () => buildSyntheticPayload([{ polygon_pct: [{ x: Number.NaN, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 8 }] }], "http://127.0.0.1"),
    /non-finite polygon coordinate/,
  );
  assert.throws(
    () => buildSyntheticPayload([{ polygon_pct: [{ x: 101, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 8 }] }], "http://127.0.0.1"),
    /outside 0–100% space/,
  );
});
