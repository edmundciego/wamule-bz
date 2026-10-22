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

export function resolvePublicSiteTemplateId(value) {
  return PUBLIC_SITE_TEMPLATES.find(template => template.id === value)?.id ?? "wamule-classic";
}

export function defaultPublicExperience(_scope) {
  return {
    templateId: "wamule-classic",
    uiRestrictedAccess: false,
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
    // Only registered layouts can render. Template selection never changes
    // tenant scope, branding or application requirements.
    templateId: resolvePublicSiteTemplateId(raw.templateId),
    // This is an explicitly UI-only preview gate. It must not be presented
    // as access control until every public data/submission endpoint enforces it.
    uiRestrictedAccess: raw.uiRestrictedAccess === true,
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
