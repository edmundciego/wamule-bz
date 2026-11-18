export type SharedProjectSlugs = { tenantSlug: string; projectSlug: string; phaseSlug: string };
export function buildSharedProjectLinks(origin: string, slugs: SharedProjectSlugs): { projectUrl: string; mapUrl: string };
