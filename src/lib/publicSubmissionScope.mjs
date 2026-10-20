export function isLocalOnlySubmissionForScope({
  isDev,
  demoMode,
  tenantSlug = "",
  projectSlug = "",
  stagingSubmissionScopes = [],
}) {
  if (isDev) return true;
  const scope = `${tenantSlug}/${projectSlug}`.trim().toLowerCase();
  if (scope !== "/" && stagingSubmissionScopes.includes(scope)) return false;
  return demoMode === "true";
}
