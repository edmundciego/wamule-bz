import { HOPKINS_TIER_ORDER, hopkinsTierSource, sourcePrice, type HopkinsTier } from "../../lib/hopkinsPlotCategoryData";

function CategoryCard({ tier }: { tier: HopkinsTier }) {
  return (
    <li className="min-w-0 rounded-lg border border-primary/15 bg-primary-soft/45 p-3 text-sm">
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border border-black/25"
          style={{ backgroundColor: tier.fill }}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <h3 className="break-words font-semibold leading-5 text-primary">{tier.label}</h3>
          {"source_label" in tier ? <p className="mt-0.5 text-xs leading-4 text-muted-foreground">Plan label: {tier.source_label}</p> : null}
          <p className="mt-1 break-words text-sm font-semibold tabular-nums text-foreground">
            {sourcePrice(tier.price)} <span className="font-normal text-muted-foreground">· {tier.price_basis}</span>
          </p>
        </div>
      </div>
    </li>
  );
}

function SourcePricingNotes({ compact = false }: { compact?: boolean }) {
  const notes = [
    hopkinsTierSource.source_pricing.currency_note,
    `Corner plots are marked +${sourcePrice(hopkinsTierSource.source_pricing.corner_premium)}.`,
    `Plan note: “${hopkinsTierSource.source_pricing.financing_source_note}”; terms are not stated.`,
  ];
  return (
    <ul className={`${compact ? "mt-3 border-t border-border pt-2" : "mt-3"} grid gap-1 text-xs leading-5 text-muted-foreground`} aria-label="Pricing notes from the Hopkins plan">
      {notes.map((note) => <li key={note}>{note}</li>)}
    </ul>
  );
}

/** Shared category catalogue for the Hopkins homepage, application map and map price guide. */
export function HopkinsPlotCategories({ variant = "legend" }: { variant?: "cards" | "legend" }) {
  const categories = HOPKINS_TIER_ORDER.map((key) => hopkinsTierSource.tiers[key]);

  if (variant === "cards") {
    return (
      <section data-testid="hopkins-plot-category-cards" aria-label="Plot categories and source prices">
        <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
          {categories.map((tier) => <CategoryCard key={tier.label} tier={tier} />)}
        </ul>
        <SourcePricingNotes />
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Category and price references follow the source plan. They do not confirm outline availability or allocate a parcel.
        </p>
      </section>
    );
  }

  return (
    <details className="rounded-lg border border-border bg-background" data-testid="hopkins-pricing-legend">
      <summary className="focus-ring min-h-11 cursor-pointer list-none px-3 py-2 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
        <span className="flex items-center justify-between gap-3">
          <span>Plot Categories &amp; Prices</span>
          <span aria-hidden="true" className="text-muted-foreground">⌄</span>
        </span>
      </summary>
      <div className="border-t border-border px-3 pb-3 pt-2" aria-label="Plot categories and prices from the original Hopkins plan">
        {(["Residential", "Commercial"] as const).map((group) => (
          <section key={group} className="mt-2 first:mt-0" aria-label={`${group} plot categories`}>
            <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{group}</h3>
            <ul className="mt-1 space-y-1.5">
              {categories.filter((tier) => tier.group === group).map((tier) => (
                <li key={tier.label} className="grid grid-cols-[0.75rem_minmax(0,1fr)_auto] items-start gap-1.5 text-xs leading-4 sm:gap-2">
                  <span className="mt-0.5 h-3 w-3 rounded-sm border border-black/20" style={{ backgroundColor: tier.fill }} aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block font-semibold text-foreground">{tier.label}</span>
                    {"source_label" in tier ? <span className="block text-muted-foreground">Plan label: {tier.source_label}</span> : null}
                    <span className="text-muted-foreground">{tier.price_basis}</span>
                  </span>
                  <span className="whitespace-nowrap text-right font-semibold tabular-nums text-foreground">{sourcePrice(tier.price)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <SourcePricingNotes compact />
      </div>
    </details>
  );
}
