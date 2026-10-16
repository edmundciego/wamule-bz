import { lazy } from "react";
import { usePublicSiteExperience } from "../../lib/publicSiteExperience";
import { defaultPublicExperience } from "../../lib/publicExperience.mjs";

const ApplicationPage = lazy(() => import("../ApplicationPage").then((module) => ({ default: module.ApplicationPage })));
const HopkinsPublicPage = lazy(() => import("./HopkinsPublicPage").then((module) => ({ default: module.HopkinsPublicPage })));

const scopes = {
  wamule: { tenantSlug: "wamule", projectSlug: "wamule", phaseSlug: "default" },
  hopkins: { tenantSlug: "hopkins-grove", projectSlug: "hopkins-grove", phaseSlug: "initial" },
} as const;

export function PublicExperienceRoute({ scopeName }: { scopeName: keyof typeof scopes }) {
  const isHopkinsRoute = scopeName === "hopkins";
  const scope = scopes[scopeName];
  const { data } = usePublicSiteExperience(scope);
  const experience = data ?? defaultPublicExperience(scope);

  // Route/host resolution fixes tenant, project, and phase. The shared
  // presentation template never changes scope or application requirements.
  return isHopkinsRoute
    ? <HopkinsPublicPage enabledModules={experience.enabledModules} />
    : <ApplicationPage templateId={experience.templateId} enabledModules={experience.enabledModules} />;
}
