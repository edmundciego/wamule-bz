import { useEffect, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { authorizationSnapshotKey, didAuthIdentityChange, didAuthorizationChange } from "../../lib/authWorkspaceCache";
import { getSessionAndProfile } from "../../lib/data";
import { supabase } from "../../lib/supabase";

export function AuthQueryCacheBoundary({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const previousAuthorizationRef = useRef<string | undefined>(undefined);
  const { data: accessState } = useQuery({
    queryKey: ["session-profile"],
    queryFn: getSessionAndProfile,
    retry: false,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const authorizationKey = authorizationSnapshotKey(accessState?.profile, accessState?.memberships);

  useEffect(() => {
    const handled = new WeakSet<object>();
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || !event.query.state.error) return;
      const error = event.query.state.error as { code?: unknown; status?: unknown; message?: unknown };
      if (error && typeof error === "object") {
        if (handled.has(error)) return;
        handled.add(error);
      }
      const denied = error.status === 401 || error.status === 403 || error.code === "42501"
        || (typeof error.message === "string" && /permission denied|row-level security|not authorized/i.test(error.message));
      if (!denied) return;

      const discardWorkspaceData = (query: { queryKey: readonly unknown[] }) =>
        !["session-profile", "workspace-options", "settings-session", "settings-current-profile"].includes(String(query.queryKey[0] ?? ""));
      void queryClient.cancelQueries({ predicate: discardWorkspaceData }).then(() => {
        queryClient.removeQueries({ predicate: discardWorkspaceData });
        void queryClient.invalidateQueries({ queryKey: ["session-profile"] });
        void queryClient.invalidateQueries({ queryKey: ["workspace-options"] });
        void queryClient.invalidateQueries({ queryKey: ["settings-current-profile"] });
      });
    });
    return unsubscribe;
  }, [queryClient]);

  useEffect(() => {
    const previous = previousAuthorizationRef.current;
    previousAuthorizationRef.current = authorizationKey;
    if (!didAuthorizationChange(previous, authorizationKey)) return;

    const discardWorkspaceData = (query: { queryKey: readonly unknown[] }) =>
      !["session-profile", "settings-session"].includes(String(query.queryKey[0] ?? ""));
    void queryClient.cancelQueries({ predicate: discardWorkspaceData }).then(() => {
      queryClient.removeQueries({ predicate: discardWorkspaceData });
      void queryClient.invalidateQueries({ queryKey: ["workspace-options"] });
      void queryClient.invalidateQueries({ queryKey: ["settings-current-profile"] });
    });
  }, [authorizationKey, queryClient]);

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
