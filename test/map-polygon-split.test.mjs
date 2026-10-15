import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/mapPolygonSplit.ts", import.meta.url), "utf8");
const javascript = ts.transpile(source, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 });
const split = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
const parent = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 10 }, { x: 0, y: 10 }];
const threeChildren = [
  [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 10 }, { x: 0, y: 10 }],
  [{ x: 4, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 10 }, { x: 4, y: 10 }],
  [{ x: 8, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 10 }, { x: 8, y: 10 }],
];

test("a manually traced three-lot division is valid and leaves no unassigned source area", () => {
  const result = split.validatePolygonSplit(parent, threeChildren);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.unassignedAreaPercent, 0);
});

test("manual split validation rejects crossings and self-intersections but flags outward corrections for explicit review", () => {
  const crossing = [[{ x: 1, y: 1 }, { x: 10, y: 1 }, { x: 1, y: 9 }, { x: 10, y: 9 }], threeChildren[1]];
  assert.equal(split.validatePolygonSplit(parent, crossing).valid, false);
  assert.match(split.validatePolygonShape(crossing[0]).join(" "), /crosses itself/);
  const outside = [...threeChildren.slice(0, 2), [{ x: 8, y: 0 }, { x: 13, y: 0 }, { x: 13, y: 10 }, { x: 8, y: 10 }]];
  const outwardCorrection = split.validatePolygonSplit(parent, outside);
  assert.equal(outwardCorrection.valid, true);
  assert.ok(outwardCorrection.warnings.some((warning) => /extends outside/.test(warning)));
});

test("manual split validation rejects overlaps and exposes unassigned area for explicit review", () => {
  const overlap = [threeChildren[0], [{ x: 3, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 10 }, { x: 3, y: 10 }], threeChildren[2]];
  assert.ok(split.validatePolygonSplit(parent, overlap).errors.some((error) => /overlap or cross/.test(error)));
  const gap = [threeChildren[0], [{ x: 4, y: 0 }, { x: 7.5, y: 0 }, { x: 7.5, y: 10 }, { x: 4, y: 10 }], threeChildren[2]];
  const gapResult = split.validatePolygonSplit(parent, gap);
  assert.equal(gapResult.valid, true);
  assert.ok(gapResult.unassignedAreaPercent > 4);
  assert.match(gapResult.warnings.join(" "), /not assigned to a traced child/);
});

test("boundary snapping uses only existing source/trace vertices", () => {
  assert.deepEqual(split.snapMapPoint({ x: 4.1, y: 4.1 }, [{ x: 4, y: 4 }], 0.2), { x: 4, y: 4 });
  assert.deepEqual(split.snapMapPoint({ x: 4.3, y: 4.3 }, [{ x: 4, y: 4 }], 0.2), { x: 4.3, y: 4.3 });
  assert.deepEqual(split.snapMapPointToEdges({ x: 6, y: 10.000002 }, [parent]), { x: 6, y: 10 });
});
