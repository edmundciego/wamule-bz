const NOTICE_FIELDS = Object.freeze([
  "public_notice_text",
  "application_acknowledgment_text",
]);

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Resolve public application controls using the M7.1 company/project contract.
 * Application availability is a two-key gate: both scopes must explicitly
 * opt in. Notice fields inherit independently only when the project field is
 * absent; an explicitly blank or malformed project value stays incomplete.
 */
export function resolvePublicApplicationSettings(companyInput, projectInput, phaseIdInput) {
  const company = objectValue(companyInput);
  const project = objectValue(projectInput);
  const text = {};

  for (const field of NOTICE_FIELDS) {
    const source = Object.prototype.hasOwnProperty.call(project, field) ? project : company;
    text[field] = cleanText(source[field]);
  }

  const phaseId = phaseIdInput;
  let phaseAllowed = true;
  if (Object.prototype.hasOwnProperty.call(project, "allowed_phase_ids")) {
    const allowed = project.allowed_phase_ids;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    phaseAllowed = Array.isArray(allowed)
      && typeof phaseId === "string"
      && uuidPattern.test(phaseId)
      && allowed.every((candidate) => typeof candidate === "string" && uuidPattern.test(candidate))
      && allowed.some((candidate) => candidate.toLowerCase() === phaseId.toLowerCase());
  }

  return {
    applicationsOpen: company.applications_open === true
      && project.applications_open === true
      && phaseAllowed,
    publicNoticeText: text.public_notice_text,
    acknowledgmentText: text.application_acknowledgment_text,
    noticesComplete: NOTICE_FIELDS.every((field) => text[field].length > 0),
  };
}
