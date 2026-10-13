import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn, formatAreaDualUnit, money } from "../../lib/utils";
import {
  allowlistTheme,
  applyCardText,
  buildThemeCssVars,
  DEFAULT_CARD_CONFIG,
  type LotMapTheme,
} from "../../lib/theme";
import type { ParcelStatus } from "../../types/database";
import { PublicInquiryModal } from "./PublicInquiryModal";
import { MapPolygon, MapRasterLayer } from "../map/MapPolygon";
import type { CorrectionMapLayer, CorrectionReviewStatus } from "../map/correctionMapLayer";
export type { CorrectionMapLayer, CorrectionReviewStatus } from "../map/correctionMapLayer";
import {
  clampMapPan,
  clientPointToMapCoordinate,
  mapPanAfterZoom,
  mapPolygonBounds,
  mapPolygonBoundsArea,
  mapViewBoxHeight,
  mapViewBoxString,
  mapViewportBounds,
  type MapPanPadding,
} from "../../lib/mapGeometry";

export interface PublicLotParcel {
  /** Generated in the browser only for SVG interaction; never a database key. */
  local_key: number;
  /** Versioned project/lot locator returned by get-public-lots; null when ambiguous. */
  public_ref: string | null;
  lot_number: string;
  status: PublicLotStatus;
  price: number;
  dimensions: string | null;
  /** Printed plat area in m² when known (OCR stage); card shows m² + sq ft. */
  area_sqm: number | null;
  map_polygon: Array<{ x: number; y: number }> | null;
  tier_key: string | null;
  tier_label: string | null;
  tier_color_hex: string | null;
  is_corner: boolean;
  effective_price_cents: number;
  /** Stable correction-workspace key; never a public parcel identifier. */
  correction_key?: string;
}

type PublicLotStatus = ParcelStatus | "Review pending";

interface MapPayload {
  tenant: { name: string; slug: string };
  project: { slug: string; name: string } | null;
  masterplan_image_url: string | null;
  /** Mobile-capped rendition; null until published (clients use full image). */
  masterplan_preview_url: string | null;
  branding: { company_name: string; logo_url: string; short_description: string };
  /** Allowlisted tenant theme; null until published (built-in defaults). */
  theme: LotMapTheme | null;
  parcels: PublicLotParcel[];
}

export type PublicLotFilter = "all" | "available";
export type PublicLotColourView = "status" | "tier";

interface PublicLotMapProps {
  tenantSlug: string;
  /** Optional project slug (/embed/:tenant/:project). Absent = tenant default. */
  projectSlug?: string;
  /** Controlled highlight in pick mode. Omit for unmanaged inquiry highlighting. */
  selectedLocalKeys?: number[];
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
  onClearSelection?: () => void;
  onParcelsLoaded?: (parcels: PublicLotParcel[]) => void;
  /**
   * Local preview mode (never used in production): loads lots.json +
   * tiers.json from a static base path and the sibling
   * masterplan_background.webp instead of calling get-public-lots.
   */
  demoDataUrl?: string;
  /** Authenticated correction-only layer; contains geometry, never sales fields. */
  correctionMapLayer?: CorrectionMapLayer;
}

const STATUS_STYLE: Record<PublicLotStatus, { fill: string; stroke: string }> = {
  Available: { fill: "#22c55e", stroke: "#15803d" },
  Reserved: { fill: "#f59e0b", stroke: "#b45309" },
  Sold: { fill: "#ef4444", stroke: "#b91c1c" },
  "Review pending": { fill: "#718078", stroke: "#52635a" },
};

const CORRECTION_REVIEW_STYLE: Record<CorrectionReviewStatus, { fill: string; stroke: string; label: string }> = {
  unreviewed: { fill: "#64748b", stroke: "#475569", label: "Unreviewed" },
  reviewed: { fill: "#2f7d4e", stroke: "#205a38", label: "Reviewed against source" },
  ambiguous: { fill: "#b7791f", stroke: "#805313", label: "Ambiguous" },
  unreadable: { fill: "#78716c", stroke: "#57534e", label: "Unreadable" },
  skipped: { fill: "#94a3b8", stroke: "#64748b", label: "Skipped" },
  "geometry-issue": { fill: "#c24132", stroke: "#8f2e26", label: "Geometry issue" },
};

type LotMarkerShape = "circle" | "diamond" | "square";

const STATUS_MARKER_SHAPE: Record<PublicLotStatus, LotMarkerShape> = {
  Available: "circle",
  Reserved: "diamond",
  Sold: "square",
  "Review pending": "circle",
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

/** Transparent pointer padding (px, non-scaling) so small lots stay tappable. */
const HIT_STROKE_PX = 14;

/** Keep the keyboard-accessible search chooser bounded for broad queries. */
const SEARCH_RESULT_LIMIT = 12;

/** Lot-label ceiling on screen so giant lots don't get billboard text. */
const MAX_LABEL_PX = 26;

/** Below this viewport width the capped preview rendition wins (bandwidth). */
const MOBILE_PREVIEW_PX = 768;

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

/**
 * Dev/test-only static fixture preview. import.meta.env.DEV is replaced with
 * `false` in production builds, so the bundler drops every branch below —
 * loadDemo, its URLs, and the badge never reach dist/. The fixture files
 * themselves live outside public/ and are served by a serve-only vite
 * plugin, so they can't be copied to dist/ either.
 */
const DEMO_PREVIEW = import.meta.env.DEV;

/** Compatibility wrappers keep this buyer component focused on its parcel contract. */
type PanPads = MapPanPadding;
const NO_PADS: PanPads = { left: 0, right: 0, top: 0, bottom: 0 };
const clampPanTo = (x: number, y: number, z: number, vbH: number, pads: PanPads = NO_PADS) =>
  clampMapPan({ x, y }, z, 100, vbH, pads);
const bboxAreaUnits = (polygon: Array<{ x: number; y: number }>): number => mapPolygonBoundsArea(polygon);

function fillFor(parcel: PublicLotParcel, view: PublicLotColourView): { fill: string; stroke: string } {
  if (view === "tier" && parcel.tier_color_hex) {
    return { fill: parcel.tier_color_hex, stroke: parcel.tier_color_hex };
  }
  return STATUS_STYLE[parcel.status] ?? STATUS_STYLE.Available;
}

function polygonMarkerPoints(shape: Exclude<LotMarkerShape, "circle">, cx: number, cy: number, radius: number): string {
  if (shape === "diamond") return `${cx},${cy - radius} ${cx + radius},${cy} ${cx},${cy + radius} ${cx - radius},${cy}`;
  const half = radius * 0.72;
  return `${cx - half},${cy - half} ${cx + half},${cy - half} ${cx + half},${cy + half} ${cx - half},${cy + half}`;
}

export function PublicLotMap({
  tenantSlug,
  projectSlug,
  selectedLocalKeys,
  onToggleLot,
  showPrices = true,
  enableInquiry = false,
  initialFilter = "all",
  initialView = "status",
  initialLotNumber,
  onSelectLot,
  onClearSelection,
  onParcelsLoaded,
  demoDataUrl,
  correctionMapLayer,
}: PublicLotMapProps) {
  const pickMode = typeof onToggleLot === "function";
  const [payload, setPayload] = useState<MapPayload | null>(null);
  const [reviewPendingDemo, setReviewPendingDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [hoveredLocalKey, setHoveredLocalKey] = useState<number | null>(null);
  const [internalSelectedKey, setInternalSelectedKey] = useState<number | null>(null);
  const [detailsFocusRevision, setDetailsFocusRevision] = useState(0);
  const [mapCursorKey, setMapCursorKey] = useState<number | null>(null);
  const [mapKeyboardFocused, setMapKeyboardFocused] = useState(false);
  const [inquiryLot, setInquiryLot] = useState<PublicLotParcel | null>(null);
  const [inquiryWaitlist, setInquiryWaitlist] = useState(false);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [query, setQuery] = useState("");
  // Measured masterplan aspect (width/height). A square viewBox would
  // letterbox differently from the object-contain image and drift polygons
  // off their lots, so the viewBox height tracks the real image ratio.
  const [imageAspect, setImageAspect] = useState<number | null>(null);
  // Display image: the native-resolution master, unless a capped preview
  // rendition is published and this is a phone-class viewport (bandwidth).
  // Decided once per mount so resizes never swap the image mid-session
  // (tile pyramids arrive with the clean-base pipeline).
  const [wantPreview] = useState(
    () => typeof window !== "undefined" && window.innerWidth < MOBILE_PREVIEW_PX,
  );
  const masterplanUrl =
    wantPreview && payload?.masterplan_preview_url ? payload.masterplan_preview_url : (payload?.masterplan_image_url ?? null);
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
  const [geometryDraft, setGeometryDraft] = useState<Array<{ x: number; y: number }> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const detailsPanelRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchResultsRef = useRef<HTMLDivElement | null>(null);
  const detailsFocusTargetRef = useRef<number | null>(null);
  const searchResultsId = useId();
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

  useEffect(() => {
    function onResize() {
      setNarrow(window.innerWidth < 640);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
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
      setReviewPendingDemo(false);
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
          status?: string;
          area_sqm?: number;
          polygon_pct: Array<{ x: number; y: number }>;
        }>;
        const tiersRaw = (await tiersRes.json()) as { tiers?: Record<string, { label: string; price: number; legend: string }> };
        const tiers = tiersRaw.tiers ?? {};
        const validStatuses = new Set(["Available", "Reserved", "Sold"]);
        const pendingStatuses = lots.length > 0 && lots.every((lot) => !validStatuses.has(lot.status ?? ""));
        const parcels: PublicLotParcel[] = lots.map((lot, index) => ({
          local_key: index + 1,
          public_ref: null,
          lot_number: lot.lot_number,
          status: validStatuses.has(lot.status ?? "") ? lot.status as ParcelStatus : "Review pending",
          price: Number(lot.price),
          dimensions: null,
          area_sqm: typeof lot.area_sqm === "number" && lot.area_sqm > 0 ? lot.area_sqm : null,
          map_polygon: lot.polygon_pct,
          tier_key: lot.tier_key,
          tier_label: tiers[lot.tier_key]?.label ?? lot.tier_key,
          tier_color_hex: tiers[lot.tier_key]?.legend ?? "#999999",
          is_corner: false,
          effective_price_cents: Math.round(Number(lot.price) * 100),
        }));
        if (cancelled) return;
        setReviewPendingDemo(pendingStatuses);
        setPayload({
          tenant: { name: "Hopkins Grove (preview)", slug: "demo" },
          project: null,
          masterplan_image_url: `${base}/masterplan_background.webp`,
          masterplan_preview_url: null,
          theme: null,
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
          `${baseUrl}/functions/v1/get-public-lots?tenant=${encodeURIComponent(tenantSlug)}${projectSlug ? `&project=${encodeURIComponent(projectSlug)}` : ""}`,
          { headers: { apikey: anonKey } },
        );
        const body = (await response.json().catch(() => ({}))) as Partial<MapPayload> & { error?: string };
        if (cancelled) return;
        if (!response.ok || body.error || !body.parcels) {
          throw new Error(body.error || `Map request failed (${response.status}).`);
        }
        const responsePayload = body as MapPayload;
        const parcels = (responsePayload.parcels as unknown as Array<Record<string, unknown>>).map((parcel, index): PublicLotParcel => ({
          local_key: index + 1,
          public_ref: typeof parcel.public_ref === "string" ? parcel.public_ref : null,
          lot_number: typeof parcel.lot_number === "string" ? parcel.lot_number : "",
          status: parcel.status === "Available" || parcel.status === "Reserved" || parcel.status === "Sold"
            ? parcel.status
            : "Review pending",
          price: Number(parcel.price ?? 0),
          dimensions: typeof parcel.dimensions === "string" ? parcel.dimensions : null,
          area_sqm: typeof parcel.area_sqm === "number" ? parcel.area_sqm : null,
          map_polygon: Array.isArray(parcel.map_polygon) ? parcel.map_polygon as PublicLotParcel["map_polygon"] : null,
          tier_key: typeof parcel.tier_key === "string" ? parcel.tier_key : null,
          tier_label: typeof parcel.tier_label === "string" ? parcel.tier_label : null,
          tier_color_hex: typeof parcel.tier_color_hex === "string" ? parcel.tier_color_hex : null,
          is_corner: parcel.is_corner === true,
          effective_price_cents: Number(parcel.effective_price_cents ?? 0),
        }));
        setPayload({ ...responsePayload, parcels });
        onParcelsLoaded?.(parcels);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Map request failed.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (tenantSlug === "correction-review") {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    if (DEMO_PREVIEW && demoDataUrl) {
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
  }, [tenantSlug, projectSlug, demoDataUrl, loadAttempt]);

  const correctionReviewTitle = correctionMapLayer?.title;
  const correctionReviewImageUrl = correctionMapLayer?.imageUrl;
  const correctionReviewParcels = correctionMapLayer?.parcels;

  useEffect(() => {
    if (!correctionReviewTitle || !correctionReviewParcels) return;
    const parcels: PublicLotParcel[] = correctionReviewParcels.map((lot, index) => ({
      local_key: index + 1,
      correction_key: lot.key,
      public_ref: null,
      lot_number: lot.reference,
      status: "Review pending",
      price: 0,
      dimensions: null,
      area_sqm: null,
      map_polygon: lot.polygon,
      tier_key: null,
      tier_label: null,
      tier_color_hex: null,
      is_corner: false,
      effective_price_cents: 0,
    }));
    setError(null);
    setReviewPendingDemo(true);
    setPayload({
      tenant: { name: correctionReviewTitle, slug: "correction-review" },
      project: null,
      masterplan_image_url: correctionReviewImageUrl ?? null,
      masterplan_preview_url: null,
      theme: null,
      branding: { company_name: correctionReviewTitle, logo_url: "", short_description: "" },
      parcels,
    });
    onParcelsLoaded?.(parcels);
  }, [correctionReviewTitle, correctionReviewImageUrl, correctionReviewParcels, onParcelsLoaded]);

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
      if (!reviewPendingDemo && filter === "available" && parcel.status !== "Available") return false;
      if (!reviewPendingDemo && parcel.tier_key && disabledTiers.includes(parcel.tier_key)) return false;
      if (needle) {
        const haystack = `${parcel.lot_number} ${(parcel.tier_label ?? parcel.tier_key ?? "")} ${parcel.status}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [payload, filter, disabledTiers, query, reviewPendingDemo]);
  // Wamule's current tenant-level staging feed has no approved project scope
  // or register signal. Treat its sales fields as preview values until that
  // approval state is represented by the public payload.
  const unapprovedWamulePreview = Boolean(payload && tenantSlug.toLowerCase() === "wamule" && !payload.project);
  const proofOfConcept = reviewPendingDemo || unapprovedWamulePreview;
  const previewLayout = proofOfConcept && !correctionMapLayer;
  const normalizedQuery = query.trim();
  const searchResults = normalizedQuery ? visibleParcels.slice(0, SEARCH_RESULT_LIMIT) : [];
  const mapParcels = visibleParcels.filter((parcel) => Array.isArray(parcel.map_polygon) && parcel.map_polygon.length >= 3);
  const totalMappedParcels = payload?.parcels.filter((parcel) => Array.isArray(parcel.map_polygon) && parcel.map_polygon.length >= 3).length ?? 0;
  const totalUnmappedParcels = (payload?.parcels.length ?? 0) - totalMappedParcels;
  const mapCursorParcel = mapParcels.find((parcel) => parcel.local_key === mapCursorKey) ?? mapParcels[0] ?? null;
  const mapListboxId = `${searchResultsId}-map-lots`;
  const mapInstructionsId = `${searchResultsId}-map-instructions`;
  const mapCursorOptionId = mapCursorParcel ? `${mapListboxId}-option-${mapCursorParcel.local_key}` : undefined;
  const mapCursorPolygon = mapCursorParcel ? polygonFor(mapCursorParcel) : [];

  // Deep link: select the matching lot once parcels arrive.
  useEffect(() => {
    if (correctionMapLayer) {
      if (!correctionMapLayer.selectedKey) {
        setInternalSelectedKey(null);
        return;
      }
      const hit = payload?.parcels.find((parcel) => parcel.correction_key === correctionMapLayer.selectedKey);
      if (!hit) return;
      setInternalSelectedKey(hit.local_key);
      setMapCursorKey(hit.local_key);
      zoomToParcel(hit);
      return;
    }
    const target = (initialLotNumber ?? "").trim().toLowerCase();
    if (!target || !payload) return;
    const hit = payload.parcels.find((parcel) => parcel.lot_number.toLowerCase() === target);
    if (hit) {
      setInternalSelectedKey(hit.local_key);
      if (previewLayout) zoomToParcel(hit);
      onSelectLot?.(hit);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, previewLayout, imageAspect, initialLotNumber, correctionMapLayer?.selectedKey]);

  // Probe the masterplan's intrinsic aspect so the viewBox matches it.
  // (The image itself lives *inside* the SVG below, so zoom/pan move the
  // whole map — background plus lots — as one layer. Both renditions share
  // the source aspect, so either URL probes identically.)
  useEffect(() => {
    const url = masterplanUrl;
    if (!url) {
      setImageAspect(null);
      return;
    }
    let cancelled = false;
    const probe = new Image();
    probe.onload = () => {
      if (!cancelled && probe.naturalWidth && probe.naturalHeight) {
        setImageAspect(probe.naturalWidth / probe.naturalHeight);
      }
    };
    probe.src = url;
    return () => {
      cancelled = true;
    };
  }, [masterplanUrl]);

  const highlighted = selectedLocalKeys ?? (internalSelectedKey !== null ? [internalSelectedKey] : []);
  // Tenant theme (allowlisted server-side; built-in defaults until the
  // tenant publishes one). Tokens become per-container CSS variables so two
  // embeds never share state; card copy/flags come from the same object.
  const theme: LotMapTheme = useMemo(
    () => allowlistTheme(payload?.theme ?? null, payload?.theme?.cssUrl ?? null),
    [payload?.theme],
  );
  const themeVars = useMemo(() => buildThemeCssVars(theme), [theme]);
  const cardConfig = theme.card ?? DEFAULT_CARD_CONFIG;
  // Sanitized to [a-z0-9-] so it always matches the overrides.css scope rule.
  const tenantScope = `lotmap-t-${tenantSlug.toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
  // Selection-locked detail card: hover NEVER drives this. Hover only
  // affects polygon styling; the card follows the locked selection.
  const focusLot = payload?.parcels.find((parcel) => parcel.local_key === highlighted[0]) ?? null;
  const focusLotKey = focusLot?.local_key ?? null;
  const demoDisplayName = payload?.tenant.name.replace(/\s+\(preview\)$/i, "") ?? "Land plan preview";
  const mapTitle = reviewPendingDemo
    ? correctionMapLayer?.title ?? demoDisplayName
    : correctionMapLayer?.title ?? (payload?.branding.company_name || payload?.tenant.name || "Lot availability");

  // A keyboard search result or map option opens the same detail card as a
  // pointer selection, then focuses that card so its actions are reachable.
  useEffect(() => {
    if (detailsFocusRevision === 0) return;
    const target = detailsFocusTargetRef.current;
    if (target !== null && focusLotKey === target) {
      detailsFocusTargetRef.current = null;
      (previewLayout ? detailsPanelRef.current : cardRef.current)?.focus();
    }
  }, [detailsFocusRevision, focusLotKey, previewLayout]);

  // Reveal-on-select with card padding: while a lot is selected, the pan
  // clamp gains room equal to the card's overlap on each edge it touches
  // (a bottom sheet adds bottom padding ~= card height), so the map can
  // shift even at 1x where the unpadded pan range is zero. If the selected
  // lot's center is hidden behind the card, pan just enough to uncover it.
  // Zoom is never touched, and this runs only when selection/zoom/layout
  // changes — never while the user pans, so it can't fight manual gestures.
  useEffect(() => {
    const cur = cardPadRef.current;
    if (focusLotKey == null) {
      if (cur.left !== 0 || cur.right !== 0 || cur.top !== 0 || cur.bottom !== 0) {
        setCardPad(NO_PADS);
      }
      return;
    }
    const svg = svgRef.current;
    const card = cardRef.current;
    if (!svg || !card) return;
    const lot = payload?.parcels.find((parcel) => parcel.local_key === focusLotKey) ?? null;
    const polygon = lot && Array.isArray(lot.map_polygon) ? lot.map_polygon : [];
    if (polygon.length < 3) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const vbH = viewBoxHRef.current;
    const z = zoomRef.current;
    const vbW = 100 / z;
    const vbHView = vbH / z;
    // viewBox -> screen mapping under preserveAspectRatio="meet".
    const scale = Math.min(rect.width / vbW, rect.height / vbHView);
    if (!(scale > 0)) return;
    const cardRect = card.getBoundingClientRect();
    if (Math.abs(cardRect.height - cardHpxRef.current) > 1) {
      cardHpxRef.current = cardRect.height;
      setCardHpx(cardRect.height);
    }
    // The card floats (bottom-3/left-3/right-3 = 12px gaps), so "touching"
    // an edge means within 16px — otherwise pads stay zero and 1x reveal
    // has no room (this exact miss stranded bottom-row lots on phones).
    const edge = 16;
    const pads: PanPads = { ...NO_PADS };
    if (cardRect.left <= rect.left + edge) {
      pads.left = Math.max(0, Math.min(cardRect.right, rect.right) - rect.left) / scale;
    }
    if (cardRect.right >= rect.right - edge) {
      pads.right = Math.max(0, rect.right - Math.max(cardRect.left, rect.left)) / scale;
    }
    if (cardRect.top <= rect.top + edge) {
      pads.top = Math.max(0, Math.min(cardRect.bottom, rect.bottom) - rect.top) / scale;
    }
    if (cardRect.bottom >= rect.bottom - edge) {
      pads.bottom = Math.max(0, rect.bottom - Math.max(cardRect.top, rect.top)) / scale;
    }
    if (pads.left !== cur.left || pads.right !== cur.right || pads.top !== cur.top || pads.bottom !== cur.bottom) {
      setCardPad(pads);
    }
    const p = clampPanTo(panRef.current.x, panRef.current.y, z, vbH, pads);
    const cx = polygon.reduce((sum, pt) => sum + pt.x, 0) / polygon.length;
    const cy = (polygon.reduce((sum, pt) => sum + pt.y, 0) / polygon.length) * (vbH / 100);
    const offX = rect.left + (rect.width - vbW * scale) / 2;
    const offY = rect.top + (rect.height - vbHView * scale) / 2;
    const sx = offX + (cx - p.x) * scale;
    const sy = offY + (cy - p.y) * scale;
    const margin = 12;
    const insideX = sx > cardRect.left - margin && sx < cardRect.right + margin;
    const insideY = sy > cardRect.top - margin && sy < cardRect.bottom + margin;
    if (!insideX || !insideY) return;
    // Minimal exit: shift along whichever axis clears the card sooner —
    // but the landing point must stay inside the SVG viewport itself
    // (shifting just past a full-width bottom sheet can otherwise push the
    // lot a few pixels off the visible map). If no exit keeps it on-map
    // (tiny viewport, huge card), leave the pan alone.
    const exitUp = cardRect.top - margin - sy;
    const exitDown = cardRect.bottom + margin - sy;
    const exitLeft = cardRect.left - margin - sx;
    const exitRight = cardRect.right + margin - sx;
    const inset = 8;
    const candidates = [exitUp, exitDown, exitLeft, exitRight]
      .map((shift, axis) => {
        const horizontal = axis >= 2;
        const qx = sx + (horizontal ? shift : 0);
        const qy = sy + (horizontal ? 0 : shift);
        const onMap =
          qx >= rect.left + inset &&
          qx <= rect.right - inset &&
          qy >= rect.top + inset &&
          qy <= rect.bottom - inset;
        return { shift, horizontal, onMap };
      })
      .filter((c) => c.onMap)
      .sort((a, b) => Math.abs(a.shift) - Math.abs(b.shift));
    if (!candidates.length) return;
    const best = candidates[0];
    const moveX = best.horizontal ? best.shift / scale : 0;
    const moveY = best.horizontal ? 0 : best.shift / scale;
    // Moving the map opposite to the desired screen shift of the point.
    setPan(clampPanTo(p.x - moveX, p.y - moveY, z, vbH, pads));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusLotKey, zoom, expanded]);

  const viewBoxH = mapViewBoxHeight(imageAspect);
  const yScale = viewBoxH / 100;
  // Pan stays in full-space units so zooming keeps the current centre
  // instead of jumping back to the top-left corner.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Extra pan range granted while a lot is selected, so a card/sheet
  // covering the lot can be escaped even at 1x (unpadded range is zero).
  const [cardPad, setCardPad] = useState<PanPads>(NO_PADS);
  // Measured card height (px) for lifting the floating controls above it.
  const [cardHpx, setCardHpx] = useState(0);
  // Phone layout flag: the detail card is a full-width bottom sheet only
  // below sm; the controls need lifting only there.
  const [narrow, setNarrow] = useState<boolean>(() =>
    typeof window === "undefined" ? false : window.innerWidth < 640,
  );
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Gesture model: NO setPointerCapture anywhere (capture retargets the
  // follow-up click to the capturing element, which broke selection).
  // pointerdown records target+position, window-level move/up listeners run
  // the pan, and selection is decided at pointerup under a drag threshold —
  // no click events involved, so drag/pinch can never select.
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<null | {
    startX: number;
    startY: number;
    panX: number;
    panY: number;
    downLotKey: number | null;
    moved: boolean;
  }>(null);
  const pinchRef = useRef<null | { startDist: number; startZoom: number; center: { x: number; y: number } }>(null);
  // Fresh-state mirrors: window listeners outlive the render that attached them.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;
  const cardPadRef = useRef(cardPad);
  cardPadRef.current = cardPad;
  const cardHpxRef = useRef(0);
  const viewBoxHRef = useRef(viewBoxH);
  viewBoxHRef.current = viewBoxH;
  const pickModeRef = useRef(pickMode);
  pickModeRef.current = pickMode;
  const visibleRef = useRef<PublicLotParcel[]>([]);
  visibleRef.current = visibleParcels;
  const wheelAccum = useRef(0);
  const wheelClient = useRef<{ x: number; y: number } | null>(null);
  const geometryDraftRef = useRef<Array<{ x: number; y: number }> | null>(null);
  const activeVertexRef = useRef<{ key: string; index: number; pointerId: number } | null>(null);

  useEffect(() => {
    const edit = correctionMapLayer?.geometryEdit;
    const next = edit ? edit.polygon.map((point) => ({ ...point })) : null;
    geometryDraftRef.current = next;
    setGeometryDraft(next);
  }, [correctionMapLayer?.geometryEdit]);

  function clampPan(x: number, y: number, z: number): { x: number; y: number } {
    return clampPanTo(x, y, z, viewBoxH, cardPad);
  }

  const viewBox = useMemo(
    () => mapViewBoxString(mapViewportBounds(pan, zoom, 100, viewBoxH, cardPad)),
    [zoom, viewBoxH, pan, cardPad],
  );

  function zoomBy(delta: number) {
    zoomTo(zoom + delta);
  }

  /** Zoom keeping the given full-space point fixed under the cursor. */
  function zoomTo(next: number, cx: number = 50, cy: number = viewBoxH / 2) {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (clamped === zoom) return;
    setZoom(clamped);
    setPan(mapPanAfterZoom(pan, zoom, clamped, { x: cx, y: cy }, 100, viewBoxH, cardPad));
  }

  function resetZoom() {
    setZoom(MIN_ZOOM);
    setPan({ x: 0, y: 0 });
  }

  function boundsOf(parcel: PublicLotParcel): { x: number; y: number; w: number; h: number } | null {
    const polygon = Array.isArray(parcel.map_polygon) ? parcel.map_polygon : [];
    if (polygon.length < 3) return null;
    const bounds = mapPolygonBounds(polygon, yScale);
    if (!bounds) return null;
    return { x: bounds.x, y: bounds.y, w: Math.max(bounds.width, 0.01), h: Math.max(bounds.height, 0.01) };
  }

  /** Explicit zoom control (detail-card button): fit the lot's bounds with
   *  padding, capped at MAX_ZOOM so tiny lots don't over-zoom. Replaces the
   *  old double-click-to-zoom, which raced the inquiry modal and had no
   *  touch/keyboard path. */
  function zoomToParcel(parcel: PublicLotParcel) {
    const b = boundsOf(parcel);
    if (!b) return;
    const pad = 1.6;
    const fit = Math.min(100 / (b.w * pad), viewBoxH / (b.h * pad));
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fit));
    setZoom(next);
    setPan(clampPan(b.x + b.w / 2 - 100 / next / 2, b.y + b.h / 2 - viewBoxH / next / 2, next));
  }

  function lotKeyAtPoint(clientX: number, clientY: number): number | null {
    // All hit polygons under the point (hit padding overlaps neighbours):
    // prefer the smallest lot, breaking equal-area ties by nearest centroid
    // to the tap. Paint order alone can't do this — ties keep data order —
    // so a tap on a tiny lot surrounded by equal tiny lots still resolves
    // to the tapped one instead of the topmost sibling.
    const els = document.elementsFromPoint(clientX, clientY);
    const ids: number[] = [];
    for (const el of els) {
      const raw = (el as Element).closest?.("[data-lot-key]")?.getAttribute("data-lot-key");
      const id = raw != null && raw !== "" ? Number(raw) : null;
      if (id !== null && !ids.includes(id)) ids.push(id);
    }
    if (ids.length === 0) return null;
    if (ids.length === 1) return ids[0];
    const svg = svgRef.current;
    let best = ids[0];
    let bestScore = Infinity;
    for (const id of ids) {
      const poly = svg?.querySelector(`polygon[data-lot-key="${id}"]`) as SVGPolygonElement | null;
      const box = poly?.getBBox?.();
      if (!box) continue;
      // Hit-polygon points are pre-scaled by the shared polygon primitive, so
      // the bbox is already in full-space map units, matching my/mx below.
      const area = box.width * box.height;
      // Centroid distance needs the tap in map units: invert the meet mapping.
      const rect = svg?.getBoundingClientRect();
      let dist = Infinity;
      if (rect?.width && rect?.height) {
        const z = zoomRef.current;
        const vbH = viewBoxHRef.current;
        const viewport = mapViewportBounds(panRef.current, z, 100, vbH);
        const point = clientPointToMapCoordinate(clientX, clientY, rect, viewport);
        if (point) {
          const ddx = box.x + box.width / 2 - point.x;
          const ddy = box.y + box.height / 2 - point.y;
          dist = Math.hypot(ddx, ddy);
        }
      }
      // Area dominates; distance breaks ties (scaled far below any area gap
      // that matters, and exact for equals).
      const score = area * 1000 + dist;
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  function selectLotByKey(lotKey: number) {
    const parcel = visibleRef.current.find((p) => p.local_key === lotKey) ?? null;
    if (parcel) handleParcelClick(parcel);
  }

  function centerMapLotIfHidden(parcel: PublicLotParcel) {
    const svg = svgRef.current;
    const polygon = svg?.querySelector(`polygon[data-lot-key="${parcel.local_key}"]`);
    const canvas = svg?.getBoundingClientRect();
    const lot = polygon?.getBoundingClientRect();
    if (!canvas || !lot) return;
    const centerX = lot.left + lot.width / 2;
    const centerY = lot.top + lot.height / 2;
    if (centerX >= canvas.left && centerX <= canvas.right && centerY >= canvas.top && centerY <= canvas.bottom) return;

    const bounds = boundsOf(parcel);
    if (!bounds) return;
    const zoom = zoomRef.current;
    const viewHeight = viewBoxHRef.current;
    setPan(
      clampPanTo(
        bounds.x + bounds.w / 2 - 100 / zoom / 2,
        bounds.y + bounds.h / 2 - viewHeight / zoom / 2,
        zoom,
        viewHeight,
        cardPadRef.current,
      ),
    );
  }

  function moveMapCursor(direction: "left" | "right" | "up" | "down") {
    const parcels = visibleRef.current.filter((parcel) => Array.isArray(parcel.map_polygon) && parcel.map_polygon.length >= 3);
    const current = parcels.find((parcel) => parcel.local_key === mapCursorParcel?.local_key) ?? parcels[0];
    const currentBounds = current ? boundsOf(current) : null;
    if (!current || !currentBounds) return;
    const currentX = currentBounds.x + currentBounds.w / 2;
    const currentY = currentBounds.y + currentBounds.h / 2;
    let closest: PublicLotParcel | null = null;
    let closestScore = Infinity;

    for (const candidate of parcels) {
      if (candidate.local_key === current.local_key) continue;
      const bounds = boundsOf(candidate);
      if (!bounds) continue;
      const dx = bounds.x + bounds.w / 2 - currentX;
      const dy = bounds.y + bounds.h / 2 - currentY;
      const forward = direction === "right" ? dx : direction === "left" ? -dx : direction === "down" ? dy : -dy;
      if (forward <= 0) continue;
      const cross = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
      const score = forward + cross * 2;
      if (score < closestScore) {
        closest = candidate;
        closestScore = score;
      }
    }
    if (closest) {
      centerMapLotIfHidden(closest);
      setMapCursorKey(closest.local_key);
    }
  }

  function handleMapKeyDown(event: React.KeyboardEvent<SVGGElement>) {
    const directions: Record<string, "left" | "right" | "up" | "down"> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    if (directions[event.key]) {
      event.preventDefault();
      moveMapCursor(directions[event.key]);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      const parcels = visibleRef.current.filter((parcel) => Array.isArray(parcel.map_polygon) && parcel.map_polygon.length >= 3);
      if (parcels.length > 0) {
        event.preventDefault();
        const parcel = parcels[event.key === "Home" ? 0 : parcels.length - 1];
        centerMapLotIfHidden(parcel);
        setMapCursorKey(parcel.local_key);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      searchInputRef.current?.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const parcel = visibleRef.current.find((item) => item.local_key === mapCursorParcel?.local_key) ?? visibleRef.current[0];
      if (!parcel) return;
      event.preventDefault();
      detailsFocusTargetRef.current = parcel.local_key;
      handleParcelClick(parcel);
      setDetailsFocusRevision((revision) => revision + 1);
    }
  }

  function endGestureListeners() {
    window.removeEventListener("pointermove", onGestureMove);
    window.removeEventListener("pointerup", onGestureUp);
    window.removeEventListener("pointercancel", onGestureUp);
  }

  function viewportCenter(): { x: number; y: number } {
    const z = zoomRef.current;
    const vbH = viewBoxHRef.current;
    const pts = [...pointersRef.current.values()];
    const svg = svgRef.current;
    const rect = svg?.getBoundingClientRect();
    if (pts.length < 2 || !rect?.width || !rect.height) return { x: 50, y: vbH / 2 };
    const cxPx = (pts[0].x + pts[1].x) / 2;
    const cyPx = (pts[0].y + pts[1].y) / 2;
    return clientPointToMapCoordinate(
      cxPx,
      cyPx,
      rect,
      mapViewportBounds(panRef.current, z, 100, vbH, cardPadRef.current),
    ) ?? { x: 50, y: vbH / 2 };
  }

  function onGestureMove(event: PointerEvent) {
    const pointers = pointersRef.current;
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const g = gestureRef.current;
    if (!g) return;
    const z = zoomRef.current;
    const vbH = viewBoxHRef.current;
    if (pointers.size >= 2) {
      if (!pinchRef.current) {
        pinchRef.current = { startDist: 0, startZoom: z, center: viewportCenter() };
        const [a, b] = [...pointers.values()];
        pinchRef.current.startDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
      const pinch = pinchRef.current;
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.startDist > 0 && dist > 0) {
        g.moved = true;
        const next = (pinch.startZoom * dist) / pinch.startDist;
        const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
        setZoom(clamped);
        setPan(mapPanAfterZoom(panRef.current, z, clamped, pinch.center, 100, vbH, cardPadRef.current));
      }
      return;
    }
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dx = ((event.clientX - g.startX) / rect.width) * (100 / z);
    const dy = ((event.clientY - g.startY) / rect.height) * (vbH / z);
    if (Math.abs(event.clientX - g.startX) + Math.abs(event.clientY - g.startY) > 6) g.moved = true;
    if (g.moved) setPan(clampPanTo(g.panX - dx, g.panY - dy, z, vbH, cardPadRef.current));
  }

  function onGestureUp(event: PointerEvent) {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size > 0) {
      // Pinch lifting one finger: re-base the surviving single-finger pan
      // and never select after a multi-touch gesture.
      pinchRef.current = null;
      const remaining = [...pointersRef.current.values()][0];
      const g = gestureRef.current;
      if (g) {
        g.startX = remaining.x;
        g.startY = remaining.y;
        g.panX = panRef.current.x;
        g.panY = panRef.current.y;
        g.moved = true;
        g.downLotKey = null;
      }
      return;
    }
    endGestureListeners();
    const g = gestureRef.current;
    gestureRef.current = null;
    pinchRef.current = null;
    if (!g || g.moved) return;
    // Tap/click with no drag: decide at pointerup. Prefer the lot under the
    // release point (finger slop), fall back to the down-target lot, else an
    // empty release clears the unlocked selection. No click events involved.
    const upLot = lotKeyAtPoint(event.clientX, event.clientY);
    const target = upLot ?? g.downLotKey;
    if (target != null) {
      selectLotByKey(target);
    } else if (!pickModeRef.current) {
      setInternalSelectedKey(null);
      setHoveredLocalKey(null);
    } else {
      setHoveredLocalKey(null);
    }
  }

  function beginGesture(event: React.PointerEvent<SVGSVGElement>) {
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!gestureRef.current) {
      const target = event.target as Element | null;
      const id = target?.closest?.("[data-lot-key]")?.getAttribute("data-lot-key");
      gestureRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        panX: panRef.current.x,
        panY: panRef.current.y,
        downLotKey: id != null && id !== "" ? Number(id) : null,
        moved: false,
      };
      window.addEventListener("pointermove", onGestureMove);
      window.addEventListener("pointerup", onGestureUp);
      window.addEventListener("pointercancel", onGestureUp);
    }
  }

  // Damped Ctrl/Cmd+wheel zoom around the cursor (plain wheel keeps
  // scrolling the page — same contract as embedded Google Maps). Native
  // listener so preventDefault actually works; rAF-batched for trackpads.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      const acc = wheelAccum.current;
      wheelAccum.current = 0;
      if (!acc) return;
      const client = wheelClient.current;
      const rect = svg.getBoundingClientRect();
      let cx = 50;
      let cy = viewBoxH / 2;
      if (client && rect.width && rect.height) {
        const point = clientPointToMapCoordinate(
          client.x,
          client.y,
          rect,
          mapViewportBounds(pan, zoom, 100, viewBoxH, cardPad),
        );
        if (point) {
          cx = point.x;
          cy = point.y;
        }
      }
      zoomTo(zoom * Math.exp(-acc * 0.0015), cx, cy);
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      wheelAccum.current += event.deltaY;
      wheelClient.current = { x: event.clientX, y: event.clientY };
      if (!raf) raf = requestAnimationFrame(apply);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      svg.removeEventListener("wheel", onWheel);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, pan, viewBoxH]);

  function handleParcelClick(parcel: PublicLotParcel) {
    // Selection only opens the detail card. The inquiry modal opens solely
    // from the card's Inquire button — never as a side effect of selection,
    // so tapping a lot can never be swallowed by a modal.
    setMapCursorKey(parcel.local_key);
    setInternalSelectedKey(parcel.local_key);
    if (correctionMapLayer && parcel.correction_key) correctionMapLayer.onSelect(parcel.correction_key);
    onSelectLot?.(parcel);
    if (previewLayout || correctionMapLayer) zoomToParcel(parcel);
    if (pickMode && parcel.status === "Available" && parcel.public_ref) onToggleLot(parcel);
  }

  function polygonFor(parcel: PublicLotParcel): Array<{ x: number; y: number }> {
    const edit = correctionMapLayer?.geometryEdit;
    if (edit && parcel.correction_key === edit.key) return geometryDraft ?? edit.polygon;
    return Array.isArray(parcel.map_polygon) ? parcel.map_polygon : [];
  }

  function reviewStyle(parcel: PublicLotParcel): { fill: string; stroke: string; label: string } {
    const status = correctionMapLayer?.reviewStatusByKey[parcel.correction_key ?? ""] ?? "unreviewed";
    return CORRECTION_REVIEW_STYLE[status] ?? CORRECTION_REVIEW_STYLE.unreviewed;
  }

  function updateGeometryVertex(
    event: React.PointerEvent<SVGCircleElement>,
    phase: "start" | "move" | "end",
    index: number,
    key: string,
  ): void {
    if (!correctionMapLayer?.geometryEdit || correctionMapLayer.geometryEdit.key !== key) return;
    event.stopPropagation();
    if (phase === "start") {
      event.preventDefault();
      activeVertexRef.current = { key, index, pointerId: event.pointerId };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const active = activeVertexRef.current;
    if (!active || active.pointerId !== event.pointerId || active.key !== key || active.index !== index) return;
    if (phase === "move") {
      const svg = svgRef.current;
      const ctm = svg?.getScreenCTM();
      if (!ctm) return;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
      const next = (geometryDraftRef.current ?? correctionMapLayer.geometryEdit.polygon).map((vertex, vertexIndex) =>
        vertexIndex === index
          ? { x: Math.max(0, Math.min(100, point.x)), y: Math.max(0, Math.min(100, point.y / yScale)) }
          : vertex,
      );
      geometryDraftRef.current = next;
      setGeometryDraft(next);
      return;
    }
    activeVertexRef.current = null;
    const draft = geometryDraftRef.current;
    if (draft) correctionMapLayer.onGeometryDraftChange?.(key, draft.map((vertex) => ({ ...vertex })));
  }

  function clearSelection() {
    setHoveredLocalKey(null);
    setInternalSelectedKey(null);
    onClearSelection?.();
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden bg-background motion-reduce:[&_button]:transition-none motion-reduce:[&_polygon]:transition-none",
        tenantScope,
        expanded && "h-[100dvh] w-screen",
        pseudoFullscreen && "fixed inset-0 z-[100]",
      )}
      style={
        {
          ...themeVars,
          fontFamily: theme.tokens.fontFamily,
          "--lotmap-accent": theme.tokens.accent,
          "--lotmap-muted": theme.tokens.muted,
          ...(pseudoFullscreen
            ? {
                paddingTop: "env(safe-area-inset-top)",
                paddingBottom: "env(safe-area-inset-bottom)",
                paddingLeft: "env(safe-area-inset-left)",
                paddingRight: "env(safe-area-inset-right)",
              }
            : undefined),
        } as React.CSSProperties
      }
    >
      {theme.cssUrl ? <link rel="stylesheet" href={theme.cssUrl} /> : null}
      <div className="relative z-30 flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2.5 sm:px-5">
        <div className="mr-auto flex min-w-0 flex-wrap items-center gap-x-2">
          <strong className="block max-w-full truncate text-base font-semibold tracking-tight text-primary">
            {mapTitle}
          </strong>
          {proofOfConcept ? (
            <span className="max-w-full rounded-full border border-secondary/25 bg-secondary-soft px-2.5 py-1 text-[11px] font-semibold leading-4 text-secondary" aria-label="Proof of concept; sales details are unapproved">
              Proof of concept · sample data
            </span>
          ) : null}
          <span className="mt-0.5 block basis-full truncate text-xs font-medium text-muted-foreground">
            {correctionMapLayer
              ? "Internal correction view · review states are not sales status"
              : reviewPendingDemo
              ? "Land plan · source review pending"
              : unapprovedWamulePreview
                ? "Sales details are not approved for publication."
              : payload?.project?.name ?? "Explore the development plan"}
          </span>
        </div>
        <div className="relative order-1 w-full md:order-none md:w-auto">
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && searchResults.length > 0) {
                event.preventDefault();
                searchResultsRef.current?.querySelector("button")?.focus();
              } else if (event.key === "Escape" && normalizedQuery) {
                event.preventDefault();
                setQuery("");
              }
            }}
            placeholder={correctionMapLayer ? "Search detection reference" : reviewPendingDemo ? "Search plan label" : "Search lot, tier, status"}
            aria-label={correctionMapLayer ? "Search detected polygons by reference" : "Search lots"}
            aria-controls={searchResultsId}
            aria-describedby={`${searchResultsId}-instructions`}
            aria-expanded={normalizedQuery.length > 0}
            className="focus-ring h-11 w-full rounded-md border border-border bg-background px-3 text-sm placeholder:text-muted-foreground md:w-44"
          />
          <span id={`${searchResultsId}-instructions`} className="sr-only">
            {correctionMapLayer
              ? "When results appear, press Arrow Down to move into them. Use Arrow Up or Escape to return to search; press Enter on a detected polygon to select it."
              : "When results appear, press Arrow Down to move into them. Use Arrow Up or Escape to return to search; press Enter on a lot to open its details."}
          </span>
          {normalizedQuery ? (
            <div
              ref={searchResultsRef}
              id={searchResultsId}
              role="region"
              aria-label={correctionMapLayer ? "Detection search results" : "Lot search results"}
              className="absolute left-0 right-auto top-full z-50 mt-1 max-h-64 w-72 max-w-[calc(100vw-1.5rem)] overflow-auto rounded-md border border-border bg-card p-2 shadow-lg"
            >
              <p className="px-1 pb-1 text-xs text-muted-foreground" role="status" aria-live="polite">
                {visibleParcels.length === 0
                  ? correctionMapLayer ? "No matching detected polygons." : "No matching lots."
                  : visibleParcels.length > SEARCH_RESULT_LIMIT
                    ? `Showing ${SEARCH_RESULT_LIMIT} of ${visibleParcels.length} matching ${correctionMapLayer ? "detected polygons" : "lots"}; refine your search.`
                    : `${visibleParcels.length} matching ${correctionMapLayer ? (visibleParcels.length === 1 ? "detected polygon" : "detected polygons") : (visibleParcels.length === 1 ? "lot" : "lots")}.`}
              </p>
              {searchResults.length > 0 ? (
                <ul className="grid gap-1">
                  {searchResults.map((parcel) => (
                    <li key={parcel.local_key}>
                      <button
                        type="button"
                        aria-label={correctionMapLayer
                          ? `Select detected polygon ${parcel.lot_number}`
                          : `Show details for Lot ${parcel.lot_number}, ${reviewPendingDemo ? "source review pending" : `${parcel.tier_label ?? parcel.tier_key ?? "unclassified"}, ${parcel.status}${unapprovedWamulePreview ? ", sample data" : ""}`}`}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowUp") {
                            event.preventDefault();
                            const previous = event.currentTarget.closest("li")?.previousElementSibling?.querySelector("button");
                            if (previous instanceof HTMLButtonElement) previous.focus();
                            else searchInputRef.current?.focus();
                          } else if (event.key === "ArrowDown") {
                            event.preventDefault();
                            const next = event.currentTarget.closest("li")?.nextElementSibling?.querySelector("button");
                            if (next instanceof HTMLButtonElement) next.focus();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            searchInputRef.current?.focus();
                          }
                        }}
                        onClick={() => {
                          const willSelect =
                            !pickMode ||
                            (parcel.status === "Available" &&
                              Boolean(parcel.public_ref) &&
                              !highlighted.includes(parcel.local_key));
                          detailsFocusTargetRef.current = willSelect ? parcel.local_key : null;
                          handleParcelClick(parcel);
                          setDetailsFocusRevision((revision) => revision + 1);
                        }}
                        className="focus-ring flex min-h-11 w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm hover:bg-primary-soft"
                      >
                        <span className="font-semibold text-foreground">{correctionMapLayer ? `Detection ${parcel.lot_number}` : `Lot ${parcel.lot_number}`}</span>
                        <span className="truncate text-muted-foreground">
                          {reviewPendingDemo
                            ? "Review pending"
                            : `${parcel.tier_label ?? parcel.tier_key ?? "Unclassified"} · ${parcel.status}${unapprovedWamulePreview ? " · sample" : ""}`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
        {!reviewPendingDemo ? <div className="order-2 flex min-w-0 flex-1 rounded-md border border-border md:order-none md:flex-initial" role="group" aria-label="Colour view">
          {(["status", "tier"] as PublicLotColourView[]).map((value) => (
            <button
              key={value}
              type="button"
              aria-label={value === "status" ? "Status colours" : "Tier colours"}
              aria-pressed={colourView === value}
              onClick={() => setColourView(value)}
              className={cn(
                "focus-ring relative min-h-11 min-w-0 flex-1 px-2 text-xs font-semibold capitalize transition whitespace-nowrap first:rounded-l-md last:rounded-r-md sm:px-3 sm:text-sm md:flex-initial",
                colourView === value ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-primary",
              )}
            >
              <span className="sm:hidden">{value === "status" ? "Status" : "Tier"}</span>
              <span className="hidden sm:inline">{value === "status" ? "Status colours" : "Tier colours"}</span>
            </button>
          ))}
        </div> : null}
        {!reviewPendingDemo ? <div className="order-2 flex min-w-0 flex-1 rounded-md border border-border md:order-none md:flex-initial" role="group" aria-label="Lot filter">
          {(["all", "available"] as PublicLotFilter[]).map((value) => (
            <button
              key={value}
              type="button"
              aria-label={value === "all" ? "All Lots" : unapprovedWamulePreview ? "Reported available only, sample data" : "Available Only"}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={cn(
                "focus-ring relative min-h-11 min-w-0 flex-1 px-2 text-xs font-semibold transition whitespace-nowrap first:rounded-l-md last:rounded-r-md sm:px-3 sm:text-sm md:flex-initial",
                filter === value ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-primary",
              )}
            >
              <span className="sm:hidden">{value === "all" ? "All" : unapprovedWamulePreview ? "Reported" : "Available"}</span>
              <span className="hidden sm:inline">{value === "all" ? "All Lots" : unapprovedWamulePreview ? "Reported available" : "Available Only"}</span>
            </button>
          ))}
        </div> : null}
      </div>
      {!reviewPendingDemo && tierOptions.length && colourView === "tier" ? (
        <div className="border-b border-border bg-card px-3 py-1.5">
          <button
            type="button"
            aria-expanded={chipsOpen}
            aria-controls="tier-filter-chips"
            onClick={() => setChipsOpen((open) => !open)}
            className="focus-ring flex min-h-11 items-center gap-2 px-1 text-sm font-semibold text-muted-foreground"
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
                      "focus-ring flex min-h-11 items-center gap-2 rounded-full border px-3 text-sm font-semibold transition",
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
      {reviewPendingDemo ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-card px-4 py-2" aria-label="Map legend">
          {correctionMapLayer ? (Object.entries(CORRECTION_REVIEW_STYLE) as Array<[CorrectionReviewStatus, typeof CORRECTION_REVIEW_STYLE[CorrectionReviewStatus]]>).map(([status, style]) => (
            <span key={status} className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: style.fill }} />
              {style.label}
            </span>
          )) : <span className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <svg aria-hidden="true" className="h-4 w-6 shrink-0" viewBox="0 0 24 16">
              <path d="M1 8h22" stroke="var(--lotmap-muted)" strokeWidth="2" />
            </svg>
            Candidate outline · review pending
          </span>}
          <span className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <svg aria-hidden="true" className="h-4 w-6 shrink-0" viewBox="0 0 24 16">
              <path d="M1 8h22" stroke="var(--lotmap-accent)" strokeWidth="4" />
            </svg>
            {correctionMapLayer ? "Selected polygon" : "Selected lot"}
          </span>
        </div>
      ) : colourView === "status" ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-1.5" aria-label="Map legend">
          {[...new Set(visibleParcels.map((parcel) => parcel.status))].map((status) => (
            <span key={status} className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <svg aria-hidden="true" className="h-4 w-4 shrink-0" viewBox="0 0 16 16">
                {STATUS_MARKER_SHAPE[status] === "circle" ? (
                  <circle cx={8} cy={8} r={4} fill={STATUS_STYLE[status].fill} stroke="white" strokeWidth={1} />
                ) : (
                  <polygon
                    points={polygonMarkerPoints(STATUS_MARKER_SHAPE[status], 8, 8, 4)}
                    fill={STATUS_STYLE[status].fill}
                    stroke="white"
                    strokeWidth={1}
                    strokeLinejoin="round"
                  />
                )}
              </svg>
              {status}{unapprovedWamulePreview ? " · sample" : ""}
            </span>
          ))}
          <span className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <svg aria-hidden="true" className="h-4 w-6 shrink-0" viewBox="0 0 24 16">
              <path d="M1 8h22" stroke="var(--lotmap-accent)" strokeWidth="4" />
            </svg>
            Selected lot
          </span>
        </div>
      ) : colourView === "tier" ? (
        <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-1.5 text-sm font-semibold text-muted-foreground" aria-label="Map legend">
          <svg aria-hidden="true" className="h-4 w-6 shrink-0" viewBox="0 0 24 16">
            <path d="M1 8h22" stroke="var(--lotmap-accent)" strokeWidth="4" />
          </svg>
          Selected lot
        </div>
      ) : null}

      <span id={mapInstructionsId} className="sr-only">
        {correctionMapLayer
          ? "Use the arrow keys to move between nearby detected polygons. Press Enter or Space to select the polygon; press Escape to return to detection search. Search uses detection references, not official lot numbers."
          : "Use the arrow keys to move between nearby lots. Press Enter or Space to open lot details; press Escape to return to lot search. Search can find any lot by identifier, tier, or status."}
      </span>

        <div className={cn(
          "relative flex min-h-0 flex-1 bg-muted",
          previewLayout && "grid min-w-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[minmax(0,1.6fr)_minmax(20rem,.8fr)] md:grid-rows-1 md:gap-4 md:bg-background md:p-4",
        )}>
        <div
          data-testid={previewLayout ? "candidate-map-viewport" : "buyer-map-viewport"}
          className={cn(
            "relative min-h-0 flex-1 bg-muted",
            previewLayout && "h-auto min-w-0 w-full aspect-[var(--demo-map-aspect)] overflow-hidden md:h-full md:aspect-auto md:rounded-xl md:border md:border-border",
          )}
          style={previewLayout ? ({ "--demo-map-aspect": imageAspect ?? 1.1875 } as React.CSSProperties) : undefined}
        >
        {loading ? (
          <div className="absolute inset-0 animate-pulse p-4 motion-reduce:animate-none" role="status" aria-live="polite">
            <span className="sr-only">Loading lot map…</span>
            <div className="h-full w-full rounded-md bg-border/60" />
          </div>
        ) : null}
        {error && !loading ? (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div className="max-w-sm rounded-md border bg-card p-5">
              <p className="font-semibold text-primary">Map unavailable</p>
              <p className="mt-2 text-sm text-muted-foreground">{error}</p>
              <button
                type="button"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
                className="mt-4 min-h-11 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                Try again
              </button>
            </div>
          </div>
        ) : null}
        {!loading && !error && payload ? (
          <>
            {visibleParcels.length === 0 ? (
              <div className="absolute inset-0 z-10 grid place-items-center p-6 text-center" role="status" aria-live="polite">
                <div className="max-w-sm rounded-md border bg-card/95 p-5 shadow-sm">
                  <p className="font-semibold text-primary">
                    {payload.parcels.length === 0 ? "No lots are published for this project yet." : "No lots match these filters."}
                  </p>
                  {payload.parcels.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        setQuery("");
                        setFilter("all");
                        setDisabledTiers([]);
                      }}
                      className="mt-3 min-h-11 rounded-md border border-border px-3 py-2 text-sm font-semibold text-primary hover:bg-primary-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    >
                      Clear filters and search
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {masterplanUrl ? null : (
              <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
                No site map image published yet.
              </div>
            )}
            <svg
              ref={svgRef}
              viewBox={viewBox}
              preserveAspectRatio="xMidYMid meet"
              className={cn("absolute inset-0 h-full w-full", zoom > MIN_ZOOM && "touch-none")}
              style={{ cursor: "grab" }}
              role="group"
              aria-label={correctionMapLayer ? "Interactive correction map" : "Interactive lot map"}
              onPointerDown={beginGesture}
            >
              <title>Lot map. Drag to pan; use the controls or pinch to zoom.</title>
              {masterplanUrl ? (
                <MapRasterLayer
                  src={masterplanUrl}
                  x={0}
                  y={0}
                  width={100}
                  height={viewBoxH}
                  preserveAspectRatio="none"
                  // Keep the source asset intact; neutralize its printed
                  // tier colors in this buyer view so status/tier overlays
                  // remain the only color-coded data layer. Lower its visual
                  // weight so the source reads as context, not the interface.
                  style={{ filter: "grayscale(1)" }}
                  opacity={0.68}
                />
              ) : null}
              {/* Status/tier layer: outlines only, no fills. The source raster
                  remains unmodified and retains its baked labels, but is
                  displayed grayscale so its tier hues don't compete with the
                  selected buyer color system. */}
              {visibleParcels.map((parcel) => {
                const polygon = polygonFor(parcel);
                if (polygon.length < 3) return null;
                const style = fillFor(parcel, reviewPendingDemo ? "status" : colourView);
                const review = reviewStyle(parcel);
                const selected = highlighted.includes(parcel.local_key);
                const hovered = parcel.local_key === hoveredLocalKey;
                const picked = pickMode && selected;
                return (
                  <MapPolygon
                    key={parcel.local_key}
                    data-lot-key={parcel.local_key}
                    coordinates={polygon}
                    coordinateScale={{ y: yScale }}
                    fill={selected ? "var(--lotmap-accent)" : correctionMapLayer ? review.fill : "none"}
                    fillOpacity={selected ? 0.32 : correctionMapLayer ? 0.13 : 0}
                    stroke={picked ? "#1d4ed8" : selected ? "var(--lotmap-accent)" : correctionMapLayer ? review.stroke : style.stroke}
                    strokeWidth={selected ? 3.5 : hovered || picked ? 1.6 : reviewPendingDemo ? 1.1 : 0.8}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />
                );
              })}
              {/* Hit layer: separate overlay, smallest lots painted last so a
                  tap between overlapping hit paddings selects the smallest
                  lot, not the topmost in data order. Always active. */}
              <g
                id={mapListboxId}
                role="listbox"
                aria-label={correctionMapLayer ? "Detected polygons on the map" : "Lots on the map"}
                aria-describedby={mapInstructionsId}
                aria-activedescendant={mapCursorOptionId}
                aria-multiselectable={pickMode || undefined}
                tabIndex={mapParcels.length > 0 ? 0 : -1}
                className="focus:outline-none focus-visible:outline-none"
                onKeyDown={handleMapKeyDown}
                onFocus={() => {
                  setMapKeyboardFocused(true);
                  if (mapCursorParcel) centerMapLotIfHidden(mapCursorParcel);
                }}
                onBlur={() => setMapKeyboardFocused(false)}
              >
                {[...visibleParcels]
                  .sort((a, b) => {
                    const pa = Array.isArray(a.map_polygon) ? a.map_polygon : [];
                    const pb = Array.isArray(b.map_polygon) ? b.map_polygon : [];
                    return bboxAreaUnits(pa) - bboxAreaUnits(pb);
                  })
                  .map((parcel) => {
                    const polygon = polygonFor(parcel);
                    if (polygon.length < 3) return null;
                    const picked = pickMode && highlighted.includes(parcel.local_key);
                    const tappable = Boolean(correctionMapLayer) || parcel.status === "Available" || parcel.status === "Reserved";
                    return (
                      <MapPolygon
                        key={`hit-${parcel.local_key}`}
                        id={`${mapListboxId}-option-${parcel.local_key}`}
                        role="option"
                        aria-label={correctionMapLayer
                          ? `Detected polygon ${parcel.lot_number}, ${reviewStyle(parcel).label}`
                          : `Lot ${parcel.lot_number}, ${reviewPendingDemo ? "review pending" : `${parcel.tier_label ?? parcel.tier_key ?? "Unclassified"}, ${parcel.status}${unapprovedWamulePreview ? ", sample data" : ""}`}`}
                        aria-selected={pickMode ? highlighted.includes(parcel.local_key) : internalSelectedKey === parcel.local_key}
                        data-lot-key={parcel.local_key}
                        coordinates={polygon}
                        coordinateScale={{ y: yScale }}
                        fill="transparent"
                        stroke="rgba(0,0,0,0)"
                        strokeWidth={HIT_STROKE_PX}
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                        style={{ cursor: tappable ? "pointer" : "default" }}
                        onMouseEnter={() => setHoveredLocalKey(parcel.local_key)}
                        onMouseLeave={() => setHoveredLocalKey((current) => (current === parcel.local_key ? null : current))}
                      >
                      <title>{correctionMapLayer
                        ? `Detected polygon ${parcel.lot_number} — ${reviewStyle(parcel).label}${internalSelectedKey === parcel.local_key ? " — selected" : ""}`
                        : `Lot ${parcel.lot_number} — ${reviewPendingDemo ? "review pending" : `${parcel.tier_label ?? parcel.status}${unapprovedWamulePreview ? " · sample" : ""}`}${picked ? " — selected" : ""}`}</title>
                      </MapPolygon>
                    );
                  })}
              </g>
              {/* Status markers pair color with distinct shapes; tier mode
                  uses one neutral marker shape. Above the hit layer and
                  pointer-transparent (never steals taps or hovers). */}
              {!reviewPendingDemo ? <g aria-hidden="true">
                {visibleParcels.map((parcel) => {
                  const polygon = Array.isArray(parcel.map_polygon) ? parcel.map_polygon : [];
                  if (polygon.length < 3) return null;
                  const style = fillFor(parcel, colourView);
                  const selected = highlighted.includes(parcel.local_key);
                  const xs = polygon.map((p) => p.x);
                  const ys = polygon.map((p) => p.y * yScale);
                  const r = Math.min(
                    Math.max(Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.07, 0.35),
                    0.8,
                  );
                  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
                  const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
                  const markerShape = colourView === "status" ? STATUS_MARKER_SHAPE[parcel.status] : "circle";
                  return (
                    <g key={`marker-${parcel.local_key}`} data-lot-key={parcel.local_key} data-lot-status={parcel.status} data-marker-shape={markerShape}>
                      {markerShape === "circle" ? (
                        <circle
                          cx={cx}
                          cy={cy}
                          r={r}
                          fill={selected ? "var(--lotmap-accent)" : style.fill}
                          stroke="#ffffff"
                          strokeWidth={1}
                          vectorEffect="non-scaling-stroke"
                          pointerEvents="none"
                        />
                      ) : (
                      <polygon
                          points={polygonMarkerPoints(markerShape, cx, cy, r)}
                          fill={selected ? "var(--lotmap-accent)" : style.fill}
                          stroke="#ffffff"
                          strokeWidth={1}
                          strokeLinejoin="round"
                          vectorEffect="non-scaling-stroke"
                          pointerEvents="none"
                        />
                      )}
                    </g>
                  );
                })}
              </g> : null}
              {mapKeyboardFocused && mapCursorPolygon.length >= 3 ? (
                <g aria-hidden="true" pointerEvents="none">
                  <MapPolygon
                    coordinates={mapCursorPolygon}
                    coordinateScale={{ y: yScale }}
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth={7}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                  <MapPolygon
                    coordinates={mapCursorPolygon}
                    coordinateScale={{ y: yScale }}
                    fill="none"
                    stroke="#111827"
                    strokeWidth={3}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              ) : null}
              {visibleParcels.map((parcel) => {
                    if (correctionMapLayer) return null;
                    // Keep one crisp vector label for the selected lot (or,
                    // with no selection, the hovered lot). The source plat
                    // already prints the rest, so avoid duplicating every
                    // label. The transparent hit layer stays active for all lots. The
                    // fs*zoom readability gate below still hides lots that
                    // would render unreadably small.
                    if (parcel.local_key !== (focusLotKey ?? hoveredLocalKey)) return null;
                    const polygon = Array.isArray(parcel.map_polygon) ? parcel.map_polygon : [];
                    if (polygon.length < 3) return null;
                    const xs = polygon.map((p) => p.x);
                    const ys = polygon.map((p) => p.y * yScale);
                    const lotW = Math.max(...xs) - Math.min(...xs);
                    const lotH = Math.max(...ys) - Math.min(...ys);
                    // Label fitted to its own lot on both axes: height-capped
                    // at half the lot height, width-capped so the full lot
                    // number fits inside the lot width — plus a screen-pixel
                    // cap so labels on very large lots (creek/commercial)
                    // don't blow up to billboard size at high zoom. Lots that
                    // would render below a readable size are skipped until
                    // deeper zoom (fs is viewBox units; fs*zoom ≈ screen/15).
                    const label = parcel.lot_number;
                    const pxPerUnit = (svgRef.current?.clientWidth || 800) / (100 / zoom);
                    const fs = Math.min(
                      lotH * 0.5,
                      lotW / (Math.max(label.length, 1) * 0.62),
                      MAX_LABEL_PX / pxPerUnit,
                    );
                    if (!(fs > 0) || fs * zoom < 1.1) return null;
                    return (
                      <text
                        key={`label-${parcel.local_key}`}
                        x={(Math.max(...xs) + Math.min(...xs)) / 2}
                        y={(Math.max(...ys) + Math.min(...ys)) / 2}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={fs}
                        fontWeight={700}
                        fill="#1f2937"
                        stroke="#ffffff"
                        strokeWidth={fs * 0.18}
                        paintOrder="stroke"
                        pointerEvents="none"
                      >
                        {parcel.lot_number}
                      </text>
                    );
                  })}
              {correctionMapLayer?.geometryEdit ? (
                <g aria-label="Editable polygon boundary vertices">
                  {(geometryDraft ?? correctionMapLayer.geometryEdit.polygon).map((point, index) => (
                    <circle
                      key={`vertex-${index}`}
                      cx={point.x}
                      cy={point.y * yScale}
                      r={1.15}
                      fill="#ffffff"
                      stroke="#b84f2d"
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                      role="slider"
                      tabIndex={0}
                      aria-label={`Move boundary point ${index + 1}`}
                      aria-valuetext={`${point.x.toFixed(2)}, ${point.y.toFixed(2)} percent`}
                      style={{ cursor: "move", touchAction: "none" }}
                      onPointerDown={(event) => updateGeometryVertex(event, "start", index, correctionMapLayer.geometryEdit!.key)}
                      onPointerMove={(event) => updateGeometryVertex(event, "move", index, correctionMapLayer.geometryEdit!.key)}
                      onPointerUp={(event) => updateGeometryVertex(event, "end", index, correctionMapLayer.geometryEdit!.key)}
                      onPointerCancel={(event) => updateGeometryVertex(event, "end", index, correctionMapLayer.geometryEdit!.key)}
                      onKeyDown={(event) => {
                        const dx = event.key === "ArrowLeft" ? -0.05 : event.key === "ArrowRight" ? 0.05 : 0;
                        const dy = event.key === "ArrowUp" ? -0.05 : event.key === "ArrowDown" ? 0.05 : 0;
                        if (!dx && !dy) return;
                        event.preventDefault();
                        const current = geometryDraftRef.current ?? correctionMapLayer.geometryEdit!.polygon;
                        const next = current.map((vertex, vertexIndex) => vertexIndex === index
                          ? { x: Math.max(0, Math.min(100, vertex.x + dx)), y: Math.max(0, Math.min(100, vertex.y + dy)) }
                          : vertex);
                        geometryDraftRef.current = next;
                        setGeometryDraft(next);
                        correctionMapLayer.onGeometryDraftChange?.(correctionMapLayer.geometryEdit!.key, next);
                      }}
                    />
                  ))}
                </g>
              ) : null}
            </svg>
            <div
              className={cn("absolute bottom-3 right-3 flex flex-col gap-1", focusLot && !previewLayout ? "bottom-48 sm:bottom-3" : "bottom-3", correctionMapLayer && focusLot && !previewLayout && "bottom-3")}
              style={focusLot && narrow && cardHpx > 0 && !previewLayout ? correctionMapLayer ? undefined : { bottom: cardHpx + 24 } : undefined}
            >
              <button
                ref={toggleRef}
                type="button"
                aria-label={expanded ? "Exit fullscreen" : "Enter fullscreen"}
                aria-pressed={expanded}
                onClick={() => (expanded ? exitFullscreen() : enterFullscreen())}
                className="focus-ring grid h-11 w-11 place-items-center rounded-md border border-border bg-card/95 shadow"
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
                onClick={() => zoomBy(0.5)}
                className="focus-ring h-11 w-11 rounded-md border border-border bg-card/95 text-sm font-bold shadow"
              >
                +
              </button>
              <button
                type="button"
                aria-label="Zoom out"
                disabled={zoom <= MIN_ZOOM}
                onClick={() => zoomBy(-0.5)}
                className="focus-ring h-11 w-11 rounded-md border border-border bg-card/95 text-sm font-bold shadow"
              >
                −
              </button>
              <button
                type="button"
                aria-label="Reset zoom"
                onClick={() => resetZoom()}
                className="focus-ring h-11 w-11 rounded-md border border-border bg-card/95 text-sm font-bold shadow"
              >
                ⟲
              </button>
            </div>
            {expanded ? (
              <button
                ref={closeRef}
                type="button"
                onClick={() => exitFullscreen()}
                className="focus-ring absolute right-3 top-3 z-10 min-h-11 rounded-md border border-border bg-card/95 px-3 text-sm font-semibold shadow"
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
            {focusLot && !previewLayout && !correctionMapLayer ? (
              <div
                ref={cardRef}
                role="region"
                aria-label={`Details for Lot ${focusLot.lot_number}`}
                tabIndex={-1}
                className={cn(
                  "focus-ring absolute bottom-3 left-3 right-3 rounded-md border bg-card/95 p-3 text-sm shadow-lg sm:left-auto sm:right-14 sm:w-64",
                  expanded && "max-h-[50dvh] overflow-auto md:bottom-auto md:right-3 md:top-14 md:w-72",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-primary">Lot {focusLot.lot_number}</strong>
                  <span className="flex items-center gap-1">
                    <span className="rounded-full border border-border bg-muted px-3 py-1 text-sm font-semibold text-foreground">
                      {focusLot.status}
                    </span>
                    {!pickMode ? (
                      <button
                        type="button"
                        aria-label={`Close details for Lot ${focusLot.lot_number}`}
                        onClick={clearSelection}
                        className="focus-ring grid h-11 w-11 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        ✕
                      </button>
                    ) : null}
                  </span>
                </div>
                {cardConfig.showTier && focusLot.tier_label ? <p className="mt-1 text-muted-foreground">{focusLot.tier_label}</p> : null}
                {cardConfig.showArea ? (
                  <p className="mt-1 text-muted-foreground">
                    {focusLot.area_sqm !== null && focusLot.area_sqm !== undefined
                      ? formatAreaDualUnit(focusLot.area_sqm)
                      : (focusLot.dimensions ?? "Size TBC")}
                  </p>
                ) : null}
                {showPrices && cardConfig.showPrice ? <p className="mt-1 font-semibold text-primary">{money(focusLot.price)}</p> : null}
                <button
                  type="button"
                  aria-label={applyCardText(cardConfig.zoomText, focusLot.lot_number)}
                  onClick={() => zoomToParcel(focusLot)}
                  className="focus-ring mt-2 min-h-11 w-full rounded-md border border-border bg-card px-3 py-2 text-sm font-semibold text-primary hover:bg-muted"
                >
                  {applyCardText(cardConfig.zoomText, focusLot.lot_number)}
                </button>
                {pickMode && focusLot.status === "Available" && focusLot.public_ref ? (
                  <button
                    type="button"
                    onClick={() => {
                      const adding = !highlighted.includes(focusLot.local_key);
                      onToggleLot(focusLot);
                      setToast(adding ? `Lot ${focusLot.lot_number} added to your preferences` : `Lot ${focusLot.lot_number} removed`);
                    }}
                    className="focus-ring mt-2 min-h-11 w-full rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
                  >
                    {highlighted.includes(focusLot.local_key) ? `Remove Lot ${focusLot.lot_number}` : `Select Lot ${focusLot.lot_number}`}
                  </button>
                ) : null}
                {!pickMode && (focusLot.status === "Available" || focusLot.status === "Reserved") && focusLot.public_ref && enableInquiry ? (
                  <button
                    type="button"
                    onClick={() => {
                      setInquiryWaitlist(focusLot.status === "Reserved");
                      setInquiryLot(focusLot);
                    }}
                    className="focus-ring mt-2 min-h-11 w-full rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
                  >
                    {focusLot.status === "Reserved"
                      ? applyCardText(cardConfig.waitlistText, focusLot.lot_number)
                      : applyCardText(cardConfig.inquireText, focusLot.lot_number)}
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
        </div>
        {previewLayout && !loading && !error ? (
          <aside className="flex min-h-0 min-w-0 flex-col overflow-y-auto border-t border-border bg-card px-4 py-4 md:rounded-xl md:border md:px-6 md:py-6" aria-label="Lot details">
            {focusLot ? reviewPendingDemo ? (
              <section
                ref={detailsPanelRef}
                role="region"
                aria-label={`Details for Lot ${focusLot.lot_number}`}
                tabIndex={-1}
                className="focus-ring flex flex-col gap-2 outline-none md:gap-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-muted-foreground">Plan label</p>
                    <h2 className="mt-1 text-xl font-semibold leading-tight text-primary">Lot {focusLot.lot_number}</h2>
                  </div>
                  <button
                    type="button"
                    aria-label={`Close details for Lot ${focusLot.lot_number}`}
                    onClick={clearSelection}
                    className="focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    ✕
                  </button>
                </div>
                <p className="inline-flex w-fit items-center rounded-full border border-border bg-muted px-3 py-1 text-sm font-semibold text-foreground">
                  Review pending
                </p>
                <p className="max-w-prose text-sm leading-5 text-muted-foreground">
                  Traced from the sales plat · register match pending.
                </p>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-y border-border py-3 text-sm md:gap-y-4 md:py-4">
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">Plan classification</dt>
                    <dd className="mt-1 break-words font-medium text-foreground">
                      {focusLot.tier_label ? `Sample · ${focusLot.tier_label}` : "Not confirmed"}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">Plan price</dt>
                    <dd className="mt-1 break-words font-medium text-foreground">
                      {showPrices && cardConfig.showPrice && focusLot.price > 0 ? `${money(focusLot.price)} · sample` : "Not confirmed"}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">Lot area</dt>
                    <dd className="mt-1 break-words font-medium text-foreground">
                      {focusLot.area_sqm ? `${formatAreaDualUnit(focusLot.area_sqm)} · sample` : focusLot.dimensions ? `${focusLot.dimensions} · sample` : "Awaiting reviewed labels"}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">Availability</dt>
                    <dd className="mt-1 break-words font-medium text-foreground">Not published</dd>
                  </div>
                </dl>
                <button
                  type="button"
                  aria-label={applyCardText(cardConfig.zoomText, focusLot.lot_number)}
                  disabled={!Array.isArray(focusLot.map_polygon) || focusLot.map_polygon.length < 3}
                  onClick={() => zoomToParcel(focusLot)}
                  className="focus-ring min-h-11 w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {applyCardText(cardConfig.zoomText, focusLot.lot_number)}
                </button>
                <p className="text-xs leading-5 text-muted-foreground">
                  Sample source values only. The approved register and human crop review are still outstanding.
                </p>
              </section>
            ) : (
              <section
                ref={detailsPanelRef}
                role="region"
                aria-label={`Details for Lot ${focusLot.lot_number}`}
                tabIndex={-1}
                className="focus-ring flex flex-col gap-2 outline-none md:gap-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Lot preview</p>
                    <h2 className="mt-1 text-2xl font-semibold leading-tight tracking-tight text-primary">Lot {focusLot.lot_number}</h2>
                  </div>
                  <button
                    type="button"
                    aria-label={`Close details for Lot ${focusLot.lot_number}`}
                    onClick={clearSelection}
                    className="focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-full border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    ✕
                  </button>
                </div>
                <p className="inline-flex w-fit items-center rounded-full border border-secondary/25 bg-secondary-soft px-3 py-1 text-xs font-semibold text-secondary sm:text-sm">
                  {focusLot.status} · sample
                </p>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-y border-border py-2 text-sm md:gap-y-5 md:py-4">
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">Classification · sample</dt>
                    <dd className="mt-1 break-words font-medium text-foreground">{focusLot.tier_label ?? "Not confirmed"}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">Dimensions · sample</dt>
                    <dd className="mt-1 break-words font-medium text-foreground">
                      {focusLot.area_sqm ? formatAreaDualUnit(focusLot.area_sqm) : focusLot.dimensions ?? "Not confirmed"}
                    </dd>
                  </div>
                  <div className="col-span-2 min-w-0 border-t border-border pt-2 md:pt-3">
                    <dt className="text-xs text-muted-foreground">Price · sample</dt>
                    <dd className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-primary md:text-2xl">
                      {showPrices && cardConfig.showPrice && focusLot.price > 0 ? money(focusLot.price) : "Not confirmed"}
                    </dd>
                  </div>
                  <div className="col-span-2 min-w-0 border-t border-border pt-2 md:pt-3">
                    <dt className="text-xs text-muted-foreground">Availability · sample</dt>
                    <dd className="mt-1 font-medium text-foreground">{focusLot.status}</dd>
                  </div>
                </dl>
                {!Array.isArray(focusLot.map_polygon) || focusLot.map_polygon.length < 3 ? (
                  <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                    This lot has no mapped outline in the current preview.
                  </p>
                ) : null}
                <button
                  type="button"
                  aria-label={applyCardText(cardConfig.zoomText, focusLot.lot_number)}
                  disabled={!Array.isArray(focusLot.map_polygon) || focusLot.map_polygon.length < 3}
                  onClick={() => zoomToParcel(focusLot)}
                  className="focus-ring min-h-11 w-full rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {applyCardText(cardConfig.zoomText, focusLot.lot_number)}
                </button>
                {!pickMode && enableInquiry && focusLot.public_ref ? (
                  <button
                    type="button"
                    onClick={() => {
                      setInquiryWaitlist(false);
                      setInquiryLot(focusLot);
                    }}
                    className="focus-ring min-h-12 w-full rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-hover"
                  >
                    Ask the team about this lot
                  </button>
                ) : (
                  <p className="text-xs leading-4 text-muted-foreground">Inquiry is not configured for this lot yet.</p>
                )}
              </section>
            ) : reviewPendingDemo ? (
              <section className="flex h-full flex-col justify-center gap-3" aria-label="No lot selected">
                <p className="text-sm font-semibold text-muted-foreground">Explore the land plan</p>
                <h2 className="text-xl font-semibold leading-tight text-primary">Choose an outlined lot</h2>
                <p className="max-w-prose text-sm leading-6 text-muted-foreground">
                  Tap a lot on the map, or search for its printed label. The outline and source notes will appear here.
                </p>
                <div className="mt-1 grid grid-cols-2 gap-4 border-y border-border py-4">
                  <div>
                    <p className="text-2xl font-semibold tabular-nums text-primary">{totalMappedParcels}</p>
                    <p className="mt-1 text-xs font-medium text-muted-foreground">Candidate outlines</p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">Under review</p>
                    <p className="mt-1 text-xs font-medium text-muted-foreground">Sales details not published</p>
                  </div>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  Plan labels and classifications are samples; price, size, status and register approval are not complete.
                </p>
              </section>
            ) : (
              <section className="flex h-full flex-col justify-center gap-3" aria-label="No lot selected">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Interactive preview</p>
                <h2 className="text-2xl font-semibold leading-tight tracking-tight text-primary">Explore the development</h2>
                <p className="max-w-prose text-sm leading-6 text-muted-foreground">
                  Select a mapped lot or search by its plan label. Preview information is shown for demonstration only.
                </p>
                <dl className="mt-1 grid grid-cols-2 gap-4 border-y border-border py-4">
                  <div>
                    <dt className="text-2xl font-semibold tabular-nums text-primary">{totalMappedParcels}</dt>
                    <dd className="mt-1 text-xs font-medium text-muted-foreground">Mapped outlines</dd>
                  </div>
                  <div>
                    <dt className="text-2xl font-semibold tabular-nums text-secondary">{totalUnmappedParcels}</dt>
                    <dd className="mt-1 text-xs font-medium text-muted-foreground">Records without geometry</dd>
                  </div>
                </dl>
                <p className="text-xs leading-5 text-muted-foreground">
                  Lot status, price, dimensions and classifications have not been approved against the sales register.
                </p>
              </section>
            )}
          </aside>
        ) : null}
      </div>

      {inquiryLot?.public_ref && payload && enableInquiry ? (
        <PublicInquiryModal
          tenantSlug={payload.tenant.slug}
          tenantName={payload.branding.company_name || payload.tenant.name}
          lotRef={inquiryLot.public_ref}
          lotNumber={inquiryLot.lot_number}
          waitlist={inquiryWaitlist}
          onClose={() => {
            setInquiryLot(null);
            setInquiryWaitlist(false);
          }}
        />
      ) : null}
    </div>
  );
}
