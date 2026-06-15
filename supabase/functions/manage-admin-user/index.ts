import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type AppRole = "Super Admin" | "Admin" | "Staff" | "Read Only";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "").trim();
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

  if (currentProfile?.role !== "Super Admin") {
    return json({ error: "Only Super Admin users can manage users." }, 403);
  }

  const body = await request.json().catch(() => null) as {
    email?: string;
    full_name?: string;
    role?: AppRole;
    password?: string;
  } | null;

  const email = body?.email?.trim().toLowerCase();
  const fullName = body?.full_name?.trim() || null;
  const role = body?.role;
  const password = body?.password;

  if (!email || !role || !["Super Admin", "Admin", "Staff", "Read Only"].includes(role)) {
    return json({ error: "Email and valid role are required." }, 400);
  }

  if (password && password.length < 8) {
    return json({ error: "Temporary password must be at least 8 characters." }, 400);
  }

  const existingUser = await findUserByEmail(supabase, email);
  let userId = existingUser?.id;
  let mode: "created" | "invited" | "existing" = existingUser ? "existing" : "created";

  if (!userId) {
    if (password) {
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });
      if (error) return json({ error: error.message }, 400);
      userId = data.user?.id;
      mode = "created";
    } else {
      const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
        data: { full_name: fullName },
      });
      if (error) return json({ error: error.message }, 400);
      userId = data.user?.id;
      mode = "invited";
    }
  }

  if (!userId) {
    return json({ error: "Could not create or locate auth user." }, 500);
  }

  const { data: profile, error: upsertError } = await supabase
    .from("admin_profiles")
    .upsert({
      user_id: userId,
      email,
      full_name: fullName,
      role,
    }, { onConflict: "user_id" })
    .select("user_id, email, full_name, role, created_at, updated_at")
    .single();

  if (upsertError) {
    return json({ error: upsertError.message }, 500);
  }

  return json({ mode, profile });
});

async function findUserByEmail(
  supabase: ReturnType<typeof createClient>,
  email: string,
) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
    if (user) return user;
    if (data.users.length < 1000) return null;
  }
  return null;
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: corsHeaders,
  });
}
