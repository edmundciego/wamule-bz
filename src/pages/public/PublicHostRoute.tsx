import { useQuery } from "@tanstack/react-query";
import { resolvePublicHostname } from "../../lib/publicHostResolver";
import { hasSupabaseConfig } from "../../lib/supabase";
import { PublicExperienceRoute } from "./PublicExperienceRoute";

/** The host is resolved before any tenant-scoped public adapter is mounted. */
export function PublicHostRoute({ mapRoute = false }: { mapRoute?: boolean }) {
  const hostname = window.location.hostname;
  const { data, isLoading, isError } = useQuery({
    queryKey: ["public-host-binding", hostname],
    queryFn: () => resolvePublicHostname(hostname),
    enabled: hasSupabaseConfig,
    staleTime: 0,
    retry: false,
  });

  if (isLoading) return <main className="grid min-h-screen place-items-center px-4" role="status">Resolving this project…</main>;
  if (!hasSupabaseConfig || isError || !data?.resolved) {
    return <main className="grid min-h-screen place-items-center px-4 text-center"><div><h1 className="font-display text-2xl font-semibold">This project is unavailable</h1><p className="mt-2 text-sm text-muted-foreground">The requested public address could not be verified.</p></div></main>;
  }

  return <PublicExperienceRoute hostname={hostname} binding={data.scope} mapRoute={mapRoute} />;
}
