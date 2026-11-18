import { lazy } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { PublicExperienceScope } from "../../lib/publicExperience.mjs";
import { getPublicApplicationAccess, usePublicSiteExperience } from "../../lib/publicSiteExperience";
import type { PublicPhaseOption } from "../../lib/publicSiteExperience";
import type { PublicHostnameResolution } from "../../lib/publicHostResolver";

const PublicApplicationForm = lazy(() => import("../../components/public/PublicApplicationForm").then((module) => ({ default: module.PublicApplicationForm })));
const PublicApplicationPage = lazy(() => import("./PublicApplicationPage").then((module) => ({ default: module.PublicApplicationPage })));
const PublicHomepage = lazy(() => import("../../components/public/PublicHomepage").then((module) => ({ default: module.PublicHomepage })));
const EmbeddableMapPage = lazy(() => import("./EmbeddableMapPage").then((module) => ({ default: module.EmbeddableMapPage })));

export function PublicExperienceRoute({
  hostname,
  binding,
  mapRoute = false,
  applicationOnly = false,
  phaseLocked = false,
}: {
  hostname?: string;
  binding: Extract<PublicHostnameResolution, { resolved: true }>["scope"];
  mapRoute?: boolean;
  applicationOnly?: boolean;
  phaseLocked?: boolean;
}) {
  const params = useParams<{ tenant_slug?: string; project_slug?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
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
  const { applicationType, enabledModules } = data.siteExperience;
  const projectSlugs = `${encodeURIComponent(scope.tenantSlug)}/${encodeURIComponent(scope.projectSlug)}`;
  const projectPath = hostname ? "/" : `/p/${projectSlugs}`;
  const applicationPath = hostname ? "/apply" : `${projectPath}/apply`;
  const mapPath = hostname ? `/embed/${projectSlugs}` : `${projectPath}/map`;
  const phaseQuery = `?phase=${encodeURIComponent(scope.phaseSlug)}`;
  const applicationHref = applicationPath + phaseQuery;
  const scopeKey = `${hostname ?? ""}/${scope.tenantSlug}/${scope.projectSlug}/${scope.phaseSlug}/${applicationType}`;
  const { canSubmit } = getPublicApplicationAccess(data, hostname ?? "");
  const applyWithOutline = applicationType === "project_application" && enabledModules.map && canSubmit
    && (data.publicApplication.max_map_preferences ?? 0) > 0
    ? (ref: string) => navigate(`${applicationHref}&apply_feature=${encodeURIComponent(ref)}`)
    : undefined;

  if (mapRoute) {
    return <EmbeddableMapPage hostname={hostname} scope={scope} phases={phases} showPrices={enabledModules.pricing} applyWithOutline={applyWithOutline} />;
  }

  const initialOutline = searchParams.get("apply_feature") || undefined;
  if (!applicationOnly && searchParams.get("apply") === "1") {
    const href = initialOutline ? `${applicationHref}&apply_feature=${encodeURIComponent(initialOutline)}` : applicationHref;
    return <Navigate to={href} replace />;
  }

  const clearInitialOutline = initialOutline ? () => {
    const next = new URLSearchParams(searchParams);
    next.delete("apply_feature");
    setSearchParams(next, { replace: true });
  } : undefined;

  if (applicationOnly) {
    const application = enabledModules.application ? (
      <PublicApplicationForm
        key={scopeKey}
        hostname={hostname ?? ""}
        data={data}
        standalone
        initialOutline={initialOutline}
        onClearInitialOutline={clearInitialOutline}
      />
    ) : null;
    return <PublicApplicationPage data={data} projectHref={projectPath + phaseQuery}>{application}</PublicApplicationPage>;
  }

  return (
    <PublicHomepage
      key={scopeKey}
      hostname={hostname ?? ""}
      data={data}
      phases={phases}
      applicationHref={applicationHref}
      mapHref={mapPath + phaseQuery}
      applyWithOutline={applyWithOutline}
      onClearInitialOutline={clearInitialOutline}
    />
  );
}

function PublicUnavailable({ message }: { message: string }) {
  return <main className="mx-auto grid min-h-screen max-w-2xl content-center gap-3 px-5 text-center"><h1 className="font-display text-2xl font-semibold">This project is unavailable</h1><p className="text-sm text-muted-foreground">{message}</p></main>;
}

export type { PublicPhaseOption };
