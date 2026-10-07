import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { money } from "../../lib/utils";
import type { ParcelStatus } from "../../types/database";
import { PublicInquiryModal } from "./PublicInquiryModal";

export interface PublicLotParcel {
  id: number;
  lot_number: string;
  status: ParcelStatus;
  price: number;
  dimensions: string | null;
  map_polygon: Array<{ x: number; y: number }> | null;
  tier_key: string | null;
  tier_label: string | null;
  tier_color_hex: string | null;
  is_corner: boolean;
  effective_price_cents: number;
}

interface MapPayload {
  tenant: { name: string; slug: string };
  masterplan_image_url: string | null;
  branding: { company_name: string; logo_url: string; short_description: string };
  parcels: PublicLotParcel[];
}

export type PublicLotFilter = "all" | "available";
export type PublicLotColourView = "status" | "tier";

interface PublicLotMapProps {
  tenantSlug: string;
  /** Controlled highlight in pick mode. Omit for unmanaged inquiry highlighting. */
  selectedIds?: number[];
  /** Pick mode: clicking an Available lot toggles it. Absent = inquiry mode. */
  onToggleLot?: (parcel: PublicLotParcel) => void;
  showPrices?: boolean;
  /** Inquiry mode: clicking an Available lot opens the inquiry modal. */
  enableInquiry?: boolean;
  initialFilter?: PublicLotFilter;
  initialView?: PublicLotColourView;
  /** Deep link: select this lot number once parcels arrive. */
  initialLotNumber?: string;
  onSelectLot?: (parcel: PublicLotParcel) => void;
  onParcelsLoaded?: (parcels: PublicLotParcel[]) => void;
  /**
   * Local preview mode (never used in production): loads lots.json +
   * tiers.json from a static base path and the sibling
   * masterplan_background.webp instead of calling get-public-lots.
   */
  demoDataUrl?: string;
}

const STATUS_STYLE: Record<ParcelStatus, { fill: string; stroke: string }> = {
  Available: { fill: "#22c55e", stroke: "#15803d" },
  Reserved: { fill: "#f59e0b", stroke: "#b45309" },
  Sold: { fill: "#ef4444", stroke: "#b91c1c" },
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

/** Transparent pointer padding (px, non-scaling) so small lots stay tappable. */
const HIT_STROKE_PX = 14;

type FullscreenHostElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

function requestContainerFullscreen(element: HTMLElement): Promise<void> {
  const host = element as FullscreenHostElement;
  const request = host.requestFullscreen?.bind(host) ?? host.webkitRequestFullscreen?.bind(host);
  if (!request) return Promise.reject(new Error("Fullscreen API unavailable."));
  try {
    const outcome = request();
    return outcome instanceof Promise ? outcome : Promise.resolve();
  } catch (requestError) {
    return Promise.reject(requestError instanceof Error ? requestError : new Error("Fullscreen request failed."));
  }
}

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

function currentFullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function exitActiveFullscreen(): Promise<void> {
  if (!currentFullscreenElement()) return Promise.resolve();
  const doc = document as FullscreenDocument;
  const exit = doc.exitFullscreen?.bind(doc) ?? doc.webkitExitFullscreen?.bind(doc);
  if (!exit) return Promise.resolve();
  try {
    const outcome = exit();
    return outcome instanceof Promise ? outcome : Promise.resolve();
  } catch (exitError) {
    return Promise.reject(exitError instanceof Error ? exitError : new Error("Fullscreen exit failed."));
  }
}

function pointsAttr(polygon: Array<{ x: number; y: number }>, yScale = 1): string {
  return polygon.map((p) => `${p.x},${p.y * yScale}`).join(" ");
}

function fillFor(parcel: PublicLotParcel, view: PublicLotColourView): { fill: string; stroke: string } {
  if (view === "tier" && parcel.tier_color_hex) {
    return { fill: parcel.tier_color_hex, stroke: parcel.tier_color_hex };
  }
  return STATUS_STYLE[parcel.status] ?? STATUS_STYLE.Available;
}

export function PublicLotMap({
  tenantSlug,
  selectedIds,
  onToggleLot,
  showPrices = true,
  enableInquiry = false,
  initialFilter = "all",
  initialView = "status",
  initialLotNumber,
  onSelectLot,
  onParcelsLoaded,
  demoDataUrl,
}: PublicLotMapProps) {
  const pickMode = typeof onToggleLot === "function";
  const [payload, setPayload] = useState<MapPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [internalSelectedId, setInternalSelectedId] = useState<number | null>(null);
  const [inquiryLot, setInquiryLot] = useState<PublicLotParcel | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [query, setQuery] = useState("");
  // Measured masterplan aspect (width/height). A square viewBox would
  // letterbox differently from the object-contain image and drift polygons
  // off their lots, so the viewBox height tracks the real image ratio.
  const [imageAspect, setImageAspect] = useState<number | null>(null);
  const [disabledTiers, setDisabledTiers] = useState<string[]>([]);
  const [filter, setFilter] = useState<PublicLotFilter>(initialFilter);
  const [colourView, setColourView] = useState<PublicLotColourView>(initialView);
  // Fullscreen: native API first, CSS pseudo-fullscreen fallback (locked body
  // scroll, manual Esc). All pick state lives above, so toggling never
  // unmounts content and selection/search/filters/zoom survive intact.
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);
  const [chipsOpen, setChipsOpen] = useState<boolean>(() =>
    typeof window === "undefined" ? true : window.innerWidth >= 640,
  );
  const [toast, setToast] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const wasExpandedRef = useRef(false);
  const pseudoRef = useRef(false);
  const previousOverflowRef = useRef("");
  const expanded = nativeFullscreen || pseudoFullscreen;

  const enterFullscreen = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    requestContainerFullscreen(element).catch(() => {
      // iPhone Safari / permission-less iframes: fall back to CSS.
      pseudoRef.current = true;
      setPseudoFullscreen(true);
    });
  }, []);

  const exitFullscreen = useCallback(() => {
    if (currentFullscreenElement()) {
      void exitActiveFullscreen()
        .catch(() => undefined)
        .finally(() => {
          pseudoRef.current = false;
          setPseudoFullscreen(false);
        });
      return;
    }
    pseudoRef.current = false;
    setPseudoFullscreen(false);
  }, []);

  // Keep component state glued to reality: browser-owned exits (Esc, device
  // UI) arrive via fullscreenchange; pseudo mode needs a manual Esc handler.
  // The vector map re-fits itself, so resize only needs a state sync tick.
  useEffect(() => {
    function sync() {
      const active = currentFullscreenElement() === containerRef.current;
      setNativeFullscreen(active);
      if (!currentFullscreenElement()) {
        pseudoRef.current = false;
        setPseudoFullscreen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && pseudoRef.current) {
        pseudoRef.current = false;
        setPseudoFullscreen(false);
      }
    }
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", sync);
    };
  }, []);

  // Enter: focus Close, lock body scroll (pseudo only). Exit: restore scroll,
  // return focus to the toggle. Skipped on first mount (never expanded).
  useEffect(() => {
    if (!expanded) {
      if (!wasExpandedRef.current) return;
      wasExpandedRef.current = false;
      document.body.style.overflow = previousOverflowRef.current;
      previousOverflowRef.current = "";
      toggleRef.current?.focus({ preventScroll: true });
      return;
    }
    wasExpandedRef.current = true;
    closeRef.current?.focus({ preventScroll: true });
    if (pseudoFullscreen) {
      previousOverflowRef.current = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.body.style.overflow = previousOverflowRef.current;
      previousOverflowRef.current = "";
    };
  }, [expanded, pseudoFullscreen]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    async function loadDemo(base: string) {
      setLoading(true);
      setError(null);
      try {
        const [lotsRes, tiersRes] = await Promise.all([
          fetch(`${base}/lots.json`),
          fetch(`${base}/tiers.json`),
        ]);
        if (!lotsRes.ok || !tiersRes.ok) throw new Error("Demo map files not found.");
        const lots = (await lotsRes.json()) as Array<{
          lot_number: string;
          tier_key: string;
          price: number;
          polygon_pct: Array<{ x: number; y: number }>;
        }>;
        const tiersRaw = (await tiersRes.json()) as { tiers?: Record<string, { label: string; price: number; legend: string }> };
        const tiers = tiersRaw.tiers ?? {};
        const parcels: PublicLotParcel[] = lots.map((lot, index) => ({
          id: 100000 + index,
          lot_number: lot.lot_number,
          status: "Available",
          price: Number(lot.price),
          dimensions: null,
          map_polygon: lot.polygon_pct,
          tier_key: lot.tier_key,
          tier_label: tiers[lot.tier_key]?.label ?? lot.tier_key,
          tier_color_hex: tiers[lot.tier_key]?.legend ?? "#999999",
          is_corner: false,
          effective_price_cents: Math.round(Number(lot.price) * 100),
        }));
        if (cancelled) return;
        setPayload({
          tenant: { name: "Hopkins Grove (preview)", slug: "demo" },
          masterplan_image_url: `${base}/masterplan_background.webp`,
          branding: { company_name: "Hopkins Grove (preview)", logo_url: "", short_description: "" },
          parcels,
        });
        onParcelsLoaded?.(parcels);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Demo map failed to load.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
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
          `${baseUrl}/functions/v1/get-public-lots?tenant=${encodeURIComponent(tenantSlug)}`,
          { headers: { apikey: anonKey } },
        );
        const body = (await response.json().catch(() => ({}))) as Partial<MapPayload> & { error?: string };
        if (cancelled) return;
        if (!response.ok || body.error || !body.parcels) {
          throw new Error(body.error || `Map request failed (${response.status}).`);
        }
        setPayload(body as MapPayload);
        onParcelsLoaded?.((body as MapPayload).parcels);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Map request failed.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (demoDataUrl) {
      void loadDemo(demoDataUrl);
      return () => {
        cancelled = true;
      };
    }
    if (tenantSlug) void load();
    else {
      setLoading(false);
      setError("Missing development identifier.");
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantSlug, demoDataUrl]);

  const tierOptions = useMemo(() => {
    const byKey = new Map<string, { label: string; color: string }>();
    for (const parcel of payload?.parcels ?? []) {
      if (parcel.tier_key && !byKey.has(parcel.tier_key)) {
        byKey.set(parcel.tier_key, {
          label: parcel.tier_label ?? parcel.tier_key,
          color: parcel.tier_color_hex ?? "#999999",
        });
      }
    }
    return [...byKey.entries()];
  }, [payload]);

  const visibleParcels = useMemo(() => {
    if (!payload) return [];
    const needle = query.trim().toLowerCase();
    return payload.parcels.filter((parcel) => {
      if (filter === "available" && parcel.status !== "Available") return false;
      if (parcel.tier_key && disabledTiers.includes(parcel.tier_key)) return false;
      if (needle) {
        const haystack = `${parcel.lot_number} ${(parcel.tier_label ?? parcel.tier_key ?? "")} ${parcel.status}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [payload, filter, disabledTiers, query]);

  // Deep link: select the matching lot once parcels arrive.
  useEffect(() => {
    const target = (initialLotNumber ?? "").trim().toLowerCase();
    if (!target || !payload) return;
    const hit = payload.parcels.find((parcel) => parcel.lot_number.toLowerCase() === target);
    if (hit) {
      setInternalSelectedId(hit.id);
      onSelectLot?.(hit);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  const highlighted = selectedIds ?? (internalSelectedId !== null ? [internalSelectedId] : []);
  const focusLot = payload?.parcels.find((parcel) => parcel.id === (hoveredId ?? highlighted[0])) ?? null;

  const viewBoxH = imageAspect ? 100 / imageAspect : 100;
  const yScale = viewBoxH / 100;
  const viewBox = useMemo(() => {
    const w = 100 / zoom;
    const h = viewBoxH / zoom;
    return `0 0 ${w} ${h}`;
  }, [zoom, viewBoxH]);

  function handleParcelClick(parcel: PublicLotParcel) {
    setInternalSelectedId(parcel.id);
    onSelectLot?.(parcel);
    if (pickMode) {
      if (parcel.status === "Available") onToggleLot(parcel);
      return;
    }
    if (parcel.status === "Available" && enableInquiry) setInquiryLot(parcel);
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden bg-background motion-reduce:[&_button]:transition-none motion-reduce:[&_polygon]:transition-none",
        expanded && "h-[100dvh] w-screen",
        pseudoFullscreen && "fixed inset-0 z-[100]",
      )}
      style={
        pseudoFullscreen
          ? {
              paddingTop: "env(safe-area-inset-top)",
              paddingBottom: "env(safe-area-inset-bottom)",
              paddingLeft: "env(safe-area-inset-left)",
              paddingRight: "env(safe-area-inset-right)",
            }
          : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
        <strong className="mr-auto truncate text-sm text-primary">
          {payload ? payload.branding.company_name || payload.tenant.name : "Lot availability"}
        </strong>
        {demoDataUrl ? (
          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-semibold text-warning">
            Preview data
          </span>
        ) : null}
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search lot, tier, status"
          aria-label="Search lots"
          className="h-8 w-44 rounded-md border border-border bg-background px-2 text-xs"
        />
        <div className="flex overflow-hidden rounded-md border border-border" role="tablist" aria-label="Colour view">
          {(["status", "tier"] as PublicLotColourView[]).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={colourView === value}
              onClick={() => setColourView(value)}
              className={cn(
                "px-3 py-1.5 text-xs font-semibold capitalize transition",
                colourView === value ? "bg-primary text-white" : "bg-card text-muted-foreground hover:text-primary",
              )}
            >
              {value === "status" ? "Status colours" : "Tier colours"}
            </button>
          ))}
        </div>
        <div className="flex overflow-hidden rounded-md border border-border" role="tablist" aria-label="Lot filter">
          {(["all", "available"] as PublicLotFilter[]).map((value) => (
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
      {tierOptions.length && colourView === "tier" ? (
        <div className="border-b border-border bg-card px-3 py-1.5">
          <button
            type="button"
            aria-expanded={chipsOpen}
            aria-controls="tier-filter-chips"
            onClick={() => setChipsOpen((open) => !open)}
            className="flex items-center gap-1 text-xs font-semibold text-muted-foreground"
          >
            <span aria-hidden>{chipsOpen ? "▾" : "▸"}</span> Tiers ({tierOptions.length})
          </button>
          {chipsOpen ? (
            <div id="tier-filter-chips" className="mt-1 flex flex-wrap items-center gap-1" aria-label="Tier filter">
              {tierOptions.map(([key, tier]) => {
                const off = disabledTiers.includes(key);
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={!off}
                    onClick={() =>
                      setDisabledTiers((current) => (off ? current.filter((t) => t !== key) : [...current, key]))
                    }
                    className={cn(
                      "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold transition",
                      off ? "border-border opacity-45" : "border-border",
                    )}
                  >
                    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: tier.color }} />
                    {tier.label}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {colourView === "status" ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-1.5" aria-label="Map legend">
          {(Object.keys(STATUS_STYLE) as ParcelStatus[]).map((status) => (
            <span key={status} className="flex items-center gap-1 text-xs font-semibold text-muted-foreground">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: STATUS_STYLE[status].fill }}
              />
              {status}
            </span>
          ))}
        </div>
      ) : null}

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
                onLoad={(event) => {
                  const img = event.currentTarget;
                  if (img.naturalWidth && img.naturalHeight) {
                    setImageAspect(img.naturalWidth / img.naturalHeight);
                  }
                }}
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
                No site map image published yet.
              </div>
            )}
            <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full">
              {visibleParcels.map((parcel) => {
                const polygon = Array.isArray(parcel.map_polygon) ? parcel.map_polygon : [];
                if (polygon.length < 3) return null;
                const style = fillFor(parcel, colourView);
                const focused = highlighted.includes(parcel.id) || parcel.id === hoveredId;
                const picked = pickMode && highlighted.includes(parcel.id);
                const tappable = parcel.status === "Available";
                return (
                  <g key={parcel.id}>
                    <polygon
                      points={pointsAttr(polygon, yScale)}
                      fill={style.fill}
                      fillOpacity={focused ? 0.55 : 0.35}
                      stroke={picked ? "#1d4ed8" : style.stroke}
                      strokeWidth={focused ? 0.7 : 0.4}
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                    <polygon
                      points={pointsAttr(polygon, yScale)}
                      fill="transparent"
                      stroke="rgba(0,0,0,0)"
                      strokeWidth={HIT_STROKE_PX}
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                      style={{ cursor: tappable ? "pointer" : "default" }}
                      onMouseEnter={() => setHoveredId(parcel.id)}
                      onMouseLeave={() => setHoveredId((current) => (current === parcel.id ? null : current))}
                      onClick={() => handleParcelClick(parcel)}
                    >
                      <title>{`Lot ${parcel.lot_number} — ${parcel.tier_label ?? parcel.status}${picked ? " — selected" : ""}`}</title>
                    </polygon>
                  </g>
                );
              })}
            </svg>
            <div className={cn("absolute bottom-3 right-3 flex flex-col gap-1", focusLot && !expanded ? "bottom-48 sm:bottom-3" : "bottom-3")}>
              <button
                ref={toggleRef}
                type="button"
                aria-label={expanded ? "Exit fullscreen" : "Enter fullscreen"}
                aria-pressed={expanded}
                onClick={() => (expanded ? exitFullscreen() : enterFullscreen())}
                className="grid h-8 w-8 place-items-center rounded-md border border-border bg-card/95 shadow"
              >
                {expanded ? (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                    <path d="M5 1v4H1M9 1v4h4M1 9V5h4M13 9V5H9" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                    <path d="M1 5V1h4M13 5V1H9M1 9v4h4M13 9v4H9" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                aria-label="Zoom in"
                disabled={zoom >= MAX_ZOOM}
                onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.5))}
                className="h-8 w-8 rounded-md border border-border bg-card/95 text-sm font-bold shadow"
              >
                +
              </button>
              <button
                type="button"
                aria-label="Zoom out"
                disabled={zoom <= MIN_ZOOM}
                onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.5))}
                className="h-8 w-8 rounded-md border border-border bg-card/95 text-sm font-bold shadow"
              >
                −
              </button>
              <button
                type="button"
                aria-label="Reset zoom"
                onClick={() => setZoom(MIN_ZOOM)}
                className="h-8 w-8 rounded-md border border-border bg-card/95 text-xs font-bold shadow"
              >
                ⟲
              </button>
            </div>
            {expanded ? (
              <button
                ref={closeRef}
                type="button"
                onClick={() => exitFullscreen()}
                className="absolute right-3 top-3 z-10 rounded-md border border-border bg-card/95 px-3 py-1.5 text-xs font-semibold shadow"
              >
                ✕ Close
              </button>
            ) : null}
            {toast ? (
              <div
                role="status"
                aria-live="polite"
                className="absolute left-1/2 top-3 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-card/95 px-3 py-1.5 text-xs font-semibold shadow"
              >
                {toast}
              </div>
            ) : null}
            {focusLot ? (
              <div
                className={cn(
                  "absolute bottom-3 left-3 right-3 rounded-md border bg-card/95 p-3 text-sm shadow-lg sm:left-auto sm:right-14 sm:w-64",
                  expanded && "max-h-[50dvh] overflow-auto md:bottom-auto md:right-3 md:top-14 md:w-72",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-primary">Lot {focusLot.lot_number}</strong>
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-semibold text-white"
                    style={{ backgroundColor: (STATUS_STYLE[focusLot.status] ?? STATUS_STYLE.Available).fill }}
                  >
                    {focusLot.status}
                  </span>
                </div>
                {focusLot.tier_label ? <p className="mt-1 text-muted-foreground">{focusLot.tier_label}</p> : null}
                <p className="mt-1 text-muted-foreground">{focusLot.dimensions ?? "Size TBC"}</p>
                {showPrices ? <p className="mt-1 font-semibold text-primary">{money(focusLot.price)}</p> : null}
                {pickMode && focusLot.status === "Available" ? (
                  <button
                    type="button"
                    onClick={() => {
                      const adding = !highlighted.includes(focusLot.id);
                      onToggleLot(focusLot);
                      setToast(adding ? `Lot ${focusLot.lot_number} added to your preferences` : `Lot ${focusLot.lot_number} removed`);
                    }}
                    className="mt-2 w-full rounded-md bg-primary px-3 py-2 text-sm font-semibold text-white"
                  >
                    {highlighted.includes(focusLot.id) ? `Remove Lot ${focusLot.lot_number}` : `Select Lot ${focusLot.lot_number}`}
                  </button>
                ) : null}
                {!pickMode && focusLot.status === "Available" && enableInquiry ? (
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

      {inquiryLot && payload && enableInquiry ? (
        <PublicInquiryModal
          tenantSlug={payload.tenant.slug}
          tenantName={payload.branding.company_name || payload.tenant.name}
          lotId={inquiryLot.id}
          lotNumber={inquiryLot.lot_number}
          onClose={() => setInquiryLot(null)}
        />
      ) : null}
    </div>
  );
}
