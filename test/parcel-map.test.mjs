import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("parcel map hook models responsive percentage coordinates", async () => {
  const [hook, migration, databaseTypes] = await Promise.all([
    read("src/hooks/useParcelMap.ts"),
    read("supabase/migrations/20260915000000_multi_tenant_foundation.sql"),
    read("src/types/database.ts"),
  ]);
  assert.match(hook, /export interface MapPoint/);
  assert.match(hook, /x: number/);
  assert.match(hook, /y: number/);
  assert.match(hook, /normalizePixelToPercent/);
  assert.match(hook, /pixelX \/ imageWidth/);
  assert.match(hook, /pixelY \/ imageHeight/);
  assert.match(hook, /addPoint|moveVertex|removeVertex/);
  assert.match(migration, /map_polygon/);
  assert.match(databaseTypes, /map_polygon/);
});

test("parcel map canvas supports draw, edit, and select modes with status colors", async () => {
  const canvas = await read("src/components/admin/parcels/ParcelMapCanvas.tsx");
  assert.match(canvas, /Draw Mode|mode === "draw"/);
  assert.match(canvas, /Edit|mode === "edit"/);
  assert.match(canvas, /Select|mode === "view"/);
  assert.match(canvas, /#22c55e/);
  assert.match(canvas, /#f59e0b/);
  assert.match(canvas, /#ef4444/);
  assert.match(canvas, /Zoom in/);
  assert.match(canvas, /Zoom out/);
  assert.match(canvas, /Snap-to-grid/);
  assert.match(canvas, /Clear polygon/);
  assert.match(canvas, /Save polygon/);
  assert.match(canvas, /vectorEffect/);
});

test("parcel drawer saves tenant-scoped map boundaries", async () => {
  const [drawer, hook] = await Promise.all([
    read("src/components/admin/parcels/ParcelDrawer.tsx"),
    read("src/hooks/useParcelMap.ts"),
  ]);
  assert.match(drawer, /Map Boundary/);
  assert.match(drawer, /from\("parcels"\)/);
  assert.match(drawer, /map_polygon/);
  assert.match(drawer, /tenant_id/);
  assert.match(drawer, /useParcelMap/);
  assert.match(hook, /sanitizePolygon/);
});
