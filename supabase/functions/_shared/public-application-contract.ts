import { parsePublicLotReference } from "./public-lot-reference.ts";

export const PUBLIC_APPLICATION_FIELDS = [
  "applicant_full_name",
  "applicant_address",
  "nationality",
  "occupation",
  "phone",
  "email",
  "intended_use",
  "intended_use_other",
  "parcel_count",
  "preferred_lot_refs",
  "alternate_lot_preference",
  "payment_option",
  "legal_notice_acknowledged",
  "applicant_acknowledgement_signature",
  "notes",
  "sustainability_terms_verified",
] as const;

const INTENDED_USES = ["Residential", "Commercial", "Agriculture", "Investment", "Rental Property", "Other"] as const;
const MAX_PREFERRED_LOTS = 20;

export interface PublicApplicationPayload {
  tenant?: unknown;
  applicant_full_name?: unknown;
  applicant_address?: unknown;
  nationality?: unknown;
  occupation?: unknown;
  phone?: unknown;
  email?: unknown;
  intended_use?: unknown;
  intended_use_other?: unknown;
  parcel_count?: unknown;
  preferred_lot_refs?: unknown;
  alternate_lot_preference?: unknown;
  payment_option?: unknown;
  legal_notice_acknowledged?: unknown;
  applicant_acknowledgement_signature?: unknown;
  notes?: unknown;
  sustainability_terms_verified?: unknown;
}

export interface ValidPublicApplication {
  tenant: string;
  applicant_full_name: string;
  applicant_address: string;
  nationality: string;
  occupation: string;
  phone: string;
  email: string;
  intended_use: (typeof INTENDED_USES)[number];
  intended_use_other: string;
  parcel_count: number;
  preferred_lot_refs: string[];
  alternate_lot_preference: string;
  payment_option: string;
  legal_notice_acknowledged: true;
  applicant_acknowledgement_signature: string;
  notes: string;
  sustainability_terms_verified: true;
}

export type PublicApplicationValidation = { error: string } | ValidPublicApplication;

/** Client builder: copies only the approved wire fields, never DB identity or status fields. */
export function buildPublicApplicationPayload(input: Record<string, unknown> & { tenant: string }): Record<string, unknown> {
  const output: Record<string, unknown> = { tenant: input.tenant };
  for (const field of PUBLIC_APPLICATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) output[field] = input[field];
  }
  return output;
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Public wire validation. Database ids, tenant ids, and staff-authored fields are never accepted. */
export function validatePublicApplicationPayload(body: PublicApplicationPayload): PublicApplicationValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid application." };
  const allowed = new Set<string>(["tenant", ...PUBLIC_APPLICATION_FIELDS]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return { error: "Reload the application form and try again." };

  const tenant = text(body.tenant, 160)?.toLowerCase() ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,159}$/.test(tenant)) return { error: "This application page is not configured." };

  const applicant_full_name = text(body.applicant_full_name, 160) ?? "";
  const applicant_address = text(body.applicant_address, 500) ?? "";
  const nationality = text(body.nationality, 100) ?? "";
  const occupation = text(body.occupation, 160) ?? "";
  const phone = text(body.phone, 40) ?? "";
  const email = (text(body.email, 254) ?? "").toLowerCase();
  const intendedUse = text(body.intended_use, 40) ?? "";
  const intended_use_other = text(body.intended_use_other, 500) ?? "";
  const alternate_lot_preference = text(body.alternate_lot_preference, 240) ?? "";
  const payment_option = text(body.payment_option, 160) ?? "";
  const applicant_acknowledgement_signature = text(body.applicant_acknowledgement_signature, 160) ?? "";
  const notes = text(body.notes, 2000) ?? "";
  const parcel_count = body.parcel_count;
  const preferred_lot_refs = body.preferred_lot_refs;

  if (applicant_full_name.length < 2) return { error: "Applicant full name is required." };
  if (!applicant_address) return { error: "Applicant address is required." };
  if (!nationality) return { error: "Nationality is required." };
  if (!occupation) return { error: "Occupation is required." };
  if (phone.length < 7) return { error: "Enter a valid phone number." };
  if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email)) return { error: "Enter a valid email address." };
  if (!(INTENDED_USES as readonly string[]).includes(intendedUse)) return { error: "Select a valid intended use." };
  if (intendedUse === "Other" && !intended_use_other) return { error: "Describe the intended use." };
  if (typeof parcel_count !== "number" || !Number.isInteger(parcel_count) || parcel_count < 1 || parcel_count > 100) {
    return { error: "Enter a valid number of parcels." };
  }
  if (!Array.isArray(preferred_lot_refs) || preferred_lot_refs.length < 1 || preferred_lot_refs.length > MAX_PREFERRED_LOTS) {
    return { error: "Select between 1 and 20 preferred lots." };
  }
  if (preferred_lot_refs.some((reference) => typeof reference !== "string" || !parsePublicLotReference(reference))) {
    return { error: "Select preferred lots from the current public map." };
  }
  const lotRefs = preferred_lot_refs as string[];
  const normalizedLotKeys = lotRefs.map((reference) => {
    const parts = parsePublicLotReference(reference)!;
    return JSON.stringify([parts.projectSlug, parts.lotNumber]);
  });
  if (new Set(normalizedLotKeys).size !== normalizedLotKeys.length) return { error: "Remove duplicate preferred lots." };
  if (!alternate_lot_preference) return { error: "Alternative lot option is required." };
  if (!payment_option) return { error: "Select a payment option." };
  if (!applicant_acknowledgement_signature) return { error: "Type your name to acknowledge." };
  if (body.legal_notice_acknowledged !== true) return { error: "Important Notice acknowledgement is required." };
  if (body.sustainability_terms_verified !== true) return { error: "Community and sustainability terms must be acknowledged." };

  return {
    tenant,
    applicant_full_name,
    applicant_address,
    nationality,
    occupation,
    phone,
    email,
    intended_use: intendedUse as ValidPublicApplication["intended_use"],
    intended_use_other,
    parcel_count: Number(parcel_count),
    preferred_lot_refs: lotRefs,
    alternate_lot_preference,
    payment_option,
    legal_notice_acknowledged: true,
    applicant_acknowledgement_signature,
    notes,
    sustainability_terms_verified: true,
  };
}
