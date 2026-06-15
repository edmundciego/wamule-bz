import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

  const token = (request.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) {
    return json({ error: "Missing authorization token." }, 401);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: currentUserData, error: currentUserError } = await supabase.auth.getUser(token);
  if (currentUserError || !currentUserData.user) {
    return json({ error: "Invalid authorization token." }, 401);
  }

  const { data: currentProfile, error: profileError } = await supabase
    .from("admin_profiles")
    .select("role")
    .eq("user_id", currentUserData.user.id)
    .maybeSingle();

  if (profileError) {
    return json({ error: profileError.message }, 500);
  }

  if (!["Super Admin", "Admin"].includes(String(currentProfile?.role ?? ""))) {
    return json({ error: "Only Super Admin or Admin users can check AI provider status." }, 403);
  }

  const { data: settings, error: settingsError } = await supabase
    .from("ai_settings")
    .select("*")
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (settingsError) {
    return json({ error: settingsError.message }, 500);
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GOOGLE_API_KEY") ?? "";
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

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Reply with OK." }] }],
          generationConfig: { maxOutputTokens: 4 },
        }),
      },
    );

    if (!response.ok) {
      return json({
        enabled,
        connected: false,
        provider: settings?.provider ?? "Gemini",
        model,
        message: `Gemini health check failed with status ${response.status}.`,
      });
    }

    return json({
      enabled,
      connected: true,
      provider: settings?.provider ?? "Gemini",
      model,
      message: "Gemini provider is reachable.",
    });
  } catch {
    return json({
      enabled,
      connected: false,
      provider: settings?.provider ?? "Gemini",
      model,
      message: "Gemini health check could not be completed.",
    });
  }
});

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: corsHeaders,
  });
}
