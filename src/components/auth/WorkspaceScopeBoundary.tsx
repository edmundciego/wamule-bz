import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getSessionAndProfile } from "../../lib/data";
import { ErrorState, LoadingState } from "../ui/State";
import { WorkspaceScopeProvider } from "./WorkspaceScope";

export function WorkspaceScopeBoundary({ children }: { children: ReactNode }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["session-profile"],
    queryFn: getSessionAndProfile,
    retry: false,
  });

  if (isLoading) return <LoadingState label="Loading account workspace" />;
  if (error || !data?.profile) return <ErrorState message={(error as Error | undefined)?.message ?? "Your account profile is unavailable."} />;

  return <WorkspaceScopeProvider profile={data.profile}>{children}</WorkspaceScopeProvider>;
}
