export type HopkinsReferencePrice = {
  categoryKey: string | null;
  categoryLabel: string;
  amount: number | null;
  basis: string | null;
  display: string;
  cornerPremiumApplied: boolean;
};

export function resolveHopkinsReferencePrice(
  tierKey: string | null | undefined,
  catalogue: unknown,
  options?: { verifiedCorner?: boolean },
): HopkinsReferencePrice;

export function verifiedHopkinsPrintedNumber(provenance: unknown): string | null;
