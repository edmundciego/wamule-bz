/**
 * Data adapters: canonical workspace shapes plus the shapes met in the
 * wild (Hopkins pipeline files, Supabase board rows). Lots without an
 * explicit stable id fall back to lot_number (demo fixtures only — app
 * data must carry the stable parcel id).
 */
import type { LotInput } from "./model.ts";
import type { DetectionUnit, MapPoint, TierDef } from "./types.ts";

interface RawLot {
  id?: string | number;
  lot_number?: string;
  polygon_pct?: MapPoint[];
  map_polygon?: MapPoint[];
  tier_key?: string | null;
}

export function adaptLots(raw: unknown): LotInput[] {
  if (!Array.isArray(raw)) return [];
  const out: LotInput[] = [];
  for (const l of raw as RawLot[]) {
    if (!l || typeof l !== "object") continue;
    const lotNumber = typeof l.lot_number === "string" ? l.lot_number : null;
    const poly = Array.isArray(l.polygon_pct) ? l.polygon_pct : Array.isArray(l.map_polygon) ? l.map_polygon : null;
    if (!lotNumber || !poly || poly.length < 3) continue;
    out.push({
      id: l.id != null ? String(l.id) : lotNumber,
      lot_number: lotNumber,
      polygon_pct: poly,
      tier_key: l.tier_key ?? null,
    });
  }
  return out;
}

export function adaptTiers(raw: unknown): { tenant: string; project: string; tiers: Record<string, TierDef> } {
  const out: { tenant: string; project: string; tiers: Record<string, TierDef> } = {
    tenant: "local",
    project: "default",
    tiers: {},
  };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.tenant === "string") out.tenant = r.tenant;
  if (typeof r.project === "string") out.project = r.project;
  // Supabase lot_tiers rows (array form).
  if (Array.isArray(r)) {
    for (const t of r as Array<Record<string, unknown>>) {
      const key = typeof t.tier_key === "string" ? t.tier_key : null;
      if (!key) continue;
      out.tiers[key] = {
        label: typeof t.label === "string" ? t.label : key,
        color: typeof t.color_hex === "string" ? t.color_hex : typeof t.color === "string" ? (t.color as string) : "#999999",
        price: typeof t.price_cents === "number" ? t.price_cents / 100 : Number(t.price ?? 0),
        sellable: t.sellable !== false && (t as { is_active?: boolean }).is_active !== false,
      };
    }
    return out;
  }
  const src = (r.tiers && typeof r.tiers === "object" ? r.tiers : {}) as Record<string, Record<string, unknown>>;
  for (const [key, t] of Object.entries(src)) {
    out.tiers[key] = {
      label: typeof t.label === "string" ? t.label : key,
      color:
        typeof t.color === "string"
          ? t.color
          : typeof t.legend === "string"
            ? t.legend
            : typeof t.color_hex === "string"
              ? (t.color_hex as string)
              : "#999999",
      price: typeof t.price_cents === "number" ? (t.price_cents as number) / 100 : Number(t.price ?? 0),
      sellable: t.sellable !== false,
    };
  }
  return out;
}

export function adaptUnits(raw: unknown): Record<string, DetectionUnit> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const src = (r.units && typeof r.units === "object" ? r.units : r.assembled_units ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const out: Record<string, DetectionUnit> = {};
  for (const [lot, u] of Object.entries(src ?? {})) {
    if (!u || typeof u !== "object") continue;
    out[lot] = {
      number: typeof u.number === "string" ? u.number : null,
      area_sqm: typeof u.area_sqm === "number" ? u.area_sqm : null,
      suspect: Array.isArray(u.suspect) ? (u.suspect as string[]) : [],
    };
  }
  return out;
}
