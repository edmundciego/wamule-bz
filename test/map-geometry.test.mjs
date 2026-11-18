import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const geometryUrl = new URL("../src/lib/mapGeometry.ts", import.meta.url);
const source = await readFile(geometryUrl, "utf8");
const javascript = ts.transpile(source, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 });
const geometry = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

test("shared geometry preserves image aspect and normalized-to-raster alignment", () => {
  const aspect = 5700 / 4800;
  const viewBoxHeight = geometry.mapViewBoxHeight(aspect);
  assert.ok(Math.abs(viewBoxHeight - 84.21052631578948) < 1e-9);
  assert.equal(geometry.mapPolygonToSvgPoints([{ x: 10, y: 25 }], { y: viewBoxHeight / 100 }), "10,21.05263157894737");
  assert.deepEqual(geometry.mapPolygonToRasterPixels([{ x: 50, y: 50 }], 5700, 4800), [{ x: 2850, y: 2400 }]);
  assert.deepEqual(geometry.mapPolygonBounds([{ x: 10, y: 20 }, { x: 40, y: 70 }], 2), {
    x: 10, y: 40, width: 30, height: 100,
  });
});

test("shared viewport clamps pan and formats the same map-space viewBox", () => {
  const pan = geometry.clampMapPan({ x: 90, y: -8 }, 2, 100, 80);
  assert.deepEqual(pan, { x: 50, y: 0 });
  const bounds = geometry.mapViewportBounds(pan, 2, 100, 80);
  assert.deepEqual(bounds, { x: 50, y: 0, width: 50, height: 40 });
  assert.equal(geometry.mapViewBoxString(bounds), "50 0 50 40");
});

test("zoom around a focal map coordinate keeps that coordinate stationary", () => {
  const nextPan = geometry.mapPanAfterZoom({ x: 0, y: 0 }, 1, 2, { x: 50, y: 40 }, 100, 80);
  assert.deepEqual(nextPan, { x: 25, y: 20 });
  const before = geometry.mapViewportBounds({ x: 0, y: 0 }, 1, 100, 80);
  const after = geometry.mapViewportBounds(nextPan, 2, 100, 80);
  assert.equal(geometry.clientPointToMapCoordinate(50, 40, { left: 0, top: 0, width: 100, height: 80 }, before, "none")?.x, 50);
  assert.equal(geometry.clientPointToMapCoordinate(50, 40, { left: 0, top: 0, width: 100, height: 80 }, after, "none")?.x, 50);
});

test("screen conversion handles xMidYMid meet letterboxing and stretched canvases", () => {
  const viewport = { x: 10, y: 5, width: 40, height: 20 };
  const rect = { left: 0, top: 0, width: 200, height: 200 };
  // meet uses a 5px-per-unit scale and vertically centers the 100px-high map.
  assert.deepEqual(geometry.clientPointToMapCoordinate(100, 50, rect, viewport), { x: 30, y: 5 });
  assert.deepEqual(geometry.clientPointToMapCoordinate(100, 100, rect, viewport), { x: 30, y: 15 });
  assert.deepEqual(geometry.clientPointToMapCoordinate(100, 100, rect, viewport, "none"), { x: 30, y: 15 });
  assert.equal(geometry.clientPointToMapCoordinate(100, 100, { ...rect, width: 0 }, viewport), null);
});

test("shared SVG primitives contain no buyer API or sales-state dependencies", async () => {
  const source = await readFile(new URL("../src/components/map/MapPolygon.tsx", import.meta.url), "utf8");
  assert.match(source, /mapPolygonToSvgPoints/);
  assert.match(source, /MapRasterLayer/);
  assert.doesNotMatch(source, /PublicLotParcel|ParcelStatus|inquir|supabase/i);
});
