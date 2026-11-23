import { useQuery } from "@tanstack/react-query";
import type { MapPayload } from "../components/public/PublicLotMap";
import type { PublicExperienceScope } from "./publicExperience.mjs";
import { hasSupabaseConfig } from "./supabase";
import { hasHopkinsReferencePricing, publicHopkinsPrintedNumber } from "./referencePlotPricing.mjs";

export type PublicParcelOption = {
  public_ref: string;
  local_key: number;
  lot_number: string;
  status: string | null;
  base_price: number;
  dimensions: string | null;
};

export type PublicOutlineOption = {
  ref: string;
  label: string;
  tierKey: string | null;
};

export function usePublicApplicationPlots(hostname: string, scope: PublicExperienceScope, enabled: boolean) {
  return useQuery({
    queryKey: ["public-application-plots", hostname, scope.tenantSlug, scope.projectSlug, scope.phaseSlug],
    queryFn: async ({ signal }) => {
      const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "");
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
      if (!baseUrl || !anonKey) throw new Error("The public lot service is not configured.");

      const params = new URLSearchParams({ tenant: scope.tenantSlug, project: scope.projectSlug, phase: scope.phaseSlug });
      if (hostname) params.set("host", hostname);
      const response = await fetch(`${baseUrl}/functions/v1/get-public-lots?${params}`, {
        headers: { apikey: anonKey },
        cache: "no-store",
        signal,
      });
      const body = await response.json().catch(() => ({})) as MapPayload & { error?: string };
      if (!response.ok || body?.tenant?.slug !== scope.tenantSlug || body.project?.slug !== scope.projectSlug
        || body.phase?.slug !== scope.phaseSlug || !Array.isArray(body.parcels)
        || (body.map_experience_mode === "demo" && !Array.isArray(body.features))) {
        throw new Error(body?.error || "Could not verify the lot list for this phase.");
      }

      const parcels = body.parcels.flatMap((parcel, index): PublicParcelOption[] =>
        typeof parcel.public_ref === "string" && typeof parcel.lot_number === "string"
          && parcel.status === "Available" && parcel.sales_selectable === true
          ? [{
            public_ref: parcel.public_ref,
            local_key: index + 1,
            lot_number: parcel.lot_number,
            status: parcel.status,
            base_price: Number(parcel.price ?? 0),
            dimensions: typeof parcel.dimensions === "string" ? parcel.dimensions : null,
          }]
          : []);
      const hopkinsReferenceMap = hasHopkinsReferencePricing(body);
      const outlines = body.map_experience_mode === "demo"
        ? (body.features ?? []).flatMap((feature): PublicOutlineOption[] => {
          if (typeof feature.map_feature_ref !== "string" || typeof feature.demo_label !== "string") return [];
          const printedNumber = hopkinsReferenceMap ? publicHopkinsPrintedNumber(feature) : null;
          return [{
            ref: feature.map_feature_ref,
            label: hopkinsReferenceMap ? printedNumber ? `Plot ${printedNumber}` : "Map plot" : feature.demo_label,
            tierKey: typeof feature.source_tier_key === "string" && feature.source_tier_status !== "source-tier-ambiguous-multiple-colors"
              ? feature.source_tier_key : null,
          }];
        })
        : [];
      return { parcels, outlines, map: body };
    },
    enabled: hasSupabaseConfig && enabled,
    retry: false,
  });
}
