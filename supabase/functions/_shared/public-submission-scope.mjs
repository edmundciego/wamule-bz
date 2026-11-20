import { normalizePublicHostname, parsePublicHostnameResolution } from "./public-hostname.mjs";

/** Resolve public tenant/project/phase selectors to active, owned rows.
 * Hostnames are optional in shared-path mode. If supplied, the verified host
 * binding is authoritative and every supplied selector must agree with it.
 */
export async function resolvePublicSubmissionScope(client, input) {
  const requestedTenant = cleanSlug(input.tenantSlug);
  const requestedProject = cleanSlug(input.projectSlug);
  const requestedPhase = cleanSlug(input.phaseSlug);
  if ((input.tenantSlug && !requestedTenant) || (input.projectSlug && !requestedProject)
    || (input.phaseSlug && !requestedPhase)) return { ok: false, reason: "invalid_scope" };

  let hostScope = null;
  if (input.hostname !== undefined && input.hostname !== null && String(input.hostname).trim() !== "") {
    const hostname = normalizePublicHostname(input.hostname);
    if (!hostname) return { ok: false, reason: "invalid_hostname" };
    const { data, error } = await client.rpc("resolve_public_hostname", { p_hostname: hostname });
    if (error) return { ok: false, reason: "lookup_failed" };
    const binding = parsePublicHostnameResolution(data);
    if (!binding.resolved) return { ok: false, reason: "unverified_hostname" };
    hostScope = binding.scope;
    if ((requestedProject && requestedProject !== hostScope.projectSlug)
      || (requestedPhase && hostScope.phaseSlug && requestedPhase !== hostScope.phaseSlug)) {
      return { ok: false, reason: "host_mismatch" };
    }
  }

  const tenantSelector = requestedTenant ?? hostScope?.tenantSlug ?? null;
  if (!tenantSelector) return { ok: false, reason: "unknown_tenant" };
  let tenantResult;
  if (input.allowTenantAlias === true) {
    const bySlug = await client.from("organizations").select("id,slug,inbound_alias,is_active")
      .eq("is_active", true).eq("slug", tenantSelector).maybeSingle();
    if (bySlug.error) return { ok: false, reason: "lookup_failed" };
    tenantResult = bySlug;
    if (!tenantResult.data) {
      tenantResult = await client.from("organizations").select("id,slug,inbound_alias,is_active")
        .eq("is_active", true).eq("inbound_alias", tenantSelector).maybeSingle();
    }
  } else {
    tenantResult = await client.from("organizations").select("id,slug,inbound_alias,is_active")
      .eq("is_active", true).eq("slug", tenantSelector).maybeSingle();
  }
  if (tenantResult.error) return { ok: false, reason: "lookup_failed" };
  if (!tenantResult.data) return { ok: false, reason: "unknown_tenant" };
  const tenant = tenantResult.data;
  if (hostScope && tenant.slug !== hostScope.tenantSlug) return { ok: false, reason: "host_mismatch" };

  const projectSelector = requestedProject ?? hostScope?.projectSlug ?? null;
  let projectsQuery = client.from("projects").select("id,name,slug,is_default,map_experience_mode")
    .eq("tenant_id", tenant.id);
  if (projectSelector) projectsQuery = projectsQuery.eq("slug", projectSelector);
  else projectsQuery = projectsQuery.eq("is_default", true);
  const projectsResult = await projectsQuery.limit(2);
  if (projectsResult.error) return { ok: false, reason: "lookup_failed" };
  if (!Array.isArray(projectsResult.data) || projectsResult.data.length !== 1) {
    return { ok: false, reason: "unknown_project" };
  }
  const project = projectsResult.data[0];
  if (hostScope && project.slug !== hostScope.projectSlug) return { ok: false, reason: "host_mismatch" };

  const phaseSelector = requestedPhase ?? hostScope?.phaseSlug ?? null;
  let phasesQuery = client.from("development_phases")
    .select("id,name,slug,is_default,is_active")
    .eq("tenant_id", tenant.id).eq("project_id", project.id).eq("is_active", true);
  if (phaseSelector) phasesQuery = phasesQuery.eq("slug", phaseSelector);
  else phasesQuery = phasesQuery.eq("is_default", true);
  const phasesResult = await phasesQuery.limit(2);
  if (phasesResult.error) return { ok: false, reason: "lookup_failed" };
  if (!Array.isArray(phasesResult.data) || phasesResult.data.length !== 1) {
    return { ok: false, reason: "unknown_phase" };
  }
  const phase = phasesResult.data[0];
  if (hostScope && hostScope.phaseSlug && phase.slug !== hostScope.phaseSlug) {
    return { ok: false, reason: "host_mismatch" };
  }

  return {
    ok: true,
    scope: {
      tenantId: String(tenant.id), tenantSlug: String(tenant.slug),
      projectId: String(project.id), projectSlug: String(project.slug),
      projectName: String(project.name ?? project.slug),
      mapExperienceMode: project.map_experience_mode === "demo" ? "demo" : "sales",
      phaseId: String(phase.id), phaseSlug: String(phase.slug), phaseName: String(phase.name ?? phase.slug),
    },
  };
}

function cleanSlug(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const slug = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,78}$/.test(slug) ? slug : null;
}
