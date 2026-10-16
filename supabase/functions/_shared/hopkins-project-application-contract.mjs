const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USES = ["Residential", "Commercial", "Agriculture", "Investment", "Rental Property", "Other"];

const SCOPE = Object.freeze({ tenant: "hopkins-grove", project: "hopkins-grove", phase: "initial" });

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

export function buildHopkinsProjectApplicationPayload(input) {
  return {
    tenant: SCOPE.tenant,
    project: SCOPE.project,
    phase: SCOPE.phase,
    submission_reference: input.submission_reference,
    applicant_full_name: input.applicant_full_name,
    applicant_address: input.applicant_address,
    nationality: input.nationality,
    occupation: input.occupation,
    phone: input.phone,
    email: input.email,
    intended_use: input.intended_use,
    intended_use_other: input.intended_use_other ?? "",
    preferred_map_feature_refs: input.preferred_map_feature_refs ?? [],
    notes: input.notes ?? "",
    legal_notice_acknowledged: input.legal_notice_acknowledged === true,
    applicant_acknowledgement_signature: input.applicant_acknowledgement_signature,
  };
}

export function validateHopkinsProjectApplicationPayload(body, maxMapPreferences = 5) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid project application." };
  const allowed = new Set([
    "tenant", "project", "phase", "submission_reference", "applicant_full_name", "applicant_address",
    "nationality", "occupation", "phone", "email", "intended_use", "intended_use_other",
    "preferred_map_feature_refs", "notes", "legal_notice_acknowledged", "applicant_acknowledgement_signature",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return { error: "Reload the Hopkins application form and try again." };

  const tenant = cleanText(body.tenant, 160).toLowerCase();
  const project = cleanText(body.project, 160).toLowerCase();
  const phase = cleanText(body.phase, 160).toLowerCase();
  if (tenant !== SCOPE.tenant || project !== SCOPE.project || phase !== SCOPE.phase) {
    return { error: "This application link does not match the Hopkins Grove project." };
  }
  const submission_reference = cleanText(body.submission_reference, 36).toLowerCase();
  if (!UUID_PATTERN.test(submission_reference)) return { error: "Refresh the form and try submitting again." };

  const applicant_full_name = cleanText(body.applicant_full_name, 160);
  const applicant_address = cleanText(body.applicant_address, 500);
  const nationality = cleanText(body.nationality, 100);
  const occupation = cleanText(body.occupation, 160);
  const phone = cleanText(body.phone, 40);
  const email = cleanText(body.email, 254).toLowerCase();
  const intended_use = cleanText(body.intended_use, 40);
  const intended_use_other = cleanText(body.intended_use_other, 500);
  const notes = cleanText(body.notes, 2000);
  const signature = cleanText(body.applicant_acknowledgement_signature, 160);
  const refs = body.preferred_map_feature_refs;

  if (applicant_full_name.length < 2) return { error: "Applicant full name is required." };
  if (!applicant_address) return { error: "Applicant address is required." };
  if (!nationality) return { error: "Nationality is required." };
  if (!occupation) return { error: "Occupation is required." };
  if (phone.replace(/\D/g, "").length < 7) return { error: "Enter a valid phone number." };
  if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email)) return { error: "Enter a valid email address." };
  if (!USES.includes(intended_use)) return { error: "Select a valid intended use." };
  if (intended_use === "Other" && !intended_use_other) return { error: "Describe the intended project use." };
  if (!Array.isArray(refs) || refs.length > maxMapPreferences) return { error: `Choose no more than ${maxMapPreferences} map outlines.` };
  if (refs.some((ref) => typeof ref !== "string" || !UUID_PATTERN.test(ref))) return { error: "Choose map outlines from the Hopkins project map." };
  const preferred_map_feature_refs = refs.map((ref) => ref.toLowerCase());
  if (new Set(preferred_map_feature_refs).size !== preferred_map_feature_refs.length) return { error: "Remove duplicate map-outline preferences." };
  if (body.legal_notice_acknowledged !== true) return { error: "Please acknowledge the Hopkins project notice." };
  if (signature.toLowerCase() !== applicant_full_name.toLowerCase()) return { error: "Type your full name to acknowledge the project notice." };

  return {
    tenant,
    project,
    phase,
    submission_reference,
    applicant_full_name,
    applicant_address,
    nationality,
    occupation,
    phone,
    email,
    intended_use,
    intended_use_other,
    preferred_map_feature_refs,
    notes,
    legal_notice_acknowledged: true,
    applicant_acknowledgement_signature: signature,
  };
}
