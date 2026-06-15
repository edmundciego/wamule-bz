import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { getSessionAndProfile } from "../../lib/data";
import { hasSupabaseConfig } from "../../lib/supabase";
import { ErrorState, LoadingState } from "../ui/State";

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["session-profile"],
    queryFn: getSessionAndProfile,
    retry: false,
  });

  if (!hasSupabaseConfig) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <ErrorState message="Supabase environment variables are missing. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to run protected admin pages." />
      </main>
    );
  }

  if (isLoading) return <main className="p-6"><LoadingState label="Checking session" /></main>;
  if (error) return <main className="p-6"><ErrorState message={(error as Error).message} /></main>;
  if (!data?.session) return <Navigate to="/login" replace />;
  if (!data.profile) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <ErrorState message="Your login does not have an admin profile. Ask a Super Admin to add your user ID to admin_profiles." />
      </main>
    );
  }

  return children;
}
