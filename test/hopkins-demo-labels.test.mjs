import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/hopkinsDemoLabels.ts", import.meta.url), "utf8");
const javascript = ts.transpile(source, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 });
const labels = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

test("map labels use a consistent readable screen size when a lot can contain them", () => {
  const wideLotFont = labels.fitStandardMapLabelFontSize({ width: 80, height: 30 }, "D-048-01", 2);
  const tallNarrowLotFont = labels.fitStandardMapLabelFontSize({ width: 80, height: 50 }, "D-048-01", 2);
  assert.equal(wideLotFont, 6);
  assert.equal(tallNarrowLotFont, 6);
});

test("labels that do not fit wait for zoom instead of becoming tiny", () => {
  assert.equal(labels.fitStandardMapLabelFontSize({ width: 12, height: 8 }, "D-048-01", 1), null);
  assert.equal(labels.fitStandardMapLabelFontSize({ width: 12, height: 8 }, "D-048-01", 6), 12 / 6);
});

test("invalid map label measurements do not render", () => {
  assert.equal(labels.fitStandardMapLabelFontSize({ width: 0, height: 4 }, "D-001", 2), null);
  assert.equal(labels.fitStandardMapLabelFontSize({ width: 4, height: 4 }, "D-001", 0), null);
});
