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
  assert.equal(wideLotFont, 6.5);
  assert.equal(tallNarrowLotFont, 6.5);
});

test("labels that do not fit wait for zoom instead of becoming tiny", () => {
  assert.equal(labels.fitStandardMapLabelFontSize({ width: 12, height: 8 }, "D-048-01", 1), null);
  assert.equal(labels.fitStandardMapLabelFontSize({ width: 12, height: 8 }, "D-048-01", 6), 13 / 6);
});

test("phone-scale Hopkins references keep Ref and its number together at readable size", () => {
  const screenPixelsPerMapUnit = 27.2;
  const fontSize = labels.layoutHopkinsSourceMapLabels([{
    local_key: 1,
    demo_label: "Plot 392",
    map_polygon: [
      { x: 10, y: 10 }, { x: 12.5, y: 10 },
      { x: 12.5, y: 11.15 }, { x: 10, y: 11.15 },
    ],
  }], {
    yScale: 1,
    screenPixelsPerMapUnit,
    selectedLocalKey: 1,
    zoom: 8,
    screenFontSize: 14,
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
  });
  assert.deepEqual(labels.hopkinsMapLabelLines("Ref 392"), ["Ref 392"]);
  assert.equal(labels.hopkinsMapLabelLines("119").join(" "), "119", "confirmed printed numbers remain on one line");
  assert.equal(fontSize.length, 1, "a selected plot with room for the reference should be labeled");
  assert.equal(fontSize[0].text, "Ref 392");
  assert.ok(fontSize[0].fontSize * screenPixelsPerMapUnit >= 13.99, "phone map text stays at a readable 14px target");
});

test("Zoom to plot can fit a phone reference inside a verified Hopkins outline", () => {
  const zoom = 16;
  const viewBoxHeight = 100 / (5700 / 4800);
  const mapScale = Math.min(270 / (100 / zoom), 227 / (viewBoxHeight / zoom));
  const labelsAtPhoneZoom = labels.layoutHopkinsSourceMapLabels([{
    local_key: 392,
    demo_label: "Plot 392",
    source_printed_lot_number_status: "no-unique-source-match",
    map_polygon: [
      { x: 53.15, y: 59.09 }, { x: 53.3, y: 58.08 },
      { x: 54.95, y: 58.43 }, { x: 54.75, y: 59.62 },
      { x: 53.15, y: 59.38 },
    ],
  }], {
    yScale: viewBoxHeight / 100,
    screenPixelsPerMapUnit: mapScale,
    selectedLocalKey: 392,
    zoom,
    screenFontSize: 14,
    viewBox: {
      x: 54.05 - 100 / zoom / 2,
      y: 49.43 - viewBoxHeight / zoom / 2,
      width: 100 / zoom,
      height: viewBoxHeight / zoom,
    },
  });

  assert.equal(labelsAtPhoneZoom.length, 1);
  assert.equal(labelsAtPhoneZoom[0].text, "Ref 392");
  assert.ok(labelsAtPhoneZoom[0].fontSize * mapScale >= 13.99);
});

test("selected phone reference remains visible when its narrow outline cannot place the 14px label", () => {
  const polygon = [
    { x: 53.15, y: 49.760000000000005 }, { x: 53.3, y: 48.90947368421053 },
    { x: 54.95, y: 49.20421052631579 }, { x: 54.75, y: 50.206315789473685 },
    { x: 53.15, y: 50.004210526315795 },
  ];
  const layout = (selectedLocalKey) => labels.layoutHopkinsSourceMapLabels([{
    local_key: 392,
    demo_label: "Plot 392",
    source_printed_lot_number_status: "no-unique-source-match",
    map_polygon: polygon,
  }], {
    yScale: 1,
    screenPixelsPerMapUnit: 37.7,
    selectedLocalKey,
    zoom: 16,
    screenFontSize: 14,
    viewBox: { x: 50, y: 46, width: 6.25, height: 4.75 },
  });

  assert.deepEqual(layout(null), [], "nonselected labels keep the normal 14px fit requirement");
  const selected = layout(392);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].text, "Ref 392");
  assert.ok(selected[0].fontSize * 37.7 >= 12.99, "selected map reference stays at the standard 13px size on a phone");
});

test("invalid map label measurements do not render", () => {
  assert.equal(labels.fitStandardMapLabelFontSize({ width: 0, height: 4 }, "D-001", 2), null);
  assert.equal(labels.fitStandardMapLabelFontSize({ width: 4, height: 4 }, "D-001", 0), null);
});

test("public Hopkins map ink uses only source-checked printed numbers", () => {
  assert.equal(labels.hopkinsPublicMapLabel({
    local_key: 1,
    demo_label: "Plot 392",
    source_printed_lot_number_candidate: "119",
    source_printed_lot_number_status: "source-image-cross-checked",
  }), "119");
  assert.equal(labels.hopkinsPublicMapLabel({
    local_key: 2,
    demo_label: "Plot 392",
    source_printed_lot_number_candidate: "119",
    source_printed_lot_number_status: "ocr-match-pending-human-review",
  }), "Ref 392");
  assert.equal(labels.hopkinsPublicMapLabel({ local_key: 3, demo_label: "Plot 393" }), "Ref 393");
  assert.equal(labels.hopkinsPublicMapLabel({ local_key: 4, demo_label: "not-a-reference" }), null);
  assert.equal(labels.publicMapReferenceLabel("Plot 119"), "Ref 119");
  assert.equal(labels.hopkinsMapReferenceInterval(1.5), Infinity);
  assert.equal(labels.hopkinsMapReferenceInterval(2.5), 16);
  assert.equal(labels.hopkinsMapReferenceInterval(3.5), 8);
  assert.equal(labels.hopkinsMapReferenceInterval(4.5), 4);
  assert.equal(labels.hopkinsMapReferenceInterval(5.5), 2);
  assert.equal(labels.hopkinsMapReferenceInterval(6), 1);
});

test("Hopkins labels reveal as zoom permits, fit inside outlines, and avoid overlaps", () => {
  const rectangle = (local_key, x, y, width, height, source = {}) => ({
    local_key,
    demo_label: `Plot ${String(local_key).padStart(3, "0")}`,
    map_polygon: [
      { x, y }, { x: x + width, y },
      { x: x + width, y: y + height }, { x, y: y + height },
    ],
    ...source,
  });
  const fixtures = [
    rectangle(16, 5, 5, 40, 20, { source_printed_lot_number_candidate: "151", source_printed_lot_number_status: "source-image-cross-checked" }),
    { ...rectangle(32, 50, 5, 40, 20), demo_label: "Plot 002" },
    rectangle(48, 5, 5, 40, 20),
  ];
  const hiddenAtOverview = labels.layoutHopkinsSourceMapLabels(fixtures.slice(0, 2), {
    yScale: 1, screenPixelsPerMapUnit: 2, zoom: 1, minimumZoom: 1.12,
  });
  assert.deepEqual(hiddenAtOverview, []);

  const shownAtZoom = labels.layoutHopkinsSourceMapLabels(fixtures, {
    yScale: 1, screenPixelsPerMapUnit: 2, zoom: 2, minimumZoom: 1.12,
  });
  assert.equal(shownAtZoom.length, 2, "overlapping outline fixture should suppress one colliding label");
  assert.equal(shownAtZoom[0].text, "151", "verified printed labels receive priority");
  assert.equal(shownAtZoom[1].text, "Ref 002");
  assert.ok(shownAtZoom.every((label) => label.x > 5 && label.x < 90 && label.y > 5 && label.y < 25));
  assert.ok(shownAtZoom[1].x < 70 && shownAtZoom[1].y < 15, "generated references prefer the quiet upper-left interior away from centered source text");
  const a = shownAtZoom[0];
  const b = shownAtZoom[1];
  const gapX = Math.abs(a.x - b.x) * 2;
  const maxTextWidth = Math.max(a.text.length, b.text.length) * Math.max(a.fontSize, b.fontSize) * 2 * 0.62 + 4;
  assert.ok(gapX >= maxTextWidth, "visible label boxes should not overlap horizontally");

  const currentView = labels.layoutHopkinsSourceMapLabels(fixtures.slice(0, 2), {
    yScale: 1, screenPixelsPerMapUnit: 2, zoom: 2, minimumZoom: 1.12,
    viewBox: { x: 49, y: 0, width: 50, height: 30 },
  });
  assert.deepEqual(currentView.map((label) => label.text), ["Ref 002"], "only labels fully within the current panned view should render");
});

test("interactive Hopkins map renders its vector label layer above the source and through map clicks", async () => {
  const sourceComponent = await readFile(new URL("../src/components/public/PublicLotMap.tsx", import.meta.url), "utf8");
  assert.match(sourceComponent, /const mapMaxZoom = isHopkinsHostedMap \? \(narrow \? 16 : MAX_ZOOM\) : MAX_ZOOM;/, "the high-resolution Hopkins plan can zoom far enough for phone labels");
  assert.match(sourceComponent, /<g aria-hidden="true" data-testid="hopkins-map-labels" pointerEvents="none">/);
  assert.match(sourceComponent, /data-map-label="true"/);
  assert.match(sourceComponent, /layoutHopkinsSourceMapLabels\(mapParcels/);
  assert.match(sourceComponent, /minimumZoom: 1\.12/);
  assert.doesNotMatch(sourceComponent, /ocr-match-pending-human-review"\s*&& parcel\.source_printed_lot_number_candidate[\s\S]{0,80}\? `\$\{parcel\.source_printed_lot_number_candidate\}\?`/);
});
