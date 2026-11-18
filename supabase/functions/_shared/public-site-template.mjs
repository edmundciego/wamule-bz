// Keep the persisted IDs accepted by save_project_site_experience.
export const DEFAULT_PUBLIC_SITE_TEMPLATE_ID = "wamule-classic";
export const SHOWCASE_PUBLIC_SITE_TEMPLATE_ID = "hopkins-project";
export const PUBLIC_SITE_HEADLINE_MAX_LENGTH = 120;

export function resolvePublicSiteTemplateId(value) {
  return value === SHOWCASE_PUBLIC_SITE_TEMPLATE_ID ? value : DEFAULT_PUBLIC_SITE_TEMPLATE_ID;
}

export function normalizePublicSiteHeadline(value) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, PUBLIC_SITE_HEADLINE_MAX_LENGTH)
    : "";
}
