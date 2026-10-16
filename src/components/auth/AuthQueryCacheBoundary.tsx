import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { didAuthIdentityChange } from "../../lib/authWorkspaceCache";
import { supabase } from "../../lib/supabase";

export function AuthQueryCacheBoundary({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    let previousUserId: string | null | undefined;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUserId = session?.user.id ?? null;
      if (didAuthIdentityChange(previousUserId, nextUserId)) queryClient.clear();
      previousUserId = nextUserId;
    });
    return () => subscription.unsubscribe();
  }, [queryClient]);

  return <>{children}</>;
}
