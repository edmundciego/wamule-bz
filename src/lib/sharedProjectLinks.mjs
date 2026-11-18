export function buildSharedProjectLinks(origin, slugs) {
  const base = new URL(origin).origin;
  const encodeSlug = (value) => {
    const slug = String(value ?? "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,78}$/.test(slug)) throw new Error("The selected workspace has an invalid public slug.");
    return encodeURIComponent(slug);
  };
  const projectPath = `/p/${encodeSlug(slugs.tenantSlug)}/${encodeSlug(slugs.projectSlug)}`;
  const phase = `?phase=${encodeSlug(slugs.phaseSlug)}`;
  return {
    projectUrl: `${base}${projectPath}${phase}`,
    mapUrl: `${base}${projectPath}/map${phase}`,
  };
}
