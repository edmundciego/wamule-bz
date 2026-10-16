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
  try {
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
      tenant_id?: string;
    } | null;

    const email = body?.email?.trim().toLowerCase();
    const fullName = body?.full_name?.trim() || null;
    const role = body?.role;
    const password = body?.password;
    const tenantId = body?.tenant_id;

    if (!email || !role || !["Admin", "Staff", "Read Only"].includes(role) || !tenantId) {
      return json({ error: "Email, tenant, and a tenant staff role are required." }, 400);
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("organizations")
      .select("id")
      .eq("id", tenantId)
      .maybeSingle();
    if (tenantError) return json({ error: tenantError.message }, 500);
    if (!tenant) return json({ error: "The selected tenant does not exist." }, 404);

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

    const { data: existingProfile, error: existingProfileError } = await supabase
      .from("admin_profiles")
      .select("user_id, tenant_id, role")
      .eq("user_id", userId)
      .maybeSingle();
    if (existingProfileError) return json({ error: existingProfileError.message }, 500);
    if (existingProfile && existingProfile.tenant_id !== tenantId) {
      return json({ error: "This account already belongs to another tenant. Its assignment was preserved." }, 409);
    }

    const profileQuery = existingProfile
      ? supabase.from("admin_profiles").update({ email, full_name: fullName, role }).eq("user_id", userId).eq("tenant_id", tenantId)
      : supabase.from("admin_profiles").insert({
        user_id: userId,
        tenant_id: tenantId,
        email,
        full_name: fullName,
        role,
      });
    const { data: profile, error: upsertError } = await profileQuery
      .select("user_id, tenant_id, email, full_name, role, created_at, updated_at")
      .single();

    if (upsertError) {
      return json({ error: upsertError.message }, 500);
    }

    return json({ mode, profile });
  } catch (error) {
    console.error("manage-admin-user failed", error);
    return json({ error: "User management failed. Check the Edge Function logs for details." }, 500);
  }
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
