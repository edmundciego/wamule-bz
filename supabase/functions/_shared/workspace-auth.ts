export type WorkspaceAuthorization =
  | { ok: true; tenantId: string; role: string }
  | { ok: false; status: number; error: string };

export async function authorizeWorkspaceTenant(
  supabase: any,
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
    .select("id")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantError) return { ok: false, status: 500, error: tenantError.message };
  if (!tenant) return { ok: false, status: 404, error: "The selected tenant does not exist." };
  return { ok: true, tenantId, role };
}
