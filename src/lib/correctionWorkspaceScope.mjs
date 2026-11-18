function scopePart(value) {
  return encodeURIComponent(String(value ?? "").trim());
}

export function correctionWorkspaceScopeKey(tenant, project, phase) {
  return `${scopePart(tenant)}:${scopePart(project)}:${scopePart(phase)}`;
}

export function correctionWorkspaceDraftStorageKey(tenant, project, phase) {
  return `cw:${correctionWorkspaceScopeKey(tenant, project, phase)}`;
}

export function correctionWorkspaceBenchmarkReviewStorageKey(benchmarkId, manifestSha, phase) {
  return `wamule-lot-number-benchmark-v1:${scopePart(benchmarkId)}:${scopePart(manifestSha)}:${scopePart(phase)}`;
}

export function correctionWorkspacePhaseStorageKey(baseKey, phase) {
  return `${baseKey}:${scopePart(phase)}`;
}

/** Read only the active masterplan belonging to the selected tenant/project/phase. */
export async function loadCorrectionWorkspaceMasterplan(client, scope) {
  const { data: version, error: versionError } = await client.from("masterplan_versions")
    .select("image_url")
    .eq("tenant_id", scope.tenantId)
    .eq("project_id", scope.projectId)
    .eq("phase_id", scope.phaseId)
    .eq("is_active", true)
    .maybeSingle();
  if (versionError) throw versionError;

  const versionUrl = usableUrl(version?.image_url);
  if (versionUrl) return versionUrl;
  if (!scope.isDefaultProject || !scope.isDefaultPhase) return null;

  const { data: organization, error: organizationError } = await client.from("organizations")
    .select("masterplan_image_url")
    .eq("id", scope.tenantId)
    .maybeSingle();
  if (organizationError) throw organizationError;
  return usableUrl(organization?.masterplan_image_url);
}

function usableUrl(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
