import type { PublicLotParcel } from "../components/public/PublicLotMap";
import type { PackageCategory } from "./mapPackage.mjs";

export type PublishedPackageFeature = {
  map_feature_ref: string;
  demo_label: string;
  plot_number: string | null;
  map_polygon: { x: number; y: number }[];
  category_key: string | null;
  category_label: string | null;
  category_color: string | null;
  area_value: number | null;
  area_unit: "m2" | "ft2" | "acres" | null;
  dimensions: string | null;
  price_cents: number | null;
  currency: string | null;
  price_basis: string | null;
  kind: "plot" | "common_area" | "amenity";
};
export type PublishedMapPackage = {
  package_id: string;
  revision: number;
  title: string;
  canvas: { width: number; height: number };
  categories: PackageCategory[];
  features: PublishedPackageFeature[];
};
export function publishedFeatureParcel(
  feature: PublishedPackageFeature,
  index: number,
): PublicLotParcel {
  const area =
    feature.area_value === null
      ? null
      : feature.area_unit === "ft2"
        ? feature.area_value * 0.09290304
        : feature.area_unit === "acres"
          ? feature.area_value * 4046.8564224
          : feature.area_value;
  return {
    local_key: index + 1,
    public_ref: null,
    map_feature_ref: feature.map_feature_ref,
    is_demo_feature: true,
    is_studio_feature: true,
    demo_label: feature.demo_label,
    lot_number: feature.plot_number ?? "",
    status: "Demo",
    price: (feature.price_cents ?? 0) / 100,
    dimensions: feature.dimensions,
    area_sqm: area,
    map_polygon: feature.map_polygon,
    tier_key: feature.category_key,
    tier_label: feature.category_label,
    tier_color_hex: feature.category_color,
    is_corner: false,
    effective_price_cents: feature.price_cents ?? 0,
  };
}
export function packagePrice(
  priceCents: number | null,
  currency: string | null,
  basis: string | null,
) {
  if (priceCents === null) return "Price on request";
  const amount = currency
    ? new Intl.NumberFormat("en", {
        style: "currency",
        currency,
        currencyDisplay: "code",
        maximumFractionDigits: 2,
      }).format(priceCents / 100)
    : `$${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(priceCents / 100)}`;
  return `${amount}${basis ? ` · ${basis}` : ""}`;
}

export function packageStartingPrice(categories: PackageCategory[]) {
  const priced = categories.filter((c) => c.price_cents !== null);
  if (!priced.length) return "Contact the team";
  if (
    new Set(priced.map((c) => `${c.currency ?? ""}:${c.price_basis ?? ""}`))
      .size !== 1
  )
    return "See plot categories";
  const lowest = priced.reduce((a, b) =>
    a.price_cents! <= b.price_cents! ? a : b,
  );
  return packagePrice(lowest.price_cents, lowest.currency, lowest.price_basis);
}
