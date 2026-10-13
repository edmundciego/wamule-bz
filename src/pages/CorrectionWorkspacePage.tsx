import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  addWaiver,
  advanceStage,
  applyBatch,
  applyEdit,
  adaptLots,
  adaptTiers,
  adaptUnits,
  buildLegend,
  bulkConfirmRest,
  confirmLot,
  createInitialState,
  evaluateStageGate,
  findDuplicates,
  findGaps,
  logCatalogueEdit,
  lotBBox,
  lotCentroid,
  ONBOARDING_STAGES,
  previewConfidentFill,
  proposeBulkAccept,
  renumberLot,
  uncertainQueue,
  undoLast,
  DraftStore,
  type CorrectionState,
  type LotSlot,
  type OnboardingStage,
  type Waiver,
} from "../lib/correction";
import { getSessionAndProfile } from "../lib/data";
import { supabase } from "../lib/supabase";
import { cn } from "../lib/utils";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Field, Input, Select } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { PublicLotMap, type CorrectionMapLayer, type CorrectionReviewStatus } from "../components/public/PublicLotMap";

/**
 * Slice 1.5 correction workspace inside the authenticated admin app.
 *
 * DEV-only `?demo=1` serves the committed correction fixture
 * (e2e/fixtures/correction via the dev-only /correct/data mount) for
 * hermetic tests — mirroring EmbeddableMapPage's demoDataUrl contract, and
 * eliminated from production bundles. Every other path requires a session
 * plus an admin profile; without one the user lands on /login.
 *
 * Persistence: localStorage drafts keyed per tenant/project until the
 * slice-1.5 migration (correction_drafts + RLS) is applied — the UI says so.
 * Stage gates and publish overlap refusal run through DraftStore, the same
 * enforcement path the server publish endpoint must call.
 */
const DEMO_PREVIEW = import.meta.env.DEV;

type Mode = "numbers" | "tiers" | "gates" | "log" | "labels";

interface WorkspaceData {
  tenant: string;
  project: string;
  lots: ReturnType<typeof adaptLots>;
  tiers: ReturnType<typeof adaptTiers>["tiers"];
  units: ReturnType<typeof adaptUnits>;
  planUrl: string | null;
  actor: string;
  serverBacked: boolean;
  reviewOnly?: boolean;
}

interface BenchmarkCase {
  id: string;
  detection_id: string;
  polygon_pct: Array<{ x: number; y: number }>;
  crop_box_px: [number, number, number, number];
  crop_file: string;
  crop_sha256: string;
  [key: string]: unknown;
}

interface BenchmarkManifest {
  schema_version: number;
  benchmark_id: string;
  source_image: { name: string; sha256: string; width: number; height: number; coordinate_space: string };
  lot_geometry_sha256: string;
  review_key: string;
  cases: BenchmarkCase[];
}

type LabelDecisionStatus = "draft" | "confirmed" | "ambiguous" | "unreadable" | "skipped";

interface LabelDecision {
  status: LabelDecisionStatus;
  printed_number: string;
  printed_area_sqm: string;
  reviewer: string;
  reviewed_at: string | null;
  geometry_issue?: boolean;
  geometry_note?: string;
}

interface GeometryFlag {
  flagged: boolean;
  note: string;
  reviewer: string;
  flagged_at: string;
}

interface LocalBenchmarkReview {
  benchmark_id: string;
  manifest_sha256: string;
  current: number;
  reviewer: string;
  reviews: Record<string, LabelDecision>;
  geometry_flags: Record<string, GeometryFlag>;
}

export function CorrectionWorkspacePage() {
  const [params] = useSearchParams();
  if (DEMO_PREVIEW && params.get("demo") === "1") {
    return <DemoWorkspace reviewOnly={params.get("mode") === "labels"} />;
  }
  return <AuthedWorkspace />;
}

function DemoWorkspace({ reviewOnly = false }: { reviewOnly?: boolean }) {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const base = reviewOnly ? "/correction-review/hopkins/map" : "/correct/data";
        const lotsRes = await fetch(`${base}/lots.json`);
        const tiersRes = reviewOnly ? null : await fetch(`${base}/tiers.json`);
        const unitsRes = reviewOnly ? null : await fetch(`${base}/units.json`);
        if (!lotsRes.ok || (!reviewOnly && (!tiersRes?.ok || !unitsRes?.ok))) {
          throw new Error(reviewOnly ? "Local Hopkins review source is unavailable." : "Correction fixture not found (dev server must serve /correct/).");
        }
        const lotsRaw = await lotsRes.json();
        const tiersRaw = reviewOnly ? {} : await tiersRes!.json();
        const unitsRaw = reviewOnly ? {} : await unitsRes!.json();
        if (cancelled) return;
        const adapted = adaptTiers(tiersRaw);
        setData({
          tenant: reviewOnly ? "hopkins-grove" : adapted.tenant,
          project: reviewOnly ? "map-review" : adapted.project,
          lots: adaptLots(lotsRaw),
          tiers: adapted.tiers,
          units: adaptUnits(unitsRaw),
          planUrl: reviewOnly ? `${base}/masterplan_background.webp` : `${base}/plan.png`,
          actor: reviewOnly ? "local reviewer" : "operator",
          serverBacked: false,
          reviewOnly,
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Fixture load failed.");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [reviewOnly]);
  if (error) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <ErrorState message={error} />
      </main>
    );
  }
  if (!data) {
    return (
      <main className="p-6">
        <LoadingState label="Loading correction fixture" />
      </main>
    );
  }
  return <WorkspaceShell data={data} />;
}

function AuthedWorkspace() {
  const { data: sessionProfile, isLoading, error } = useQuery({
    queryKey: ["session-profile"],
    queryFn: getSessionAndProfile,
    retry: false,
  });
  const tenantId = (sessionProfile?.profile as { tenant_id?: string } | null)?.tenant_id ?? null;
  const actor =
    (sessionProfile?.session as { user?: { email?: string; id?: string } } | null)?.user?.email ??
    (sessionProfile?.session as { user?: { id?: string } } | null)?.user?.id ??
    "operator";

  const board = useQuery({
    queryKey: ["correction-board", tenantId],
    queryFn: async () => {
      const { data, error: qErr } = await supabase.from("parcel_board_view").select("*").order("lot_number");
      if (qErr) throw qErr;
      return (data ?? []) as Array<Record<string, unknown>>;
    },
    enabled: tenantId !== null,
  });
  const tiersQuery = useQuery({
    queryKey: ["correction-tiers", tenantId],
    queryFn: async () => {
      const { data, error: qErr } = await supabase.from("lot_tiers").select("*").eq("tenant_id", tenantId);
      if (qErr) throw qErr;
      return (data ?? []) as Array<Record<string, unknown>>;
    },
    enabled: tenantId !== null,
  });
  const orgQuery = useQuery({
    queryKey: ["correction-org", tenantId],
    queryFn: async () => {
      const { data, error: qErr } = await supabase
        .from("organizations")
        .select("masterplan_image_url")
        .eq("id", tenantId)
        .maybeSingle();
      if (qErr) throw qErr;
      return (data ?? {}) as { masterplan_image_url?: string | null };
    },
    enabled: tenantId !== null,
  });

  if (isLoading) {
    return (
      <main className="p-6">
        <LoadingState label="Checking session" />
      </main>
    );
  }
  if (error) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <ErrorState message={(error as Error).message} />
      </main>
    );
  }
  if (!sessionProfile?.session) return <Navigate to="/login" replace />;
  if (!sessionProfile.profile) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <ErrorState message="Your login does not have an admin profile. Ask a Super Admin to add your user ID to admin_profiles." />
      </main>
    );
  }
  if (board.isLoading || tiersQuery.isLoading) {
    return (
      <main className="p-6">
        <LoadingState label="Loading board lots" />
      </main>
    );
  }
  if (board.error || tiersQuery.error) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <ErrorState message={((board.error ?? tiersQuery.error) as Error).message} />
      </main>
    );
  }
  const adapted = adaptTiers(tiersQuery.data ?? []);
  const data: WorkspaceData = {
    tenant: tenantId ?? "local",
    project: "default",
    lots: adaptLots(
      (board.data ?? []).map((row) => ({
        id: String(row.id),
        lot_number: String(row.lot_number ?? "?"),
        polygon_pct: Array.isArray(row.map_polygon) ? row.map_polygon : [],
        tier_key: typeof row.tier_key === "string" ? row.tier_key : null,
      })),
    ),
    tiers: adapted.tiers,
    units: {},
    planUrl: orgQuery.data?.masterplan_image_url ?? null,
    actor,
    serverBacked: false, // slice-1.5 migration unapplied: local drafts + banner
  };
  // NOTE: rendered outside AdminLayout's Outlet tree (route-level demo
  // bypass requires it); auth is enforced above, and admin nav links here.
  return <WorkspaceShell data={data} />;
}

function storeKey(tenant: string, project: string): string {
  return `cw:${tenant}:${project}`;
}

function restoreLocalCorrectionState(data: WorkspaceData): CorrectionState {
  const initial = createInitialState({
    lots: data.lots.map((lot) => ({ id: lot.id, lot_number: lot.lot_number, polygon_pct: lot.polygon_pct, tier_key: lot.tier_key })),
    tiers: data.tiers,
    units: data.units,
    actor: data.actor,
    tenant: data.tenant,
    project: data.project,
  });
  try {
    const raw = localStorage.getItem(storeKey(data.tenant, data.project));
    if (!raw) return initial;
    const saved = JSON.parse(raw) as Partial<CorrectionState>;
    const savedLots = saved.lots;
    if (!savedLots || typeof savedLots !== "object") return initial;
    const initialIds = Object.keys(initial.lots).sort();
    if (JSON.stringify(Object.keys(savedLots).sort()) !== JSON.stringify(initialIds)) return initial;
    for (const id of initialIds) {
      const candidate = savedLots[id];
      if (!candidate || candidate.id !== id || candidate.lot_number !== initial.lots[id].lot_number ||
        !Array.isArray(candidate.polygon) || candidate.polygon.length < 3) return initial;
    }
    return {
      ...initial,
      ...saved,
      tenant: data.tenant,
      project: data.project,
      actor: data.actor,
      lots: savedLots as CorrectionState["lots"],
      tiers: saved.tiers && typeof saved.tiers === "object" ? saved.tiers : initial.tiers,
      log: Array.isArray(saved.log) ? saved.log : [],
      pointer: Number.isInteger(saved.pointer) ? saved.pointer! : 0,
      waivers: Array.isArray(saved.waivers) ? saved.waivers : [],
      geometry_revisions: saved.geometry_revisions ?? initial.geometry_revisions,
    };
  } catch {
    return initial;
  }
}

function WorkspaceShell({ data }: { data: WorkspaceData }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedMode = searchParams.get("mode");
  const [mode, setMode] = useState<Mode>(() =>
    requestedMode === "labels" ? "labels" : requestedMode === "tiers" || requestedMode === "gates" || requestedMode === "log" ? requestedMode : "numbers",
  );
  const [state, setState] = useState<CorrectionState>(() => restoreLocalCorrectionState(data));
  const [toast, setToast] = useState<string | null>(null);
  // Synchronous mirror of state: mutate() trials the edit on a clone FIRST
  // so refusals (duplicate renumber, two-signal confirm, gate bypass) throw
  // before anything commits. (Trial inside a setState updater would run too
  // late to report — and a throwing updater unmounts the React tree.)
  const stateRef = useRef<CorrectionState | null>(null);
  stateRef.current = state;

  function mutate(fn: (draft: CorrectionState) => void, message?: string): void {
    const prev = stateRef.current ?? state;
    const next: CorrectionState = JSON.parse(JSON.stringify(prev)) as CorrectionState;
    fn(next); // throws on refusal: nothing committed, stored, or logged
    try {
      localStorage.setItem(
        storeKey(next.tenant, next.project),
        JSON.stringify({ lots: next.lots, tiers: next.tiers, log: next.log, pointer: next.pointer, waivers: next.waivers, stage: next.stage, publishedAt: next.publishedAt, geometry_revisions: next.geometry_revisions }),
      );
    } catch {
      /* storage full/blocked: session-only */
    }
    setState(next);
    if (message) {
      setToast(message);
      window.setTimeout(() => setToast(null), 2200);
    }
  }

  const modes: Mode[] = data.reviewOnly ? ["labels"] : ["numbers", "tiers", "gates", "log", "labels"];
  const drawableDetectionCount = Object.values(state.lots).filter((lot) => lot.polygon.length >= 3).length;
  function chooseMode(next: Mode): void {
    setMode(next);
    const params = new URLSearchParams(searchParams);
    params.set("mode", next);
    setSearchParams(params, { replace: true });
  }

  return (
    <section className={data.serverBacked ? "" : "v2-page-shell"}>
      <div className={cn("v2-page-header", mode === "labels" && "py-3 sm:py-4")}>
        <p className="v2-page-kicker">{mode === "labels" ? "Map review · M2 correction" : "Onboarding · Correct"}</p>
        <h1 className="v2-page-title">{mode === "labels" ? "Hopkins Grove map review" : "Correction workspace"}</h1>
        <p className="v2-page-description">
          {data.tenant} / {data.project} · {mode === "labels" ? `${drawableDetectionCount} detected polygons` : `${Object.keys(state.lots).length} lots`} · actor {state.actor}
          {mode === "labels" ? " · source-grounded review only · browser-local until shared drafts are verified" : data.serverBacked ? "" : " · local drafts (server drafts pending migration apply)"}
        </p>
      </div>
      <div className="flex gap-2" role="tablist" aria-label="Workspace modes">
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-label={m === "labels" ? "Lot number review" : m}
            aria-selected={mode === m}
            onClick={() => chooseMode(m)}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-semibold transition",
              mode === m ? "bg-primary-soft text-primary" : "text-muted-foreground hover:text-primary",
            )}
          >
            {m === "labels" ? "Lot number review" : m[0].toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>
      {mode === "numbers" ? <NumbersTab state={state} mutate={mutate} planUrl={data.planUrl} /> : null}
      {mode === "tiers" ? <TiersTab state={state} mutate={mutate} planUrl={data.planUrl} /> : null}
      {mode === "gates" ? <GatesTab state={state} mutate={mutate} /> : null}
      {mode === "log" ? <LogTab state={state} mutate={mutate} /> : null}
      {mode === "labels" ? <LotNumberReviewTab data={data} state={state} mutate={mutate} /> : null}
      {toast ? (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded bg-foreground px-4 py-2 text-sm text-background" role="status">
          {toast}
        </div>
      ) : null}
    </section>
  );
}

function LotNumberReviewTab({
  data,
  state,
  mutate,
}: {
  data: WorkspaceData;
  state: CorrectionState;
  mutate: (fn: (draft: CorrectionState) => void, message?: string) => void;
}) {
  const [manifest, setManifest] = useState<BenchmarkManifest | null>(null);
  const [manifestSha, setManifestSha] = useState("");
  const [sourceVerified, setSourceVerified] = useState(false);
  const [packError, setPackError] = useState<string | null>(null);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [review, setReview] = useState<LocalBenchmarkReview>({
    benchmark_id: "hopkins-grove-lot-number-benchmark-v1",
    manifest_sha256: "",
    current: 0,
    reviewer: data.actor,
    reviews: {},
    geometry_flags: {},
  });
  const [currentIndex, setCurrentIndex] = useState<number | null>(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [numberDraft, setNumberDraft] = useState("");
  const [areaDraft, setAreaDraft] = useState("");
  const [geometryNote, setGeometryNote] = useState("");
  const [geometryEditKey, setGeometryEditKey] = useState<string | null>(null);
  const [geometryDraft, setGeometryDraft] = useState<Array<{ x: number; y: number }> | null>(null);
  const [showOutstanding, setShowOutstanding] = useState(true);
  const [feedback, setFeedback] = useState("");
  const importRef = useRef<HTMLInputElement | null>(null);

  const mappedSlots = useMemo(() => Object.values(state.lots).filter((slot) => slot.polygon.length >= 3), [state.lots]);
  const sourcePolygonFor = useCallback((slot: LotSlot): Array<{ x: number; y: number }> => {
    const original = state.log.find((entry) => entry.lot === slot.id && entry.field === "polygon");
    return Array.isArray(original?.before) ? original.before as Array<{ x: number; y: number }> : slot.polygon;
  }, [state.log]);
  const slotForCase = (item: BenchmarkCase): LotSlot | null =>
    Object.values(state.lots).find((slot) => slot.id === item.detection_id || slot.lot_number === item.detection_id) ?? null;
  const caseGeometryMatches = useCallback((item: BenchmarkCase, slot: LotSlot | null): boolean =>
    Boolean(slot && JSON.stringify(sourcePolygonFor(slot)) === JSON.stringify(item.polygon_pct)), [sourcePolygonFor]);

  useEffect(() => {
    let cancelled = false;
    async function loadPack() {
      setPackError(null);
      try {
        const response = await fetch("/correction-review/hopkins/benchmark/benchmark-manifest.json", { cache: "no-store" });
        if (!response.ok) throw new Error("Local Hopkins benchmark is unavailable. Start the Vite development server with the prepared M1 review artifacts.");
        const raw = await response.text();
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
        const sha = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const parsed = JSON.parse(raw) as BenchmarkManifest;
        if (parsed.schema_version !== 1 || parsed.benchmark_id !== "hopkins-grove-lot-number-benchmark-v1" || parsed.cases?.length !== 60) {
          throw new Error("The review pack is not the expected versioned 60-case Hopkins benchmark.");
        }
        if (!data.planUrl) throw new Error("This workspace has no source image. Number review is blocked until the source drawing is available.");
        const imageResponse = await fetch(data.planUrl, { cache: "no-store" });
        if (!imageResponse.ok) throw new Error("The source drawing could not be verified from this workspace.");
        const imageBlob = await imageResponse.blob();
        const imageDigest = await crypto.subtle.digest("SHA-256", await imageBlob.arrayBuffer());
        const imageSha = Array.from(new Uint8Array(imageDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const bitmap = await createImageBitmap(imageBlob);
        const dimensionsMatch = bitmap.width === parsed.source_image.width && bitmap.height === parsed.source_image.height;
        bitmap.close();
        if (cancelled) return;
        setManifest(parsed);
        setManifestSha(sha);
        setSourceVerified(imageSha === parsed.source_image.sha256 && dimensionsMatch);
        if (imageSha !== parsed.source_image.sha256 || !dimensionsMatch) {
          setPackError("Source image fingerprint or dimensions do not match the benchmark. Label decisions and exports are disabled.");
        }
        const key = `wamule-lot-number-benchmark-v1:${sha}`;
        const saved = JSON.parse(localStorage.getItem(key) || "null") as Partial<LocalBenchmarkReview> | null;
        if (saved?.benchmark_id === parsed.benchmark_id && saved?.manifest_sha256 === sha) {
          const caseIds = new Set(parsed.cases.map((item) => item.id));
          const importedReviews = Object.fromEntries(Object.entries(saved.reviews ?? {}).filter(([id]) => caseIds.has(id)));
          setReview({
            benchmark_id: parsed.benchmark_id,
            manifest_sha256: sha,
            current: Math.max(0, Math.min(parsed.cases.length - 1, Number(saved.current) || 0)),
            reviewer: typeof saved.reviewer === "string" ? saved.reviewer : data.actor,
            reviews: importedReviews,
            geometry_flags: saved.geometry_flags && typeof saved.geometry_flags === "object" ? saved.geometry_flags : {},
          });
          setCurrentIndex(Math.max(0, Math.min(parsed.cases.length - 1, Number(saved.current) || 0)));
        } else {
          setReview((previous) => ({ ...previous, manifest_sha256: sha }));
        }
        setStateLoaded(true);
      } catch (error) {
        if (!cancelled) setPackError(error instanceof Error ? error.message : "Could not load the Hopkins review pack.");
      }
    }
    void loadPack();
    return () => { cancelled = true; };
  }, [data.planUrl, data.actor]);

  useEffect(() => {
    if (!stateLoaded || !manifestSha) return;
    try {
      localStorage.setItem(`wamule-lot-number-benchmark-v1:${manifestSha}`, JSON.stringify(review));
    } catch {
      setFeedback("Browser storage is unavailable. Export your review JSON before leaving this page.");
    }
  }, [review, manifestSha, stateLoaded]);

  useEffect(() => {
    const decision = currentIndex == null || !manifest ? null : review.reviews[manifest.cases[currentIndex]?.id] ?? null;
    setNumberDraft(decision?.printed_number ?? "");
    setAreaDraft(decision?.printed_area_sqm ?? "");
  }, [currentIndex, manifest, review.reviews]);

  useEffect(() => {
    const flag = selectedKey ? review.geometry_flags[selectedKey] : null;
    setGeometryNote(flag?.note ?? "");
    setGeometryEditKey(null);
    setGeometryDraft(null);
  }, [selectedKey, review.geometry_flags]);

  const selectedSlot = selectedKey ? state.lots[selectedKey] ?? null : null;
  const selectedCaseIndex = manifest && selectedSlot
    ? manifest.cases.findIndex((item) => (item.detection_id === selectedSlot.id || item.detection_id === selectedSlot.lot_number) && caseGeometryMatches(item, selectedSlot))
    : -1;
  const activeIndex = selectedCaseIndex >= 0 ? selectedCaseIndex : currentIndex;
  const activeCase = manifest && activeIndex != null ? manifest.cases[activeIndex] ?? null : null;
  const activeDecision = activeCase ? review.reviews[activeCase.id] : undefined;
  const duplicateLabelCases = activeCase && /^\d+$/.test(numberDraft.trim())
    ? manifest?.cases.filter((item) => item.id !== activeCase.id
      && review.reviews[item.id]?.status === "confirmed"
      && review.reviews[item.id]?.printed_number === numberDraft.trim()) ?? []
    : [];
  const activeCaseMatches = Boolean(activeCase && selectedSlot && caseGeometryMatches(activeCase, selectedSlot));
  const canRecordNumber = Boolean(manifest && sourceVerified && activeCase && activeCaseMatches && selectedSlot);
  const reviewedCount = manifest?.cases.filter((item) => ["confirmed", "ambiguous", "unreadable"].includes(review.reviews[item.id]?.status ?? "")).length ?? 0;
  const skippedCount = manifest?.cases.filter((item) => review.reviews[item.id]?.status === "skipped").length ?? 0;
  const unresolvedCount = (manifest?.cases.length ?? 60) - reviewedCount - skippedCount;
  const outstandingCases = manifest?.cases.filter((item) => !["confirmed", "ambiguous", "unreadable"].includes(review.reviews[item.id]?.status ?? "")) ?? [];
  const queueCases = showOutstanding ? outstandingCases : (manifest?.cases ?? []);

  const reviewStatusByKey = useMemo(() => {
    const statuses: Record<string, CorrectionReviewStatus> = {};
    for (const slot of mappedSlots) {
      if (review.geometry_flags[slot.id]?.flagged) {
        statuses[slot.id] = "geometry-issue";
        continue;
      }
      const item = manifest?.cases.find((candidate) => candidate.detection_id === slot.id || candidate.detection_id === slot.lot_number);
      const status = item ? review.reviews[item.id]?.status : undefined;
      statuses[slot.id] = status === "confirmed" ? "reviewed" : status === "ambiguous" ? "ambiguous" : status === "unreadable" ? "unreadable" : status === "skipped" ? "skipped" : "unreviewed";
    }
    return statuses;
  }, [mappedSlots, review.geometry_flags, review.reviews, manifest]);

  const layer = useMemo<CorrectionMapLayer>(() => ({
    title: "Hopkins Grove · internal map review",
    imageUrl: data.planUrl,
    parcels: mappedSlots.map((slot) => ({ key: slot.id, reference: slot.lot_number, polygon: slot.polygon })),
    selectedKey,
    reviewStatusByKey,
    geometryEdit: geometryEditKey && selectedSlot && geometryDraft
      ? { key: geometryEditKey, polygon: geometryDraft }
      : null,
    onSelect: (key) => {
      setSelectedKey(key);
      const slot = state.lots[key];
      const index = manifest?.cases.findIndex((item) =>
        (item.detection_id === slot?.id || item.detection_id === slot?.lot_number) && caseGeometryMatches(item, slot ?? null)) ?? -1;
      if (index >= 0) {
        setCurrentIndex(index);
        setReview((previous) => ({ ...previous, current: index }));
      } else {
        setCurrentIndex(null);
      }
    },
    onGeometryDraftChange: (_key, polygon) => setGeometryDraft(polygon),
  }), [data.planUrl, mappedSlots, selectedKey, reviewStatusByKey, geometryEditKey, selectedSlot, geometryDraft, state.lots, manifest, caseGeometryMatches]);

  function saveDecision(status: LabelDecisionStatus): void {
    if (!activeCase || !selectedSlot || !canRecordNumber) {
      setFeedback("Decision blocked: verify the original source image and exact benchmark polygon before recording.");
      return;
    }
    const reviewer = review.reviewer.trim();
    if (!reviewer) {
      setFeedback("Enter the reviewer name before recording a decision.");
      return;
    }
    const number = numberDraft.trim();
    const area = areaDraft.trim();
    if (status === "confirmed" && !/^\d+$/.test(number)) {
      setFeedback("Enter only the digits printed inside the outlined polygon, or choose ambiguous/unreadable.");
      return;
    }
    if (area && (!/^\d+(?:\.\d+)?$/.test(area) || Number(area) <= 0)) {
      setFeedback("If recording a printed area, use a positive number or leave it blank.");
      return;
    }
    const decision: LabelDecision = {
      status,
      printed_number: status === "confirmed" ? number : "",
      printed_area_sqm: status === "confirmed" ? area : "",
      reviewer,
      reviewed_at: new Date().toISOString(),
      ...(review.geometry_flags[selectedSlot.id]?.flagged ? { geometry_issue: true, geometry_note: review.geometry_flags[selectedSlot.id].note } : {}),
    };
    setReview((previous) => ({ ...previous, current: activeIndex ?? previous.current, reviews: { ...previous.reviews, [activeCase.id]: decision } }));
    setFeedback(status === "confirmed" ? "Source-drawing decision saved locally." : `Marked ${status}; it remains separate from sales status.`);
    if (status === "confirmed" || status === "ambiguous" || status === "unreadable" || status === "skipped") {
      goNextUnresolved(activeIndex ?? 0);
    }
  }

  function goToCase(index: number): void {
    if (!manifest || !manifest.cases[index]) return;
    setCurrentIndex(index);
    setReview((previous) => ({ ...previous, current: index }));
    const slot = slotForCase(manifest.cases[index]);
    setSelectedKey(slot?.id ?? null);
  }

  function goNextUnresolved(from: number): void {
    if (!manifest) return;
    for (let offset = 1; offset <= manifest.cases.length; offset += 1) {
      const index = (from + offset) % manifest.cases.length;
      const status = review.reviews[manifest.cases[index].id]?.status;
      if (!["confirmed", "ambiguous", "unreadable"].includes(status ?? "") && status !== "skipped") {
        goToCase(index);
        return;
      }
    }
    const skipped = manifest.cases.findIndex((item) => review.reviews[item.id]?.status === "skipped");
    if (skipped >= 0) goToCase(skipped);
  }

  function updateGeometryFlag(): void {
    if (!selectedSlot) return;
    const reviewer = review.reviewer.trim();
    if (!reviewer) {
      setFeedback("Enter the reviewer name before saving a geometry flag.");
      return;
    }
    const existing = review.geometry_flags[selectedSlot.id];
    const next: GeometryFlag = {
      flagged: !existing?.flagged,
      note: geometryNote.trim(),
      reviewer,
      flagged_at: new Date().toISOString(),
    };
    setReview((previous) => ({ ...previous, geometry_flags: { ...previous.geometry_flags, [selectedSlot.id]: next } }));
    setFeedback(next.flagged ? "Geometry issue saved locally; no shape was changed." : "Geometry issue flag cleared locally.");
  }

  function beginGeometryEdit(): void {
    if (!selectedSlot) return;
    if (!review.reviewer.trim()) {
      setFeedback("Enter the reviewer name before editing a boundary.");
      return;
    }
    if (!review.geometry_flags[selectedSlot.id]?.flagged) {
      setFeedback("Flag the geometry issue first, then preview a boundary correction.");
      return;
    }
    setGeometryEditKey(selectedSlot.id);
    setGeometryDraft(selectedSlot.polygon.map((point) => ({ ...point })));
    setFeedback("Drag or keyboard-adjust the highlighted vertices. The original boundary is unchanged until you save the preview.");
  }

  function saveGeometryEdit(): void {
    if (!selectedSlot || !geometryDraft || geometryEditKey !== selectedSlot.id) return;
    if (JSON.stringify(selectedSlot.polygon) === JSON.stringify(geometryDraft)) {
      setFeedback("No boundary changes to save.");
      return;
    }
    mutate((draft) => {
      applyEdit(draft, { actor: draft.actor, lot: selectedSlot.id, field: "polygon", before: selectedSlot.polygon, after: geometryDraft });
    }, `${selectedSlot.lot_number} boundary preview saved to the local correction draft`);
    setGeometryEditKey(null);
    setGeometryDraft(null);
    setFeedback("Boundary correction saved to the local correction draft with original geometry and edit history preserved. It is not published.");
  }

  function exportJson(): void {
    if (!manifest || !sourceVerified || !manifestSha) return;
    const cases = manifest.cases.map((item) => {
      const slot = slotForCase(item);
      const decision = review.reviews[item.id] ?? {
        status: "pending",
        printed_number: "",
        printed_area_sqm: "",
        reviewer: "",
        reviewed_at: null,
      };
      return {
        ...item,
        ...decision,
        original_polygon_pct: item.polygon_pct,
        geometry_review: slot ? review.geometry_flags[slot.id] ?? null : null,
        correction_history: slot ? state.log.filter((entry) => entry.lot === slot.id && entry.field === "polygon") : [],
        current_polygon_pct: slot?.polygon ?? null,
      };
    });
    const decisions = cases.filter((item) => ["confirmed", "ambiguous", "unreadable"].includes(String(item.status)));
    const skipped = cases.filter((item) => item.status === "skipped").length;
    const geometryIssues = Object.entries(review.geometry_flags).filter(([, flag]) => flag.flagged).map(([key, flag]) => ({
      correction_key: key,
      detection_reference: state.lots[key]?.lot_number ?? key,
      ...flag,
      original_polygon_pct: state.lots[key] ? sourcePolygonFor(state.lots[key]) : null,
      current_polygon_pct: state.lots[key]?.polygon ?? null,
      correction_history: state.log.filter((entry) => entry.lot === key && entry.field === "polygon"),
    }));
    downloadFile("hopkins-grove-lot-number-ground-truth-v1.json", JSON.stringify({
      schema_version: 1,
      artifact_type: "wamule-lot-number-ground-truth",
      benchmark_id: manifest.benchmark_id,
      export_status: decisions.length === manifest.cases.length ? "complete" : "partial",
      exported_at_utc: new Date().toISOString(),
      reviewer_name: review.reviewer,
      review_summary: { expected_cases: manifest.cases.length, decisions_recorded: decisions.length, skipped, unresolved: manifest.cases.length - decisions.length - skipped },
      source_image: manifest.source_image,
      lot_geometry_sha256: manifest.lot_geometry_sha256,
      benchmark_manifest_sha256: manifestSha,
      cases,
      geometry_issues: geometryIssues,
      persistence: "browser-local; not synchronized or published",
    }, null, 2) + "\n", "application/json");
    setFeedback("Versioned source review JSON exported. It includes polygon, crop, source fingerprint, reviewer, decision, timestamps, and local geometry-edit history.");
  }

  function exportCsv(): void {
    if (!manifest || !sourceVerified) return;
    const escape = (value: unknown) => {
      const text = String(value ?? "");
      return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const rows: unknown[][] = [["id", "printed_number", "printed_area_sqm", "ambiguous", "unreadable", "skipped", "reviewer", "reviewed_at"]];
    for (const item of manifest.cases) {
      const decision = review.reviews[item.id];
      rows.push([
        item.id,
        decision?.status === "confirmed" ? decision.printed_number : "",
        decision?.status === "confirmed" ? decision.printed_area_sqm : "",
        decision?.status === "ambiguous" ? "1" : "",
        decision?.status === "unreadable" ? "1" : "",
        decision?.status === "skipped" ? "1" : "",
        decision?.reviewer ?? "",
        decision?.reviewed_at ?? "",
      ]);
    }
    downloadFile("hopkins-grove-labels.csv", rows.map((row) => row.map(escape).join(",")).join("\n") + "\n", "text/csv;charset=utf-8");
    setFeedback("Scorer-compatible CSV exported. Blank, ambiguous, unreadable, and skipped cases are not scored as numbers.");
  }

  async function importJson(file?: File): Promise<void> {
    if (!file || !manifest || !manifestSha) return;
    try {
      const parsed = JSON.parse(await file.text()) as { artifact_type?: string; benchmark_id?: string; benchmark_manifest_sha256?: string; reviewer_name?: string; cases?: Array<Record<string, unknown>> };
      if (parsed.artifact_type !== "wamule-lot-number-ground-truth" || parsed.benchmark_id !== manifest.benchmark_id || parsed.benchmark_manifest_sha256 !== manifestSha || !Array.isArray(parsed.cases)) {
        throw new Error("This JSON is not an export for the same versioned Hopkins benchmark.");
      }
      const known = new Set(manifest.cases.map((item) => item.id));
      const imported = Object.fromEntries(parsed.cases.filter((item) => typeof item.id === "string" && known.has(item.id)).map((item) => [String(item.id), {
        status: item.status === "confirmed" || item.status === "ambiguous" || item.status === "unreadable" || item.status === "skipped" || item.status === "draft" ? item.status : "draft",
        printed_number: typeof item.printed_number === "string" ? item.printed_number : "",
        printed_area_sqm: typeof item.printed_area_sqm === "string" ? item.printed_area_sqm : typeof item.printed_area_sqm === "number" ? String(item.printed_area_sqm) : "",
        reviewer: typeof item.reviewer === "string" ? item.reviewer : parsed.reviewer_name ?? "",
        reviewed_at: typeof item.reviewed_at === "string" ? item.reviewed_at : null,
      } as LabelDecision]));
      setReview((previous) => ({ ...previous, reviewer: parsed.reviewer_name ?? previous.reviewer, reviews: { ...previous.reviews, ...imported } }));
      setFeedback(`Imported ${Object.keys(imported).length} decisions from a matching exported review JSON.`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Review JSON could not be imported.");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  }

  const cropCase = activeCase;
  const cropPolygon = cropCase?.polygon_pct ?? (selectedSlot ? sourcePolygonFor(selectedSlot) : []);
  const cropBox = cropCase?.crop_box_px ?? polygonCropBox(cropPolygon, 5700, 4800);
  const statusForActive = activeDecision?.status ?? "pending";

  return (
    <div className="correction-review-grid">
      <section className="correction-review-map" aria-label="Hopkins Grove development map">
        <PublicLotMap tenantSlug="correction-review" showPrices={false} correctionMapLayer={layer} />
      </section>
      <aside className="correction-review-panel" aria-label="Lot number review panel">
        <header className="flex items-start justify-between gap-3">
          <div>
            <p className="v2-page-kicker">Independent source review</p>
            <h2 className="mt-1 text-lg font-semibold text-primary">{activeCase ? `Case ${activeCase.id}` : selectedSlot ? "Polygon review" : "Select a polygon"}</h2>
          </div>
          <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
            {statusForActive === "pending" ? "Unreviewed" : statusForActive}
          </span>
        </header>
        <div className="mt-3" aria-label="Benchmark review progress">
          <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground">
            <span>{reviewedCount} / {manifest?.cases.length ?? 60} decisions recorded</span>
            <span>{skippedCount} skipped · {unresolvedCount} unresolved</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={manifest?.cases.length ?? 60} aria-valuenow={reviewedCount} aria-label="Recorded benchmark decisions">
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${(reviewedCount / (manifest?.cases.length ?? 60)) * 100}%` }} />
          </div>
        </div>
        {packError ? <p className="mt-3 rounded-md border border-warning/30 bg-accent-soft p-2.5 text-xs leading-5 text-foreground" role="alert">{packError}</p> : null}
        <p className="mt-3 rounded-md border border-primary/15 bg-primary-soft/50 p-2.5 text-xs leading-5 text-muted-foreground">
          Printed drawing and detected geometry only. The reference is for navigation—not an official lot number. No price, tier, availability, or OCR/AI guess is shown. Progress is browser-local until M4 shared drafts are verified.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Field label="Reviewer">
            <Input value={review.reviewer} onChange={(event) => setReview((previous) => ({ ...previous, reviewer: event.target.value }))} autoComplete="name" placeholder="Reviewer name" />
          </Field>
          <div className="flex items-end gap-2">
            <label className="flex min-h-11 flex-1 items-center gap-2 rounded-md border border-border px-3 text-sm">
              <input type="checkbox" checked={showOutstanding} onChange={(event) => setShowOutstanding(event.target.checked)} />
              Outstanding only
            </label>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
          <label className="sr-only" htmlFor="benchmark-case-select">Benchmark review queue</label>
          <select id="benchmark-case-select" value={activeCase?.id ?? ""} onChange={(event) => {
            const index = manifest?.cases.findIndex((item) => item.id === event.target.value) ?? -1;
            if (index >= 0) goToCase(index);
          }} className="focus-ring h-11 min-w-0 rounded-md border border-border bg-card px-2 text-sm" disabled={!manifest}>
            {queueCases.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.detection_id} · {review.reviews[item.id]?.status ?? "unreviewed"}</option>)}
          </select>
          <Button type="button" variant="outline" disabled={currentIndex == null || currentIndex <= 0} onClick={() => goToCase((currentIndex ?? 0) - 1)} aria-label="Previous benchmark case">←</Button>
          <Button type="button" variant="outline" disabled={!manifest || unresolvedCount === 0} onClick={() => selectedKey == null ? goToCase(currentIndex ?? 0) : goNextUnresolved(currentIndex ?? 0)}>{selectedKey == null ? "Open current target" : "Next unresolved"}</Button>
        </div>

        {selectedSlot ? (
          <div className="mt-3 rounded-lg border border-border bg-background p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Detection reference · not canonical identity</p>
                <p className="mt-1 font-semibold text-foreground">{selectedSlot.lot_number}</p>
              </div>
              <button type="button" className="focus-ring min-h-11 rounded-md px-3 text-sm font-semibold text-muted-foreground hover:bg-muted" onClick={() => { setSelectedKey(null); setCurrentIndex(null); }}>Clear map selection</button>
            </div>
            {cropPolygon.length >= 3 && data.planUrl ? (
              <SourcePolygonCrop imageUrl={data.planUrl} polygon={cropPolygon} cropBox={cropBox} />
            ) : <div className="mt-2 grid min-h-36 place-items-center rounded-md border border-dashed text-sm text-muted-foreground">No traceable polygon crop is available.</div>}
            {cropCase ? (
              <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                Source-bound crop: {cropCase.crop_file} · SHA-256 {cropCase.crop_sha256.slice(0, 12)}… · map outline and crop use original percentage coordinates.
              </p>
            ) : <p className="mt-2 text-[11px] leading-4 text-muted-foreground">Outside the 60-case benchmark. Boundary review can be recorded; no printed-number ground truth is accepted in this scope.</p>}
            {activeCase && selectedCaseIndex >= 0 ? (
              <>
                <p className="mt-3 text-sm leading-5 text-foreground">Review only the number inside the outlined boundary. If it covers multiple lots or cannot be read confidently, mark ambiguous or unreadable. Adjacent labels are context only.</p>
                <Field label="Printed lot number · digits only">
                  <Input value={numberDraft} onChange={(event) => {
                    const value = event.target.value.replace(/\D/g, "");
                    setNumberDraft(value);
                    if (activeCase) setReview((previous) => ({ ...previous, reviews: { ...previous.reviews, [activeCase.id]: { status: "draft", printed_number: value, printed_area_sqm: areaDraft, reviewer: previous.reviewer, reviewed_at: null } } }));
                  }} inputMode="numeric" maxLength={12} placeholder="Read from outlined polygon" disabled={!sourceVerified} />
                </Field>
                {duplicateLabelCases.length > 0 ? (
                  <p className="mt-2 rounded-md border border-warning/30 bg-accent-soft p-2.5 text-xs leading-5 text-foreground" role="alert">
                    Possible duplicate printed number {numberDraft.trim()} is already recorded for {duplicateLabelCases.map((item) => item.detection_id).join(", ")}. Compare both source crops before resolving; this warning does not change canonical identity.
                  </p>
                ) : null}
                <Field label="Printed area (optional; only if independently clear)">
                  <Input value={areaDraft} onChange={(event) => setAreaDraft(event.target.value)} inputMode="decimal" placeholder="Leave blank if unclear" disabled={!sourceVerified} />
                </Field>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Button type="button" onClick={() => saveDecision("confirmed")} disabled={!canRecordNumber}>Confirm printed number</Button>
                  <Button type="button" variant="outline" onClick={() => saveDecision("ambiguous")} disabled={!canRecordNumber}>Ambiguous</Button>
                  <Button type="button" variant="outline" onClick={() => saveDecision("unreadable")} disabled={!canRecordNumber}>Unreadable</Button>
                  <Button type="button" variant="outline" onClick={() => saveDecision("skipped")} disabled={!canRecordNumber}>Skip for later</Button>
                  <Button type="button" variant="outline" className="col-span-2" onClick={() => saveDecision("draft")} disabled={!canRecordNumber}>Save draft</Button>
                </div>
                {!sourceVerified || !activeCaseMatches ? <p className="mt-2 text-xs text-destructive">Review is blocked until the source fingerprint and target polygon match the versioned benchmark.</p> : null}
                {activeDecision?.reviewed_at ? <p className="mt-2 text-xs text-muted-foreground">Saved by {activeDecision.reviewer} · {new Date(activeDecision.reviewed_at).toLocaleString()}</p> : null}
              </>
            ) : null}

            <div className="mt-3 border-t border-border pt-3">
              <p className="text-sm font-semibold text-foreground">Boundary review</p>
              <label className="mt-2 block text-xs font-medium text-muted-foreground" htmlFor="geometry-note">What looks wrong? (optional)</label>
              <textarea id="geometry-note" rows={2} maxLength={300} value={geometryNote} onChange={(event) => setGeometryNote(event.target.value)} className="focus-ring mt-1 w-full resize-y rounded-md border border-border bg-card p-2 text-sm" placeholder="Boundary crosses a neighboring lot…" />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={updateGeometryFlag}>
                  {review.geometry_flags[selectedSlot.id]?.flagged ? "Clear geometry flag" : "Flag geometry issue"}
                </Button>
                {!geometryEditKey ? <Button type="button" variant="outline" onClick={beginGeometryEdit} disabled={!sourceVerified}>Adjust boundary</Button> : null}
              </div>
              {geometryEditKey ? (
                <div className="mt-2 rounded-md border border-secondary/30 bg-secondary-soft/35 p-2.5 text-xs leading-5">
                  Preview mode: drag a white handle or focus one and use arrow keys. Changes remain local until explicitly saved.
                  <div className="mt-2 flex gap-2">
                    <Button type="button" onClick={saveGeometryEdit}>Save boundary preview</Button>
                    <Button type="button" variant="outline" onClick={() => { setGeometryEditKey(null); setGeometryDraft(null); }}>Discard preview</Button>
                  </div>
                </div>
              ) : null}
              {review.geometry_flags[selectedSlot.id]?.flagged ? <p className="mt-2 text-xs font-semibold text-destructive">Geometry issue flagged · {review.geometry_flags[selectedSlot.id].note || "no note"}</p> : null}
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-dashed border-border bg-background p-5 text-sm leading-6 text-muted-foreground">
            <strong className="text-foreground">Choose a polygon on the full development map.</strong> The target appears with its original source crop and review controls here. The map includes all traceable detections; printed-number decisions are limited to the 60-case benchmark.
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3">
          <Button type="button" variant="outline" onClick={() => exportJson()} disabled={!sourceVerified || !manifest}>Export review JSON</Button>
          <Button type="button" variant="outline" onClick={() => exportCsv()} disabled={!sourceVerified || !manifest}>Export scorer CSV</Button>
          <input ref={importRef} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => void importJson(event.target.files?.[0])} />
          <Button type="button" variant="outline" className="col-span-2" onClick={() => importRef.current?.click()} disabled={!manifest}>Import prior review JSON</Button>
        </div>
        {feedback ? <p className="mt-2 rounded-md bg-muted p-2 text-xs leading-5 text-foreground" role="status">{feedback}</p> : null}
        <p className="mt-2 text-[11px] leading-4 text-muted-foreground">No candidate suggestions are loaded or displayed before the independent review. JSON preserves all 60 source cases; CSV stays compatible with the existing OCR scorer.</p>
      </aside>
    </div>
  );
}

function polygonCropBox(polygon: Array<{ x: number; y: number }>, width: number, height: number): [number, number, number, number] {
  if (!polygon.length) return [0, 0, width, height];
  const xs = polygon.map((point) => point.x * width / 100);
  const ys = polygon.map((point) => point.y * height / 100);
  const pad = Math.max(40, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.2);
  const left = Math.max(0, Math.floor(Math.min(...xs) - pad));
  const top = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const right = Math.min(width, Math.ceil(Math.max(...xs) + pad));
  const bottom = Math.min(height, Math.ceil(Math.max(...ys) + pad));
  return [left, top, right, bottom];
}

function SourcePolygonCrop({
  imageUrl,
  polygon,
  cropBox,
}: {
  imageUrl: string;
  polygon: Array<{ x: number; y: number }>;
  cropBox: [number, number, number, number];
}) {
  const [x0, y0, x1, y1] = cropBox;
  const points = polygon.map((point) => `${point.x * 57},${point.y * 48}`).join(" ");
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-border bg-white" data-testid="source-polygon-crop">
      <svg role="img" aria-label="High-resolution subdivision drawing crop with the target polygon outlined" viewBox={`${x0} ${y0} ${Math.max(1, x1 - x0)} ${Math.max(1, y1 - y0)}`} className="block max-h-[280px] w-full">
        <image href={imageUrl} x={0} y={0} width={5700} height={4800} preserveAspectRatio="none" />
        <polygon points={points} fill="rgba(185,79,45,.16)" stroke="#ffffff" strokeWidth={16} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <polygon points={points} fill="none" stroke="#b84f2d" strokeWidth={8} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function downloadFile(name: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------- Numbers ------------------------------- */

function flagChips(slot: LotSlot): string[] {
  const chips: string[] = [];
  if (!slot.hasUnit) chips.push("no-unit");
  if (slot.number == null) chips.push("no-number");
  chips.push(...slot.suspect);
  if (slot.status !== "suggested") chips.push(slot.status);
  return chips;
}

function NumbersTab({
  state,
  mutate,
  planUrl,
}: {
  state: CorrectionState;
  mutate: (fn: (draft: CorrectionState) => void, message?: string) => void;
  planUrl: string | null;
}) {
  const queue = useMemo(() => uncertainQueue(state), [state]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const current = (currentId && state.lots[currentId] ? currentId : queue[0]) ?? Object.keys(state.lots)[0];
  const slot = current ? state.lots[current] : null;
  const [numberDraft, setNumberDraft] = useState("");
  const [areaDraft, setAreaDraft] = useState("");
  const [renumberDraft, setRenumberDraft] = useState("");
  const [fillPreview, setFillPreview] = useState<string[] | null>(null);

  useEffect(() => {
    if (slot) {
      setNumberDraft(slot.number ?? "");
      setAreaDraft(slot.area != null ? String(slot.area) : "");
      setRenumberDraft(slot.lot_number);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const dups = useMemo(() => findDuplicates(state), [state]);
  const gaps = useMemo(() => findGaps(state), [state]);

  function commit(field: "number" | "area"): void {
    if (!slot) return;
    const raw = (field === "number" ? numberDraft : areaDraft).trim();
    if (field === "number" && raw !== "" && !/^\d+$/.test(raw)) return;
    if (field === "area" && raw !== "" && !/^\d+(\.\d+)?$/.test(raw)) return;
    const after = raw === "" ? null : field === "number" ? raw : Number(raw);
    if (after === slot[field]) return;
    mutate(
      (draft) => {
        applyEdit(draft, { actor: draft.actor, lot: slot.id, field, before: slot[field], after });
      },
    );
  }

  function step(dir: 1 | -1): void {
    const idx = queue.indexOf(current ?? "");
    const next = queue[(idx + dir + queue.length) % Math.max(queue.length, 1)];
    if (next) setCurrentId(next);
  }

  function confirm(): void {
    if (!slot) return;
    try {
      mutate((draft) => {
        const s = draft.lots[slot.id];
        // Two-signal check first: refusal throws before any edit lands.
        confirmLot(draft, { actor: draft.actor, id: s.id });
        const nRaw = numberDraft.trim();
        if (nRaw !== (s.number ?? "")) {
          applyEdit(draft, { actor: draft.actor, lot: s.id, field: "number", before: s.number, after: nRaw === "" ? null : nRaw });
        }
        const aRaw = areaDraft.trim();
        const aVal = aRaw === "" ? null : Number(aRaw);
        if (aVal !== s.area) {
          applyEdit(draft, { actor: draft.actor, lot: s.id, field: "area", before: s.area, after: aVal });
        }
      }, `${slot.id} confirmed`);
      step(1);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Confirm refused");
    }
  }

  function renumber(): void {
    if (!slot) return;
    try {
      mutate(
        (draft) => {
          renumberLot(draft, { actor: draft.actor, id: slot.id, newNumber: renumberDraft });
        },
        `${slot.id} renumbered to ${renumberDraft.trim()} (id unchanged)`,
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : "Renumber refused");
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr_320px]">
      <div className="v2-workflow-panel max-h-[60vh] overflow-auto p-2" aria-label="Uncertain-first lot queue">
        {queue.map((id) => {
          const s = state.lots[id];
          return (
            <button
              key={id}
              type="button"
              onClick={() => setCurrentId(id)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted",
                id === current && "bg-primary-soft",
              )}
            >
              <span>
                <strong>Lot {s.number ?? "?"}</strong> <span className="text-xs text-muted-foreground">{s.lot_number} · {id}</span>
              </span>
              <span className="text-xs text-destructive">{flagChips(s).join(" · ") || s.status}</span>
            </button>
          );
        })}
      </div>
      <div className="v2-workflow-panel p-4">
        {slot ? (
          <>
            <h2 className="text-lg font-semibold">
              Lot {slot.number ?? "?"} — {slot.lot_number} <span className="text-xs text-muted-foreground">({slot.id})</span>
            </h2>
            <p className="text-xs text-destructive">{flagChips(slot).join(" · ") || slot.status}</p>
            {slot.confirmed_by ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Confirmed by {slot.confirmed_by.actor} · {slot.confirmed_by.method} · signals {slot.confirmed_by.signals.join("+")}
                {slot.confirmed_by.sampleOf ? ` · sample ${slot.confirmed_by.sampleOf.join(", ")}` : ""}
              </p>
            ) : null}
            <CropCanvas planUrl={planUrl} polygon={slot.polygon} />
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Proposed lot number">
                <Input value={numberDraft} onChange={(e) => setNumberDraft(e.target.value)} onBlur={() => commit("number")} inputMode="numeric" />
              </Field>
              <Field label="Proposed area (sqm)">
                <Input value={areaDraft} onChange={(e) => setAreaDraft(e.target.value)} onBlur={() => commit("area")} inputMode="decimal" />
              </Field>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" onClick={confirm}>
                Confirm (two-signal)
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  mutate((draft) => {
                    applyEdit(draft, { actor: draft.actor, lot: slot.id, field: "status", before: slot.status, after: "locked" });
                  }, `${slot.id} locked`);
                }}
              >
                Lock
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const list = previewConfidentFill(state);
                  setFillPreview(list);
                }}
              >
                Run fill with preview
              </Button>
            </div>
            <div className="mt-3 flex items-end gap-2">
              <Field label="Renumber (display label; id unchanged)">
                <Input value={renumberDraft} onChange={(e) => setRenumberDraft(e.target.value)} />
              </Field>
              <Button type="button" variant="outline" onClick={renumber}>
                Renumber
              </Button>
            </div>
            {fillPreview ? (
              <div className="mt-3 rounded-md border border-dashed p-3 text-sm">
                <p>
                  Would confirm {fillPreview.length} lots: {fillPreview.slice(0, 12).join(", ")}
                  {fillPreview.length > 12 ? ` +${fillPreview.length - 12} more` : ""}
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    type="button"
                    onClick={() => {
                      mutate((draft) => {
                        applyBatch(draft, {
                          actor: draft.actor,
                          edits: (fillPreview ?? []).map((id) => ({ lot: id, field: "status", before: draft.lots[id].status, after: "confirmed" as const })),
                        });
                      }, `${fillPreview.length} lots confirmed`);
                      setFillPreview(null);
                    }}
                  >
                    Confirm {fillPreview.length} lots
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setFillPreview(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No lots.</p>
        )}
      </div>
      <div className="v2-workflow-panel p-4 text-sm" role="status" aria-label="Live duplicates and gaps">
        <p className="font-semibold">Duplicates (live)</p>
        {Object.keys(dups).length ? (
          <ul className="list-disc pl-5">
            {Object.entries(dups).map(([v, ids]) => (
              <li key={v}>
                {v}: {ids.join(", ")}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">none</p>
        )}
        <p className="mt-2 font-semibold">Gaps (flagged, never auto-filled)</p>
        <p className="text-muted-foreground">{gaps.length ? `${gaps.length} missing (${gaps.slice(0, 12).join(", ")}${gaps.length > 12 ? ", …" : ""})` : "none in range"}</p>
      </div>
    </div>
  );
}

function CropCanvas({ planUrl, polygon }: { planUrl: string | null; polygon: Array<{ x: number; y: number }> }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#f4f2ec";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!planUrl || polygon.length < 3) {
      ctx.fillStyle = "#666";
      ctx.font = "14px sans-serif";
      ctx.fillText(planUrl ? "no geometry" : "no plan image", 12, 24);
      return;
    }
    const img = new Image();
    img.onload = () => {
      const [x0, y0, x1, y1] = lotBBox(polygon.map((p) => ({ x: p.x, y: p.y })));
      const mx = Math.max(160 / 57, 0.3 * (x1 - x0)) / 2;
      const my = Math.max(160 / 48, 0.3 * (y1 - y0)) / 2;
      const bx0 = Math.max(0, x0 - mx);
      const by0 = Math.max(0, y0 - my);
      const bx1 = Math.min(100, x1 + mx);
      const by1 = Math.min(100, y1 + my);
      ctx.drawImage(
        img,
        (bx0 / 100) * img.naturalWidth,
        (by0 / 100) * img.naturalHeight,
        ((bx1 - bx0) / 100) * img.naturalWidth,
        ((by1 - by0) / 100) * img.naturalHeight,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    };
    img.src = planUrl;
  }, [planUrl, polygon]);
  return <canvas ref={ref} width={480} height={360} className="mt-3 w-full rounded-md border" />;
}

/* -------------------------------- Tiers -------------------------------- */

function TiersTab({
  state,
  mutate,
  planUrl,
}: {
  state: CorrectionState;
  mutate: (fn: (draft: CorrectionState) => void, message?: string) => void;
  planUrl: string | null;
}) {
  const [activeTier, setActiveTier] = useState<string | null>(null);
  const [lasso, setLasso] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  // Mirror PublicLotMap: viewBox height tracks the plan aspect so polygons
  // sit on their lots instead of squashing (0-100 polygon space).
  const [aspect, setAspect] = useState(900 / 700);
  useEffect(() => {
    if (!planUrl) return;
    const probe = new Image();
    probe.onload = () => {
      if (probe.naturalWidth && probe.naturalHeight) setAspect(probe.naturalWidth / probe.naturalHeight);
    };
    probe.src = planUrl;
  }, [planUrl]);
  const vbH = 100 / aspect;
  const yScale = vbH / 100;
  const legend = buildLegend(state);
  const current = activeTier ?? Object.keys(state.tiers)[0] ?? null;

  function paint(ids: string[], how: string): void {
    if (current == null) return;
    let targets = ids;
    if (how === "block") {
      const sourceTier = state.lots[ids[0]]?.tier_key;
      targets = Object.entries(state.lots)
        .filter(([, s]) => s.tier_key === sourceTier)
        .map(([id]) => id);
    }
    const edits = targets
      .filter((id) => state.lots[id].tier_key !== current)
      .map((id) => ({ lot: id, field: "tier_key", before: state.lots[id].tier_key, after: current }));
    if (!edits.length) return;
    mutate((draft) => {
      applyBatch(draft, { actor: draft.actor, edits });
    }, `${edits.length} lot${edits.length > 1 ? "s" : ""} → ${state.tiers[current]?.label ?? current} (${how})`);
  }

  function svgPoint(svg: SVGSVGElement, e: React.PointerEvent): { x: number; y: number } {
    const pt = new DOMPoint(e.clientX, e.clientY);
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    // DOMPoint.matrixTransform gives SVG user units directly.
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="v2-workflow-panel p-4">
        <svg
          viewBox={`0 0 100 ${vbH}`}
          className="h-auto w-full rounded-md border"
          style={{ touchAction: "none" }}
          role="application"
          aria-label="Tier paint map"
          onPointerDown={(e) => {
            if (e.altKey) return;
            const svg = e.currentTarget;
            dragRef.current = svgPoint(svg, e);
          }}
          onPointerMove={(e) => {
            const start = dragRef.current;
            if (!start) return;
            const p = svgPoint(e.currentTarget, e);
            if (Math.hypot(p.x - start.x, p.y - start.y) < 1) return;
            setLasso({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) });
          }}
          onPointerUp={() => {
            const start = dragRef.current;
            dragRef.current = null;
            if (!lasso || !start) {
              setLasso(null);
              return;
            }
            const inside = Object.entries(state.lots)
              .filter(([, s]) => {
                const [cx, cy] = lotCentroid(s.polygon);
                return cx >= lasso.x && cx <= lasso.x + lasso.w && cy * yScale >= lasso.y && cy * yScale <= lasso.y + lasso.h;
              })
              .map(([id]) => id);
            setLasso(null);
            if (inside.length) paint(inside, "lasso");
          }}
        >
          {Object.entries(state.lots).map(([id, s]) => (
            <polygon
              key={id}
              data-lot={id}
              points={s.polygon.map((p) => `${p.x},${p.y * yScale}`).join(" ")}
              fill={s.tier_key == null ? "#e5e5e5" : (state.tiers[s.tier_key]?.color ?? "#999999")}
              fillOpacity={s.status === "suggested" ? 0.55 : 0.85}
              stroke={current != null && s.tier_key === current ? "#111" : "#fff"}
              strokeWidth={0.25}
              onClick={(ev) => {
                if (lasso) return;
                paint([id], ev.altKey ? "block" : "click");
              }}
            >
              <title>{`${id} — ${s.number ?? "?"} — ${s.tier_key ?? "unassigned"} (${s.status})`}</title>
            </polygon>
          ))}
          {lasso ? (
            <rect x={lasso.x} y={lasso.y} width={lasso.w} height={lasso.h} fill="rgba(29,78,216,0.12)" stroke="#1d4ed8" strokeWidth={0.3} />
          ) : null}
        </svg>
        <p className="mt-2 text-xs text-muted-foreground">
          Click paints · drag lassos · Alt+click paints the whole block sharing that lot&apos;s tier. All paints are logged batches (undo in Log).
        </p>
      </div>
      <div className="v2-workflow-panel p-4">
        {legend.rows.map((row) => (
          <button
            key={row.key}
            type="button"
            onClick={() => setActiveTier(row.key)}
            aria-pressed={current === row.key}
            className={cn("mb-2 flex w-full items-center gap-2 rounded-md border p-2 text-left text-sm", current === row.key && "ring-2 ring-primary")}
          >
            <span className="inline-block h-4 w-4 rounded" style={{ backgroundColor: row.color }} />
            <span>
              <strong>{row.label}</strong> <span className="text-xs text-muted-foreground">{row.key} · {row.count} lots · ${row.price.toLocaleString()}</span>
            </span>
          </button>
        ))}
        <p className="text-sm text-muted-foreground" aria-label="Unassigned counter">
          Unassigned: {legend.unassigned} / {legend.total}
        </p>
        <TierEditor state={state} activeKey={current} mutate={mutate} />
        <div className="mt-3 flex flex-wrap gap-1" aria-label="Embed legend preview">
          {legend.rows
            .filter((r) => r.sellable)
            .map((r) => (
              <span key={r.key} className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: r.color }} />
                {r.label} ({r.count})
              </span>
            ))}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- Gates -------------------------------- */

function TierEditor({
  state,
  activeKey,
  mutate,
}: {
  state: CorrectionState;
  activeKey: string | null;
  mutate: (fn: (draft: CorrectionState) => void, message?: string) => void;
}) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [price, setPrice] = useState("");
  const [color, setColor] = useState("#22c55e");
  const [sellable, setSellable] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function addTier(): void {
    const k = key.trim().toLowerCase();
    if (!/^[a-z0-9_]+$/.test(k)) return setError("Tier key: lowercase, digits, underscores.");
    if (!label.trim()) return setError("Tier name required.");
    const p = Number(price);
    if (!Number.isFinite(p) || p < 0) return setError("Price must be >= 0.");
    if (!/^#[0-9a-fA-F]{6}$/.test(color.trim())) return setError("Color must be #rrggbb.");
    if (state.tiers[k]) return setError("Tier key exists.");
    setError(null);
    mutate((draft) => {
      draft.tiers[k] = { label: label.trim(), color: color.trim(), price: p, sellable };
      logCatalogueEdit(draft, { actor: draft.actor, field: "tier/add", before: null, after: k });
    }, `Tier ${k} added`);
    setKey("");
    setLabel("");
    setPrice("");
  }

  function saveActive(): void {
    if (activeKey == null || !state.tiers[activeKey]) return setError("Pick a tier first.");
    const cur = state.tiers[activeKey];
    const next = {
      label: label.trim() || cur.label,
      color: /^#[0-9a-fA-F]{6}$/.test(color.trim()) ? color.trim() : cur.color,
      price: price.trim() === "" ? cur.price : Number(price),
      sellable,
    };
    if (!Number.isFinite(next.price) || next.price < 0) return setError("Price must be >= 0.");
    setError(null);
    mutate((draft) => {
      const before = { ...draft.tiers[activeKey] };
      draft.tiers[activeKey] = next;
      logCatalogueEdit(draft, { actor: draft.actor, field: `tier/${activeKey}`, before, after: { ...next } });
    }, `Tier ${activeKey} saved`);
  }

  return (
    <div className="mt-3 rounded-md border border-dashed p-3">
      <p className="text-sm font-semibold">Tier editor</p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <Field label="Key">
          <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="garden" />
        </Field>
        <Field label="Name">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Garden Tier" />
        </Field>
        <Field label="Price">
          <Input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Color">
          <Input value={color} maxLength={7} onChange={(e) => setColor(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={sellable} onChange={(e) => setSellable(e.target.checked)} />
          Sellable
        </label>
      </div>
      <div className="mt-2 flex gap-2">
        <Button type="button" variant="outline" onClick={addTier}>
          Add tier
        </Button>
        <Button type="button" variant="outline" onClick={saveActive}>
          Save active tier
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------- Gates -------------------------------- */

function GatesTab({
  state,
  mutate,
}: {
  state: CorrectionState;
  mutate: (fn: (draft: CorrectionState) => void, message?: string) => void;
}) {
  const gate = evaluateStageGate(state);
  const [scope, setScope] = useState<Waiver["scope"]>("lot");
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [bulk, setBulk] = useState<{ proposal: string[]; sample: string[]; seed?: number } | null>(null);
  const [advanceMsg, setAdvanceMsg] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<string | null>(null);

  return (
    <div className="grid gap-4">
      <div className="v2-workflow-panel p-4">
        <div className="flex flex-wrap gap-2" aria-label="Onboarding stages">
          {ONBOARDING_STAGES.map((s: OnboardingStage) => (
            <Badge key={s} tone={s === state.stage ? "blue" : "gray"}>
              {s}
            </Badge>
          ))}
        </div>
        <p className="mt-2 text-sm">
          Gate <strong>{gate.stage}</strong>: {gate.pass ? <Badge tone="green">PASS</Badge> : <Badge tone="red">BLOCKED</Badge>}
        </p>
        {gate.blocking.length ? (
          <ul className="mt-2 list-disc pl-5 text-sm">
            {gate.blocking.map((f, i) => (
              <li key={i}>
                {f.code}: {f.detail}
              </li>
            ))}
          </ul>
        ) : null}
        {gate.waived.length ? (
          <p className="mt-2 text-sm text-muted-foreground">Waived: {gate.waived.map((f) => f.detail).join("; ")}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={() => {
              try {
                mutate((draft) => {
                  advanceStage(draft, draft.actor);
                }, "Stage advanced");
                setAdvanceMsg("Advanced — see stage chips above.");
              } catch (e) {
                setAdvanceMsg(e instanceof Error ? e.message : "Advance refused");
              }
            }}
          >
            Advance stage
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              // Server-path dry-run: ephemeral DraftStore doc, real publish()
              // (overlap refusal + stage gate), discarded afterwards.
              try {
                const s = new DraftStore();
                const snapshot: CorrectionState = JSON.parse(JSON.stringify(state)) as CorrectionState;
                const probe = `${state.project}__dryrun`;
                try {
                  s.create({ tenant: state.tenant, project: probe, state: snapshot, actor: state.actor });
                } catch {
                  // Reuse the probe slot across clicks.
                }
                const probeDoc = s.load(state.tenant, probe, state.tenant);
                s.save({
                  tenant: state.tenant,
                  project: probe,
                  requesterTenant: state.tenant,
                  baseRev: probeDoc.rev,
                  state: snapshot,
                  actor: state.actor,
                });
                const out = s.publish({ tenant: state.tenant, project: probe, requesterTenant: state.tenant, actor: state.actor, existing: [] });
                setDryRun(
                  `Publish dry-run (server path): ${out.plan.matched.length} matched, ${out.plan.created.length} new, no overlaps — would advance to ${out.stage}.`,
                );
              } catch (e) {
                setDryRun(e instanceof Error ? e.message : "Publish dry-run refused");
              }
            }}
          >
            Publish dry-run
          </Button>
        </div>
        {advanceMsg ? <p className="mt-2 text-sm">{advanceMsg}</p> : null}
        {dryRun ? <p className="mt-2 text-sm">{dryRun}</p> : null}
      </div>

      <div className="v2-workflow-panel grid gap-3 p-4 sm:grid-cols-4">
        <Field label="Waiver scope">
          <Select value={scope} onChange={(e) => setScope(e.target.value as Waiver["scope"])}>
            <option value="lot">lot</option>
            <option value="gate">gate</option>
            <option value="duplicate">duplicate</option>
            <option value="gap">gap</option>
          </Select>
        </Field>
        <Field label="Target">
          <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="L-012 / duplicates:105" />
        </Field>
        <Field label="Reason (required)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why this is safe" />
        </Field>
        <div className="flex items-end">
          <Button
            type="button"
            onClick={() => {
              try {
                let wid = "";
                mutate((draft) => {
                  const { addWaiver: add } = { addWaiver };
                  wid = add(draft, { actor: draft.actor, scope, target: target.trim(), reason }).id;
                }, `Waiver ${wid} recorded`);
                setTarget("");
                setReason("");
              } catch (e) {
                alert(e instanceof Error ? e.message : "Waiver refused");
              }
            }}
          >
            Add waiver
          </Button>
        </div>
      </div>
      {state.waivers.length ? (
        <div className="v2-workflow-panel p-4 text-sm">
          <p className="font-semibold">Waivers ({state.waivers.length})</p>
          <ul className="list-disc pl-5">
            {state.waivers.map((w) => (
              <li key={w.id}>
                {w.scope}:{w.target} — {w.reason} <span className="text-muted-foreground">({w.actor}, {w.time})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="v2-workflow-panel p-4">
        <p className="font-semibold">Bulk accept (three signals + reviewed sample)</p>
        <p className="text-xs text-muted-foreground">
          Proposal = suggested lots passing the gating signals (OCR number = working copy equals ingest read; street-run = ±1 neighbour in tier
          within ~1.5 lot widths; scale-area = printed figure vs polygon at measured scale) and not duplicated. Scale-area shows “unavailable” until a
          measured scale is provided and does not gate until then. Sample ≥ 20 (or all when fewer), stratified by tier/block. Any wrong sample lot
          blocks the bulk confirm. Production seeds are server-issued single-use nonces (correction_bulk_seeds, consumed atomically in the database);
          this local preview draws its seed via crypto and never authorizes a server confirm.
        </p>
        {!bulk ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const { proposeBulkAccept: propose } = { proposeBulkAccept };
              const buf = new Uint32Array(1);
              crypto.getRandomValues(buf);
              const seed = buf[0] % 0x7fffffff;
              const next = propose(state, seed);
              setBulk({ ...next, seed } as typeof next & { seed: number });
            }}
          >
            Propose bulk accept
          </Button>
        ) : (
          <>
            <p className="text-sm">
              Proposal {bulk.proposal.length} lots; stratified sample {bulk.sample.length} (seed {(bulk as { seed?: number }).seed ?? "—"}); review
              sample first: {bulk.sample.join(", ") || "—"}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {bulk.sample.map((id) => {
                const s = state.lots[id];
                const done = s?.status === "confirmed" && s.confirmed_by?.method === "manual";
                return (
                  <Button
                    key={id}
                    type="button"
                    variant="outline"
                    disabled={done}
                    onClick={() => {
                      mutate((draft) => {
                        confirmLot(draft, { actor: draft.actor, id });
                      });
                    }}
                  >
                    {done ? `✓ ${id}` : `Confirm sample ${id}`}
                  </Button>
                );
              })}
            </div>
            <div className="mt-2">
              <Button
                type="button"
                onClick={() => {
                  try {
                    let n = 0;
                    mutate((draft) => {
                      const { bulkConfirmRest: rest } = { bulkConfirmRest };
                      n = rest(draft, { actor: draft.actor, proposal: bulk.proposal, sample: bulk.sample }).length;
                    }, `${n} lots bulk-confirmed (sample ${bulk.sample.join(", ")})`);
                    setBulk(null);
                  } catch (e) {
                    alert(e instanceof Error ? e.message : "Bulk confirm refused (confirm the sample first)");
                  }
                }}
              >
                Confirm remaining ({bulk.proposal.length - bulk.sample.length})
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* --------------------------------- Log --------------------------------- */

function LogTab({
  state,
  mutate,
}: {
  state: CorrectionState;
  mutate: (fn: (draft: CorrectionState) => void, message?: string) => void;
}) {
  async function exportSnapshot(): Promise<void> {
    const snapshot = {
      tenant: state.tenant,
      project: state.project,
      exportedAt: new Date().toISOString(),
      actor: state.actor,
      stage: state.stage,
      lots: Object.fromEntries(
        Object.entries(state.lots).map(([k, s]) => [k, { status: s.status, number: s.number, area: s.area, tier_key: s.tier_key, lot_number: s.lot_number }]),
      ),
      tiers: state.tiers,
      logEntries: state.log.length,
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `correction-snapshot-${state.tenant}-${state.project}.json`;
    a.click();
    URL.revokeObjectURL(url);
    mutate((draft) => {
      draft.publishedAt = snapshot.exportedAt;
    }, "Snapshot exported (local stub for backend publish)");
  }

  const rows = [...state.log].slice(Math.max(0, state.pointer - 60), state.pointer).reverse();
  return (
    <div className="v2-workflow-panel p-4">
      <div className="flex gap-2">
        <Button
          type="button"
          disabled={state.pointer === 0}
          onClick={() => {
            mutate((draft) => {
              undoLast(draft);
            }, "Undid last batch");
          }}
        >
          Undo last batch
        </Button>
        <Button type="button" variant="outline" onClick={() => void exportSnapshot()}>
          Publish snapshot (local export)
        </Button>
      </div>
      {!rows.length ? (
        <p className="mt-3 text-sm text-muted-foreground">No edits yet.</p>
      ) : (
        <div className="mt-3 font-mono text-xs">
          {rows.map((e) => (
            <div key={e.seq} className="flex gap-3 border-b py-1">
              <span className="text-muted-foreground">
                #{e.seq} {e.batchId}
              </span>
              <span>
                {e.actor} · {e.lot} · {e.field}
              </span>
              <span>
                {JSON.stringify(e.before)} → {JSON.stringify(e.after)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
