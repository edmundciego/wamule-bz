export type HopkinsReferencePrice = {
  categoryKey: string | null;
  categoryLabel: string;
  amount: number | null;
  basis: string | null;
  display: string;
  cornerPremiumApplied: boolean;
};

export function hasHopkinsReferencePricing(map?: {
  map_experience_mode?: string | null;
  tenant?: { slug: string } | null;
  project?: { slug: string } | null;
} | null): boolean;

export function resolveHopkinsReferencePrice(
  tierKey: string | null | undefined,
  catalogue: unknown,
  options?: { verifiedCorner?: boolean },
): HopkinsReferencePrice;

export function verifiedHopkinsPrintedNumber(provenance: unknown): string | null;
