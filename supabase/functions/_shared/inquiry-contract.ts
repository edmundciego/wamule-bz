/**
 * Shared inquiry-submission contract: the single source of truth for the
 * public inquiry payload shape and field validation.
 *
 * Imported by BOTH the Deno edge function
 * (supabase/functions/submit-public-inquiry/index.ts) and the web app
 * (PublicInquiryModal, ApplicationPage) plus the node contract test, so the
 * modal payload always matches the function's validation schema.
 *
 * Dependency-free on purpose: no Node/Deno/browser APIs, no const enums
 * (node type-stripping + isolatedModules compatible).
 */

export const ALLOWED_INQUIRY_INTERESTS = [
  "Available lots",
  "Lot pricing",
  "Payment options",
  "Site visit",
  "Buying process",
  "A specific lot",
] as const;

export type InquiryInterest = (typeof ALLOWED_INQUIRY_INTERESTS)[number];

export const INQUIRY_LIMITS = {
  name: 120,
  email: 254,
  phone: 40,
  interest: 80,
  message: 1000,
  pageUrl: 1000,
  tenant: 160,
  clientReferenceId: 64,
} as const;

/** Raw payload as sent over the wire (unknown-typed: validation owns it). */
export interface InquiryPayload {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  interests?: unknown;
  specific_lot_id?: unknown;
  message?: unknown;
  page_url?: unknown;
  tenant?: unknown;
  client_reference_id?: unknown;
}

export interface ValidInquiry {
  name: string;
  email: string;
  phone: string;
  message: string;
  pageUrl: string;
  tenantSlug: string | null;
  interests: string[];
  specificLotId: number | null;
  clientReferenceId: string | null;
}

export type InquiryValidation = { error: string } | ValidInquiry;

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/**
 * Build the wire payload, dropping absent optionals. Both inquiry forms use
 * this so the shape can't drift from the schema below.
 */
export function buildInquiryPayload(input: {
  name: string;
  email: string;
  phone?: string;
  interests: string[];
  specificLotId?: number | null;
  message?: string;
  pageUrl?: string;
  tenant?: string | null;
  clientReferenceId?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: input.name,
    email: input.email,
    interests: input.interests,
  };
  if (input.phone) body.phone = input.phone;
  if (input.specificLotId !== undefined && input.specificLotId !== null) {
    body.specific_lot_id = input.specificLotId;
  }
  if (input.message) body.message = input.message;
  if (input.pageUrl) body.page_url = input.pageUrl;
  if (input.tenant) body.tenant = input.tenant;
  if (input.clientReferenceId) body.client_reference_id = input.clientReferenceId;
  return body;
}

/** Pure field validation. Error strings are buyer-facing (shown verbatim). */
export function validateInquiryPayload(body: InquiryPayload): InquiryValidation {
  const name = cleanText(body.name, INQUIRY_LIMITS.name);
  const email = cleanText(body.email, INQUIRY_LIMITS.email).toLowerCase();
  const phone = cleanText(body.phone, INQUIRY_LIMITS.phone);
  const message = cleanText(body.message, INQUIRY_LIMITS.message);
  const pageUrl = cleanText(body.page_url, INQUIRY_LIMITS.pageUrl);
  const tenantSlug = cleanText(body.tenant, INQUIRY_LIMITS.tenant).toLowerCase() || null;
  const interests = Array.isArray(body.interests)
    ? [...new Set(body.interests.map((item) => cleanText(item, INQUIRY_LIMITS.interest)).filter(Boolean))]
    : [];
  const invalidInterest = interests.find(
    (interest) => !(ALLOWED_INQUIRY_INTERESTS as readonly string[]).includes(interest),
  );
  const specificLotId =
    body.specific_lot_id === null || body.specific_lot_id === undefined || body.specific_lot_id === ""
      ? null
      : Number(body.specific_lot_id);
  const clientReferenceId = cleanText(body.client_reference_id, INQUIRY_LIMITS.clientReferenceId) || null;

  if (!name) return { error: "Name is required." };
  if (!email || !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email)) {
    return { error: "Enter a valid email address." };
  }
  if (invalidInterest) return { error: "Select a valid inquiry interest." };
  if (specificLotId !== null && (!Number.isInteger(specificLotId) || specificLotId <= 0)) {
    return { error: "Select a valid lot." };
  }
  if (clientReferenceId !== null && !/^[A-Za-z0-9-]{8,64}$/.test(clientReferenceId)) {
    return { error: "Invalid request reference. Please reload and try again." };
  }

  return { name, email, phone, message, interests, specificLotId, pageUrl, tenantSlug, clientReferenceId };
}

/**
 * Lot-authoritative tenant decision (pure; DB lookups stay in the caller).
 * The lead's tenant derives from the parcel. A provided tenant slug must
 * resolve to that same tenant. Without a lot, the slug must resolve — there
 * is no default fallback.
 */
export type TenantDecision = { tenantId: string } | { error: string };

export function decideLeadTenant(input: {
  lotRequested: boolean;
  /** Parcel's tenant_id (null when no lot requested or parcel tenantless). */
  lotTenantId: string | null;
  /** Whether the caller sent a tenant slug/alias at all. */
  slugProvided: boolean;
  /** Resolved id for the slug, or null when absent/unresolvable. */
  slugTenantId: string | null;
}): TenantDecision {
  if (input.lotRequested) {
    if (input.lotTenantId) {
      if (input.slugProvided) {
        if (!input.slugTenantId) return { error: "Unknown development. Please check the listing link." };
        if (input.slugTenantId !== input.lotTenantId) {
          return { error: "That lot belongs to a different development." };
        }
      }
      return { tenantId: input.lotTenantId };
    }
    if (!input.slugProvided || !input.slugTenantId) {
      return {
        error: !input.slugProvided
          ? "A development identifier is required."
          : "Unknown development. Please check the listing link.",
      };
    }
    return { tenantId: input.slugTenantId };
  }
  if (!input.slugProvided || !input.slugTenantId) {
    return {
      error: !input.slugProvided
        ? "A development identifier is required."
        : "Unknown development. Please check the listing link.",
    };
  }
  return { tenantId: input.slugTenantId };
}

/** Identifying core of a submission (message/page URL may vary on retry). */export interface InquiryFingerprint {
  name: string;
  email: string;
  phone: string;
  parcelId: number | null;
  /** Null = unknown (e.g. activity metadata missing): never conflicts. */
  interests: string[] | null;
}

/**
 * Same key, same inquiry? Email case-insensitive, interests order-free.
 * Unknown prior interests can't conflict.
 */
export function sameInquiryAs(a: InquiryFingerprint, b: InquiryFingerprint): boolean {
  return (
    a.name === b.name &&
    a.email.toLowerCase() === b.email.toLowerCase() &&
    a.phone === b.phone &&
    a.parcelId === b.parcelId &&
    (a.interests === null ||
      b.interests === null ||
      (a.interests.length === b.interests.length && a.interests.every((interest) => b.interests!.includes(interest))))
  );
}

/**
 * What an inquiry means for a lot status: Available → normal inquiry,
 * Reserved → waitlist request (no availability promise), anything else
 * (Sold, …) → not requestable.
 */
export type LotDisposition = "available" | "waitlist" | "unavailable";

export function lotDisposition(status: string | null): LotDisposition {
  if (status === "Available") return "available";
  if (status === "Reserved") return "waitlist";
  return "unavailable";
}
