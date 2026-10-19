import { useEffect, useRef, useState } from "react";
import { MapPackagePreview } from "../maps/MapPackagePreview";
import { PublicInquiryModal } from "./PublicInquiryModal";
import {
  packagePrice,
  publishedFeatureParcel,
  type PublishedMapPackage,
} from "../../lib/publishedMapPackage";
import type { PublicLotParcel } from "./PublicLotMap";

export function PublishedPackageMap({
  map,
  backgroundUrl,
  tenantSlug,
  projectSlug,
  phaseSlug,
  initialLotNumber,
  onSelectLot,
  onClearSelection,
  onToggleMapFeature,
  selectedMapFeatureRefs,
  showPrices,
  enableInquiry,
  localDemoOnly,
}: {
  map: PublishedMapPackage;
  backgroundUrl?: string | null;
  tenantSlug: string;
  projectSlug?: string;
  phaseSlug?: string;
  initialLotNumber?: string;
  onSelectLot?: (parcel: PublicLotParcel) => void;
  onClearSelection?: () => void;
  onToggleMapFeature?: (parcel: PublicLotParcel) => void;
  selectedMapFeatureRefs?: string[];
  showPrices: boolean;
  enableInquiry: boolean;
  localDemoOnly: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(
    () =>
      map.features.find((f) =>
        [f.map_feature_ref, f.plot_number, f.demo_label].includes(
          initialLotNumber ?? "",
        ),
      )?.map_feature_ref ?? null,
  );
  const [query, setQuery] = useState("");
  const [inquiry, setInquiry] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const feature = map.features.find((f) => f.map_feature_ref === selected);
  const features = map.features.filter((f) =>
    `${f.demo_label} ${f.plot_number ?? ""} ${f.category_label ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  useEffect(() => {
    function escape(e: KeyboardEvent) {
      if (e.key === "Escape") setExpanded(false);
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  function select(key: string) {
    setSelected(key);
    const index = map.features.findIndex((f) => f.map_feature_ref === key);
    if (index >= 0)
      onSelectLot?.(publishedFeatureParcel(map.features[index], index));
  }
  const model = {
    title: map.title,
    canvas: { ...map.canvas, background: null },
    categories: map.categories,
    plots: features.map((f) => ({
      key: f.map_feature_ref,
      number: f.plot_number || f.demo_label,
      kind: f.kind,
      polygon: f.map_polygon,
      original_polygon: f.map_polygon,
      source_polygon: null,
      source_layer: null,
      area_value: f.area_value,
      area_unit: f.area_unit,
      area_basis: "recorded" as const,
      dimensions: f.dimensions,
      category_key: f.category_key,
      price_cents: f.price_cents,
      currency: f.currency,
      price_basis: f.price_basis,
      reviewed: true,
      issues: [],
    })),
  };
  return (
    <div
      ref={container}
      className={`${expanded ? "fixed inset-0 z-50 overflow-auto bg-background p-4" : "min-h-0 min-w-0 flex-1 overflow-auto"} text-foreground`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div>
          <h2 className="font-semibold text-primary">{map.title}</h2>
          <p className="text-xs text-muted-foreground">
            {map.features.length} mapped outlines
          </p>
        </div>
        <button
          className="min-h-10 rounded-md border px-3 text-sm"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Close full screen" : "Full screen"}
        </button>
      </div>
      <div className="grid min-w-0 gap-4 p-3 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0">
          <label className="mb-3 grid gap-1 text-sm font-medium">
            Find a plot
            <input
              type="search"
              className="min-h-11 w-full rounded-md border bg-card px-3"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Plot number, reference or category"
            />
          </label>
          <MapPackagePreview
            map={model}
            selectedKey={selected}
            onSelect={select}
            backgroundUrl={backgroundUrl ?? undefined}
          />
          <label className="grid gap-1 text-sm">
            Choose a plot
            <select
              className="min-h-11 w-full rounded-md border bg-card px-2"
              value={selected ?? ""}
              onChange={(e) => select(e.target.value)}
            >
              <option value="">Select an outline…</option>
              {features.map((f) => (
                <option key={f.map_feature_ref} value={f.map_feature_ref}>
                  {f.plot_number ? `Plot ${f.plot_number}` : f.demo_label}
                  {f.category_label ? ` · ${f.category_label}` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <aside className="grid content-start gap-4">
          {feature ? (
            <section
              className="rounded-xl border bg-card p-4"
              role="region"
              aria-label={`Details for ${feature.plot_number || feature.demo_label}`}
            >
              <div className="mb-4 flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {feature.plot_number ? "Plot" : "Map reference"}
                  </p>
                  <h3 className="text-xl font-semibold text-primary">
                    {feature.plot_number || feature.demo_label}
                  </h3>
                </div>
                <button
                  className="min-h-10 min-w-10 rounded-md border"
                  aria-label="Close plot details"
                  onClick={() => {
                    setSelected(null);
                    onClearSelection?.();
                  }}
                >
                  ×
                </button>
              </div>
              <dl className="grid gap-3 text-sm">
                {feature.category_label && (
                  <div>
                    <dt className="text-muted-foreground">Category</dt>
                    <dd className="font-medium">{feature.category_label}</dd>
                  </div>
                )}
                {feature.area_value !== null && (
                  <div>
                    <dt className="text-muted-foreground">Area</dt>
                    <dd className="font-medium">
                      {new Intl.NumberFormat("en", {
                        maximumFractionDigits: 3,
                      }).format(feature.area_value)}{" "}
                      {feature.area_unit === "m2"
                        ? "m²"
                        : feature.area_unit === "ft2"
                          ? "ft²"
                          : "acres"}
                    </dd>
                  </div>
                )}
                {feature.dimensions && (
                  <div>
                    <dt className="text-muted-foreground">Dimensions</dt>
                    <dd>{feature.dimensions}</dd>
                  </div>
                )}
                {showPrices && (
                  <div>
                    <dt className="text-muted-foreground">Price</dt>
                    <dd className="font-semibold text-primary">
                      {packagePrice(
                        feature.price_cents,
                        feature.currency,
                        feature.price_basis,
                      )}
                    </dd>
                    {feature.price_cents !== null && !feature.currency && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Currency not specified.
                      </p>
                    )}
                  </div>
                )}
              </dl>
              <p className="mt-4 text-xs text-muted-foreground">
                Contact the team to confirm availability.
              </p>
              {feature.kind === "plot" && onToggleMapFeature && (
                <button
                  className="mt-4 min-h-11 w-full rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground"
                  aria-pressed={
                    selectedMapFeatureRefs?.includes(feature.map_feature_ref) ??
                    false
                  }
                  onClick={() =>
                    onToggleMapFeature(
                      publishedFeatureParcel(
                        feature,
                        map.features.indexOf(feature),
                      ),
                    )
                  }
                >
                  {selectedMapFeatureRefs?.includes(feature.map_feature_ref)
                    ? "Remove preference"
                    : "Add plot preference"}
                </button>
              )}
              {feature.kind === "plot" && enableInquiry && (
                <button
                  className="mt-3 min-h-11 w-full rounded-md border px-3 text-sm font-semibold text-primary"
                  onClick={() => setInquiry(true)}
                >
                  Ask about this plot
                </button>
              )}
            </section>
          ) : (
            <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
              Choose an outlined plot to view its details.
            </p>
          )}
          {map.categories.length > 0 && (
            <section className="rounded-xl border bg-card p-4">
              <h3 className="mb-3 text-sm font-semibold">
                Plot categories{showPrices ? " & prices" : ""}
              </h3>
              <ul className="grid gap-3">
                {map.categories.map((c) => (
                  <li key={c.key} className="flex items-start gap-2 text-sm">
                    <span
                      className="mt-1 h-3 w-3 shrink-0 rounded-sm border border-black/15"
                      style={{ background: c.color }}
                    />
                    <div>
                      <p className="font-medium">{c.label}</p>
                      {showPrices && (
                        <p className="text-xs text-muted-foreground">
                          {packagePrice(
                            c.price_cents,
                            c.currency,
                            c.price_basis,
                          )}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
      {inquiry && feature && (
        <PublicInquiryModal
          tenantSlug={tenantSlug}
          projectSlug={projectSlug}
          phaseSlug={phaseSlug}
          tenantName={map.title}
          mapFeatureRef={feature.map_feature_ref}
          lotNumber={feature.plot_number || feature.demo_label}
          localDemoOnly={localDemoOnly}
          onClose={() => setInquiry(false)}
        />
      )}
    </div>
  );
}
