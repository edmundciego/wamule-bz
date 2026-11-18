export const PUBLIC_SITE_TEMPLATE_ID: "wamule-classic";
export type PublicSiteModuleId = "map" | "inquiry" | "application" | "pricing";
export type PublicApplicationType = "land_purchase" | "project_application";
export type PublicExperienceScope = { tenantSlug: string; projectSlug: string; phaseSlug: string };
export type PublicExperienceConfig = {
  templateId: typeof PUBLIC_SITE_TEMPLATE_ID;
  applicationType: PublicApplicationType;
  enabledModules: Record<PublicSiteModuleId, boolean>;
};
export const PUBLIC_SITE_MODULES: Array<{ id: PublicSiteModuleId; name: string; description: string }>;
export function defaultPublicExperience(): PublicExperienceConfig;
export function normalizePublicExperience(value: unknown): PublicExperienceConfig;
export function publicExperienceSetting(value: unknown): Record<string, unknown>;
