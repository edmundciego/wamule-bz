import { createTenantProvisioningService } from "../../../scripts/lib/tenant-provisioning-service.mjs";

const ALLOWED_HIERARCHY_ACTIONS = new Set([
  "set_tenant_active", "create_project", "update_project", "set_default_project",
  "create_phase", "update_phase", "set_default_phase", "set_phase_active",
]);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
  },
});

function cleanError(error) {
  return error instanceof Error ? error.message : String(error ?? "Super Admin request failed.");
}

function assertSuccessful(result, operation) {
  if (result?.error) throw new Error(`${operation}: ${result.error.message}`);
  return result?.data;
}

async function listUsers(authAdmin) {
  const users = [];
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await authAdmin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Auth user listing: ${error.message}`);
    for (const user of data?.users ?? []) {
      users.push({
        id: user.id,
        email: user.email ?? null,
        full_name: user.user_metadata?.full_name ?? user.user_metadata?.name ?? null,
      });
    }
    if (!data?.users?.length || data.users.length < 1000) break;
  }
  return users;
}

async function listWorkspaceData(serviceClient) {
  const [tenants, projects, phases, profiles, memberships] = await Promise.all([
    serviceClient.from("organizations").select("id,name,slug,inbound_alias,is_active,created_at").order("name"),
    serviceClient.from("projects").select("id,tenant_id,slug,name,is_default,map_experience_mode,created_at").order("name"),
    serviceClient.from("development_phases").select("id,tenant_id,project_id,slug,name,is_default,is_active,created_at").order("name"),
    serviceClient.from("admin_profiles").select("user_id,email,full_name,role,tenant_id").order("email"),
    serviceClient.from("project_memberships").select("id,user_id,tenant_id,project_id,phase_id,member_role,created_at").order("created_at"),
  ]);
  const named = ["Tenants", "Projects", "Phases", "Profiles", "Memberships"];
  const outputs = [tenants, projects, phases, profiles, memberships];
  outputs.forEach((result, index) => {
    if (result.error) throw new Error(`${named[index]} could not be loaded: ${result.error.message}`);
  });
  const authUsers = await listUsers(serviceClient.auth.admin);
  const projectRows = projects.data ?? [];
  const phaseRows = phases.data ?? [];
  const hierarchy = (tenants.data ?? []).map((tenant) => {
    const tenantProjects = projectRows.filter((project) => project.tenant_id === tenant.id).map((project) => {
      const projectPhases = phaseRows.filter((phase) => phase.project_id === project.id);
      const defaultPhase = projectPhases.find((phase) => phase.is_default) ?? null;
      const activePhases = projectPhases.filter((phase) => phase.is_active);
      return {
        ...project,
        phases: projectPhases,
        default_phase_id: defaultPhase?.id ?? null,
        workspace_access_ready: tenant.is_active && Boolean(defaultPhase?.is_active),
        active_phase_count: activePhases.length,
      };
    });
    return {
      ...tenant,
      projects: tenantProjects,
      workspace_access_ready: tenant.is_active && tenantProjects.some((project) => project.workspace_access_ready),
      project_availability_note: "Projects have no is_active field; availability follows tenant and active phase state.",
    };
  });
  return {
    tenants: hierarchy,
    projects: projectRows,
    phases: phaseRows,
    profiles: profiles.data ?? [],
    memberships: memberships.data ?? [],
    auth_users: authUsers,
    readiness_basis: "Workspace access is separate from sales setup, map publication, provider sign-in and domain readiness.",
  };
}

export async function handleSuperAdminConsole(request, dependencies = {}) {
  const env = dependencies.env ?? {};
  const createClient = dependencies.createClient;
  const createProvisioningService = dependencies.createProvisioningService ?? createTenantProvisioningService;
  if (request.method === "OPTIONS") return json({ ok: true });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (typeof createClient !== "function") return json({ error: "Server Supabase client is unavailable." }, 500);

  try {
    const authorization = request.headers.get("Authorization") ?? "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim();
    if (!token) return json({ error: "A signed-in Super Admin session is required." }, 401);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "A JSON action is required." }, 400);

    const supabaseUrl = env.SUPABASE_URL;
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    const anonKey = env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !serviceRoleKey || !anonKey) return json({ error: "Super Admin server credentials are not configured." }, 503);

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const operator = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const identity = await serviceClient.auth.getUser(token);
    if (identity.error || !identity.data?.user?.id) return json({ error: "The signed-in session could not be verified." }, 401);
    const actorId = identity.data.user.id;
    const profileResult = await serviceClient.from("admin_profiles").select("role,tenant_id").eq("user_id", actorId).maybeSingle();
    if (profileResult.error) return json({ error: "Current permissions could not be verified." }, 500);
    if (profileResult.data?.role !== "Super Admin") return json({ error: "Only a current Super Admin may use the tenant console." }, 403);

    if (body.action === "list") {
      return json({ ok: true, actor_id: actorId, ...(await listWorkspaceData(serviceClient)) });
    }

    if (body.action === "provision") {
      if (!body.manifest || typeof body.manifest !== "object") return json({ error: "A provisioning manifest is required." }, 400);
      const apply = body.apply === true;
      const expectedProjectRef = env.WAMULE_EXPECTED_SUPABASE_PROJECT_REF ?? "kvocwmrcuhiaezlcgzjf";
      const service = createProvisioningService({ supabase: serviceClient, supabaseUrl, expectedProjectRef });
      let outcome;
      if (Array.isArray(body.manifest.users) && body.manifest.users.length > 0) {
        outcome = await service.onboardMember(body.manifest, {
          apply,
          operator,
          operatorAccessToken: token,
          authAdmin: serviceClient.auth.admin,
        });
      } else {
        outcome = await service.run(body.manifest, { apply });
      }
      return json({ ok: true, action: "provision", ...outcome });
    }

    if (body.action === "hierarchy") {
      if (!ALLOWED_HIERARCHY_ACTIONS.has(body.operation)) return json({ error: "Unsupported hierarchy action." }, 400);
      const allowed = ["p_tenant_id", "p_name", "p_slug", "p_project_id", "p_phase_id", "p_is_active", "p_map_experience_mode", "p_phase_slug", "p_phase_name"];
      const args = { p_action: body.operation };
      for (const key of allowed) if (Object.hasOwn(body, key)) args[key] = body[key];
      if (!args.p_tenant_id) return json({ error: "Select a tenant from the verified list." }, 400);
      const result = await operator.rpc("super_admin_manage_workspace_hierarchy_v1", args);
      return json({ ok: true, action: "hierarchy", result: assertSuccessful(result, "Hierarchy update failed") });
    }

    if (body.action === "member") {
      const targetUserId = body.target_user_id;
      const tenantId = body.tenant_id;
      const role = body.profile_role;
      const memberships = body.memberships;
      if (typeof targetUserId !== "string" || typeof tenantId !== "string"
        || !["Admin", "Staff", "Read Only", "Super Admin"].includes(role)
        || !Array.isArray(memberships)) {
        return json({ error: "A target user, tenant, valid profile role and complete membership replacement set are required." }, 400);
      }
      const targetUser = (await serviceClient.auth.admin.getUserById(targetUserId));
      if (targetUser.error || !targetUser.data?.user) return json({ error: "Select an existing Auth account." }, 404);
      const assignment = await operator.rpc("manage_workspace_member", {
        p_target_user_id: targetUserId,
        p_tenant_id: tenantId,
        p_profile_role: role,
        p_memberships: memberships,
        p_email: targetUser.data.user.email ?? null,
        p_full_name: targetUser.data.user.user_metadata?.full_name ?? targetUser.data.user.user_metadata?.name ?? null,
      });
      return json({ ok: true, action: "member", result: assertSuccessful(assignment, "Membership change failed") });
    }

    return json({ error: "Unsupported Super Admin console action." }, 400);
  } catch (error) {
    return json({ error: cleanError(error) }, 400);
  }
}
