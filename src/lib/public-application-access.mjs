export function resolvePublicApplicationAccess(data) {
  const settings = data.publicApplication;
  const projectApplication = data.siteExperience.applicationType === "project_application";
  const accepting = data.siteExperience.enabledModules.application === true
    && settings.applications_open === true
    && settings.notices_complete === true
    && (!projectApplication || Boolean(settings.allowed_intended_uses?.length));
  return { accepting, canSubmit: accepting };
}
