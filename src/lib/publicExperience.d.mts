export type PublicSiteTemplateId = "wamule-classic" | "hopkins-project";
export type PublicSiteModuleId = "map" | "inquiry" | "application" | "pricing";
export type PublicApplicationType = "land_purchase" | "project_application";
export type PublicExperienceScope = { tenantSlug: string; projectSlug: string; phaseSlug: string };
export type PublicExperienceConfig = {
  templateId: PublicSiteTemplateId;
  applicationType: PublicApplicationType;
  enabledModules: Record<PublicSiteModuleId, boolean>;
};
export const PUBLIC_SITE_TEMPLATES: Array<{ id: PublicSiteTemplateId; name: string; description: string }>;
export const PUBLIC_SITE_MODULES: Array<{ id: PublicSiteModuleId; name: string; description: string }>;
export function defaultPublicExperience(scope: PublicExperienceScope): PublicExperienceConfig;
export function normalizePublicExperience(scope: PublicExperienceScope, value: unknown): PublicExperienceConfig;
export function publicExperienceSetting(value: unknown): Record<string, unknown>;
