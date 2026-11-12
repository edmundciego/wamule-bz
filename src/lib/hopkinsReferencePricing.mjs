/** Resolve source-plan reference pricing without treating it as inventory pricing. */
export function resolveHopkinsReferencePrice(tierKey, catalogue, { verifiedCorner = false } = {}) {
  const tiers = catalogue?.tiers && typeof catalogue.tiers === "object" ? catalogue.tiers : {};
  const tier = typeof tierKey === "string" ? tiers[tierKey] : null;
  if (!tier || typeof tier !== "object") {
    return {
      categoryKey: null,
      categoryLabel: "Unclassified",
      amount: null,
      basis: null,
      display: "Price on request",
      cornerPremiumApplied: false,
    };
  }

  const hasPrice = Object.prototype.hasOwnProperty.call(tier, "price")
    && typeof tier.price === "number"
    && Number.isFinite(tier.price);
  const premium = catalogue?.source_pricing?.corner_premium;
  const premiumCanApply = verifiedCorner
    && hasPrice
    && typeof premium === "number"
    && Number.isFinite(premium)
    && premium > 0;
  const amount = hasPrice ? tier.price + (premiumCanApply ? premium : 0) : null;
  const currency = typeof catalogue?.source_pricing?.currency_code === "string"
    ? catalogue.source_pricing.currency_code
    : "BZD";

  return {
    categoryKey: tierKey,
    categoryLabel: typeof tier.source_label === "string" ? tier.source_label : String(tier.label ?? tierKey),
    amount,
    basis: typeof tier.price_basis === "string" ? tier.price_basis : null,
    display: amount === null ? "Price on request" : `${currency} ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(amount)}`,
    cornerPremiumApplied: premiumCanApply,
  };
}

/**
 * A generated map label is never an official lot number. Only expose the
 * source printed number after the hosted publisher's source-image check.
 */
export function verifiedHopkinsPrintedNumber(provenance) {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return null;
  if (provenance.source_printed_lot_number_status !== "source-image-cross-checked") return null;
  const number = provenance.source_printed_lot_number_verified;
  return typeof number === "string" && /^\d{1,5}$/.test(number) ? number : null;
}
