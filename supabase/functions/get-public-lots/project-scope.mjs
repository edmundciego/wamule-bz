/**
 * Choose a tenant-scoped project row and normalize its database field names
 * for the public endpoint's internal contract.
 * @param {Array<{id: string, slug: string, name: string, is_default: boolean}>} rows
 * @param {string | null} slug
 * @returns {{id: string, slug: string, name: string, isDefault: boolean} | null}
 */
export function chooseResolvedProject(rows, slug) {
  const selected = slug
    ? rows.find((row) => row.slug.toLowerCase() === slug)
    : rows.find((row) => row.is_default);

  if (!selected) return null;
  return {
    id: selected.id,
    slug: selected.slug,
    name: selected.name,
    isDefault: selected.is_default === true,
  };
}

/** Tenant-level settings are a compatibility fallback only for legacy maps or the default project. */
export function projectAllowsTenantFallback(project) {
  return !project || project.isDefault === true;
}

/** Keep active-image resolution distinct from a valid legacy result with no active version. */
export function normalizeActiveMapLookup(data, error) {
  if (error) return { ok: false, version: null };
  if (!data || typeof data.id !== "string") return { ok: true, version: null };
  return {
    ok: true,
    version: {
      id: data.id,
      imageUrl: typeof data.image_url === "string" ? data.image_url : null,
      previewUrl: typeof data.preview_url === "string" ? data.preview_url : null,
    },
  };
}

/** Scope a masterplan-version query to one project (or legacy NULL scope). */
export function applyActiveVersionProjectScope(query, tenantId, projectId) {
  let scoped = query.eq("tenant_id", tenantId).eq("is_active", true);
  scoped = projectId ? scoped.eq("project_id", projectId) : scoped.is("project_id", null);
  return scoped;
}

/**
 * Apply tenant-selected project and active-version boundaries to a parcels
 * query. NULL project/version rows remain visible only for the legacy map
 * path. Project-assigned maps cannot absorb unassigned tenant rows.
 * @template Query
 * @param {Query & {eq: Function, is: Function, or: Function}} query
 * @param {{id: string, slug: string, name: string, isDefault: boolean} | null} project
 * @param {string | null} activeVersionId
 * @returns {Query & {eq: Function, is: Function, or: Function}}
 */
export function applyProjectAndVersionScope(query, project, activeVersionId) {
  let scoped = query;
  if (!project) {
    scoped = scoped.is("project_id", null);
  } else {
    scoped = scoped.eq("project_id", project.id);
  }

  if (activeVersionId) {
    scoped = scoped.or(`masterplan_version_id.is.null,masterplan_version_id.eq.${activeVersionId}`);
  } else {
    scoped = scoped.is("masterplan_version_id", null);
  }
  return scoped;
}
