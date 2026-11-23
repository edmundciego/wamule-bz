export type HopkinsReferencePrice = {
  categoryKey: string | null;
  categoryLabel: string;
  amount: number | null;
  basis: string | null;
  display: string;
  cornerPremiumApplied: boolean;
};

export function isHopkinsPublicProject(tenantSlug?: string, projectSlug?: string): boolean;

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

export function publicHopkinsPrintedNumber(feature: {
  source_printed_lot_number_candidate?: string | null;
  source_printed_lot_number_status?: string | null;
}): string | null;

export function hopkinsPriceUnit(basis: string | null): string | null;
