// Retain the saved identifier so existing project settings remain usable.
export const PUBLIC_SITE_TEMPLATE_ID = "wamule-classic";

export const PUBLIC_SITE_MODULES = [
  { id: "map", name: "Interactive map", description: "Show the selected phase’s published map." },
  { id: "inquiry", name: "Inquiry form", description: "Let visitors request information from the project team." },
  { id: "application", name: "Application", description: "Show the configured application and its current status." },
  { id: "pricing", name: "Public pricing", description: "Show public lot prices and published plan reference prices where available." },
];

export function defaultPublicExperience() {
  return {
    templateId: PUBLIC_SITE_TEMPLATE_ID,
    applicationType: "land_purchase",
    enabledModules: {
      map: true,
      inquiry: true,
      application: true,
      pricing: true,
    },
  };
}

export function normalizePublicExperience(value) {
  const defaults = defaultPublicExperience();
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const moduleInput = raw.enabledModules && typeof raw.enabledModules === "object" && !Array.isArray(raw.enabledModules)
    ? raw.enabledModules
    : {};
  return {
    templateId: defaults.templateId,
    applicationType: raw.applicationType === "project_application"
      ? "project_application"
      : "land_purchase",
    enabledModules: Object.fromEntries(PUBLIC_SITE_MODULES.map(({ id }) => [
      id,
      typeof moduleInput[id] === "boolean" ? moduleInput[id] : defaults.enabledModules[id],
    ])),
  };
}

export function publicExperienceSetting(value) {
  const theme = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return theme.site_experience && typeof theme.site_experience === "object" && !Array.isArray(theme.site_experience)
    ? theme.site_experience
    : {};
}
