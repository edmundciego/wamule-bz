// Explicit buyer-facing projection; never spread a database/package object.
export function publicMapPackage(raw) {
  if (!raw) return null;
  const cleanText = (v, max = 160) =>
    typeof v === "string" && v.length <= max ? v : null;
  const finite = (v) =>
    v !== null && v !== undefined && Number.isFinite(Number(v))
      ? Number(v)
      : null;
  const price = (v) => {
    const n = finite(v);
    return n !== null && Number.isSafeInteger(n) && n >= 0 && n <= 1e12
      ? n
      : null;
  };
  const currency = (v) =>
    typeof v === "string" && /^[A-Z]{3}$/.test(v) ? v : null;
  const color = (v) =>
    typeof v === "string" && /^#[a-f0-9]{6}$/i.test(v) ? v : null;
  if (
    !Array.isArray(raw.features) ||
    !Array.isArray(raw.categories) ||
    !raw.canvas ||
    !(finite(raw.canvas.width) > 0) ||
    !(finite(raw.canvas.height) > 0)
  )
    throw new Error("Invalid published map package.");
  return {
    package_id: cleanText(raw.package_id, 36),
    revision: finite(raw.revision),
    title: cleanText(raw.title),
    canvas: {
      width: finite(raw.canvas.width),
      height: finite(raw.canvas.height),
    },
    categories: raw.categories.map((c) => ({
      key: cleanText(c.key, 80),
      label: cleanText(c.label, 100),
      color: color(c.color),
      price_cents: price(c.price_cents),
      currency: currency(c.currency),
      price_basis: cleanText(c.price_basis, 100),
    })),
    features: raw.features.map((f) => ({
      map_feature_ref: cleanText(f.map_feature_ref, 36),
      demo_label: cleanText(f.demo_label, 100),
      plot_number: cleanText(f.plot_number, 80),
      kind: ["common_area", "amenity"].includes(f.kind) ? f.kind : "plot",
      map_polygon: Array.isArray(f.map_polygon)
        ? f.map_polygon.map((p) => ({ x: finite(p.x), y: finite(p.y) }))
        : [],
      category_key: cleanText(f.category_key, 80),
      category_label: cleanText(f.category_label, 100),
      category_color: color(f.category_color),
      area_value: finite(f.area_value),
      area_unit: ["m2", "ft2", "acres"].includes(f.area_unit)
        ? f.area_unit
        : null,
      dimensions: cleanText(f.dimensions),
      price_cents: price(f.price_cents),
      currency: currency(f.currency),
      price_basis: cleanText(f.price_basis, 100),
    })),
  };
}
