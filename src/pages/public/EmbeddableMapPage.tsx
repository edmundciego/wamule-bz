import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { cn } from "../../lib/utils";
import { money } from "../../lib/utils";
import type { ParcelStatus } from "../../types/database";
import { PublicInquiryModal } from "../../components/public/PublicInquiryModal";

interface EmbedParcel {
  id: number;
  lot_number: string;
  status: ParcelStatus;
  price: number;
  dimensions: string | null;
  map_polygon: Array<{ x: number; y: number }> | null;
}

interface EmbedPayload {
  tenant: { name: string; slug: string };
  masterplan_image_url: string | null;
  branding: { company_name: string; logo_url: string; short_description: string };
  parcels: EmbedParcel[];
}

type LotFilter = "all" | "available";

const STATUS_STYLE: Record<ParcelStatus, { fill: string; stroke: string }> = {
  Available: { fill: "#22c55e", stroke: "#15803d" },
  Reserved: { fill: "#f59e0b", stroke: "#b45309" },
  Sold: { fill: "#ef4444", stroke: "#b91c1c" },
};

function pointsAttr(polygon: Array<{ x: number; y: number }>): string {
  return polygon.map((p) => `${p.x},${p.y}`).join(" ");
}

export function EmbeddableMapPage() {
  const { tenant_slug = "" } = useParams<{ tenant_slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [payload, setPayload] = useState<EmbedPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [inquiryLot, setInquiryLot] = useState<EmbedParcel | null>(null);

  const filter: LotFilter = searchParams.get("filter") === "available" ? "available" : "all";
  const setFilter = (next: LotFilter) => {
    setSearchParams(next === "available" ? { filter: "available" } : {}, { replace: true });
  };

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "");
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
      if (!baseUrl || !anonKey) {
        setLoading(false);
        setError("Map service is not configured.");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `${baseUrl}/functions/v1/get-public-lots?tenant=${encodeURIComponent(tenant_slug)}`,
          { headers: { apikey: anonKey } },
        );
        const body = (await response.json().catch(() => ({}))) as Partial<EmbedPayload> & { error?: string };
        if (cancelled) return;
        if (!response.ok || body.error || !body.parcels) {
          throw new Error(body.error || `Map request failed (${response.status}).`);
        }
        setPayload(body as EmbedPayload);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Map request failed.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (tenant_slug) void load();
    else {
      setLoading(false);
      setError("Missing development identifier.");
    }
    return () => {
      cancelled = true;
    };
  }, [tenant_slug]);

  const visibleParcels = useMemo(() => {
    if (!payload) return [];
    return payload.parcels.filter((parcel) => filter === "all" || parcel.status === "Available");
  }, [payload, filter]);

  const focusLot = payload?.parcels.find((parcel) => parcel.id === (selectedId ?? hoveredId)) ?? null;

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-background" style={{ width: "100vw", height: "100vh" }}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
        <strong className="mr-auto truncate text-sm text-primary">
          {payload ? payload.branding.company_name || payload.tenant.name : "Lot availability"}
        </strong>
        <div className="flex overflow-hidden rounded-md border border-border" role="tablist" aria-label="Lot filter">
          {(["all", "available"] as LotFilter[]).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value)}
              className={cn(
                "px-3 py-1.5 text-xs font-semibold transition",
                filter === value ? "bg-primary text-white" : "bg-card text-muted-foreground hover:text-primary",
              )}
            >
              {value === "all" ? "All Lots" : "Available Only"}
            </button>
          ))}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 bg-muted">
        {loading ? (
          <div className="absolute inset-0 animate-pulse p-4" aria-label="Loading lot map">
            <div className="h-full w-full rounded-md bg-border/60" />
          </div>
        ) : null}
        {error && !loading ? (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div className="max-w-sm rounded-md border bg-card p-5">
              <p className="font-semibold text-primary">Map unavailable</p>
              <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            </div>
          </div>
        ) : null}
        {!loading && !error && payload ? (
          <>
            {payload.masterplan_image_url ? (
              <img
                src={payload.masterplan_image_url}
                alt={`${payload.tenant.name} site map`}
                className="absolute inset-0 h-full w-full object-contain"
                draggable={false}
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
                No site map image published yet.
              </div>
            )}
            <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full">
              {visibleParcels.map((parcel) => {
                const polygon = Array.isArray(parcel.map_polygon) ? parcel.map_polygon : [];
                if (polygon.length < 3) return null;
                const style = STATUS_STYLE[parcel.status] ?? STATUS_STYLE.Available;
                const focused = parcel.id === (selectedId ?? hoveredId);
                return (
                  <polygon
                    key={parcel.id}
                    points={pointsAttr(polygon)}
                    fill={style.fill}
                    fillOpacity={focused ? 0.55 : 0.35}
                    stroke={style.stroke}
                    strokeWidth={focused ? 0.7 : 0.4}
                    vectorEffect="non-scaling-stroke"
                    style={{ cursor: parcel.status === "Available" ? "pointer" : "default" }}
                    onMouseEnter={() => setHoveredId(parcel.id)}
                    onMouseLeave={() => setHoveredId((current) => (current === parcel.id ? null : current))}
                    onClick={() => {
                      setSelectedId(parcel.id);
                      if (parcel.status === "Available") setInquiryLot(parcel);
                    }}
                  >
                    <title>{`Lot ${parcel.lot_number} — ${parcel.status}`}</title>
                  </polygon>
                );
              })}
            </svg>
            {focusLot ? (
              <div className="absolute bottom-3 left-3 right-3 rounded-md border bg-card/95 p-3 text-sm shadow-lg sm:left-auto sm:right-3 sm:w-64">
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-primary">Lot {focusLot.lot_number}</strong>
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-semibold text-white"
                    style={{ backgroundColor: (STATUS_STYLE[focusLot.status] ?? STATUS_STYLE.Available).fill }}
                  >
                    {focusLot.status}
                  </span>
                </div>
                <p className="mt-1 text-muted-foreground">{focusLot.dimensions ?? "Size TBC"}</p>
                <p className="mt-1 font-semibold text-primary">{money(focusLot.price)}</p>
                {focusLot.status === "Available" ? (
                  <button
                    type="button"
                    onClick={() => setInquiryLot(focusLot)}
                    className="mt-2 w-full rounded-md bg-primary px-3 py-2 text-sm font-semibold text-white"
                  >
                    Inquire About Lot {focusLot.lot_number}
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {inquiryLot && payload ? (
        <PublicInquiryModal
          tenantSlug={payload.tenant.slug}
          tenantName={payload.branding.company_name || payload.tenant.name}
          lotId={inquiryLot.id}
          lotNumber={inquiryLot.lot_number}
          onClose={() => setInquiryLot(null)}
        />
      ) : null}
    </main>
  );
}
