export const PUBLIC_SITE_TEMPLATES = [
  {
    id: "wamule-classic",
    name: "Wamule Classic",
    description: "The shared two-column homepage, project facts, information panels, and familiar application form.",
  },
];

export const PUBLIC_SITE_MODULES = [
  { id: "map", name: "Project map", description: "Show the public map experience." },
  { id: "inquiry", name: "General inquiries", description: "Show the general project inquiry form." },
  { id: "application", name: "Applications", description: "Show the application experience configured for this project." },
  { id: "pricing", name: "Public prices", description: "Allow the template to show prices when project settings also permit it." },
];

export function defaultPublicExperience(_scope) {
  return {
    templateId: "wamule-classic",
    enabledModules: {
      map: true,
      inquiry: true,
      application: true,
      pricing: true,
    },
  };
}

export function normalizePublicExperience(scope, value) {
  const defaults = defaultPublicExperience(scope);
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const moduleInput = raw.enabledModules && typeof raw.enabledModules === "object" && !Array.isArray(raw.enabledModules)
    ? raw.enabledModules
    : {};
  return {
    // Presentation is deliberately fixed to the first shared template.
    // Tenant, project, phase, branding, and application rules remain scoped
    // independently by their own configuration and route.
    templateId: defaults.templateId,
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
