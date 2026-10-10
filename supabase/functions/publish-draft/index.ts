// Slice 1.6 publish-draft edge function (local-only; not deployed).
//
// Enforcement split: DB owns invariants (RLS tenant isolation, append-only
// log, rev monotonicity, waiver checks). THIS function owns the publish
// verdict — overlap refusal + stage gate — by calling enforcePublish(),
// which imports the single canonical implementation in
// src/lib/correction (no forked logic here).
//
// Request (POST JSON):
//   { tenant_id, project_slug, base_rev, actor, existing: [{id,lot_number,polygon}] }
// Response:
//   200 { ok:true, rev, stage, matched, created }
//   409 { error } on stale rev / gate bypass / overlap.
//
// Actor binding: actor must be the server-session actor (auth.uid() email/id);
// empty actors are rejected. RLS on correction_drafts still applies (service
// role reads the row, but the tenant_id must equal the caller's tenant —
// cross-tenant publishes are rejected before enforcePublish runs).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { enforcePublish, GateBypassError } from "./publish.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }
  const body = (await request.json().catch(() => ({}))) as {
    tenant_id?: unknown;
    project_slug?: unknown;
    base_rev?: unknown;
    actor?: unknown;
    existing?: unknown;
  };
  const tenantId = typeof body.tenant_id === "string" ? body.tenant_id : "";
  const projectSlug = typeof body.project_slug === "string" ? body.project_slug : "";
  const actor = typeof body.actor === "string" ? body.actor : "";
  const baseRev = typeof body.base_rev === "number" ? body.base_rev : -1;
  const existing = Array.isArray(body.existing) ? body.existing : [];
  if (!tenantId || !projectSlug) return json({ error: "tenant_id and project_slug are required." }, 400);
  if (!actor.trim()) return json({ error: "actor is required (server-session actor)." }, 400);
  if (baseRev < 0) return json({ error: "base_rev is required (optimistic locking)." }, 400);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: draft, error } = await supabase
    .from("correction_drafts")
    .select("rev, doc, tenant_id")
    .eq("tenant_id", tenantId)
    .eq("project_slug", projectSlug)
    .maybeSingle();
  if (error || !draft) return json({ error: "Draft not found." }, 404);
  const row = draft as { rev: number; doc: unknown; tenant_id: string };
  if (row.rev !== baseRev) {
    return json({ error: `stale revision: draft is at rev ${row.rev}, reload and retry` }, 409);
  }
  const rawState = (row.doc ?? null) as Parameters<typeof enforcePublish>[0]["state"] | null;
  if (!rawState || typeof rawState !== "object" || !rawState.lots) {
    return json({ error: "Draft doc is corrupt." }, 500);
  }
  // Stage authority: onboarding_states is the server-side stage record; the
  // doc-embedded stage is client-influenced (saves carry full state) and MUST
  // NOT be trusted for the verdict. Override it here so doc tampering that
  // relabels the stage cannot skip gates (see bypass test).
  const { data: onboarding } = await supabase
    .from("onboarding_states")
    .select("stage")
    .eq("tenant_id", tenantId)
    .eq("project_slug", projectSlug)
    .maybeSingle();
  const dbStage = (onboarding as { stage?: unknown } | null)?.stage;
  const state = {
    ...rawState,
    stage: typeof dbStage === "string" && dbStage ? dbStage : rawState.stage,
  } as Parameters<typeof enforcePublish>[0]["state"];

  try {
    const out = enforcePublish({
      state,
      existing: existing as Parameters<typeof enforcePublish>[0]["existing"],
      actor,
    });
    const now = new Date().toISOString();
    const { error: saveError } = await supabase
      .from("correction_drafts")
      .update({ doc: { ...state, stage: out.stage, publishedAt: now }, rev: row.rev + 1, updated_by: actor, updated_at: now })
      .eq("tenant_id", tenantId)
      .eq("project_slug", projectSlug)
      .eq("rev", baseRev);
    if (saveError) return json({ error: saveError.message }, 409);
    await supabase.from("onboarding_states").upsert(
      { tenant_id: tenantId, project_slug: projectSlug, stage: out.stage, updated_by: actor, updated_at: now },
      { onConflict: "tenant_id,project_slug" },
    );
    return json({ ok: true, rev: row.rev + 1, stage: out.stage, matched: out.plan.matched.length, created: out.plan.created.length });
  } catch (e) {
    if (e instanceof GateBypassError) return json({ error: e.message }, 409);
    if (e instanceof Error && /gate bypass refused|overlap/.test(e.message)) {
      return json({ error: `publish refused: ${e.message}` }, 409);
    }
    console.error("publish-draft failed", e instanceof Error ? e.message : e);
    return json({ error: "Publish failed." }, 500);
  }
});

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}
