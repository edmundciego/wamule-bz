import { useQuery } from "@tanstack/react-query";
import { hasSupabaseConfig, supabase } from "./supabase";

export const CANONICAL_COMPANY_NAME = "Wamule Development";
export const CANONICAL_SHORT_NAME = "Wamule";

export type CompanyBrand = { company_name?: string | null; logo_url?: string | null };

export function companyName(profile?: CompanyBrand | null) {
  return profile?.company_name?.trim() || CANONICAL_COMPANY_NAME;
}

export function companyShortName(profile?: CompanyBrand | null) {
  const name = companyName(profile);
  return name.replace(/\s+Development$/i, "").trim() || CANONICAL_SHORT_NAME;
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

export type CompanyProfile = typeof defaultCompanyProfile;

export function useCompanyProfile() {
  const query = useQuery({
    queryKey: ["company-profile"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("business_settings")
        .select("value")
        .eq("key", "company_profile")
        .maybeSingle();
      if (error) throw error;
      return (data?.value ?? null) as Partial<CompanyProfile> | null;
    },
    enabled: hasSupabaseConfig,
    staleTime: 5 * 60 * 1000,
  });

  const company = { ...defaultCompanyProfile, ...(query.data ?? {}) };
  const hasProfile = query.data !== null && query.data !== undefined;

  return {
    company,
    companyName: companyName(company),
    shortName: companyShortName(company),
    isLoading: hasSupabaseConfig && query.isLoading,
    isUnavailable: hasSupabaseConfig && (query.isError || !hasProfile),
  };
}
