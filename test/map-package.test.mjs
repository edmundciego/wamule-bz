import test from "node:test";
import assert from "node:assert/strict";
import {
  validateMapPackage,
  validateMapPolygon,
  mergePlotCsv,
  exportPlotCsv,
  buildMapEmbed,
  mapPackagePreview,
  verifyMapPackageAsset,
  sha256Bytes,
  mapLabelAnchor,
} from "../src/lib/mapPackage.mjs";
import { readMapWorkspaceRows } from "../src/lib/mapPackagePages.mjs";
import { publicMapPackage } from "../supabase/functions/get-public-lots/map-package-public.mjs";

function fixture() {
  return {
    format: "wamule-map-package",
    version: 1,
    dataset_id: "12345678-1234-4123-8123-123456789012",
    revision: 1,
    title: "Unit test plan",
    source: {
      name: "plan.dxf",
      format: "dxf",
      sha256: "a".repeat(64),
      units: "m",
    },
    canvas: { width: 1000, height: 700, background: null },
    categories: [
      {
        key: "standard",
        label: "Standard",
        color: "#abcd12",
        price_cents: null,
        currency: null,
        price_basis: null,
      },
    ],
    plots: [
      {
        key: "cad/A",
        number: "101",
        kind: "plot",
        polygon: [
          { x: 10, y: 10 },
          { x: 30, y: 10 },
          { x: 30, y: 50 },
          { x: 10, y: 50 },
        ],
        source_polygon: null,
        source_layer: "PLOTS",
        area_value: 150,
        area_unit: "m2",
        area_basis: "cad-calculated",
        dimensions: null,
        category_key: "standard",
        price_cents: null,
        currency: null,
        price_basis: null,
        reviewed: false,
        issues: [],
      },
    ],
  };
}
test("portable package excludes tenant assignment, business status and arbitrary fields", () => {
  const raw = fixture();
  raw.tenant_id = "another-tenant";
  raw.service_role_key = "never-copy";
  raw.plots[0].status = "Available";
  const result = validateMapPackage(raw);
  assert.equal(result.tenant_id, undefined);
  assert.equal(result.service_role_key, undefined);
  assert.equal(result.plots[0].status, undefined);
  assert.equal(result.plots[0].price_cents, null);
  assert.equal(result.plots[0].reviewed, false);
});
test("rejects duplicate IDs, duplicate numbers, zero area and crossed boundaries", () => {
  const raw = fixture();
  raw.plots.push({ ...raw.plots[0] });
  assert.throws(() => validateMapPackage(raw), /Duplicate/);
  raw.plots[1].key = "cad/B";
  assert.throws(() => validateMapPackage(raw), /same plot number/);
  assert.throws(
    () =>
      validateMapPolygon([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ]),
    /zero area/,
  );
  assert.throws(
    () =>
      validateMapPolygon([
        { x: 0, y: 0 },
        { x: 8, y: 9 },
        { x: 0, y: 8 },
        { x: 9, y: 0 },
      ]),
    /crosses itself/,
  );
});
test("real area needs an explicit unit and currency is never inferred", () => {
  const raw = fixture();
  raw.plots[0].area_unit = null;
  assert.throws(() => validateMapPackage(raw), /Area and unit/);
  raw.plots[0].area_unit = "m2";
  raw.categories[0].currency = "$";
  assert.throws(() => validateMapPackage(raw), /currency/i);
});
test("CSV joins by stable key, supports quoted values and fails without partial updates", () => {
  const pkg = validateMapPackage(fixture());
  const merged = mergePlotCsv(
    pkg,
    'plot_key,area_value,area_unit,price,currency,price_basis,dimensions\n"cad/A",160,m2,25000.50,BZD,"Per plot","10, 16 m"',
  );
  assert.equal(merged.plots[0].area_value, 160);
  assert.equal(merged.plots[0].price_cents, 2500050);
  assert.equal(merged.plots[0].dimensions, "10, 16 m");
  assert.throws(
    () => mergePlotCsv(pkg, "plot_key,price\ncad/A,200\nmissing,300"),
    /No unique outline/,
  );
  assert.equal(pkg.plots[0].price_cents, null);
  assert.throws(
    () => mergePlotCsv(pkg, "plot_key,price\ncad/A,200\ncad/A,300"),
    /repeats/,
  );
});
test("CSV export preserves plot-level price details on spreadsheet round trips", () => {
  const pkg = validateMapPackage(fixture());
  pkg.plots[0].price_cents = 250050;
  pkg.plots[0].currency = "BZD";
  pkg.plots[0].price_basis = "Per plot";
  pkg.plots[0].dimensions = '10, 16 m';
  const csv = exportPlotCsv(pkg);
  assert.match(csv, /2500\.5/);
  const restored = mergePlotCsv(pkg, csv).plots[0];
  assert.equal(restored.price_cents, 250050);
  assert.equal(restored.currency, "BZD");
  assert.equal(restored.price_basis, "Per plot");
  assert.equal(restored.dimensions, '10, 16 m');
});
test("embed includes exact tenant/project/phase and accepts an independent canonical host", () => {
  const embed = buildMapEmbed("https://maps.example.test/admin", {
    tenantSlug: "wamule",
    projectSlug: "main",
    phaseSlug: "phase-one",
  });
  assert.equal(
    embed.url,
    "https://maps.example.test/embed/wamule/main?phase=phase-one",
  );
  assert.match(embed.html, /title="Interactive plot map"/);
  assert.throws(
    () => buildMapEmbed("javascript:alert(1)", {}),
    /website address/,
  );
});
test("comparison matches stable dataset identities and retains omitted references", () => {
  const pkg = validateMapPackage(fixture());
  assert.deepEqual(
    mapPackagePreview(pkg, [
      { feature_key: `studio:${pkg.dataset_id}:cad/A` },
      { feature_key: "legacy/keep" },
    ]),
    { total: 1, matched: 1, newPlots: 0, retained: 1, unreviewed: 1 },
  );
});
test("tampered background bytes fail checksum verification", async () => {
  const pkg = fixture();
  const bytes = new Uint8Array([1, 2, 3]);
  pkg.canvas.background = {
    mime: "image/png",
    sha256: await sha256Bytes(bytes),
    data_base64: "AQID",
  };
  await verifyMapPackageAsset(validateMapPackage(pkg));
  pkg.canvas.background.sha256 = "b".repeat(64);
  await assert.rejects(
    () => verifyMapPackageAsset(validateMapPackage(pkg)),
    /checksum/,
  );
});
test("public projection strips source paths, notes, parcel IDs and backend metadata", () => {
  const result = publicMapPackage({
    package_id: "12345678-1234-4123-8123-123456789012",
    revision: 1,
    title: "Public plan",
    background_path: "private/source.dxf",
    source_polygon: [1, 2],
    canvas: { width: 100, height: 80 },
    categories: [],
    features: [
      {
        map_feature_ref: "12345678-1234-4123-8123-123456789012",
        demo_label: "Ref ABC",
        plot_number: null,
        map_polygon: [
          { x: 1, y: 1 },
          { x: 2, y: 1 },
          { x: 2, y: 2 },
        ],
        area_value: null,
        area_unit: null,
        price_cents: null,
        parcel_id: 99,
        review_notes: "private",
        created_by: "admin",
        source_key: "cad/A",
      },
    ],
  });
  const json = JSON.stringify(result);
  for (const secret of [
    "background_path",
    "source_polygon",
    "review_notes",
    "created_by",
    "parcel_id",
    "source_key",
  ])
    assert.ok(!json.includes(secret));
  assert.equal(result.features[0].price_cents, null);
});

test("display boundary edits retain original geometry and recorded area", () => {
  const initial = validateMapPackage(fixture());
  const changed = structuredClone(initial);
  changed.plots[0].polygon[0].x = 11;
  const result = validateMapPackage(changed);
  assert.equal(result.plots[0].polygon[0].x, 11);
  assert.equal(result.plots[0].original_polygon[0].x, 10);
  assert.equal(result.plots[0].area_value, 150);
});

test("label boxes fit inside concave plots or are withheld until zoom", () => {
  const lShape = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 3 },
    { x: 3, y: 3 },
    { x: 3, y: 10 },
    { x: 0, y: 10 },
  ];
  const point = mapLabelAnchor(lShape, 2, 1);
  assert.ok(point && (point.x < 3 || point.y < 3));
  assert.equal(mapLabelAnchor(lShape, 20, 20), null);
});

test("workspace reads follow actual page caps and refuse a changing comparison", async () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
  const starts = [];
  const result = await readMapWorkspaceRows(async (from) => {
    starts.push(from);
    return { data: rows.slice(from, from + 2), count: 5, error: null };
  });
  assert.deepEqual(starts, [0, 2, 4]);
  assert.deepEqual(result.data, rows);
  await assert.rejects(
    () =>
      readMapWorkspaceRows(async (from) => ({
        data: [{ id: from }],
        count: from ? 3 : 2,
        error: null,
      })),
    /changed/,
  );
});
