import { lazy } from "react";
import { usePublicSiteExperience } from "../../lib/publicSiteExperience";
import { hasSupabaseConfig } from "../../lib/supabase";
import { ErrorState, LoadingState } from "../../components/ui/State";

const ApplicationPage = lazy(() => import("../ApplicationPage").then((module) => ({ default: module.ApplicationPage })));
const HopkinsPublicPage = lazy(() => import("./HopkinsPublicPage").then((module) => ({ default: module.HopkinsPublicPage })));

const scopes = {
  wamule: { tenantSlug: "wamule", projectSlug: "wamule", phaseSlug: "default" },
  hopkins: { tenantSlug: "hopkins-grove", projectSlug: "hopkins-grove", phaseSlug: "initial" },
} as const;

export function PublicExperienceRoute({ scopeName }: { scopeName: keyof typeof scopes }) {
  const isHopkinsRoute = scopeName === "hopkins";
  const scope = scopes[scopeName];
  const { data, isLoading, isError } = usePublicSiteExperience(scope);
  if (!hasSupabaseConfig) return <main className="mx-auto min-h-screen max-w-3xl bg-background px-4 py-20"><ErrorState message="Project homepage settings are not configured. Please try again later." /></main>;
  if (isLoading) return <main className="min-h-screen bg-background px-4 py-20"><LoadingState label="Loading project homepage" /></main>;
  if (isError || !data) return <main className="mx-auto min-h-screen max-w-3xl bg-background px-4 py-20"><ErrorState message="Project homepage settings are temporarily unavailable. Please try again." /></main>;
  const experience = data;

  // Route/host resolution fixes tenant, project, and phase. The shared
  // presentation template never changes scope or application requirements.
  if (experience.uiRestrictedAccess) {
    const diagnosticScope = new URLSearchParams({ ...scope });
    return (
      <main className="grid min-h-screen place-items-center bg-background px-4 py-10">
        <section className="grid max-w-xl gap-3 rounded-xl border border-warning/30 bg-card p-6 shadow-sm" data-testid="ui-only-restricted-preview" role="status">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-warning-foreground">UI-only restriction · incomplete</p>
          <h1 className="font-display text-2xl font-semibold text-primary">This public preview is hidden</h1>
          <p className="text-sm leading-6 text-muted-foreground">This tenant/project flag hides the page in the interface only. Public map, company, and submission endpoints remain accessible; server-side access enforcement has not been implemented.</p>
          <a href={`/version?${diagnosticScope.toString()}`} className="w-fit text-sm font-semibold text-primary underline">Build and map diagnostics</a>
        </section>
      </main>
    );
  }

  return isHopkinsRoute
    ? <HopkinsPublicPage templateId={experience.templateId} enabledModules={experience.enabledModules} />
    : <ApplicationPage templateId={experience.templateId} enabledModules={experience.enabledModules} />;
}
