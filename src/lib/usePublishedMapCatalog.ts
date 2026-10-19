import { useEffect, useState } from "react";
import type { PackageCategory } from "./mapPackage.mjs";

export function usePublishedMapCatalog(
  scope: { tenant: string; project: string; phase: string },
  onLoaded?: (value: PackageCategory[] | null) => void,
) {
  const [categories, setCategories] = useState<PackageCategory[] | null>(null);
  const [error, setError] = useState(false);
  const { tenant, project, phase } = scope;
  useEffect(() => {
    const base = import.meta.env.VITE_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (!base || !key) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      tenant,
      project,
      phase,
      catalog_only: "true",
    });
    fetch(`${base}/functions/v1/get-public-lots?${params}`, {
      headers: { apikey: key },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Catalogue unavailable");
        return response.json();
      })
      .then((body) => {
        if (controller.signal.aborted) return;
        const result = Array.isArray(body.map_package_catalog)
          ? (body.map_package_catalog as PackageCategory[])
          : null;
        setCategories(result);
        setError(false);
        onLoaded?.(result);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError(true);
        onLoaded?.([]);
      });
    return () => controller.abort();
  }, [tenant, project, phase, onLoaded]);
  return { categories, error };
}
