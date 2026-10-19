import hopkinsTierSource from "../../map-input/hopkins.tiers.json";

export { hopkinsTierSource };
export type HopkinsTierKey = keyof typeof hopkinsTierSource.tiers;
export type HopkinsTier = (typeof hopkinsTierSource.tiers)[HopkinsTierKey];

export const HOPKINS_TIER_ORDER: HopkinsTierKey[] = ["standard", "premium", "boulevard", "creek", "orange", "purple", "red"];

export function hopkinsTier(key: string | null | undefined): HopkinsTier | null {
  if (!key || !Object.prototype.hasOwnProperty.call(hopkinsTierSource.tiers, key)) return null;
  return hopkinsTierSource.tiers[key as HopkinsTierKey];
}

export function hopkinsTierLabel(tier: HopkinsTier): string {
  return "source_label" in tier && typeof tier.source_label === "string" ? tier.source_label : tier.label;
}

export function sourcePrice(price: number): string {
  return `${hopkinsTierSource.source_pricing.currency_symbol}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(price)}`;
}
