import { resolveAiWorkspace, resolveAiProviderKey } from "../_shared/aiWorkspace.ts";
import { generateGeminiJson, GEMINI_FALLBACK_MODEL } from "../_shared/geminiFallback.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (request) => {
  try {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  const token = (request.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) {
    return json({ error: "Missing authorization token." }, 401);
  }

  const serverSupabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: currentUserData, error: currentUserError } = await serverSupabase.auth.getUser(token);
  if (currentUserError || !currentUserData.user) {
    return json({ error: "Invalid authorization token." }, 401);
  }

  const { data: currentProfile, error: profileError } = await serverSupabase
    .from("admin_profiles")
    .select("role, tenant_id")
    .eq("user_id", currentUserData.user.id)
    .maybeSingle();

  if (profileError) {
    return json({ error: profileError.message }, 500);
  }

  if (!["Super Admin", "Admin"].includes(String(currentProfile?.role ?? ""))) {
    return json({ error: "Only Super Admin or Admin users can check AI provider status." }, 403);
  }

  const body = await request.json().catch(() => null) as { tenant_id?: unknown } | null;

  const workspace = await resolveAiWorkspace(token, currentProfile, body?.tenant_id);
  if (!workspace.ok) return json({ error: workspace.error }, workspace.status);
  const supabase = workspace.client;

  const { data: settings, error: settingsError } = await supabase
    .from("ai_settings")
    .select("*")
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (settingsError) {
    return json({ error: settingsError.message }, 500);
  }

  const apiKey = await resolveAiProviderKey(serverSupabase, workspace.tenantId);
  const enabled = Boolean(settings?.is_enabled);
  const model = String(settings?.model ?? "gemini-3.1-flash-lite");

  if (!enabled) {
    return json({
      enabled,
      connected: false,
      provider: settings?.provider ?? "Gemini",
      model,
      message: "AI is disabled in settings.",
    });
  }

  if (!apiKey) {
    return json({
      enabled,
      connected: false,
      provider: settings?.provider ?? "Gemini",
      model,
      message: "Gemini API key is not configured server-side.",
    });
  }

  const failures: Array<{ model: string; status?: number; reason: string }> = [];
  const probe = await generateGeminiJson({ apiKey, model, prompt: 'Return only JSON: {"summary":"OK"}', maxOutputTokens: 32,
    onFailure: failure => failures.push(failure) });
  const lastFailure = failures.at(-1);
  const failureMessage = lastFailure?.status === 429
    ? "Gemini returned a rate or usage limit (429). Data-only summaries remain available."
    : [400, 401, 403].includes(lastFailure?.status ?? 0)
    ? `Gemini rejected the existing provider request (${lastFailure?.status}). Check the server-side credential and provider access.`
    : lastFailure?.status === 404
    ? "The configured Gemini model is unavailable (404). Check the selected model and provider access."
    : lastFailure?.reason === "timeout"
    ? "Gemini did not respond in time. Data-only summaries remain available."
    : "Gemini is unavailable; summaries can use the labeled data-only fallback.";
  return json({ enabled, connected: Boolean(probe), provider: "Gemini", model: probe?.model ?? model,
    primaryModel: model, fallbackModel: GEMINI_FALLBACK_MODEL,
    ...(probe ? {} : { diagnostic: lastFailure ?? { reason: "empty_provider_output" } }),
    message: probe ? "Gemini provider is reachable." : failureMessage });

  } catch {
    console.error("AI workspace operation failed; no provider credentials were logged.");
    return json({ error: "Could not complete the workspace AI request. Please try again." }, 500);
  }
});

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: corsHeaders,
  });
}
