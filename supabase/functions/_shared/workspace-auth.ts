export type WorkspaceAuthorization =
  | { ok: true; tenantId: string; role: string }
  | { ok: false; status: number; error: string };

type WorkspaceAuthQuery = {
  select(columns: string): WorkspaceAuthQuery;
  eq(column: string, value: unknown): WorkspaceAuthQuery;
  is(column: string, value: null): WorkspaceAuthQuery;
  maybeSingle(): Promise<{
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  }>;
};

type WorkspaceAuthClient = { from(table: string): WorkspaceAuthQuery };

export async function authorizeWorkspaceTenant(
  supabase: WorkspaceAuthClient,
  userId: string,
  requestedTenantId: unknown,
  allowedRoles: string[],
): Promise<WorkspaceAuthorization> {
  const tenantId = typeof requestedTenantId === "string" ? requestedTenantId.trim() : "";
  if (!tenantId) return { ok: false, status: 400, error: "tenant_id is required for this workspace action." };

  const { data: profile, error: profileError } = await supabase
    .from("admin_profiles")
    .select("role, tenant_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (profileError) return { ok: false, status: 500, error: profileError.message };
  const role = String(profile?.role ?? "");
  if (!allowedRoles.includes(role)) return { ok: false, status: 403, error: "This account does not have access to this workspace action." };
  if (role !== "Super Admin" && profile?.tenant_id !== tenantId) {
    return { ok: false, status: 403, error: "The selected tenant is outside this account's workspace." };
  }

  const { data: tenant, error: tenantError } = await supabase
    .from("organizations")
    .select("id,is_active")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantError) return { ok: false, status: 500, error: tenantError.message };
  if (!tenant) return { ok: false, status: 404, error: "The selected tenant does not exist." };
  if (tenant.is_active !== true) {
    return { ok: false, status: 403, error: "The selected tenant is inactive. This operation requires an active workspace." };
  }
  return { ok: true, tenantId, role };
}

/**
 * Authorize a server-side operation against a record's database-derived,
 * currently active project/phase. Tenant IDs supplied by a request are only
 * accepted after authorizeWorkspaceTenant verifies the actor and tenant.
 */
export async function authorizeWorkspaceActivePhase(
  supabase: WorkspaceAuthClient,
  userId: string,
  requestedTenantId: unknown,
  requestedProjectId: unknown,
  requestedPhaseId: unknown,
  allowedRoles: string[],
): Promise<WorkspaceAuthorization> {
  const base = await authorizeWorkspaceTenant(supabase, userId, requestedTenantId, allowedRoles);
  if (!base.ok) return base;
  const projectId = typeof requestedProjectId === "string" ? requestedProjectId.trim() : "";
  const phaseId = typeof requestedPhaseId === "string" ? requestedPhaseId.trim() : "";
  if (!projectId || !phaseId) {
    return { ok: false, status: 403, error: "This action requires a verified project and phase." };
  }

  const { data: project, error: projectError } = await supabase.from("projects")
    .select("id,tenant_id").eq("id", projectId).eq("tenant_id", base.tenantId).maybeSingle();
  if (projectError) return { ok: false, status: 500, error: projectError.message };
  if (!project) return { ok: false, status: 404, error: "The selected project is outside this workspace." };

  const { data: phase, error: phaseError } = await supabase.from("development_phases")
    .select("id,tenant_id,project_id,is_active").eq("id", phaseId).eq("tenant_id", base.tenantId)
    .eq("project_id", projectId).eq("is_active", true).maybeSingle();
  if (phaseError) return { ok: false, status: 500, error: phaseError.message };
  if (!phase) return { ok: false, status: 403, error: "This action requires the selected active project phase." };

  if (base.role === "Admin" || base.role === "Super Admin") return base;
  if (base.role !== "Staff") {
    return { ok: false, status: 403, error: "This account cannot perform a phase-scoped service action." };
  }

  const [exact, allPhase] = await Promise.all([
    supabase.from("project_memberships").select("member_role")
      .eq("tenant_id", base.tenantId).eq("project_id", projectId).eq("phase_id", phaseId).eq("user_id", userId).maybeSingle(),
    supabase.from("project_memberships").select("member_role")
      .eq("tenant_id", base.tenantId).eq("project_id", projectId).is("phase_id", null).eq("user_id", userId).maybeSingle(),
  ]);
  if (exact.error || allPhase.error) {
    return { ok: false, status: 500, error: exact.error?.message ?? allPhase.error?.message ?? "Could not verify project membership." };
  }
  if (exact.data && allPhase.data) {
    return { ok: false, status: 403, error: "Conflicting project memberships deny this phase-scoped action." };
  }
  const membership = exact.data ?? allPhase.data;
  if (!membership || !["owner", "admin", "staff"].includes(String(membership.member_role))) {
    return { ok: false, status: 403, error: "This account is not assigned to the selected active phase." };
  }
  return base;
}
