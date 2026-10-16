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
