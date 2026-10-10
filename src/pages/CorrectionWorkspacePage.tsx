import { useEffect, useMemo, useRef, useState } from "react";
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

type Mode = "numbers" | "tiers" | "gates" | "log";

interface WorkspaceData {
  tenant: string;
  project: string;
  lots: ReturnType<typeof adaptLots>;
  tiers: ReturnType<typeof adaptTiers>["tiers"];
  units: ReturnType<typeof adaptUnits>;
  planUrl: string | null;
  actor: string;
  serverBacked: boolean;
}

export function CorrectionWorkspacePage() {
  const [params] = useSearchParams();
  if (DEMO_PREVIEW && params.get("demo") === "1") {
    return <DemoWorkspace />;
  }
  return <AuthedWorkspace />;
}

function DemoWorkspace() {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const base = "/correct/data/";
        const [lotsRes, tiersRes, unitsRes] = await Promise.all([
          fetch(`${base}lots.json`),
          fetch(`${base}tiers.json`),
          fetch(`${base}units.json`),
        ]);
        if (!lotsRes.ok || !tiersRes.ok || !unitsRes.ok) throw new Error("Correction fixture not found (dev server must serve /correct/).");
        const [lotsRaw, tiersRaw, unitsRaw] = await Promise.all([lotsRes.json(), tiersRes.json(), unitsRes.json()]);
        if (cancelled) return;
        const adapted = adaptTiers(tiersRaw);
        setData({
          tenant: adapted.tenant,
          project: adapted.project,
          lots: adaptLots(lotsRaw),
          tiers: adapted.tiers,
          units: adaptUnits(unitsRaw),
          planUrl: `${base}plan.png`,
          actor: "operator",
          serverBacked: false,
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Fixture load failed.");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);
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

function WorkspaceShell({ data }: { data: WorkspaceData }) {
  const [mode, setMode] = useState<Mode>("numbers");
  const [state, setState] = useState<CorrectionState>(() =>
    createInitialState({
      lots: data.lots.map((l) => ({ id: l.id, lot_number: l.lot_number, polygon_pct: l.polygon_pct, tier_key: l.tier_key })),
      tiers: data.tiers,
      units: data.units,
      actor: data.actor,
      tenant: data.tenant,
      project: data.project,
    }),
  );
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
        JSON.stringify({ lots: next.lots, tiers: next.tiers, log: next.log, pointer: next.pointer, waivers: next.waivers, stage: next.stage, publishedAt: next.publishedAt }),
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

  return (
    <section className={data.serverBacked ? "" : "v2-page-shell"}>
      <div className="v2-page-header">
        <p className="v2-page-kicker">Onboarding · Correct</p>
        <h1 className="v2-page-title">Correction workspace</h1>
        <p className="v2-page-description">
          {data.tenant} / {data.project} · {Object.keys(state.lots).length} lots · actor {state.actor}
          {data.serverBacked ? "" : " · local drafts (server drafts pending migration apply)"}
        </p>
      </div>
      <div className="flex gap-2" role="tablist" aria-label="Workspace modes">
        {(["numbers", "tiers", "gates", "log"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-semibold capitalize transition",
              mode === m ? "bg-primary-soft text-primary" : "text-muted-foreground hover:text-primary",
            )}
          >
            {m}
          </button>
        ))}
      </div>
      {mode === "numbers" ? <NumbersTab state={state} mutate={mutate} planUrl={data.planUrl} /> : null}
      {mode === "tiers" ? <TiersTab state={state} mutate={mutate} planUrl={data.planUrl} /> : null}
      {mode === "gates" ? <GatesTab state={state} mutate={mutate} /> : null}
      {mode === "log" ? <LogTab state={state} mutate={mutate} /> : null}
      {toast ? (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded bg-foreground px-4 py-2 text-sm text-background" role="status">
          {toast}
        </div>
      ) : null}
    </section>
  );
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
