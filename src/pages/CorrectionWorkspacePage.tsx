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
import { WorkspaceScopeBoundary } from "../components/auth/WorkspaceScopeBoundary";
import { useWorkspaceScope } from "../components/auth/workspaceScopeContext";
import { workspaceScopeKey } from "../lib/workspaceScope";
import { supabase } from "../lib/supabase";
import { cn } from "../lib/utils";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Field, Input, Select } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { PublicLotMap } from "../components/public/PublicLotMap";
import type { CorrectionMapLayer, CorrectionReviewStatus } from "../components/map/correctionMapLayer";
import { MapPolygon, MapRasterLayer } from "../components/map/MapPolygon";
import { mapPolygonBounds, mapPolygonToRasterPixels, mapViewBoxHeight, type MapCoordinate } from "../lib/mapGeometry";
import { snapMapPoint, snapMapPointToEdges, validatePolygonShape, validatePolygonSplit } from "../lib/mapPolygonSplit";
import {
  buildApprovedPreviewSnapshot,
  canonicalSha256,
  draftRevisionFingerprint,
  mergeDraftUpdate,
  parseDigitizerProposal,
  parseSplitDraftStore,
  persistApprovalSnapshot,
  samePolygon,
  splitDraftStorageKey,
  type ApprovedPreviewSnapshot,
  type EditableSplitDraft,
  type SplitDraftContext,
  type SplitDraftStore,
} from "../lib/mapApprovalFlow";
import {
  addApprovedPreviewSnapshot,
  localMapPreviewStorageKey,
  notifyLocalMapPreviewUpdated,
  parseLocalMapPreviewStore,
  type LocalMapPreviewScope,
} from "../lib/localMapPreview";

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
  reviewTitle?: string;
  reviewFixture?: "hopkins" | "synthetic";
  reviewBenchmarkBase?: string;
  reviewBenchmarkId?: string;
  reviewExpectedCaseCount?: number;
  reviewDetectionSourceSha256?: string;
  localMapPreviewScope?: LocalMapPreviewScope;
}

interface BenchmarkCase {
  id: string;
  detection_id: string;
  polygon_pct: Array<{ x: number; y: number }>;
  crop_box_px: [number, number, number, number];
  crop_file: string | null;
  crop_sha256: string | null;
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

type SplitChildDecision = "draft" | "confirmed" | "ambiguous" | "unreadable";

interface SplitChildDraft {
  id: string;
  parent_detection_id: string;
  polygon_pct: MapCoordinate[];
  review: {
    status: SplitChildDecision;
    printed_number: string;
    reviewer: string;
    reviewed_at: string | null;
  };
}

interface PolygonSplitOperation {
  operation_id: string;
  parent_detection_id: string;
  parent_polygon_pct: MapCoordinate[];
  proposed_from_polygon_pct: MapCoordinate[];
  source_image_sha256: string;
  created_by: string;
  created_at: string;
  status: "confirmed" | "undone";
  undone_by?: string;
  undone_at?: string;
  unassigned_area_percent: number;
  children: SplitChildDraft[];
}

interface LocalBenchmarkReview {
  benchmark_id: string;
  manifest_sha256: string;
  current: number;
  reviewer: string;
  reviews: Record<string, LabelDecision>;
  geometry_flags: Record<string, GeometryFlag>;
  split_operations: PolygonSplitOperation[];
  ai_suggestion_exposures?: Record<string, { case_id: string; parent_detection_id: string; proposal_fingerprint: string; exposed_at: string; reviewer: string; provider: string }>;
}

export function CorrectionWorkspacePage() {
  const [params] = useSearchParams();
  if (DEMO_PREVIEW && params.get("demo") === "1") {
    return (
      <DemoWorkspace
        reviewOnly={params.get("mode") === "labels"}
        reviewFixture={params.get("fixture") === "synthetic" ? "synthetic" : "hopkins"}
        phaseSlug={params.get("phase") ?? "default"}
      />
    );
  }
  return <WorkspaceScopeBoundary><AuthedWorkspace /></WorkspaceScopeBoundary>;
}

function DemoWorkspace({
  reviewOnly = false,
  reviewFixture = "hopkins",
  phaseSlug = "default",
}: {
  reviewOnly?: boolean;
  reviewFixture?: "hopkins" | "synthetic";
  phaseSlug?: string;
}) {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const reviewBase = reviewFixture === "synthetic" ? "/correction-review/synthetic/map" : "/correction-review/hopkins/map";
        const base = reviewOnly ? reviewBase : "/correct/data";
        const lotsRes = await fetch(`${base}/lots.json`);
        const tiersRes = reviewOnly ? null : await fetch(`${base}/tiers.json`);
        const unitsRes = reviewOnly ? null : await fetch(`${base}/units.json`);
        if (!lotsRes.ok || (!reviewOnly && (!tiersRes?.ok || !unitsRes?.ok))) {
          throw new Error(reviewOnly ? `Local ${reviewFixture} review source is unavailable.` : "Correction fixture not found (dev server must serve /correct/).");
        }
        const lotsText = await lotsRes.text();
        const lotsRaw = JSON.parse(lotsText);
        const detectionDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lotsText));
        const detectionSourceSha256 = Array.from(new Uint8Array(detectionDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const tiersRaw = reviewOnly ? {} : await tiersRes!.json();
        const unitsRaw = reviewOnly ? {} : await unitsRes!.json();
        if (cancelled) return;
        const adapted = adaptTiers(tiersRaw);
        setData({
          tenant: reviewOnly ? (reviewFixture === "synthetic" ? "synthetic-map" : "hopkins-grove") : adapted.tenant,
          project: reviewOnly ? (reviewFixture === "synthetic" ? "portable-review-fixture" : "map-review") : adapted.project,
          lots: adaptLots(lotsRaw),
          tiers: adapted.tiers,
          units: adaptUnits(unitsRaw),
          planUrl: reviewOnly ? `${base}/${reviewFixture === "synthetic" ? "masterplan_background.svg" : "masterplan_background.webp"}` : `${base}/plan.png`,
          actor: reviewOnly ? "local reviewer" : "operator",
          serverBacked: false,
          reviewOnly,
          reviewTitle: reviewOnly ? (reviewFixture === "synthetic" ? "Synthetic map review · test fixture" : "Hopkins Grove map review") : undefined,
          reviewFixture: reviewOnly ? reviewFixture : undefined,
          reviewBenchmarkBase: reviewOnly
            ? reviewFixture === "synthetic" ? "/correction-review/synthetic/benchmark" : "/correction-review/hopkins/benchmark"
            : undefined,
          reviewBenchmarkId: reviewOnly
            ? reviewFixture === "synthetic" ? "wamule-map-renderer-synthetic-v1" : "hopkins-grove-lot-number-benchmark-v1"
            : undefined,
          reviewExpectedCaseCount: reviewOnly ? reviewFixture === "synthetic" ? 6 : 60 : undefined,
          reviewDetectionSourceSha256: reviewOnly ? detectionSourceSha256 : undefined,
          localMapPreviewScope: reviewOnly && reviewFixture === "hopkins" ? {
            tenantSlug: "hopkins-grove",
            projectSlug: "map-review",
            phaseSlug,
          } : undefined,
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Fixture load failed.");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [reviewOnly, reviewFixture, phaseSlug]);
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
  return <WorkspaceShell key={`${data.tenant}:${data.project}`} data={data} />;
}

function AuthedWorkspace() {
  const { workspace, isLoading: workspaceLoading, error: workspaceError } = useWorkspaceScope();
  const scopeKey = workspaceScopeKey(workspace);
  const { data: sessionProfile, isLoading, error } = useQuery({
    queryKey: ["session-profile"],
    queryFn: getSessionAndProfile,
    retry: false,
  });
  const tenantId = workspace?.tenantId ?? null;
  const actor =
    (sessionProfile?.session as { user?: { email?: string; id?: string } } | null)?.user?.email ??
    (sessionProfile?.session as { user?: { id?: string } } | null)?.user?.id ??
    "operator";

  const board = useQuery({
    queryKey: ["correction-board", scopeKey],
    queryFn: async () => {
      const { data, error: qErr } = await supabase.from("parcel_board_view").select("*")
        .eq("tenant_id", tenantId!).eq("project_id", workspace!.projectId).eq("phase_id", workspace!.phaseId).order("lot_number");
      if (qErr) throw qErr;
      return (data ?? []) as Array<Record<string, unknown>>;
    },
    enabled: Boolean(tenantId && workspace),
  });
  const tiersQuery = useQuery({
    queryKey: ["correction-tiers", scopeKey],
    queryFn: async () => {
      const { data, error: qErr } = await supabase.from("lot_tiers").select("*").eq("tenant_id", tenantId);
      if (qErr) throw qErr;
      return (data ?? []) as Array<Record<string, unknown>>;
    },
    enabled: Boolean(tenantId && workspace),
  });
  const orgQuery = useQuery({
    queryKey: ["correction-org", scopeKey],
    queryFn: async () => {
      const { data, error: qErr } = await supabase
        .from("organizations")
        .select("masterplan_image_url")
        .eq("id", tenantId)
        .maybeSingle();
      if (qErr) throw qErr;
      return (data ?? {}) as { masterplan_image_url?: string | null };
    },
    enabled: Boolean(tenantId && workspace),
  });

  if (isLoading || workspaceLoading) {
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
  if (!workspace) {
    return <main className="mx-auto max-w-2xl p-6"><ErrorState message={workspaceError ?? "Choose an accessible workspace before opening the local correction draft."} /></main>;
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
    project: workspace.isDefaultProject ? "default" : workspace.projectId,
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
  return <WorkspaceShell key={`${data.tenant}:${data.project}`} data={data} />;
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
    DEMO_PREVIEW && requestedMode === "labels" ? "labels" : requestedMode === "tiers" || requestedMode === "gates" || requestedMode === "log" ? requestedMode : "numbers",
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

  const modes: Mode[] = DEMO_PREVIEW
    ? data.reviewOnly ? ["labels"] : ["numbers", "tiers", "gates", "log", "labels"]
    : ["numbers", "tiers", "gates", "log"];
  const labelReviewMode = DEMO_PREVIEW && mode === "labels";
  const drawableDetectionCount = Object.values(state.lots).filter((lot) => lot.polygon.length >= 3).length;
  function chooseMode(next: Mode): void {
    setMode(next);
    const params = new URLSearchParams(searchParams);
    params.set("mode", next);
    setSearchParams(params, { replace: true });
  }

  return (
    <section className={data.serverBacked ? "" : "v2-page-shell"}>
      <div className={cn("v2-page-header", labelReviewMode && "py-3 sm:py-4")}>
        <p className="v2-page-kicker">{labelReviewMode ? "Map review · M2 correction" : "Onboarding · Correct"}</p>
        <h1 className="v2-page-title">{labelReviewMode ? data.reviewTitle ?? "Lot number map review" : "Correction workspace"}</h1>
        <p className="v2-page-description">
          {data.tenant} / {data.project} · {labelReviewMode ? `${drawableDetectionCount} detected polygons` : `${Object.keys(state.lots).length} lots`} · actor {state.actor}
          {labelReviewMode ? " · source-grounded review only · browser-local until shared drafts are verified" : data.serverBacked ? "" : " · local drafts (server drafts pending migration apply)"}
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
      {labelReviewMode ? <LotNumberReviewTab data={data} state={state} mutate={mutate} /> : null}
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
  const [splitDrafts, setSplitDrafts] = useState<EditableSplitDraft[]>([]);
  const [approvedSnapshots, setApprovedSnapshots] = useState<ApprovedPreviewSnapshot[]>([]);
  const [splitDraftKey, setSplitDraftKey] = useState<string | null>(null);
  const [splitDraftStoreLoaded, setSplitDraftStoreLoaded] = useState(false);
  const [splitDraftStoreError, setSplitDraftStoreError] = useState<string | null>(null);
  const [activeProposalDraftId, setActiveProposalDraftId] = useState<string | null>(null);
  const [proposalGapAcknowledged, setProposalGapAcknowledged] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const approvalInFlight = useRef(false);
  const proposalImportRef = useRef<HTMLInputElement | null>(null);
  const [review, setReview] = useState<LocalBenchmarkReview>({
    benchmark_id: data.reviewBenchmarkId ?? "hopkins-grove-lot-number-benchmark-v1",
    manifest_sha256: "",
    current: 0,
    reviewer: data.actor,
    reviews: {},
    geometry_flags: {},
    split_operations: [],
        ai_suggestion_exposures: {},
  });
  const [currentIndex, setCurrentIndex] = useState<number | null>(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [numberDraft, setNumberDraft] = useState("");
  const [areaDraft, setAreaDraft] = useState("");
  const [geometryNote, setGeometryNote] = useState("");
  const [geometryEditKey, setGeometryEditKey] = useState<string | null>(null);
  const [geometryDraft, setGeometryDraft] = useState<Array<{ x: number; y: number }> | null>(null);
  const [splitSessionParentKey, setSplitSessionParentKey] = useState<string | null>(null);
  const [splitTracePoints, setSplitTracePoints] = useState<MapCoordinate[]>([]);
  const [splitTraceChildren, setSplitTraceChildren] = useState<MapCoordinate[][]>([]);
  const [splitDrawingEnabled, setSplitDrawingEnabled] = useState(false);
  const [splitEditingChildIndex, setSplitEditingChildIndex] = useState<number | null>(null);
  const [splitPreviewed, setSplitPreviewed] = useState(false);
  const [acknowledgeSplitGap, setAcknowledgeSplitGap] = useState(false);
  const [splitNumberDraft, setSplitNumberDraft] = useState("");
  const [showOutstanding, setShowOutstanding] = useState(true);
  const [feedback, setFeedback] = useState("");
  const importRef = useRef<HTMLInputElement | null>(null);
  const reviewPanelRef = useRef<HTMLElement | null>(null);

  const mappedSlots = useMemo(() => Object.values(state.lots).filter((slot) => slot.polygon.length >= 3), [state.lots]);
  const sourcePolygonFor = useCallback((slot: LotSlot): Array<{ x: number; y: number }> => {
    const original = state.log.find((entry) => entry.lot === slot.id && entry.field === "polygon");
    return Array.isArray(original?.before) ? original.before as Array<{ x: number; y: number }> : slot.polygon;
  }, [state.log]);
  const slotForCase = useCallback((item: BenchmarkCase): LotSlot | null =>
    Object.values(state.lots).find((slot) => slot.id === item.detection_id || slot.lot_number === item.detection_id) ?? null, [state.lots]);
  const caseGeometryMatches = useCallback((item: BenchmarkCase, slot: LotSlot | null): boolean =>
    Boolean(slot && JSON.stringify(sourcePolygonFor(slot)) === JSON.stringify(item.polygon_pct)), [sourcePolygonFor]);

  function readSplitDraftStore(): SplitDraftStore {
    if (!manifest || !manifestSha || !splitDraftKey || !splitDraftStoreLoaded) throw new Error("The versioned local draft store is not ready yet.");
    return parseSplitDraftStore(localStorage.getItem(splitDraftKey), {
      benchmark_id: manifest.benchmark_id,
      benchmark_manifest_sha256: manifestSha,
      source_image_sha256: manifest.source_image.sha256,
    });
  }

  function writeSplitDraftStore(nextStore: SplitDraftStore): void {
    if (!splitDraftKey) throw new Error("The local draft store has no verified source key.");
    localStorage.setItem(splitDraftKey, JSON.stringify(nextStore));
    setSplitDrafts(nextStore.drafts);
    setApprovedSnapshots(nextStore.approved_snapshots ?? []);
  }

  function saveSplitDraft(nextDraft: EditableSplitDraft, expectedRevision: number | null): EditableSplitDraft {
    const latest = readSplitDraftStore();
    const merged = mergeDraftUpdate(latest, nextDraft, expectedRevision);
    writeSplitDraftStore(merged);
    return merged.drafts.find((draft) => draft.draft_id === nextDraft.draft_id)!;
  }

  useEffect(() => {
    let cancelled = false;
    async function loadPack() {
      setPackError(null);
      try {
        const expectedBenchmarkId = data.reviewBenchmarkId ?? "hopkins-grove-lot-number-benchmark-v1";
        const expectedCaseCount = data.reviewExpectedCaseCount ?? 60;
        const benchmarkBase = data.reviewBenchmarkBase ?? "/correction-review/hopkins/benchmark";
        const response = await fetch(`${benchmarkBase}/benchmark-manifest.json`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Local ${data.reviewFixture ?? "Hopkins"} benchmark is unavailable. Start the Vite development server with its prepared review fixtures.`);
        const raw = await response.text();
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
        const sha = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const parsed = JSON.parse(raw) as BenchmarkManifest;
        if (parsed.schema_version !== 1 || parsed.benchmark_id !== expectedBenchmarkId || parsed.cases?.length !== expectedCaseCount) {
          throw new Error(`The review pack is not the expected versioned ${expectedCaseCount}-case ${data.reviewFixture ?? "Hopkins"} benchmark.`);
        }
        if (!data.planUrl) throw new Error("This workspace has no source image. Number review is blocked until a source drawing is available.");
        const imageResponse = await fetch(data.planUrl, { cache: "no-store" });
        if (!imageResponse.ok) throw new Error("The source image could not be verified from this workspace.");
        const imageBlob = await imageResponse.blob();
        const imageDigest = await crypto.subtle.digest("SHA-256", await imageBlob.arrayBuffer());
        const imageSha = Array.from(new Uint8Array(imageDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const dimensions = await readSourceImageDimensions(imageBlob);
        const dimensionsMatch = dimensions.width === parsed.source_image.width && dimensions.height === parsed.source_image.height;
        if (cancelled) return;
        setManifest(parsed);
        setManifestSha(sha);
        setSourceVerified(imageSha === parsed.source_image.sha256 && dimensionsMatch);
        const draftContext: SplitDraftContext = {
          benchmark_id: parsed.benchmark_id,
          benchmark_manifest_sha256: sha,
          source_image_sha256: parsed.source_image.sha256,
        };
        const draftKey = splitDraftStorageKey(draftContext.benchmark_id, sha, parsed.source_image.sha256);
        setSplitDraftKey(draftKey);
        try {
          const savedDrafts = parseSplitDraftStore(localStorage.getItem(draftKey), draftContext);
          setSplitDrafts(savedDrafts.drafts);
          setApprovedSnapshots(savedDrafts.approved_snapshots ?? []);
          setSplitDraftStoreError(null);
        } catch (error) {
          setSplitDraftStoreError(error instanceof Error ? error.message : "Saved local drafts could not be safely restored.");
        } finally {
          setSplitDraftStoreLoaded(true);
        }
        if (imageSha !== parsed.source_image.sha256 || !dimensionsMatch) {
          setPackError("Source image fingerprint or dimensions do not match the benchmark. Label decisions and exports are disabled.");
        }
        const key = `wamule-lot-number-benchmark-v1:${sha}`;
        const saved = JSON.parse(localStorage.getItem(key) || "null") as Partial<LocalBenchmarkReview> | null;
        if (saved?.benchmark_id === parsed.benchmark_id && saved?.manifest_sha256 === sha) {
          const caseIds = new Set(parsed.cases.map((item) => item.id));
          const importedReviews = Object.fromEntries(Object.entries(saved.reviews ?? {}).filter(([id]) => caseIds.has(id)));
          const restoredIndex = Math.max(0, Math.min(parsed.cases.length - 1, Number(saved.current) || 0));
          setReview({
            benchmark_id: parsed.benchmark_id,
            manifest_sha256: sha,
            current: restoredIndex,
            reviewer: typeof saved.reviewer === "string" ? saved.reviewer : data.actor,
            reviews: importedReviews,
            geometry_flags: saved.geometry_flags && typeof saved.geometry_flags === "object" ? saved.geometry_flags : {},
            split_operations: Array.isArray(saved.split_operations) ? saved.split_operations : [],
            ai_suggestion_exposures: saved.ai_suggestion_exposures && typeof saved.ai_suggestion_exposures === "object" ? saved.ai_suggestion_exposures : {},
          });
          setCurrentIndex(restoredIndex);
          setSelectedKey(slotForCase(parsed.cases[restoredIndex])?.id ?? null);
        } else {
          setReview((previous) => ({ ...previous, manifest_sha256: sha }));
        }
        setStateLoaded(true);
      } catch (error) {
        if (!cancelled) setPackError(error instanceof Error ? error.message : "Could not load the map review pack.");
      }
    }
    void loadPack();
    return () => { cancelled = true; };
  }, [data.planUrl, data.actor, data.reviewBenchmarkBase, data.reviewBenchmarkId, data.reviewExpectedCaseCount, data.reviewFixture, slotForCase]);

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
    setSplitEditingChildIndex(null);
  }, [selectedKey, review.geometry_flags]);

  const activeSplitByParent = useMemo(() => {
    const byParent = new Map<string, PolygonSplitOperation>();
    for (const operation of review.split_operations ?? []) {
      if (operation?.parent_detection_id) {
        if (operation.status === "confirmed") byParent.set(operation.parent_detection_id, operation);
        else byParent.delete(operation.parent_detection_id);
      }
    }
    return byParent;
  }, [review.split_operations]);
  const selectedOperationChild = selectedKey
    ? [...activeSplitByParent.values()].flatMap((operation) => operation.children ?? []).find((child) => child.id === selectedKey) ?? null
    : null;
  const selectedLocalDraft = selectedKey
    ? splitDrafts.find((draft) => (draft.status === "proposal-review" || draft.status === "accepted-draft" || draft.status === "approved-preview") && draft.children.some((child) => child.id === selectedKey)) ?? null
    : null;
  const selectedLocalDraftChild = selectedLocalDraft?.children.find((child) => child.id === selectedKey) ?? null;
  const selectedSplitChild = selectedOperationChild ?? selectedLocalDraftChild;
  const activeProposalDraft = activeProposalDraftId
    ? splitDrafts.find((draft) => draft.draft_id === activeProposalDraftId && draft.source_kind === "plat-digitizer") ?? null
    : null;
  const acceptedDraftByParent = useMemo(() => {
    const byParent = new Map<string, EditableSplitDraft>();
    for (const draft of splitDrafts) {
      if (draft.source_kind === "plat-digitizer" && (draft.status === "accepted-draft" || draft.status === "approved-preview")) {
        byParent.set(draft.parent_detection_id, draft);
      }
    }
    return byParent;
  }, [splitDrafts]);
  const selectedSlot = selectedKey && !selectedSplitChild ? state.lots[selectedKey] ?? null : null;
  const selectedParentSlot = selectedSlot ?? (selectedSplitChild ? state.lots[selectedSplitChild.parent_detection_id] ?? null : null);

  useEffect(() => {
    setSplitNumberDraft(selectedSplitChild?.review?.printed_number ?? "");
  }, [selectedSplitChild?.id, selectedSplitChild?.review?.printed_number]);
  const selectedCaseIndex = manifest && selectedSlot
    ? manifest.cases.findIndex((item) => (item.detection_id === selectedSlot.id || item.detection_id === selectedSlot.lot_number) && caseGeometryMatches(item, selectedSlot))
    : -1;
  const activeIndex = selectedCaseIndex >= 0 ? selectedCaseIndex : currentIndex;
  const activeCase = manifest && activeIndex != null ? manifest.cases[activeIndex] ?? null : null;
  const activeDecision = activeCase ? review.reviews[activeCase.id] : undefined;
  const activeCaseExposed = Boolean(activeCase && review.ai_suggestion_exposures?.[activeCase.id]);
  const duplicateLabelCases = activeCase && /^\d+$/.test(numberDraft.trim())
    ? manifest?.cases.filter((item) => item.id !== activeCase.id
      && review.reviews[item.id]?.status === "confirmed"
      && review.reviews[item.id]?.printed_number === numberDraft.trim()) ?? []
    : [];
  const activeCaseMatches = Boolean(activeCase && selectedSlot && caseGeometryMatches(activeCase, selectedSlot));
  const cropCase = activeCaseMatches ? activeCase : null;
  const selectedGeometryFlagged = Boolean(selectedSlot && review.geometry_flags[selectedSlot.id]?.flagged);
  const canRecordNumber = Boolean(manifest && sourceVerified && activeCase && activeCaseMatches && selectedSlot && !selectedGeometryFlagged && !activeCaseExposed);
  const reviewedCount = manifest?.cases.filter((item) => !review.ai_suggestion_exposures?.[item.id] && ["confirmed", "ambiguous", "unreadable"].includes(review.reviews[item.id]?.status ?? "")).length ?? 0;
  const skippedCount = manifest?.cases.filter((item) => !review.ai_suggestion_exposures?.[item.id] && review.reviews[item.id]?.status === "skipped").length ?? 0;
  const exposedCount = manifest?.cases.filter((item) => Boolean(review.ai_suggestion_exposures?.[item.id])).length ?? 0;
  const caseCount = manifest?.cases.length ?? data.reviewExpectedCaseCount ?? 0;
  const unresolvedCount = caseCount - reviewedCount - skippedCount - exposedCount;
  const outstandingCases = manifest?.cases.filter((item) => !review.ai_suggestion_exposures?.[item.id] && !["confirmed", "ambiguous", "unreadable"].includes(review.reviews[item.id]?.status ?? "")) ?? [];
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
    for (const operation of activeSplitByParent.values()) {
      for (const child of operation.children ?? []) {
        const status = child.review?.status;
        statuses[child.id] = status === "confirmed" ? "reviewed" : status === "ambiguous" ? "ambiguous" : status === "unreadable" ? "unreadable" : "unreviewed";
      }
    }
    for (const draft of splitDrafts) {
      if (draft.status !== "proposal-review" && draft.status !== "accepted-draft" && draft.status !== "approved-preview") continue;
      for (const child of draft.children) statuses[child.id] = draft.status === "proposal-review" ? "proposal-candidate" : draft.status === "approved-preview" ? "approved-preview" : "editable-draft";
    }
    return statuses;
  }, [mappedSlots, review.geometry_flags, review.reviews, manifest, activeSplitByParent, splitDrafts]);

  const splitDraftValidation = splitSessionParentKey
    ? validatePolygonSplit(state.lots[splitSessionParentKey]?.polygon ?? [], splitTraceChildren)
    : null;
  const splitTraceShapeErrors = useMemo(() => splitTracePoints.length >= 3 ? validatePolygonShape(splitTracePoints) : [], [splitTracePoints]);
  const splitTraceGuidance = splitTracePoints.length > 0
    ? splitTracePoints.length < 3
      ? `Add at least 3 corner points to this outline (${splitTracePoints.length} added), then finish the polygon.`
      : splitTraceShapeErrors[0] ?? "Finish the current polygon or remove its points before previewing."
    : splitEditingChildIndex != null ? "Save or cancel the vertex adjustment before previewing." : null;
  const splitCanPreview = Boolean(splitDraftValidation?.valid && !splitTraceGuidance);
  const splitConfirmBlockers = [
    ...(splitDraftValidation?.errors ?? []),
    ...(splitTraceGuidance ? [splitTraceGuidance] : []),
    ...(!review.reviewer.trim() ? ["Enter your name in the Reviewer field above."] : []),
    ...(!geometryNote.trim() ? ["Add a short note explaining why this detection needs to be split."] : []),
    ...(splitDraftValidation?.warnings.length && !acknowledgeSplitGap ? ["Inspect the uncovered parent area and each child-boundary warning, then check the acknowledgment box."] : []),
    ...(splitCanPreview && !splitPreviewed ? ["Preview the valid child outlines before confirming."] : []),
    ...(splitEditingChildIndex != null ? ["Save or cancel the child vertex adjustment before confirming."] : []),
  ];
  const splitChildErrors = splitTraceChildren.map((child, index) => {
    const label = index + 1;
    const childWarning = splitDraftValidation?.warnings.some((warning) => warning.startsWith(`Child ${label}:`)) ?? false;
    const overlap = splitDraftValidation?.errors.some((error) =>
      new RegExp(`^Polygons (?:${label} and \\d+|\\d+ and ${label}) overlap`).test(error),
    ) ?? false;
    return validatePolygonShape(child).length > 0 || childWarning || overlap;
  });
  const activeSplitForSelection = selectedSplitChild
    ? activeSplitByParent.get(selectedSplitChild.parent_detection_id) ?? null
    : selectedSlot ? activeSplitByParent.get(selectedSlot.id) ?? null : null;
  const completedSplitChildReviews = [...activeSplitByParent.values()].flatMap((operation) => operation.children ?? []);
  const splitChildReviewCount = completedSplitChildReviews.filter((child) => child.review?.status && child.review.status !== "draft").length;
  const activeProposalValidation = activeProposalDraft
    ? validatePolygonSplit(activeProposalDraft.parent_polygon_pct, activeProposalDraft.children.map((child) => child.polygon_pct))
    : null;
  const competingDraftForParent = activeProposalDraft
    ? splitDrafts.find((draft) => draft.draft_id !== activeProposalDraft.draft_id && draft.parent_detection_id === activeProposalDraft.parent_detection_id && draft.status !== "rejected")
    : null;
  const proposalApprovalBlockers = activeProposalDraft ? [
    ...(!data.localMapPreviewScope ? ["This correction session has no explicit project/phase preview scope."] : []),
    ...(!sourceVerified || activeProposalDraft.source_image_sha256 !== manifest?.source_image.sha256 ? ["Verify the original source image fingerprint for this proposal."] : []),
    ...(!review.reviewer.trim() ? ["Enter your reviewer name."] : []),
    ...(!geometryNote.trim() ? ["Add a correction note describing the source evidence and remaining limitations."] : []),
    ...(activeProposalValidation?.errors ?? []),
    ...(activeProposalValidation?.warnings.length && !proposalGapAcknowledged ? ["Inspect the uncovered area and every boundary warning, then acknowledge the reasoned waiver."] : []),
    ...(activeProposalValidation?.warnings.length && !geometryNote.trim() ? ["A reasoned waiver note is required while coverage or boundary warnings remain."] : []),
    ...(activeSplitByParent.has(activeProposalDraft.parent_detection_id) ? ["A confirmed local split already replaces this parent; review it before approving another draft."] : []),
    ...(competingDraftForParent ? ["Another saved proposal for this parent exists. Resolve or reject it before approving this one."] : []),
    ...(geometryEditKey ? ["Save or cancel the active boundary edit."] : []),
    ...(splitDraftStoreError ? ["The local draft store could not be safely restored; approval is disabled to preserve existing work."] : []),
  ] : [];

  const layer = useMemo<CorrectionMapLayer>(() => ({
    title: `${data.reviewTitle ?? "Lot number map review"} · internal map review`,
    imageUrl: data.planUrl,
    parcels: mappedSlots.flatMap((slot) => {
      const operation = activeSplitByParent.get(slot.id);
      const draft = acceptedDraftByParent.get(slot.id);
      if (operation) return (operation.children ?? []).map((child, index) => ({ key: child.id, reference: `Draft child ${index + 1} · not canonical`, polygon: child.polygon_pct }));
      if (draft?.status === "approved-preview") return draft.children.map((child, index) => ({ key: child.id, reference: `Approved preview child ${index + 1} · label pending`, polygon: child.polygon_pct }));
      if (draft?.status === "accepted-draft") return [
        { key: slot.id, reference: `Parent detection ${slot.lot_number} · draft overlay`, polygon: slot.polygon },
        ...draft.children.map((child, index) => ({ key: child.id, reference: `Editable draft child ${index + 1} · label pending`, polygon: child.polygon_pct })),
      ];
      if (activeProposalDraft?.parent_detection_id === slot.id && activeProposalDraft.status === "proposal-review") return [
        { key: slot.id, reference: `Parent detection ${slot.lot_number} · proposal review`, polygon: slot.polygon },
        ...activeProposalDraft.children.map((child, index) => ({ key: child.id, reference: `Unaccepted proposal child ${index + 1} · label pending`, polygon: child.polygon_pct })),
      ];
      return [{ key: slot.id, reference: slot.lot_number, polygon: slot.polygon }];
    }),
    selectedKey,
    reviewStatusByKey,
    splitTrace: splitSessionParentKey && state.lots[splitSessionParentKey] ? {
      parentKey: splitSessionParentKey,
      parentPolygon: state.lots[splitSessionParentKey].polygon,
      completedChildren: splitTraceChildren,
      activePoints: splitTracePoints,
      drawingEnabled: splitDrawingEnabled,
      activeIssue: splitTraceShapeErrors[0] ?? null,
      editedChildIndex: splitEditingChildIndex,
      editedChildPolygon: splitEditingChildIndex == null ? null : geometryDraft,
      onMapPoint: (point) => {
        if (!splitDrawingEnabled) return;
        setFeedback("");
        const polygons = [state.lots[splitSessionParentKey].polygon, ...splitTraceChildren];
        const snapped = snapMapPointToEdges(snapMapPoint(point, polygons.flat(), 0.35), polygons, 0.35);
        setSplitPreviewed(false);
        setAcknowledgeSplitGap(false);
        setSplitTracePoints((previous) => {
          const last = previous.at(-1);
          return last && Math.hypot(last.x - snapped.x, last.y - snapped.y) < 0.08 ? previous : [...previous, snapped];
        });
      },
    } : null,
    geometryEdit: geometryEditKey && geometryDraft && (
      (selectedSlot && geometryEditKey === selectedSlot.id)
      || (selectedLocalDraftChild && geometryEditKey === selectedLocalDraftChild.id)
      || (splitSessionParentKey && splitEditingChildIndex != null && geometryEditKey === `${splitSessionParentKey}:trace:${splitEditingChildIndex}`)
    )
      ? { key: geometryEditKey, polygon: geometryDraft }
      : null,
    onSelect: (key) => {
      setSelectedKey(key);
      const child = [...activeSplitByParent.values()].flatMap((operation) => operation.children ?? []).find((item) => item.id === key)
        ?? splitDrafts.flatMap((draft) => draft.children).find((item) => item.id === key);
      const localParentDraft = splitDrafts.find((draft) => draft.parent_detection_id === key && draft.source_kind === "plat-digitizer");
      const localChildDraft = child ? splitDrafts.find((draft) => draft.children.some((item) => item.id === child.id)) : null;
      setActiveProposalDraftId(localParentDraft?.draft_id ?? localChildDraft?.draft_id ?? null);
      setProposalGapAcknowledged(false);
      const slot = child ? null : state.lots[key];
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
  }), [data.planUrl, data.reviewTitle, mappedSlots, activeSplitByParent, acceptedDraftByParent, activeProposalDraft, splitDrafts, selectedKey, reviewStatusByKey, splitSessionParentKey, splitTraceChildren, splitTracePoints, splitDrawingEnabled, splitTraceShapeErrors, splitEditingChildIndex, geometryEditKey, selectedSlot, selectedLocalDraftChild, geometryDraft, state.lots, manifest, caseGeometryMatches]);

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
    cancelSplitTrace();
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

  function beginLocalDraftChildEdit(): void {
    if (!selectedLocalDraft || !selectedLocalDraftChild || !review.reviewer.trim()) {
      setFeedback("Select a saved proposal child and enter your reviewer name before editing its boundary.");
      return;
    }
    setGeometryEditKey(selectedLocalDraftChild.id);
    setGeometryDraft(selectedLocalDraftChild.polygon_pct.map((point) => ({ ...point })));
    setFeedback("Editing a recoverable local child draft. The original proposal geometry and any prior approval snapshot remain preserved.");
  }

  function saveLocalDraftChildEdit(): void {
    if (!selectedLocalDraft || !selectedLocalDraftChild || !geometryDraft || geometryEditKey !== selectedLocalDraftChild.id) return;
    const shapeErrors = validatePolygonShape(geometryDraft);
    if (shapeErrors.length) {
      setFeedback(`Boundary not saved: ${shapeErrors[0]}`);
      return;
    }
    try {
      const now = new Date().toISOString();
      const children = selectedLocalDraft.children.map((child) => child.id === selectedLocalDraftChild.id ? {
        ...child,
        polygon_pct: geometryDraft.map((point) => ({ ...point })),
        geometry_source: "human-edited-opencv-contour" as const,
        geometry_validation: { valid: true, errors: [], warnings: [] },
        geometry_history: [...child.geometry_history, {
          edited_by: review.reviewer.trim(),
          edited_at: now,
          before: child.polygon_pct.map((point) => ({ ...point })),
          after: geometryDraft.map((point) => ({ ...point })),
        }],
      } : child);
      const validation = validatePolygonSplit(selectedLocalDraft.parent_polygon_pct, children.map((child) => child.polygon_pct));
      saveSplitDraft({
        ...selectedLocalDraft,
        status: selectedLocalDraft.status === "approved-preview" ? "accepted-draft" : selectedLocalDraft.status,
        updated_at: now,
        children,
        unassigned_area_percent: validation.unassignedAreaPercent,
        proposal_validation: validation,
      }, selectedLocalDraft.revision ?? 0);
      setGeometryEditKey(null);
      setGeometryDraft(null);
      setProposalGapAcknowledged(false);
      setFeedback(`Child boundary saved to local draft history. ${validation.errors.length ? `Approval remains blocked: ${validation.errors[0]}` : `${validation.unassignedAreaPercent.toFixed(3)}% remains unassigned.`}`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "The child boundary was not saved.");
    }
  }

  function beginSplitTrace(): void {
    if (!selectedSlot) return;
    if (!sourceVerified) {
      setFeedback("Polygon splitting is blocked until the source image fingerprint matches this local review pack.");
      return;
    }
    setSplitSessionParentKey(selectedSlot.id);
    setSplitTracePoints([]);
    setSplitTraceChildren([]);
    setSplitDrawingEnabled(true);
    setSplitPreviewed(false);
    setAcknowledgeSplitGap(false);
    setFeedback("");
  }

  function cancelSplitTrace(): void {
    setSplitSessionParentKey(null);
    setSplitTracePoints([]);
    setSplitTraceChildren([]);
    setSplitDrawingEnabled(false);
    setSplitEditingChildIndex(null);
    setSplitPreviewed(false);
    setGeometryEditKey(null);
    setGeometryDraft(null);
    setAcknowledgeSplitGap(false);
  }

  function undoLastTracePoint(): void {
    setSplitPreviewed(false);
    setAcknowledgeSplitGap(false);
    setSplitTracePoints((previous) => previous.slice(0, -1));
  }

  function finishTraceChild(): void {
    if (!splitSessionParentKey) return;
    const parent = state.lots[splitSessionParentKey];
    if (!parent) return;
    const shapeErrors = validatePolygonShape(splitTracePoints);
    if (shapeErrors.length) {
      setFeedback(`This outline needs correction: ${shapeErrors[0]}`);
      return;
    }
    setSplitTraceChildren((previous) => [...previous, splitTracePoints.map((point) => ({ ...point }))]);
    setSplitTracePoints([]);
    setSplitDrawingEnabled(false);
    setSplitPreviewed(false);
    setAcknowledgeSplitGap(false);
    setFeedback(`Child ${splitTraceChildren.length + 1} is complete. Choose Start Next Polygon to trace another plot, or Edit Child ${splitTraceChildren.length + 1} to adjust its vertices.`);
  }

  function startNextSplitChild(): void {
    if (!splitSessionParentKey || splitEditingChildIndex != null || splitTracePoints.length) return;
    setSplitDrawingEnabled(true);
    setSplitPreviewed(false);
    setAcknowledgeSplitGap(false);
    setFeedback(`Drawing child ${splitTraceChildren.length + 1}. Tap its visible corners on the map, then choose Finish Polygon.`);
  }

  function beginAdjustTraceChild(index: number): void {
    const polygon = splitTraceChildren[index];
    if (!polygon) return;
    setSplitEditingChildIndex(index);
    setSplitDrawingEnabled(false);
    setSplitPreviewed(false);
    setAcknowledgeSplitGap(false);
    setGeometryEditKey(`${splitSessionParentKey}:trace:${index}`);
    setGeometryDraft(polygon.map((point) => ({ ...point })));
    setFeedback(`Adjusting child outline ${index + 1}. Drag a handle or use arrow keys, then explicitly save or cancel this preview.`);
  }

  function saveAdjustedTraceChild(): void {
    if (splitEditingChildIndex == null || !splitSessionParentKey || !geometryDraft) return;
    const parent = state.lots[splitSessionParentKey];
    if (!parent) return;
    const shapeError = validatePolygonShape(geometryDraft)[0];
    if (shapeError) {
      setFeedback(shapeError ?? "This boundary is not a valid child outline.");
      return;
    }
    setSplitTraceChildren((previous) => previous.map((polygon, index) => index === splitEditingChildIndex
      ? geometryDraft.map((point) => ({ ...point }))
      : polygon));
    setSplitEditingChildIndex(null);
    setGeometryEditKey(null);
    setGeometryDraft(null);
    setSplitPreviewed(false);
    setAcknowledgeSplitGap(false);
    setFeedback(`Child ${splitEditingChildIndex + 1} is updated in the local preview. Review overlap and coverage, then choose Start Next Polygon or Preview Split.`);
  }

  function confirmPolygonSplit(): void {
    if (!selectedSlot || !splitSessionParentKey || splitSessionParentKey !== selectedSlot.id || !splitDraftValidation) return;
    if (!sourceVerified || !review.reviewer.trim() || !geometryNote.trim()) {
      setFeedback("Before confirming, verify the source, enter a reviewer name, and explain why this geometry needs to be split.");
      return;
    }
    if (!splitDraftValidation.valid) {
      setFeedback(splitDraftValidation.errors[0] ?? "Correct the invalid child outlines before confirming the split.");
      return;
    }
    if (splitDraftValidation.warnings.length && !acknowledgeSplitGap) {
      setFeedback("Inspect and acknowledge the unassigned portion of the original detection before confirming.");
      return;
    }
    const parentId = selectedSlot.id;
    const revision = (review.split_operations ?? []).filter((operation) => operation.parent_detection_id === parentId).length + 1;
    const operationId = `${parentId}-split-${revision}`;
    const now = new Date().toISOString();
    const children: SplitChildDraft[] = splitTraceChildren.map((polygon, index) => ({
      id: `DRAFT-${parentId}-S${revision}-C${index + 1}`,
      parent_detection_id: parentId,
      polygon_pct: polygon.map((point) => ({ ...point })),
      review: { status: "draft", printed_number: "", reviewer: "", reviewed_at: null },
    }));
    const operation: PolygonSplitOperation = {
      operation_id: operationId,
      parent_detection_id: parentId,
      parent_polygon_pct: sourcePolygonFor(selectedSlot).map((point) => ({ ...point })),
      proposed_from_polygon_pct: selectedSlot.polygon.map((point) => ({ ...point })),
      source_image_sha256: manifest?.source_image.sha256 ?? "",
      created_by: review.reviewer.trim(),
      created_at: now,
      status: "confirmed",
      unassigned_area_percent: splitDraftValidation.unassignedAreaPercent,
      children,
    };
    const geometryFlag: GeometryFlag = {
      flagged: true,
      note: geometryNote.trim(),
      reviewer: review.reviewer.trim(),
      flagged_at: now,
    };
    setReview((previous) => ({
      ...previous,
      geometry_flags: { ...previous.geometry_flags, [parentId]: geometryFlag },
      split_operations: [...(previous.split_operations ?? []), operation],
    }));
    cancelSplitTrace();
    setSelectedKey(children[0]?.id ?? parentId);
    setFeedback(`Local split draft ${operationId} saved with ${children.length} child polygons. The original detection and benchmark geometry remain unchanged.`);
    requestAnimationFrame(() => reviewPanelRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
  }

  function undoPolygonSplit(operation: PolygonSplitOperation): void {
    const now = new Date().toISOString();
    setReview((previous) => ({
      ...previous,
      split_operations: (previous.split_operations ?? []).map((entry) => entry.operation_id === operation.operation_id
        ? { ...entry, status: "undone", undone_by: previous.reviewer.trim(), undone_at: now }
        : entry),
    }));
    setSelectedKey(operation.parent_detection_id);
    setFeedback(`Split draft ${operation.operation_id} was undone locally. Its child geometry and review evidence remain in correction history.`);
  }

  async function importDigitizerProposal(file?: File): Promise<void> {
    if (!file || !selectedSlot || !manifest || !sourceVerified || !data.reviewDetectionSourceSha256 || !splitDraftStoreLoaded) {
      setFeedback("Choose a selected source polygon after the benchmark and local draft store are verified.");
      return;
    }
    try {
      const parentPolygon = sourcePolygonFor(selectedSlot).map((point) => ({ ...point }));
      const raw = JSON.parse(await file.text()) as unknown;
      const parentSha = await canonicalSha256({ parent_detection_id: selectedSlot.id, polygon_pct: parentPolygon });
      const parsed = await parseDigitizerProposal(raw, {
        sourceImage: { sha256: manifest.source_image.sha256, width: manifest.source_image.width, height: manifest.source_image.height },
        detectionSourceSha256: data.reviewDetectionSourceSha256,
        parentDetectionId: selectedSlot.id,
        parentGeometrySha256: parentSha,
        parentPolygon,
        detectionCount: mappedSlots.length,
      });
      const draftId = `plat-${parsed.proposal.proposal_fingerprint}`;
      const existing = splitDrafts.find((draft) => draft.draft_id === draftId);
      if (existing) {
        if (existing.parent_detection_id !== selectedSlot.id || existing.proposal_fingerprint !== parsed.proposal.proposal_fingerprint) {
          throw new Error("This stable proposal ID is already bound to different source evidence; the saved draft was not overwritten.");
        }
        setActiveProposalDraftId(existing.draft_id);
        setSelectedKey(existing.parent_detection_id);
        setProposalGapAcknowledged(false);
        setFeedback(`Resumed saved ${existing.status.replaceAll("-", " ")} ${existing.draft_id}. Child geometry, evidence, and approval history were preserved.`);
      } else {
        const now = new Date().toISOString();
        const additionalWarnings = [
          ...(parsed.proposal.validation?.pairwise_child_overlaps?.length ? ["The proposal artifact reports child overlaps; inspect and correct them before approval."] : []),
          ...(parsed.proposal.validation?.existing_detection_overlaps?.length ? ["The proposal artifact reports overlap with neighboring detections; inspect the source map."] : []),
        ];
        const draft: EditableSplitDraft = {
          draft_id: draftId,
          source_kind: "plat-digitizer",
          status: "proposal-review",
          parent_detection_id: selectedSlot.id,
          parent_polygon_pct: parentPolygon,
          source_image_sha256: manifest.source_image.sha256,
          proposal_fingerprint: parsed.proposal.proposal_fingerprint,
          detection_source_sha256: parsed.proposal.detection_source.sha256,
          created_by: review.reviewer.trim() || data.actor,
          created_at: now,
          updated_at: now,
          active_points: [],
          drawing_enabled: false,
          children: parsed.proposal.children.map((child) => {
            const errors = validatePolygonShape(child.polygon_pct);
            return {
              id: child.draft_id,
              parent_detection_id: child.parent_detection_id,
              polygon_pct: child.polygon_pct.map((point) => ({ ...point })),
              geometry_source: "opencv-contour",
              proposed_printed_number: child.number_evidence?.proposed_printed_number ?? child.proposed_printed_number ?? null,
              number_provider: child.number_evidence?.provider ?? parsed.proposal.processing?.ocr_provider ?? null,
              number_model_version: child.number_evidence?.model_version ?? parsed.proposal.processing?.ocr_model_version ?? null,
              number_confidence_note: child.number_evidence?.confidence_note ?? "Unverified extraction suggestion; inspect the source drawing before recording a human decision.",
              review: { status: "draft", printed_number: "", reviewer: "", reviewed_at: null },
              geometry_validation: { valid: errors.length === 0, errors, warnings: [] },
              geometry_history: [],
            };
          }),
          unassigned_area_percent: parsed.validation.unassignedAreaPercent,
          proposal_validation: { ...parsed.validation, warnings: [...parsed.validation.warnings, ...additionalWarnings] },
          edit_history: [],
          revision: 0,
        };
        const stored = saveSplitDraft(draft, null);
        setActiveProposalDraftId(stored.draft_id);
        setSelectedKey(selectedSlot.id);
        setCurrentIndex(null);
        setProposalGapAcknowledged(false);
        const benchmarkCase = manifest.cases.find((item) => item.detection_id === selectedSlot.id || item.detection_id === selectedSlot.lot_number);
        if (benchmarkCase) {
          const exposure = {
            case_id: benchmarkCase.id,
            parent_detection_id: selectedSlot.id,
            proposal_fingerprint: parsed.proposal.proposal_fingerprint,
            exposed_at: now,
            reviewer: review.reviewer.trim() || data.actor,
            provider: parsed.proposal.processing?.ocr_provider ?? parsed.proposal.processing?.geometry_provider ?? "plat-digitizer",
          };
          setReview((previous) => ({
            ...previous,
            ai_suggestion_exposures: { ...previous.ai_suggestion_exposures, [benchmarkCase.id]: previous.ai_suggestion_exposures?.[benchmarkCase.id] ?? exposure },
          }));
        }
        setFeedback(`Proposal loaded as an unapproved review candidate. ${stored.children.length} stable child drafts · ${stored.unassigned_area_percent?.toFixed(3) ?? "unknown"}% parent area unassigned. OCR suggestions remain unverified.`);
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "The proposal could not be verified; existing local drafts were not changed.");
    } finally {
      if (proposalImportRef.current) proposalImportRef.current.value = "";
    }
  }

  function acceptProposalAsEditableDraft(): void {
    if (!activeProposalDraft || !sourceVerified || activeProposalDraft.status !== "proposal-review") return;
    const validation = validatePolygonSplit(activeProposalDraft.parent_polygon_pct, activeProposalDraft.children.map((child) => child.polygon_pct));
    const blockers = [
      ...validation.errors,
      ...(!review.reviewer.trim() ? ["Enter your reviewer name before accepting draft geometry."] : []),
      ...(validation.warnings.length && !proposalGapAcknowledged ? ["Inspect and acknowledge the uncovered parent area and boundary warnings."] : []),
      ...(validation.warnings.length && !geometryNote.trim() ? ["Add a reasoned note for accepting a draft with unresolved coverage/boundary warnings."] : []),
    ];
    if (blockers.length) {
      setFeedback(`Accept as editable draft is blocked: ${blockers[0]}`);
      return;
    }
    try {
      const now = new Date().toISOString();
      const accepted = saveSplitDraft({
        ...activeProposalDraft,
        status: "accepted-draft",
        updated_at: now,
        unassigned_area_percent: validation.unassignedAreaPercent,
        proposal_validation: validation,
        edit_history: [...activeProposalDraft.edit_history, { action: "accepted", reviewer: review.reviewer.trim(), timestamp: now, note: "Accepted as editable internal draft only; labels remain unverified." }],
      }, activeProposalDraft.revision ?? 0);
      setActiveProposalDraftId(accepted.draft_id);
      setFeedback(`Accepted as editable draft. ${accepted.children.length} outlines are now selectable on the internal map; all lot-number fields remain blank/pending.`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "The draft could not be saved safely.");
    }
  }

  function rejectProposalDraft(): void {
    if (!activeProposalDraft || activeProposalDraft.status === "approved-preview") return;
    try {
      const now = new Date().toISOString();
      const rejected = saveSplitDraft({
        ...activeProposalDraft,
        status: "rejected",
        updated_at: now,
        rejection_note: geometryNote.trim() || "Rejected during local proposal review.",
        edit_history: [...activeProposalDraft.edit_history, { action: "rejected", reviewer: review.reviewer.trim() || data.actor, timestamp: now, note: geometryNote.trim() || undefined }],
      }, activeProposalDraft.revision ?? 0);
      setActiveProposalDraftId(rejected.draft_id);
      setFeedback("Proposal rejected and retained in local history. No source geometry, benchmark record, or buyer data changed.");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "The proposal rejection was not saved.");
    }
  }

  async function approveAndUpdatePreviewMap(): Promise<void> {
    if (approvalInFlight.current) return;
    const draft = activeProposalDraft;
    if (!draft || !manifest) return;
    approvalInFlight.current = true;
    setApprovalBusy(true);
    try {
      const validation = validatePolygonSplit(draft.parent_polygon_pct, draft.children.map((child) => child.polygon_pct));
      const parent = state.lots[draft.parent_detection_id];
      const blockers = [
        ...validation.errors,
        ...(draft.status !== "accepted-draft" ? ["Accept this proposal as an editable draft first."] : []),
        ...(!sourceVerified || draft.source_image_sha256 !== manifest.source_image.sha256 ? ["The source image fingerprint is not verified for this draft revision."] : []),
        ...(!data.reviewDetectionSourceSha256 || draft.detection_source_sha256 !== data.reviewDetectionSourceSha256 ? ["The current detection-set fingerprint does not match the proposal."] : []),
        ...(!parent || !samePolygon(draft.parent_polygon_pct, sourcePolygonFor(parent)) ? ["The parent detection geometry changed. Re-import only after reviewing the new source revision."] : []),
        ...(!review.reviewer.trim() ? ["Enter your reviewer name."] : []),
        ...(!geometryNote.trim() ? ["Add a correction note describing the source evidence and remaining limitations."] : []),
        ...(validation.warnings.length && !proposalGapAcknowledged ? ["Inspect the uncovered area and boundary warnings, then acknowledge them."] : []),
        ...(validation.warnings.length && !geometryNote.trim() ? ["A reasoned waiver note is required when warnings remain."] : []),
        ...(activeSplitByParent.has(draft.parent_detection_id) ? ["A local split already replaces this detection. Review it first; this proposal will not overwrite it."] : []),
        ...(geometryEditKey ? ["Save or cancel the current boundary edit before approval."] : []),
      ];
      if (blockers.length) throw new Error(blockers[0]);
      const latestStore = readSplitDraftStore();
      const storedDraft = latestStore.drafts.find((item) => item.draft_id === draft.draft_id);
      if (!storedDraft) throw new Error("The accepted draft is missing from local storage; export/recovery is required before continuing.");
      const currentRevision = await draftRevisionFingerprint(draft);
      const storedRevision = await draftRevisionFingerprint(storedDraft);
      if (currentRevision !== storedRevision || (storedDraft.revision ?? 0) !== (draft.revision ?? 0)) {
        throw new Error("This draft changed in another tab or since it was loaded. The newer revision was preserved; reload it before approval.");
      }
      const approvedAt = new Date().toISOString();
      const snapshot = buildApprovedPreviewSnapshot(draft, currentRevision, {
        reviewer: review.reviewer.trim(),
        note: geometryNote.trim(),
        waiver: validation.warnings.length ? geometryNote.trim() : null,
        approvedAt,
        parentMapReference: parent.lot_number,
      });
      const nextStore = persistApprovalSnapshot(latestStore, draft.draft_id, currentRevision, draft, snapshot);
      const previewScope = data.localMapPreviewScope;
      if (!previewScope) throw new Error("This correction session has no project/phase preview scope; nothing was approved.");
      const previewKey = localMapPreviewStorageKey(previewScope);
      const latestPreview = parseLocalMapPreviewStore(localStorage.getItem(previewKey), previewScope);
      const nextPreview = addApprovedPreviewSnapshot(latestPreview, snapshot);
      if (!splitDraftKey) throw new Error("The versioned local draft key is unavailable; nothing was approved.");
      writeSplitDraftStore(nextStore);
      try {
        localStorage.setItem(previewKey, JSON.stringify(nextPreview));
      } catch (previewWriteError) {
        try {
          localStorage.setItem(splitDraftKey, JSON.stringify(latestStore));
          setSplitDrafts(latestStore.drafts);
          setApprovedSnapshots(latestStore.approved_snapshots ?? []);
        } catch {
          throw new Error("The project map preview store could not be saved, and rollback of the review store failed. Export both local stores before continuing.");
        }
        throw previewWriteError;
      }
      notifyLocalMapPreviewUpdated(previewKey, nextPreview.revision);
      setSelectedKey(draft.children[0]?.id ?? draft.parent_detection_id);
      setFeedback(`Approved snapshot ${snapshot.snapshot_id.slice(-12)} saved to the ${previewScope.projectSlug}/${previewScope.phaseSlug} local preview. The native map redraws with child outlines; each label remains pending. This did not publish buyer inventory.`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Approval failed; the existing draft was preserved.");
    } finally {
      approvalInFlight.current = false;
      setApprovalBusy(false);
    }
  }

  function saveSplitChildReview(status: SplitChildDecision): void {
    if (!selectedSplitChild) return;
    const reviewer = review.reviewer.trim();
    const number = splitNumberDraft.trim();
    if (!sourceVerified) {
      setFeedback("Child label review is blocked until the source image fingerprint is verified.");
      return;
    }
    if (!reviewer) {
      setFeedback("Enter the reviewer name before reviewing a draft child polygon.");
      return;
    }
    if (status === "confirmed" && !/^\d+$/.test(number)) {
      setFeedback("Enter only the digits printed inside this draft child, or mark it ambiguous/unreadable.");
      return;
    }
    const now = new Date().toISOString();
    if (selectedLocalDraft && selectedLocalDraftChild) {
      try {
        const updated: EditableSplitDraft = {
          ...selectedLocalDraft,
          updated_at: now,
          children: selectedLocalDraft.children.map((child) => child.id === selectedLocalDraftChild.id
            ? { ...child, review: { status, printed_number: status === "confirmed" ? number : "", reviewer, reviewed_at: now } }
            : child),
        };
        saveSplitDraft(updated, selectedLocalDraft.revision ?? 0);
        setFeedback(`Draft child marked ${status} against the source drawing. The OCR suggestion remains separate, and this does not approve a parcel identity.`);
      } catch (error) {
        setFeedback(error instanceof Error ? error.message : "The local child review was not saved.");
      }
      return;
    }
    setReview((previous) => ({
      ...previous,
      split_operations: (previous.split_operations ?? []).map((operation) => ({
        ...operation,
        children: operation.children.map((child) => child.id === selectedSplitChild.id
          ? { ...child, review: { status, printed_number: status === "confirmed" ? number : "", reviewer, reviewed_at: now } }
          : child),
      })),
    }));
    setFeedback(`Draft child marked ${status} against the source drawing. This is not the 60-case benchmark ground truth or an approved parcel identity.`);
  }

  const duplicateSplitChildren = selectedSplitChild && /^\d+$/.test(splitNumberDraft.trim())
    ? [
      ...completedSplitChildReviews,
      ...splitDrafts.flatMap((draft) => draft.children),
    ].filter((child) => child.id !== selectedSplitChild.id
      && child.review?.status === "confirmed" && child.review.printed_number === splitNumberDraft.trim())
    : [];

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
      const exposed = Boolean(review.ai_suggestion_exposures?.[item.id]);
      return {
        ...item,
        ...decision,
        status: exposed ? "exposed-to-ai-suggestions" : decision.status,
        printed_number: exposed ? "" : decision.printed_number,
        printed_area_sqm: exposed ? "" : decision.printed_area_sqm,
        ai_suggestion_exposure: review.ai_suggestion_exposures?.[item.id] ?? null,
        pre_exposure_decision: exposed ? decision : null,
        original_polygon_pct: item.polygon_pct,
        geometry_review: slot ? review.geometry_flags[slot.id] ?? null : null,
        correction_history: slot ? state.log.filter((entry) => entry.lot === slot.id && entry.field === "polygon") : [],
        current_polygon_pct: slot?.polygon ?? null,
      };
    });
    const decisions = cases.filter((item) => !review.ai_suggestion_exposures?.[String(item.id)] && ["confirmed", "ambiguous", "unreadable"].includes(String(item.status)));
    const skipped = cases.filter((item) => !review.ai_suggestion_exposures?.[String(item.id)] && item.status === "skipped").length;
    const geometryIssues = Object.entries(review.geometry_flags).filter(([, flag]) => flag.flagged).map(([key, flag]) => ({
      correction_key: key,
      detection_reference: state.lots[key]?.lot_number ?? key,
      ...flag,
      original_polygon_pct: state.lots[key] ? sourcePolygonFor(state.lots[key]) : null,
      current_polygon_pct: state.lots[key]?.polygon ?? null,
      correction_history: state.log.filter((entry) => entry.lot === key && entry.field === "polygon"),
    }));
    const exportPrefix = data.reviewFixture === "synthetic" ? "wamule-synthetic-map-review-v1" : "hopkins-grove-lot-number-ground-truth-v1";
    downloadFile(`${exportPrefix}.json`, JSON.stringify({
      schema_version: 1,
      artifact_type: "wamule-lot-number-ground-truth",
      benchmark_id: manifest.benchmark_id,
      export_status: decisions.length === manifest.cases.length ? "complete" : "partial",
      exported_at_utc: new Date().toISOString(),
      reviewer_name: review.reviewer,
      review_summary: { expected_cases: manifest.cases.length, decisions_recorded: decisions.length, skipped, exposed_to_ai_suggestions: exposedCount, unresolved: manifest.cases.length - decisions.length - skipped - exposedCount },
      source_image: manifest.source_image,
      lot_geometry_sha256: manifest.lot_geometry_sha256,
      benchmark_manifest_sha256: manifestSha,
      cases,
      geometry_issues: geometryIssues,
      proposed_polygon_splits: review.split_operations ?? [],
      local_polygon_drafts: splitDrafts,
      approved_preview_snapshots: approvedSnapshots,
      ai_suggestion_exposures: review.ai_suggestion_exposures ?? {},
      benchmark_case_geometry_unchanged: true,
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
      const exposed = Boolean(review.ai_suggestion_exposures?.[item.id]);
      rows.push([
        item.id,
        !exposed && decision?.status === "confirmed" ? decision.printed_number : "",
        !exposed && decision?.status === "confirmed" ? decision.printed_area_sqm : "",
        !exposed && decision?.status === "ambiguous" ? "1" : "",
        !exposed && decision?.status === "unreadable" ? "1" : "",
        !exposed && decision?.status === "skipped" ? "1" : "",
        exposed ? "" : decision?.reviewer ?? "",
        exposed ? "" : decision?.reviewed_at ?? "",
      ]);
    }
    const filename = data.reviewFixture === "synthetic" ? "wamule-synthetic-map-review-labels.csv" : "hopkins-grove-labels.csv";
    downloadFile(filename, rows.map((row) => row.map(escape).join(",")).join("\n") + "\n", "text/csv;charset=utf-8");
    setFeedback("Scorer-compatible CSV exported. Blank, ambiguous, unreadable, and skipped cases are not scored as numbers.");
  }

  function exportSplitDraftRecovery(): void {
    if (!manifest || !manifestSha || !sourceVerified) return;
    try {
      const store = readSplitDraftStore();
      downloadFile(`wamule-local-map-drafts-${manifest.benchmark_id}.json`, JSON.stringify({
        ...store,
        artifact_type: "wamule-local-correction-split-drafts",
        exported_at_utc: new Date().toISOString(),
        persistence: "browser-local; internal preview only; not canonical or published",
        ai_suggestion_exposures: review.ai_suggestion_exposures ?? {},
      }, null, 2) + "\n", "application/json");
      setFeedback(`Recovery export saved with ${store.drafts.length} draft(s) and ${(store.approved_snapshots ?? []).length} approved preview snapshot(s).`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "The local draft backup could not be exported.");
    }
  }

  async function importJson(file?: File): Promise<void> {
    if (!file || !manifest || !manifestSha) return;
    try {
      const parsed = JSON.parse(await file.text()) as { artifact_type?: string; benchmark_id?: string; benchmark_manifest_sha256?: string; reviewer_name?: string; cases?: Array<Record<string, unknown>> };
      if (parsed.artifact_type !== "wamule-lot-number-ground-truth" || parsed.benchmark_id !== manifest.benchmark_id || parsed.benchmark_manifest_sha256 !== manifestSha || !Array.isArray(parsed.cases)) {
        throw new Error("This JSON is not an export for the same versioned review benchmark.");
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

  const cropPolygon = selectedSplitChild?.polygon_pct
    ?? cropCase?.polygon_pct
    ?? (selectedSlot ? sourcePolygonFor(selectedSlot) : []);
  const cropBox = cropCase?.crop_box_px ?? polygonCropBox(cropPolygon, 5700, 4800);
  const statusForActive = activeDecision?.status ?? "pending";

  return (
    <div className="correction-review-grid">
      <section className="correction-review-map" aria-label={`${data.reviewTitle ?? "Development"} map`}>
        <PublicLotMap tenantSlug="correction-review" showPrices={false} correctionMapLayer={layer} />
      </section>
      <aside ref={reviewPanelRef} className="correction-review-panel" aria-label="Lot number review panel">
        <header className="flex items-start justify-between gap-3">
          <div>
            <p className="v2-page-kicker">Independent source review</p>
            <h2 className="mt-1 text-lg font-semibold text-primary">
              {splitSessionParentKey && selectedSlot ? `Split Mode · ${selectedSlot.lot_number}` : selectedSplitChild ? `Draft child · ${selectedSplitChild.id}` : activeCase && selectedSlot ? `Case ${activeCase.id}` : selectedSlot ? "Polygon review" : "Select a polygon"}
            </h2>
          </div>
          <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
            {selectedSplitChild ? selectedSplitChild.review.status : statusForActive === "pending" ? "Unreviewed" : statusForActive}
          </span>
        </header>
        {selectedSplitChild ? (
          <p className="mt-3 rounded-md border border-primary/15 bg-primary-soft/50 p-2.5 text-xs leading-5 text-foreground" role="status" data-testid="split-child-next-steps">
            This split is saved as a local draft. To review the next plot, tap its outlined child on the map; its crop will appear here. Enter that plot's printed number, then choose Save number review.
          </p>
        ) : null}
        {selectedLocalDraftChild && selectedLocalDraft ? (
          <div className="mt-2 rounded-md border border-warning/25 bg-accent-soft p-2.5 text-xs leading-5" data-testid="proposal-child-context">
            <p><strong>{selectedLocalDraft.status === "approved-preview" ? "Approved internal preview" : selectedLocalDraft.status === "accepted-draft" ? "Editable draft" : "Unaccepted proposal candidate"}.</strong> This child is not public inventory; its reviewed label is separate from the OCR suggestion.</p>
            <p className="mt-1">Human label: {selectedLocalDraftChild.review.printed_number || "pending"} · OCR suggestion (unverified): {selectedLocalDraftChild.proposed_printed_number || "none"}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => { setSelectedKey(selectedLocalDraft.parent_detection_id); setCurrentIndex(null); setActiveProposalDraftId(selectedLocalDraft.draft_id); setGeometryEditKey(null); setGeometryDraft(null); }}>Return to proposal and parent</Button>
              {!geometryEditKey ? <Button type="button" variant="outline" onClick={beginLocalDraftChildEdit} disabled={!review.reviewer.trim()}>Edit child boundary</Button> : null}
            </div>
            {geometryEditKey === selectedLocalDraftChild.id && geometryDraft ? <div className="mt-2 rounded border border-secondary/30 bg-card p-2.5">
              Drag or keyboard-adjust the map handles, then save this local revision. Approval will require current geometry review.
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" onClick={saveLocalDraftChildEdit}>Save draft boundary</Button>
                <Button type="button" variant="outline" onClick={() => { setGeometryEditKey(null); setGeometryDraft(null); }}>Cancel boundary edit</Button>
              </div>
            </div> : null}
          </div>
        ) : null}
        {!splitSessionParentKey && !selectedSplitChild ? <div className="mt-3" aria-label="Benchmark review progress">
          <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground">
            <span>{reviewedCount} / {caseCount} decisions recorded</span>
            <span>{skippedCount} skipped · {unresolvedCount} unresolved</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={caseCount} aria-valuenow={reviewedCount} aria-label="Recorded benchmark decisions">
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${caseCount > 0 ? (reviewedCount / caseCount) * 100 : 0}%` }} />
          </div>
        </div> : null}
        {!splitSessionParentKey ? <p className="mt-2 text-xs leading-5 text-muted-foreground" data-testid="split-review-progress">
          Proposed split labels: {splitChildReviewCount} / {completedSplitChildReviews.length} reviewed · kept separate from the 60-case benchmark.
        </p> : null}
        {packError ? <p className="mt-3 rounded-md border border-warning/30 bg-accent-soft p-2.5 text-xs leading-5 text-foreground" role="alert">{packError}</p> : null}
        {splitDraftStoreError ? <p className="mt-3 rounded-md border border-danger/30 bg-danger/5 p-2.5 text-xs leading-5 text-foreground" role="alert" data-testid="local-draft-store-error">{splitDraftStoreError} Existing drafts were left untouched.</p> : null}
        {feedback && (activeProposalDraft || selectedLocalDraft || approvedSnapshots.length > 0) ? <p className="mt-3 rounded-md border border-primary/20 bg-primary-soft/50 p-2.5 text-xs leading-5 text-foreground" role="status" data-testid="review-feedback">{feedback}</p> : null}
        {approvedSnapshots.length ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/25 bg-primary-soft/50 p-2.5 text-xs leading-5" role="status" data-testid="approved-preview-status">
            <span><strong>Internal preview map updated.</strong> {approvedSnapshots.at(-1)?.children.length ?? 0} approved geometry draft(s) are persisted locally; printed labels remain pending. Hosted publishing is separate.</span>
            <Button type="button" variant="outline" className="min-h-9 px-3 py-1.5 text-xs" onClick={() => {
              const latest = approvedSnapshots.at(-1);
              const draft = latest ? splitDrafts.find((entry) => entry.draft_id === latest.draft_id) : null;
              if (latest && draft) {
                setActiveProposalDraftId(draft.draft_id);
                setSelectedKey(draft.children[0]?.id ?? draft.parent_detection_id);
                setCurrentIndex(null);
              }
            }}>Open approved draft</Button>
          </div>
        ) : null}
        {!splitSessionParentKey ? <p className="mt-3 rounded-md border border-primary/15 bg-primary-soft/50 p-2.5 text-xs leading-5 text-muted-foreground">
          Printed drawing and detected geometry only. The reference is for navigation—not an official lot number. No price, tier, availability, or OCR/AI guess is shown. Progress is browser-local until M4 shared drafts are verified.
        </p> : null}
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Field label="Reviewer">
            <Input value={review.reviewer} onChange={(event) => setReview((previous) => ({ ...previous, reviewer: event.target.value }))} autoComplete="name" placeholder="Reviewer name" />
          </Field>
          {!splitSessionParentKey && !selectedSplitChild ? <div className="flex items-end gap-2">
            <label className="flex min-h-11 flex-1 items-center gap-2 rounded-md border border-border px-3 text-sm">
              <input type="checkbox" checked={showOutstanding} onChange={(event) => setShowOutstanding(event.target.checked)} />
              Outstanding only
            </label>
          </div> : null}
        </div>
        {!splitSessionParentKey && !selectedSplitChild ? <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
          <label className="sr-only" htmlFor="benchmark-case-select">Benchmark review queue</label>
          <select id="benchmark-case-select" value={activeCase?.id ?? ""} onChange={(event) => {
            const index = manifest?.cases.findIndex((item) => item.id === event.target.value) ?? -1;
            if (index >= 0) goToCase(index);
          }} className="focus-ring h-11 min-w-0 rounded-md border border-border bg-card px-2 text-sm" disabled={!manifest}>
            {queueCases.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.detection_id} · {review.reviews[item.id]?.status ?? "unreviewed"}</option>)}
          </select>
          <Button type="button" variant="outline" disabled={currentIndex == null || currentIndex <= 0} onClick={() => goToCase((currentIndex ?? 0) - 1)} aria-label="Previous benchmark case">←</Button>
          <Button type="button" variant="outline" disabled={!manifest || unresolvedCount === 0} onClick={() => selectedKey == null ? goToCase(currentIndex ?? 0) : goNextUnresolved(currentIndex ?? 0)}>{selectedKey == null ? "Open current target" : "Next unresolved"}</Button>
        </div> : null}

        {selectedSlot || selectedSplitChild ? (
          <div className="mt-3 rounded-lg border border-border bg-background p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {selectedSplitChild ? "Proposed child geometry · not canonical identity" : "Detection reference · not canonical identity"}
                </p>
                <p className="mt-1 font-semibold text-foreground">
                  {selectedSplitChild ? `${selectedSplitChild.id} · from ${selectedParentSlot?.lot_number ?? selectedSplitChild.parent_detection_id}` : selectedSlot?.lot_number}
                </p>
              </div>
              <button type="button" className="focus-ring min-h-11 rounded-md px-3 text-sm font-semibold text-muted-foreground hover:bg-muted" onClick={() => { cancelSplitTrace(); setSelectedKey(null); setCurrentIndex(null); }}>Clear map selection</button>
            </div>
            {selectedSlot && !splitSessionParentKey ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <Button type="button" className="min-h-12 text-base" onClick={beginSplitTrace} disabled={!sourceVerified}>Split Polygon</Button>
                <input ref={proposalImportRef} className="sr-only" type="file" accept="application/json,.json" aria-label="Select plat-digitizer proposal JSON" onChange={(event) => void importDigitizerProposal(event.target.files?.[0])} />
                <Button type="button" variant="outline" className="min-h-12 text-base" onClick={() => proposalImportRef.current?.click()} disabled={!sourceVerified || !data.reviewDetectionSourceSha256 || !splitDraftStoreLoaded || Boolean(splitDraftStoreError)}>Review AI Proposal</Button>
              </div>
            ) : null}
            {selectedSlot && !splitSessionParentKey && activeProposalDraft?.parent_detection_id === selectedSlot.id ? (
              <section className="mt-3 rounded-lg border-2 border-secondary/35 bg-secondary-soft/25 p-3" aria-label="AI proposal review" data-testid="ai-proposal-review" data-status={activeProposalDraft.status}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-base font-semibold text-primary">Plat digitizer proposal · {activeProposalDraft.children.length} child outlines</h3>
                    <p className="mt-1 text-xs text-muted-foreground">Proposal {activeProposalDraft.proposal_fingerprint?.slice(0, 12)}… · source, detection set, and parent fingerprints retained.</p>
                  </div>
                  <span className="rounded-full border border-secondary/40 bg-card px-2.5 py-1 text-xs font-semibold text-secondary-foreground">{activeProposalDraft.status.replaceAll("-", " ")}</span>
                </div>
                <p className="mt-2 rounded-md border border-warning/30 bg-accent-soft p-2.5 text-xs leading-5" data-testid="proposal-coverage-warning">
                  <strong>{(activeProposalDraft.unassigned_area_percent ?? 0).toFixed(3)}% of the parent is unassigned.</strong> This is not assumed to be a lot or common area. Child labels stay pending unless separately reviewed from the source drawing.
                </p>
                {activeProposalValidation?.errors.length ? <div className="mt-2 rounded-md border border-danger/30 bg-danger/5 p-2.5 text-xs" role="alert" data-testid="proposal-validation-errors">
                  <strong>Geometry blocks approval:</strong><ul className="mt-1 list-disc pl-5">{activeProposalValidation.errors.map((error) => <li key={error}>{error}</li>)}</ul>
                </div> : null}
                {activeProposalValidation?.warnings.length ? <div className="mt-2 rounded-md border border-warning/25 bg-card p-2.5 text-xs leading-5" data-testid="proposal-validation-warnings">
                  <strong>Source checks that need a reasoned waiver</strong><ul className="mt-1 list-disc pl-5">{activeProposalValidation.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                </div> : null}
                <ul className="mt-2 space-y-2" aria-label="Proposal children; OCR numbers are unverified">
                  {activeProposalDraft.children.map((child, index) => (
                    <li key={child.id} className="rounded-md border border-border bg-card p-2.5" data-testid="proposal-child" data-child-id={child.id}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-semibold text-foreground">Child {index + 1} · {child.id}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground" data-testid="unverified-ocr-suggestion">Unverified OCR suggestion: {child.proposed_printed_number || "none"} · {child.number_provider ?? "unknown provider"}</p>
                          <p className="mt-0.5 text-xs font-medium text-warning">Map label: pending human/source review</p>
                        </div>
                        <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${child.geometry_validation.valid ? "bg-primary-soft text-primary" : "bg-danger/10 text-danger"}`}>
                          {child.geometry_validation.valid ? "Shape valid · review required" : `Needs correction · ${child.geometry_validation.errors[0]}`}
                        </span>
                      </div>
                      {child.number_confidence_note ? <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{child.number_confidence_note}</p> : null}
                      {activeProposalDraft.status !== "rejected" ? <Button type="button" variant="outline" className="mt-2 min-h-9 px-3 py-1.5 text-xs" onClick={() => {
                        setSelectedKey(child.id);
                        setCurrentIndex(null);
                        setActiveProposalDraftId(activeProposalDraft.draft_id);
                      }}>Inspect child crop</Button> : null}
                    </li>
                  ))}
                </ul>
                {(activeProposalDraft.status === "proposal-review" || activeProposalDraft.status === "accepted-draft") && activeProposalValidation?.warnings.length ? (
                  <label className="mt-2 flex min-h-11 items-start gap-2 rounded-md border border-border bg-card p-2.5 text-xs leading-5">
                    <input type="checkbox" checked={proposalGapAcknowledged} onChange={(event) => setProposalGapAcknowledged(event.target.checked)} />
                    I inspected the uncovered source area and boundary warnings; I understand these remain unapproved sales data.
                  </label>
                ) : null}
                {activeProposalDraft.status !== "rejected" && activeProposalDraft.status !== "approved-preview" ? (
                  <Field label="Correction note / reasoned waiver">
                    <Input value={geometryNote} onChange={(event) => setGeometryNote(event.target.value)} maxLength={300} placeholder="Describe the source evidence and unresolved boundary/coverage issues" />
                  </Field>
                ) : null}
                {activeProposalDraft.status === "proposal-review" ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <Button type="button" onClick={acceptProposalAsEditableDraft} disabled={!sourceVerified || !review.reviewer.trim() || Boolean(activeProposalValidation?.errors.length) || Boolean(activeProposalValidation?.warnings.length && (!proposalGapAcknowledged || !geometryNote.trim()))}>Accept as editable draft</Button>
                    <Button type="button" variant="outline" onClick={rejectProposalDraft}>Reject proposal</Button>
                  </div>
                ) : null}
                {activeProposalDraft.status === "accepted-draft" ? (
                  <div className="mt-3 border-t border-border pt-3">
                    <p className="text-xs leading-5 text-foreground">Accepted geometry is now on the internal draft map and children are selectable. Printed numbers remain blank/pending; OCR suggestions are evidence only.</p>
                    <div className="mt-2 rounded-md border border-warning/25 bg-card p-2.5 text-xs leading-5" role="status" aria-label="Preview approval blockers" data-testid="preview-approval-blockers">
                      <strong>Approval requirements</strong>
                      {proposalApprovalBlockers.length ? <ul className="mt-1 list-disc pl-5">{[...new Set(proposalApprovalBlockers)].map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : <p className="mt-1 text-primary">No blockers. One action will save the approval snapshot and redraw this internal preview map.</p>}
                    </div>
                    <Button type="button" className="mt-2 min-h-12 w-full text-base" onClick={() => void approveAndUpdatePreviewMap()} disabled={approvalBusy || proposalApprovalBlockers.length > 0} data-testid="approve-update-preview-map">
                      {approvalBusy ? "Saving approved preview…" : "Approve and update preview map"}
                    </Button>
                    <p className="mt-2 text-[11px] leading-4 text-muted-foreground">This approval is local to the internal map preview. It does not approve legal parcel identity, price, availability, or public publication.</p>
                    <Button type="button" variant="outline" className="mt-2 min-h-10" onClick={rejectProposalDraft}>Reject and retain history</Button>
                  </div>
                ) : null}
                {activeProposalDraft.status === "approved-preview" ? (
                  <div className="mt-3 rounded-md border border-primary/25 bg-primary-soft/50 p-2.5 text-xs leading-5" role="status" data-testid="approved-preview-status">
                    <strong>Internal preview map updated.</strong> Snapshot {activeProposalDraft.approval?.snapshot_id.slice(-12)} was saved by {activeProposalDraft.approval?.approved_by}. Each printed number remains pending; hosted publishing and public inventory approval are separate and not implemented here.
                  </div>
                ) : null}
                {activeProposalDraft.status === "rejected" ? <p className="mt-2 text-xs text-muted-foreground">Rejected proposal retained in the local draft store for recovery; it is not drawn on the map.</p> : null}
              </section>
            ) : null}
            {selectedSlot && splitSessionParentKey === selectedSlot.id ? (
              <section className="mt-3 rounded-lg border-2 border-primary/30 bg-primary-soft/35 p-3" aria-label="Split Mode" data-testid="polygon-split-mode">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-primary">Split Mode</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-primary/20 bg-card px-2.5 py-1 text-xs font-semibold text-primary">{splitTraceChildren.length} {splitTraceChildren.length === 1 ? "polygon" : "polygons"} drawn</span>
                    <Button type="button" className="min-h-9 px-3 py-1.5 text-xs" variant="outline" onClick={cancelSplitTrace}>Cancel Split</Button>
                  </div>
                </div>
                <p className="mt-1 text-sm leading-5 text-foreground">
                  {splitDrawingEnabled
                    ? `Drawing child ${splitTraceChildren.length + 1}. Tap each corner on the map, then choose Finish Polygon.`
                    : splitEditingChildIndex != null
                      ? `Editing child ${splitEditingChildIndex + 1}. Move its map handles, then save or cancel the adjustment.`
                      : splitTraceChildren.length
                        ? `Child ${splitTraceChildren.length} is complete. Start another child or preview the draft outlines.`
                        : "Trace each real printed lot over the source map. These are draft boundaries only; the original detection and benchmark remain unchanged."}
                </p>
                <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs leading-5 text-foreground">
                  <li>Tap or click each visible corner of one printed lot on the map. Use at least 3 points; zoom for small corners. Drag the map to pan.</li>
                  <li>Choose <strong>Finish Polygon</strong>. The child is marked complete; choose <strong>Start Next Polygon</strong> before drawing another.</li>
                  <li>Choose <strong>Edit Child N</strong> to move its visible handles; save or cancel the adjustment.</li>
                  <li>Choose <strong>Preview split</strong> and inspect every outline against the source image and any warnings.</li>
                  <li>Choose <strong>Confirm Split</strong> only when the preview is correct. You can cancel without changing the map.</li>
                </ol>
                <p className="mt-2 rounded-md border border-border bg-card px-2.5 py-2 text-xs leading-5 text-muted-foreground" role="status" aria-live="polite" data-testid="split-drawn-progress">
                  {splitTraceChildren.length} {splitTraceChildren.length === 1 ? "polygon" : "polygons"} drawn · current outline: {splitTracePoints.length} {splitTracePoints.length === 1 ? "corner" : "corners"}.
                  {splitDrawingEnabled ? ` Drawing child ${splitTraceChildren.length + 1}.` : splitEditingChildIndex != null ? ` Editing child ${splitEditingChildIndex + 1}.` : splitTraceChildren.length ? " Drawing paused. Start the next polygon explicitly." : " Add corners for child 1."}
                  {splitPreviewed ? " Preview is ready—compare the highlighted outlines with the source." : ""}
                </p>
                {splitDrawingEnabled ? (
                  <p className={`mt-2 rounded-md border px-2.5 py-2 text-xs font-semibold leading-5 ${splitTraceShapeErrors.length ? "border-danger/30 bg-danger/5 text-danger" : "border-warning/30 bg-accent-soft text-foreground"}`} role="status" aria-live="polite" data-testid="split-active-child-state" data-state={splitTraceShapeErrors.length ? "needs-correction" : "drawing"}>
                    {splitTraceShapeErrors.length ? `Current outline · Needs correction: ${splitTraceShapeErrors[0]}` : `Current outline · Drawing child ${splitTraceChildren.length + 1} · ${splitTracePoints.length} ${splitTracePoints.length === 1 ? "corner" : "corners"}`}
                  </p>
                ) : null}
                {splitTraceChildren.length ? (
                  <ul className="mt-2 space-y-1.5" aria-label="Draft child polygon states" data-testid="split-child-states">
                    {splitTraceChildren.map((_, index) => {
                      const status = splitEditingChildIndex === index ? "Editing" : splitChildErrors[index] ? "Needs correction" : "Completed";
                      return (
                        <li key={index} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-2.5 py-2" data-child-state={status.toLowerCase().replaceAll(" ", "-")}>
                          <span className="text-xs font-semibold text-foreground">Child {index + 1} · {status}</span>
                          <Button type="button" className="min-h-9 px-3 py-1.5 text-xs" variant="outline" onClick={() => beginAdjustTraceChild(index)} disabled={splitEditingChildIndex != null}>Edit Child {index + 1}</Button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                <Field label="Why should this detection be split?">
                  <Input id="split-geometry-note" value={geometryNote} onChange={(event) => setGeometryNote(event.target.value)} placeholder="For example: one outline covers four printed lots" maxLength={300} />
                </Field>
                {!review.reviewer.trim() ? <p className="mt-2 text-xs font-medium text-warning" role="status">Enter your name in the Reviewer field above before confirming this local correction.</p> : null}
                {splitDraftValidation?.errors.length || splitTraceGuidance ? (
                  <div className="mt-2 rounded-md border border-danger/25 bg-danger/5 p-2.5 text-xs leading-5 text-foreground" role="alert" aria-label="Split validation guidance">
                    <p className="font-semibold text-danger">Not ready to preview yet. Fix these items:</p>
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      {splitDraftValidation?.errors.map((error) => <li key={error}>{error}</li>)}
                      {splitTraceGuidance ? <li>{splitTraceGuidance}</li> : null}
                    </ul>
                  </div>
                ) : null}
                {splitDraftValidation?.warnings.length ? (
                  <div className="mt-2 rounded-md border border-warning/30 bg-accent-soft p-2.5 text-xs leading-5 text-foreground">
                    <p className="font-semibold">Source checks to review</p>
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      {splitDraftValidation.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                    </ul>
                    <p className="mt-1">Compare each highlighted boundary with the drawing. Do not assume an unassigned gap is another lot.</p>
                  </div>
                ) : null}
                {splitDraftValidation?.warnings.length ? (
                  <label className="mt-2 flex min-h-11 items-start gap-2 rounded-md border border-border bg-card p-2.5 text-xs leading-5">
                    <input type="checkbox" checked={acknowledgeSplitGap} onChange={(event) => setAcknowledgeSplitGap(event.target.checked)} />
                    I checked the uncovered area and all child-boundary warnings against the source.
                  </label>
                ) : null}
                {feedback ? <p className="mt-2 rounded-md border border-success/25 bg-success/5 p-2.5 text-xs leading-5 text-foreground" role="status" data-testid="split-action-feedback">{feedback}</p> : null}
                {splitConfirmBlockers.length ? (
                  <div className="mt-2 rounded-md border border-warning/30 bg-accent-soft p-2.5 text-xs leading-5 text-foreground" role="status" aria-label="Why Confirm Split is unavailable" data-testid="split-confirm-blockers">
                    <p className="font-semibold">Confirm Split is unavailable until these items are resolved:</p>
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      {[...new Set(splitConfirmBlockers)].map((blocker) => <li key={blocker}>{blocker}</li>)}
                    </ul>
                  </div>
                ) : null}
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button type="button" variant="outline" onClick={undoLastTracePoint} disabled={splitTracePoints.length === 0 || splitEditingChildIndex != null}>Undo last point</Button>
                  <Button type="button" variant="outline" onClick={() => { setSplitTraceChildren((previous) => previous.slice(0, -1)); setSplitPreviewed(false); setAcknowledgeSplitGap(false); setSplitTracePoints([]); }} disabled={splitTraceChildren.length === 0 || splitEditingChildIndex != null}>Remove last polygon</Button>
                  {splitDrawingEnabled ? <Button type="button" onClick={finishTraceChild} disabled={splitTracePoints.length < 3 || splitTraceShapeErrors.length > 0 || splitEditingChildIndex != null}>Finish Polygon</Button> : splitTraceChildren.length > 0 && splitEditingChildIndex == null ? <Button type="button" onClick={startNextSplitChild}>Start Next Polygon</Button> : null}
                  <Button type="button" variant="outline" onClick={() => setSplitPreviewed(true)} disabled={!splitCanPreview}>Preview split</Button>
                  {splitEditingChildIndex != null && geometryDraft ? (
                    <div className="col-span-2 rounded-md border border-secondary/30 bg-card p-2.5 text-xs leading-5">
                      Adjusting polygon {splitEditingChildIndex + 1}. Drag its visible handles, then save or cancel.
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button type="button" onClick={saveAdjustedTraceChild}>Save adjustment</Button>
                        <Button type="button" variant="outline" onClick={() => { setSplitEditingChildIndex(null); setGeometryEditKey(null); setGeometryDraft(null); setSplitPreviewed(false); }}>Cancel adjustment</Button>
                      </div>
                    </div>
                  ) : null}
                  <Button type="button" className="col-span-2" onClick={confirmPolygonSplit} disabled={!splitPreviewed || !splitCanPreview || splitConfirmBlockers.length > 0 || splitEditingChildIndex != null}>Confirm Split</Button>
                </div>
              </section>
            ) : null}
            {cropPolygon.length >= 3 && data.planUrl ? (
              <SourcePolygonCrop imageUrl={data.planUrl} polygon={cropPolygon} cropBox={cropBox} />
            ) : <div className="mt-2 grid min-h-36 place-items-center rounded-md border border-dashed text-sm text-muted-foreground">No traceable polygon crop is available.</div>}
            {cropCase ? (
              <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                {cropCase.crop_file && cropCase.crop_sha256
                  ? <>Source-bound crop: {cropCase.crop_file} · SHA-256 {cropCase.crop_sha256.slice(0, 12)}… · map outline and crop use original percentage coordinates.</>
                  : <>Context crop rendered directly from the source image and target polygon · original percentage coordinates retained.</>}
              </p>
            ) : selectedSplitChild ? (
              <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                Draft crop from the verified source image. Parent detection {selectedSplitChild.parent_detection_id} remains unchanged; this proposed child is not part of the benchmark target geometry.
              </p>
            ) : <p className="mt-2 text-[11px] leading-4 text-muted-foreground">Outside this benchmark. Boundary review can be recorded; no printed-number ground truth is accepted in this scope.</p>}
            {activeCase && selectedSlot && selectedCaseIndex >= 0 && splitSessionParentKey !== selectedSlot.id ? (
              <>
                <p className="mt-3 text-sm leading-5 text-foreground">Review only the number inside the outlined boundary. If it covers multiple lots or cannot be read confidently, mark ambiguous or unreadable. Adjacent labels are context only.</p>
                {selectedGeometryFlagged ? <p className="mt-2 rounded-md border border-warning/30 bg-accent-soft p-2.5 text-xs leading-5 text-foreground" role="status">This target is flagged for geometry review. Its benchmark geometry stays fixed and cannot receive a printed-number decision until the issue is resolved. Draft child reviews remain separate.</p> : null}
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

            {selectedSplitChild ? (
              <div className="mt-3 border-t border-border pt-3" data-testid="split-child-review">
                <p className="text-sm font-semibold text-foreground">Draft child number review</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Read only the printed digits inside this traced child outline. This local proposal is separate from benchmark ground truth and legal/register approval.
                </p>
                <Field label="Printed lot number · digits only">
                  <Input value={splitNumberDraft} onChange={(event) => setSplitNumberDraft(event.target.value.replace(/\D/g, ""))} inputMode="numeric" maxLength={12} placeholder="Read from this child outline" disabled={!sourceVerified} />
                </Field>
                {duplicateSplitChildren.length ? (
                  <p className="mt-2 rounded-md border border-warning/30 bg-accent-soft p-2.5 text-xs leading-5 text-foreground" role="alert">
                    Possible duplicate {splitNumberDraft.trim()} is already recorded on {duplicateSplitChildren.map((child) => child.id).join(", ")}. Compare the source crops; no identity is reconciled automatically.
                  </p>
                ) : null}
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Button type="button" onClick={() => saveSplitChildReview("confirmed")} disabled={!sourceVerified || !/^\d+$/.test(splitNumberDraft.trim())}>Save number review</Button>
                  <Button type="button" variant="outline" onClick={() => saveSplitChildReview("ambiguous")} disabled={!sourceVerified}>Ambiguous</Button>
                  <Button type="button" variant="outline" onClick={() => saveSplitChildReview("unreadable")} disabled={!sourceVerified}>Unreadable</Button>
                  {activeSplitForSelection ? <Button type="button" variant="outline" className="col-span-2" onClick={() => undoPolygonSplit(activeSplitForSelection)}>Undo split · restore parent</Button> : null}
                </div>
                <p className="mt-2 text-[11px] leading-4 text-muted-foreground">Review state: {selectedSplitChild.review.status}{selectedSplitChild.review.reviewed_at ? ` · ${selectedSplitChild.review.reviewer} · ${new Date(selectedSplitChild.review.reviewed_at).toLocaleString()}` : " · unreviewed"}</p>
              </div>
            ) : null}

            {selectedSlot && splitSessionParentKey !== selectedSlot.id ? <div className="mt-3 border-t border-border pt-3">
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
            </div> : null}
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-dashed border-border bg-background p-5 text-sm leading-6 text-muted-foreground">
            <strong className="text-foreground">Choose a polygon on the full development map.</strong> The target appears with its source crop and review controls here. Printed-number decisions are limited to the versioned benchmark.
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3">
          <Button type="button" variant="outline" onClick={() => exportJson()} disabled={!sourceVerified || !manifest}>Export review JSON</Button>
          <Button type="button" variant="outline" onClick={() => exportCsv()} disabled={!sourceVerified || !manifest}>Export scorer CSV</Button>
          <Button type="button" variant="outline" className="col-span-2" onClick={exportSplitDraftRecovery} disabled={!sourceVerified || !manifest || !splitDraftStoreLoaded}>Export local draft recovery JSON</Button>
          <input ref={importRef} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => void importJson(event.target.files?.[0])} />
          <Button type="button" variant="outline" className="col-span-2" onClick={() => importRef.current?.click()} disabled={!manifest}>Import prior review JSON</Button>
        </div>
        {feedback && !splitSessionParentKey ? <p className="mt-2 rounded-md bg-muted p-2 text-xs leading-5 text-foreground" role="status">{feedback}</p> : null}
        <p className="mt-2 text-[11px] leading-4 text-muted-foreground">No candidate suggestions are loaded or displayed before the independent review. JSON preserves all {caseCount} source cases; CSV stays compatible with the existing OCR scorer.</p>
      </aside>
    </div>
  );
}

function polygonCropBox(polygon: Array<{ x: number; y: number }>, width: number, height: number): [number, number, number, number] {
  if (!polygon.length) return [0, 0, width, height];
  const bounds = mapPolygonBounds(mapPolygonToRasterPixels(polygon, width, height));
  if (!bounds) return [0, 0, width, height];
  const pad = Math.max(40, Math.max(bounds.width, bounds.height) * 0.2);
  const left = Math.max(0, Math.floor(bounds.x - pad));
  const top = Math.max(0, Math.floor(bounds.y - pad));
  const right = Math.min(width, Math.ceil(bounds.x + bounds.width + pad));
  const bottom = Math.min(height, Math.ceil(bounds.y + bounds.height + pad));
  return [left, top, right, bottom];
}

async function readSourceImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return dimensions;
    } catch {
      // Some browsers cannot create an ImageBitmap from SVG; Image.decode is
      // a standards-based fallback that keeps the source fingerprint check.
    }
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
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
  const rasterPolygon = mapPolygonToRasterPixels(polygon, 5700, 4800);
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-border bg-white" data-testid="source-polygon-crop">
      <svg role="img" aria-label="High-resolution subdivision drawing crop with the target polygon outlined" viewBox={`${x0} ${y0} ${Math.max(1, x1 - x0)} ${Math.max(1, y1 - y0)}`} className="block max-h-[280px] w-full">
        <MapRasterLayer src={imageUrl} x={0} y={0} width={5700} height={4800} preserveAspectRatio="none" />
        <MapPolygon coordinates={rasterPolygon} fill="rgba(185,79,45,.16)" stroke="#ffffff" strokeWidth={16} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <MapPolygon coordinates={rasterPolygon} fill="none" stroke="#b84f2d" strokeWidth={8} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function downloadFile(name: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  // Let the browser start consuming the object URL before revoking it. A
  // synchronous revoke can cancel the download in Chromium/WebKit.
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 1000);
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
  const vbH = mapViewBoxHeight(aspect);
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
            <MapPolygon
              key={id}
              data-lot={id}
              coordinates={s.polygon}
              coordinateScale={{ y: yScale }}
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
            </MapPolygon>
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
          within ~1.5 lot widths; scale-area = printed figure vs polygon at measured scale) and not duplicated. Scale-area remains unavailable until a
          reviewed scale and approved policy are provided, and it does gate bulk acceptance. Sample ≥ 20 (or all when fewer), stratified by tier/block. Any wrong sample lot
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
        ) : bulk.proposal.length === 0 ? (
          <div className="mt-3 rounded-md border border-border bg-muted/40 p-3 text-sm" role="status" aria-label="Bulk accept unavailable">
            <p className="font-semibold">No eligible lots in this proposal.</p>
            <p className="mt-1 text-muted-foreground">
              No suggested lots currently pass every required number, neighboring-lot, and reviewed-scale/area check. No records were changed.
            </p>
            <Button type="button" variant="outline" className="mt-2" onClick={() => setBulk(null)}>
              Dismiss
            </Button>
          </div>
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
