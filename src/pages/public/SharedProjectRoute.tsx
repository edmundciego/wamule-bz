import { useParams, useSearchParams } from "react-router-dom";
import { PublicExperienceRoute } from "./PublicExperienceRoute";

export function SharedProjectRoute({ mapRoute = false, applicationOnly = false }: { mapRoute?: boolean; applicationOnly?: boolean }) {
  const { tenant_slug: tenantSlug = "", project_slug: projectSlug = "" } = useParams<{ tenant_slug: string; project_slug: string }>();
  const [searchParams] = useSearchParams();
  const requestedPhase = searchParams.get("phase");
  const validSlug = (value: string) => /^[a-z0-9][a-z0-9-]{0,78}$/.test(value);
  if (!validSlug(tenantSlug) || !validSlug(projectSlug) || (requestedPhase !== null && !validSlug(requestedPhase))) {
    return <main className="mx-auto grid min-h-screen max-w-2xl content-center gap-3 px-5 text-center"><h1 className="font-display text-2xl font-semibold">This project is unavailable</h1><p className="text-sm text-muted-foreground">The shared project address is invalid.</p></main>;
  }
  return <PublicExperienceRoute hostname="" binding={{ tenantSlug, projectSlug, phaseSlug: requestedPhase }} mapRoute={mapRoute} applicationOnly={applicationOnly} />;
}
