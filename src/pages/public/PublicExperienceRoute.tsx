import { lazy } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import type { PublicExperienceScope, PublicSiteTemplateId } from "../../lib/publicExperience.mjs";
import { usePublicSiteExperience } from "../../lib/publicSiteExperience";
import type { PublicPhaseOption } from "../../lib/publicSiteExperience";
import type { PublicHostnameResolution } from "../../lib/publicHostResolver";

const ApplicationPage = lazy(() => import("../ApplicationPage").then((module) => ({ default: module.ApplicationPage })));
const HopkinsPublicPage = lazy(() => import("./HopkinsPublicPage").then((module) => ({ default: module.HopkinsPublicPage })));
const EmbeddableMapPage = lazy(() => import("./EmbeddableMapPage").then((module) => ({ default: module.EmbeddableMapPage })));

export function PublicExperienceRoute({
  hostname,
  binding,
  mapRoute = false,
  phaseLocked = false,
}: {
  hostname?: string;
  binding: Extract<PublicHostnameResolution, { resolved: true }>["scope"];
  mapRoute?: boolean;
  phaseLocked?: boolean;
}) {
  const params = useParams<{ tenant_slug?: string; project_slug?: string }>();
  const [searchParams] = useSearchParams();
  const pathScopeMatches = !mapRoute || (
    params.tenant_slug === binding.tenantSlug
    && (!params.project_slug || params.project_slug === binding.projectSlug)
  );
  const explicitPhase = searchParams.has("phase");
  const requestedPhaseSlug = explicitPhase ? searchParams.get("phase") : binding.phaseSlug;
  const lockedPhaseMismatch = phaseLocked && explicitPhase && requestedPhaseSlug !== binding.phaseSlug;
  const { data, isLoading, isError, error } = usePublicSiteExperience(
    hostname ?? "",
    binding,
    requestedPhaseSlug,
    pathScopeMatches && !lockedPhaseMismatch,
  );

  if (!pathScopeMatches || lockedPhaseMismatch) return <PublicUnavailable message="This public project path does not match its verified tenant, project, or phase." />;
  if (isLoading) return <main className="grid min-h-screen place-items-center px-4" role="status">Loading public project information…</main>;
  if (isError || !data) {
    return <PublicUnavailable message={error instanceof Error ? error.message : "This public project could not be verified."} />;
  }

  const scope: PublicExperienceScope = data.scope;
  const phases = phaseLocked ? data.phases.filter((phase) => phase.slug === binding.phaseSlug) : data.phases;
  if (mapRoute) {
    return <EmbeddableMapPage hostname={hostname} scope={scope} phases={phases} />;
  }

  const templateId: PublicSiteTemplateId = data.siteExperience.templateId;
  const enabledModules = data.siteExperience.enabledModules;
  return data.siteExperience.applicationType === "project_application"
    ? <HopkinsPublicPage hostname={hostname ?? ""} scope={scope} phases={phases} templateId={templateId} enabledModules={enabledModules} />
    : <ApplicationPage hostname={hostname ?? ""} scope={scope} phases={phases} company={data.company} publicApplication={data.publicApplication}
      installmentPlans={data.installmentPlans} paymentMethods={data.paymentMethods} templateId={templateId} enabledModules={enabledModules} />;
}

function PublicUnavailable({ message }: { message: string }) {
  return <main className="mx-auto grid min-h-screen max-w-2xl content-center gap-3 px-5 text-center"><h1 className="font-display text-2xl font-semibold">This project is unavailable</h1><p className="text-sm text-muted-foreground">{message}</p></main>;
}

export type { PublicPhaseOption };
