import { lazy } from "react";
import { usePublicSiteExperience } from "../../lib/publicSiteExperience";
import type { PublicSiteTemplateId } from "../../lib/publicExperience.mjs";

const ApplicationPage = lazy(() => import("../ApplicationPage").then((module) => ({ default: module.ApplicationPage })));
const HopkinsPublicPage = lazy(() => import("./HopkinsPublicPage").then((module) => ({ default: module.HopkinsPublicPage })));

const scopes = {
  wamule: { tenantSlug: "wamule", projectSlug: "wamule", phaseSlug: "default" },
  hopkins: { tenantSlug: "hopkins-grove", projectSlug: "hopkins-grove", phaseSlug: "initial" },
} as const;

export function PublicExperienceRoute({ defaultTemplate }: { defaultTemplate: PublicSiteTemplateId }) {
  const isHopkinsRoute = defaultTemplate === "hopkins-project";
  const scope = isHopkinsRoute ? scopes.hopkins : scopes.wamule;
  const { data } = usePublicSiteExperience(scope);
  const templateId = data?.templateId ?? defaultTemplate;
  const enabledModules = data?.enabledModules;

  // Host/path resolution fixes tenant, project, and phase. The selected
  // presentation template never changes that scope or its form requirements.
  return isHopkinsRoute
    ? <HopkinsPublicPage templateId={templateId} enabledModules={enabledModules} />
    : <ApplicationPage templateId={templateId} enabledModules={enabledModules} />;
}
