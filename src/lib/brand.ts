export const CANONICAL_COMPANY_NAME = "Wamule Development";
export const CANONICAL_SHORT_NAME = "Wamule";

export type CompanyBrand = { company_name?: string | null; logo_url?: string | null };

export function companyName(profile?: CompanyBrand | null) {
  return profile?.company_name?.trim() || CANONICAL_COMPANY_NAME;
}

export function companyShortName(profile?: CompanyBrand | null) {
  const name = companyName(profile);
  return name === CANONICAL_COMPANY_NAME ? CANONICAL_SHORT_NAME : name;
}

export const defaultCompanyProfile = {
  company_name: CANONICAL_COMPANY_NAME,
  logo_url: "/favicon/android-chrome-192x192.png",
  contact_email: "",
  phone_number: "",
  website: "",
  location_address: "Mile 3 on the Hummingbird Highway in Dangriga Town, Belize",
  short_description: "Private subdivision land development in Dangriga Town, Belize.",
};
