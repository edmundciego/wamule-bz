/**
 * Tenant profiles are currently bound to one authenticated account. Clear
 * cached records when that account changes so a shared browser cannot briefly
 * render the previous tenant's data after sign-out/sign-in.
 */
export function didAuthIdentityChange(
  previousUserId: string | null | undefined,
  nextUserId: string | null,
): boolean {
  return previousUserId !== undefined && previousUserId !== nextUserId;
}

export function authorizationSnapshotKey(
  profile: { user_id: string; role: string; tenant_id?: string | null } | null | undefined,
  memberships: Array<{ user_id?: string; tenant_id: string; project_id: string; phase_id: string | null; member_role: string }> = [],
) {
  if (!profile) return "signed-out";
  const scopes = memberships
    .map(({ user_id, tenant_id, project_id, phase_id, member_role }) => [user_id ?? profile.user_id, tenant_id, project_id, phase_id, member_role].join(":"))
    .sort();
  return JSON.stringify([profile.user_id, profile.role, profile.tenant_id ?? null, scopes]);
}

export function didAuthorizationChange(previous: string | undefined, next: string) {
  return previous !== undefined && previous !== next;
}
