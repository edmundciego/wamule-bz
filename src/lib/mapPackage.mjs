// Portable contract shared by the independent Studio and the authenticated importer.
// No tenant IDs, API keys or business statuses belong in this file format.
export const MAP_PACKAGE_FORMAT = "wamule-map-package";
export const MAP_PACKAGE_VERSION = 1;
export const MAP_PACKAGE_MAX_BYTES = 24 * 1024 * 1024;
export const AREA_UNITS = ["m2", "ft2", "acres"];
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,79}$/;
const hashPattern = /^[a-f0-9]{64}$/;

function text(value, name, max = 160, nullable = false) {
  if (nullable && (value === null || value === undefined || value === ""))
    return null;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > max ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new Error(`${name} must be text, up to ${max} characters.`);
  return value.trim();
}
function number(value, name, min, max, nullable = false) {
  if (nullable && (value === null || value === undefined || value === ""))
    return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${name} is outside the allowed range.`);
  return value;
}
function currency(value) {
  const result = text(value, "Currency", 3, true);
  if (result && !/^[A-Z]{3}$/.test(result))
    throw new Error(
      "Use a three-letter currency code, or leave it unspecified.",
    );
  return result;
}
function cents(value, name) {
  const result = number(value, name, 0, 1e12, true);
  if (result !== null && !Number.isSafeInteger(result))
    throw new Error(`${name} must use whole cents.`);
  return result;
}
export function polygonArea(points) {
  return (
    Math.abs(
      points.reduce((sum, p, i) => {
        const q = points[(i + 1) % points.length];
        return sum + p.x * q.y - q.x * p.y;
      }, 0),
    ) / 2
  );
}
function pointInside(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
export function mapLabelAnchor(polygon, width, height) {
  const ys = polygon.map((p) => p.y),
    top = Math.min(...ys),
    bottom = Math.max(...ys);
  for (const fraction of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const y = top + (bottom - top) * fraction,
      xs = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length];
      if (a.y > y !== b.y > y)
        xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x = (xs[i] + xs[i + 1]) / 2;
      if (
        xs[i + 1] - xs[i] > width &&
        [-1, 1].every((dx) =>
          [-1, 1].every((dy) =>
            pointInside(
              { x: x + (dx * width) / 2, y: y + (dy * height) / 2 },
              polygon,
            ),
          ),
        )
      )
        return { x, y };
    }
  }
  return null;
}
function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
export function validateMapPolygon(value, name = "Boundary") {
  if (!Array.isArray(value) || value.length < 3 || value.length > 200)
    throw new Error(`${name} needs 3–200 vertices.`);
  const points = value.map((p) => ({
    x: number(p?.x, name, 0, 100),
    y: number(p?.y, name, 0, 100),
  }));
  if (new Set(points.map((p) => `${p.x},${p.y}`)).size !== points.length)
    throw new Error(`${name} contains duplicate vertices.`);
  if (polygonArea(points) < 0.000001) throw new Error(`${name} has zero area.`);
  for (let i = 0; i < points.length; i++)
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      const a = points[i],
        b = points[(i + 1) % points.length],
        c = points[j],
        d = points[(j + 1) % points.length];
      if (
        cross(a, b, c) * cross(a, b, d) < 0 &&
        cross(c, d, a) * cross(c, d, b) < 0
      )
        throw new Error(`${name} crosses itself.`);
    }
  return points;
}
export function validateMapPackage(raw) {
  if (
    new TextEncoder().encode(JSON.stringify(raw)).length > MAP_PACKAGE_MAX_BYTES
  )
    throw new Error(
      "The map package exceeds 24 MB. Simplify large boundaries or reduce the display image.",
    );
  if (
    !raw ||
    raw.format !== MAP_PACKAGE_FORMAT ||
    raw.version !== MAP_PACKAGE_VERSION
  )
    throw new Error("Choose a version 1 Wamule Map Studio package.");
  if (!uuid.test(raw.dataset_id ?? ""))
    throw new Error("The package needs a stable dataset UUID.");
  const revision = number(raw.revision, "Revision", 1, 1e6);
  if (!Number.isInteger(revision))
    throw new Error("Revision must be a whole number.");
  const source = raw.source ?? {};
  if (!hashPattern.test(source.sha256 ?? ""))
    throw new Error("The source checksum is missing.");
  if (!["dxf", "pdf", "image", "json"].includes(source.format))
    throw new Error("Unsupported source format.");
  if (!["m", "ft", "us-ft", "unknown"].includes(source.units))
    throw new Error("Unsupported drawing units.");
  const canvas = raw.canvas ?? {};
  const width = number(canvas.width, "Canvas width", 1, 1e7);
  const height = number(canvas.height, "Canvas height", 1, 1e7);
  if (width / height < 0.05 || width / height > 20)
    throw new Error("The canvas aspect ratio is unsupported.");
  let background = null;
  if (canvas.background) {
    const b = canvas.background;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(b.mime) ||
      !hashPattern.test(b.sha256 ?? "")
    )
      throw new Error("Invalid background image metadata.");
    if (
      typeof b.data_base64 !== "string" ||
      b.data_base64.length > 14 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(b.data_base64)
    )
      throw new Error(
        "The background must be an embedded PNG, JPEG or WebP under 10 MB.",
      );
    background = { mime: b.mime, sha256: b.sha256, data_base64: b.data_base64 };
  }
  if (!Array.isArray(raw.categories) || raw.categories.length > 100)
    throw new Error("At most 100 categories are supported.");
  const categories = raw.categories.map((c) => {
    if (
      !/^[a-z0-9_]{1,80}$/.test(c.key ?? "") ||
      !/^#[0-9a-f]{6}$/i.test(c.color ?? "")
    )
      throw new Error(
        "Category keys use lowercase letters, digits and underscores; colors use six-digit hex.",
      );
    return {
      key: c.key,
      label: text(c.label, "Category name", 100),
      color: c.color,
      price_cents: cents(c.price_cents, "Category price"),
      currency: currency(c.currency),
      price_basis: text(c.price_basis, "Price basis", 100, true),
    };
  });
  const categoryKeys = new Set(categories.map((c) => c.key));
  if (categoryKeys.size !== categories.length)
    throw new Error("Duplicate category keys.");
  if (!Array.isArray(raw.plots) || !raw.plots.length || raw.plots.length > 5000)
    throw new Error("The package needs 1–5,000 outlines.");
  const plots = raw.plots.map((p) => {
    if (!keyPattern.test(p.key ?? ""))
      throw new Error("Invalid stable plot key.");
    if (!["plot", "common_area", "amenity"].includes(p.kind))
      throw new Error(`Invalid type for ${p.key}.`);
    const area = number(p.area_value, "Area", 0.000001, 1e12, true);
    if (
      (area !== null && !AREA_UNITS.includes(p.area_unit)) ||
      (area === null && p.area_unit != null)
    )
      throw new Error(`Area and unit must be entered together for ${p.key}.`);
    const category = text(p.category_key, "Category key", 80, true);
    if (category && !categoryKeys.has(category))
      throw new Error(`Unknown category for ${p.key}.`);
    const original =
      Array.isArray(p.source_polygon) && p.source_polygon.length <= 2000
        ? p.source_polygon.map((v) => ({
            x: number(v?.x, "Source coordinate", -1e15, 1e15),
            y: number(v?.y, "Source coordinate", -1e15, 1e15),
          }))
        : null;
    return {
      key: p.key,
      number: text(p.number, "Plot number", 80, true),
      kind: p.kind,
      polygon: validateMapPolygon(p.polygon, `Boundary ${p.key}`),
      original_polygon: validateMapPolygon(
        p.original_polygon ?? p.polygon,
        `Original boundary ${p.key}`,
      ),
      source_polygon: original,
      source_layer: text(p.source_layer, "Source layer", 160, true),
      area_value: area,
      area_unit: area === null ? null : p.area_unit,
      area_basis: ["recorded", "cad-calculated"].includes(p.area_basis)
        ? p.area_basis
        : "unknown",
      dimensions: text(p.dimensions, "Dimensions", 160, true),
      category_key: category,
      price_cents: cents(p.price_cents, "Plot price"),
      currency: currency(p.currency),
      price_basis: text(p.price_basis, "Price basis", 100, true),
      reviewed: p.reviewed === true,
      issues: Array.isArray(p.issues)
        ? p.issues.slice(0, 30).map((s) => text(s, "Review note", 300))
        : [],
    };
  });
  if (new Set(plots.map((p) => p.key)).size !== plots.length)
    throw new Error("Duplicate stable plot keys.");
  const numbers = plots
    .filter((p) => p.number)
    .map((p) => p.number.toLowerCase());
  if (new Set(numbers).size !== numbers.length)
    throw new Error(
      "Two outlines use the same plot number. Resolve the match before exporting.",
    );
  return {
    format: MAP_PACKAGE_FORMAT,
    version: 1,
    dataset_id: raw.dataset_id.toLowerCase(),
    revision,
    title: text(raw.title, "Map title", 160),
    source: {
      name: text(source.name, "Source name", 200),
      format: source.format,
      sha256: source.sha256,
      units: source.units,
    },
    canvas: { width, height, background },
    categories,
    plots,
  };
}
export async function sha256Bytes(bytes) {
  return [
    ...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function backgroundBytes(pkg) {
  const raw = pkg.canvas.background?.data_base64;
  return raw ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)) : null;
}
export async function verifyMapPackageAsset(pkg) {
  const bytes = backgroundBytes(pkg);
  if (bytes && bytes.length > 10 * 1024 * 1024)
    throw new Error("The background exceeds 10 MB.");
  if (bytes && (await sha256Bytes(bytes)) !== pkg.canvas.background.sha256)
    throw new Error("The background checksum does not match the package.");
  return bytes;
}
export function mapPackageCore(pkg) {
  return {
    ...pkg,
    canvas: {
      ...pkg.canvas,
      background: pkg.canvas.background
        ? {
            mime: pkg.canvas.background.mime,
            sha256: pkg.canvas.background.sha256,
          }
        : null,
    },
  };
}
export function mapPackagePreview(pkg, existing = []) {
  const keys = new Set(existing.map((row) => row.feature_key));
  const incoming = new Set(
    pkg.plots.map((p) => `studio:${pkg.dataset_id}:${p.key}`),
  );
  return {
    total: pkg.plots.length,
    matched: [...incoming].filter((k) => keys.has(k)).length,
    newPlots: [...incoming].filter((k) => !keys.has(k)).length,
    retained: [...keys].filter((k) => !incoming.has(k)).length,
    unreviewed: pkg.plots.filter((p) => !p.reviewed).length,
  };
}
export function buildMapEmbed(baseUrl, scope, options = {}) {
  const base = new URL(baseUrl);
  if (
    !["https:", "http:"].includes(base.protocol) ||
    base.username ||
    base.password
  )
    throw new Error("Use the public map website address.");
  for (const name of ["tenantSlug", "projectSlug", "phaseSlug"])
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(scope[name] ?? ""))
      throw new Error("Select a tenant, project and phase first.");
  const url = new URL(
    `/embed/${scope.tenantSlug}/${scope.projectSlug}`,
    base.origin,
  );
  url.searchParams.set("phase", scope.phaseSlug);
  const height = [500, 700, 900].includes(options.height)
    ? options.height
    : 700;
  const escaped = url.href.replaceAll("&", "&amp;");
  return {
    url: url.href,
    html: `<iframe src="${escaped}" title="Interactive plot map" width="100%" height="${height}" style="border:0;border-radius:12px" loading="lazy" allow="fullscreen"></iframe>`,
  };
}

export function exportPlotCsv(pkg) {
  const headers = [
    "plot_key",
    "plot_number",
    "area_value",
    "area_unit",
    "category_key",
    "price",
    "currency",
    "price_basis",
    "dimensions",
  ];
  const rows = pkg.plots.map((plot) =>
    [
      plot.key,
      plot.number ?? "",
      plot.area_value ?? "",
      plot.area_unit ?? "",
      plot.category_key ?? "",
      plot.price_cents === null ? "" : plot.price_cents / 100,
      plot.currency ?? "",
      plot.price_basis ?? "",
      plot.dimensions ?? "",
    ]
      .map((value) => `"${String(value).replaceAll('"', '""')}"`)
      .join(","),
  );
  return [headers.join(","), ...rows].join("\n");
}

export function parseCsv(input) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') {
      if (quoted && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error("The CSV has an unclosed quote.");
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (!rows.length) throw new Error("The CSV is empty.");
  const headers = rows
    .shift()
    .map((s) => s.replace(/^\ufeff/, "").toLowerCase());
  if (new Set(headers).size !== headers.length)
    throw new Error("Duplicate CSV column names.");
  return rows.map((values, i) => {
    if (values.length !== headers.length)
      throw new Error(`CSV row ${i + 2} has a different number of columns.`);
    return Object.fromEntries(headers.map((h, index) => [h, values[index]]));
  });
}
export function mergePlotCsv(pkg, input) {
  const plots = pkg.plots.map((p) => ({ ...p }));
  const seen = new Set();
  for (const row of parseCsv(input)) {
    if (!row.plot_key && !row.plot_number)
      throw new Error("CSV rows need plot_key or plot_number.");
    const matches = plots.filter((p) =>
      row.plot_key ? p.key === row.plot_key : p.number === row.plot_number,
    );
    if (matches.length !== 1)
      throw new Error(
        `No unique outline matches ${row.plot_key || row.plot_number}.`,
      );
    const plot = matches[0];
    if (seen.has(plot.key)) throw new Error(`The CSV repeats ${plot.key}.`);
    seen.add(plot.key);
    for (const name of [
      "dimensions",
      "category_key",
      "currency",
      "price_basis",
      "area_unit",
    ])
      if (row[name]) plot[name] = row[name];
    if (row.plot_number) plot.number = row.plot_number;
    if (row.area_value) {
      plot.area_value = Number(row.area_value);
      plot.area_basis = "recorded";
    }
    if (row.price) {
      if (!/^\d+(\.\d{1,2})?$/.test(row.price))
        throw new Error(
          "CSV prices must be plain amounts with at most two decimal places.",
        );
      plot.price_cents = Math.round(Number(row.price) * 100);
    }
  }
  return validateMapPackage({ ...pkg, plots });
}
