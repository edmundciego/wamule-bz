export type PackagePoint = { x: number; y: number };
export type PackageCategory = {
  key: string;
  label: string;
  color: string;
  price_cents: number | null;
  currency: string | null;
  price_basis: string | null;
};
export type PackagePlot = {
  key: string;
  number: string | null;
  kind: "plot" | "common_area" | "amenity";
  polygon: PackagePoint[];
  original_polygon: PackagePoint[];
  source_polygon: PackagePoint[] | null;
  source_layer: string | null;
  area_value: number | null;
  area_unit: "m2" | "ft2" | "acres" | null;
  area_basis: "recorded" | "cad-calculated" | "unknown";
  dimensions: string | null;
  category_key: string | null;
  price_cents: number | null;
  currency: string | null;
  price_basis: string | null;
  reviewed: boolean;
  issues: string[];
};
export type MapPackage = {
  format: "wamule-map-package";
  version: 1;
  dataset_id: string;
  revision: number;
  title: string;
  source: {
    name: string;
    format: "dxf" | "pdf" | "image" | "json";
    sha256: string;
    units: "m" | "ft" | "us-ft" | "unknown";
  };
  canvas: {
    width: number;
    height: number;
    background: { mime: string; sha256: string; data_base64: string } | null;
  };
  categories: PackageCategory[];
  plots: PackagePlot[];
};
export const MAP_PACKAGE_FORMAT: string;
export const MAP_PACKAGE_VERSION: number;
export const MAP_PACKAGE_MAX_BYTES: number;
export const AREA_UNITS: string[];
export function validateMapPackage(raw: unknown): MapPackage;
export function validateMapPolygon(raw: unknown, name?: string): PackagePoint[];
export function polygonArea(points: PackagePoint[]): number;
export function mapLabelAnchor(
  points: PackagePoint[],
  width: number,
  height: number,
): PackagePoint | null;
export function sha256Bytes(bytes: BufferSource): Promise<string>;
export function backgroundBytes(pkg: MapPackage): Uint8Array | null;
export function verifyMapPackageAsset(
  pkg: MapPackage,
): Promise<Uint8Array | null>;
export function mapPackageCore(pkg: MapPackage): unknown;
export function mapPackagePreview(
  pkg: MapPackage,
  existing?: { feature_key: string }[],
): {
  total: number;
  matched: number;
  newPlots: number;
  retained: number;
  unreviewed: number;
};
export function buildMapEmbed(
  baseUrl: string,
  scope: { tenantSlug: string; projectSlug: string; phaseSlug: string },
  options?: { height?: number },
): { url: string; html: string };
export function parseCsv(input: string): Record<string, string>[];
export function mergePlotCsv(pkg: MapPackage, input: string): MapPackage;
