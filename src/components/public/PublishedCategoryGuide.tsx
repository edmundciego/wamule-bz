import type { PackageCategory } from "../../lib/mapPackage.mjs";
import { packagePrice } from "../../lib/publishedMapPackage";

export function PublishedCategoryGuide({ categories, cards, showPrices = true }: { categories: PackageCategory[]; cards: boolean; showPrices?: boolean }) {
  return <section aria-label={showPrices ? "Plot categories and prices" : "Plot categories"}>
    <ul className={cards ? "grid min-w-0 gap-2 sm:grid-cols-2" : "grid gap-2"}>
      {categories.map(category => <li className="min-w-0 rounded-lg border border-primary/15 bg-primary-soft/45 p-3 text-sm" key={category.key}>
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border border-black/25" style={{ background: category.color }} aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="break-words font-semibold leading-5 text-primary">{category.label}</h3>
            {showPrices ? <p className="mt-1 break-words text-sm font-semibold tabular-nums text-foreground">{packagePrice(category.price_cents, category.currency, category.price_basis)}</p> : null}
          </div>
        </div>
      </li>)}
    </ul>
    {showPrices && categories.some(c => c.price_cents!==null && !c.currency) && <p className="mt-2 text-xs text-muted-foreground">Currency is not specified for prices marked $.</p>}
    <p className="mt-3 text-xs leading-5 text-muted-foreground">Contact the team to confirm plot availability and current terms.</p>
  </section>;
}
