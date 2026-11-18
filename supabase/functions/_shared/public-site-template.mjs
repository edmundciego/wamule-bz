// Keep the persisted IDs accepted by save_project_site_experience.
export const DEFAULT_PUBLIC_SITE_TEMPLATE_ID = "wamule-classic";
export const SHOWCASE_PUBLIC_SITE_TEMPLATE_ID = "hopkins-project";

export function resolvePublicSiteTemplateId(value) {
  return value === SHOWCASE_PUBLIC_SITE_TEMPLATE_ID ? value : DEFAULT_PUBLIC_SITE_TEMPLATE_ID;
}
