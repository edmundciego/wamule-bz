import { useParams, useSearchParams } from "react-router-dom";
import type { PublicExperienceScope } from "../../lib/publicExperience.mjs";
import { PublicExperienceRoute } from "./PublicExperienceRoute";

/** Shared-platform path whose three slugs are re-resolved by public Edge Functions. */
export function PublicPlatformRoute() {
  const params = useParams<{ tenant_slug?: string; project_slug?: string; phase_slug?: string }>();
  const [searchParams] = useSearchParams();
  const tenantSlug = params.tenant_slug ?? "";
  const projectSlug = params.project_slug ?? "";
  const phaseSlug = params.phase_slug ?? "";
  if (![tenantSlug, projectSlug, phaseSlug].every((part) => /^[a-z0-9][a-z0-9-]{0,78}$/.test(part))) {
    return <main className="mx-auto grid min-h-screen max-w-2xl content-center gap-3 px-5 text-center"><div><h1 className="font-display text-2xl font-semibold">This project is unavailable</h1><p className="text-sm text-muted-foreground">The tenant, project, or phase path is invalid.</p></div></main>;
  }
  const binding: PublicExperienceScope = { tenantSlug, projectSlug, phaseSlug };
  return <PublicExperienceRoute binding={binding} phaseLocked mapRoute={searchParams.get("map") === "1"} />;
}
