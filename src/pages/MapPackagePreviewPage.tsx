import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPolygon, MapRasterLayer } from "../components/map/MapPolygon";
import { ErrorState, LoadingState } from "../components/ui/State";
import { useWorkspaceScope } from "../components/auth/workspaceScopeContext";
import { getSessionAndProfile } from "../lib/data";
import { supabase } from "../lib/supabase";
import type { MapFeature, MapFeatureSnapshot, ProjectMapPackage } from "../types/database";

type PreviewData = {
  packageRow: Pick<ProjectMapPackage, "id" | "snapshot_id" | "package_data" | "background_path" | "published_at">;
  snapshot: Pick<MapFeatureSnapshot, "id" | "snapshot_version" | "outline_count" | "is_active">;
  features: Array<Pick<MapFeature, "identity_id" | "demo_label" | "map_polygon" | "provenance">>;
  backgroundUrl: string | null;
};

type ReviewLinkRow = {
  id: string;
  package_id: string;
  snapshot_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};

type Coordinate = { x: number; y: number };

export function MapPackagePreviewPage() {
  const { workspace, isLoading: workspaceLoading, error: workspaceError } = useWorkspaceScope();
  const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(null);
  const [expiresInSeconds, setExpiresInSeconds] = useState("86400");
  const [createdLink, setCreatedLink] = useState("");
  const [linkActionError, setLinkActionError] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const queryClient = useQueryClient();
  const sessionProfileQuery = useQuery({ queryKey: ["session-profile"], queryFn: getSessionAndProfile });
  const canManageReviewLinks = ["Super Admin", "Admin"].includes(sessionProfileQuery.data?.profile?.role ?? "");
  const previewQuery = useQuery({
    queryKey: ["private-map-package-preview", workspace?.tenantId, workspace?.projectId, workspace?.phaseId],
    enabled: Boolean(workspace),
    retry: false,
    queryFn: async (): Promise<PreviewData | null> => {
      const scope = workspace!;
      const { data: packageRow, error: packageError } = await supabase.from("project_map_packages")
        .select("id,snapshot_id,package_data,background_path,published_at")
        .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.phaseId)
        .is("published_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (packageError) throw packageError;
      if (!packageRow) return null;

      const [snapshotResult, featuresResult] = await Promise.all([
        supabase.from("map_feature_snapshots").select("id,snapshot_version,outline_count,is_active")
          .eq("id", packageRow.snapshot_id).single(),
        supabase.from("map_features").select("identity_id,demo_label,map_polygon,provenance")
          .eq("tenant_id", scope.tenantId).eq("project_id", scope.projectId).eq("phase_id", scope.phaseId)
          .eq("snapshot_id", packageRow.snapshot_id).eq("is_active", true).order("demo_label"),
      ]);
      if (snapshotResult.error) throw snapshotResult.error;
      if (featuresResult.error) throw featuresResult.error;
      let backgroundUrl: string | null = null;
      if (packageRow.background_path) {
        const { data, error } = await supabase.storage.from("project-map-packages")
          .createSignedUrl(packageRow.background_path, 60);
        if (error) throw error;
        backgroundUrl = data.signedUrl;
      }
      return {
        packageRow,
        snapshot: snapshotResult.data,
        features: featuresResult.data ?? [],
        backgroundUrl,
      };
    },
  });

  const linkScope = workspace && previewQuery.data ? {
    tenant_id: workspace.tenantId,
    project_id: workspace.projectId,
    phase_id: workspace.phaseId,
  } : null;
  const linksQuery = useQuery({
    queryKey: ["project-map-review-links", linkScope?.tenant_id, linkScope?.project_id, linkScope?.phase_id],
    enabled: Boolean(linkScope && canManageReviewLinks),
    retry: false,
    queryFn: async (): Promise<ReviewLinkRow[]> => {
      const { data, error } = await supabase.functions.invoke("project-map-review-link", {
        body: { action: "list", ...linkScope },
      });
      if (error) throw new Error(await reviewLinkError(error));
      if (data?.error) throw new Error(String(data.error));
      return (data?.links ?? []) as ReviewLinkRow[];
    },
  });

  async function createReviewerLink() {
    if (!linkScope || !previewQuery.data) return;
    setLinkActionError(null);
    setCreatedLink("");
    setCopiedLink(false);
    const { data, error } = await supabase.functions.invoke("project-map-review-link", {
      body: {
        action: "create", ...linkScope,
        package_id: previewQuery.data.packageRow.id,
        expires_in_seconds: Number(expiresInSeconds),
      },
    });
    if (error || data?.error || typeof data?.token !== "string") {
      setLinkActionError(error ? await reviewLinkError(error) : String(data?.error ?? "The signed review link could not be created."));
      return;
    }
    setCreatedLink(`${window.location.origin}/review#${data.token}`);
    await queryClient.invalidateQueries({ queryKey: ["project-map-review-links", linkScope.tenant_id, linkScope.project_id, linkScope.phase_id] });
  }

  async function revokeReviewerLink(linkId: string) {
    if (!linkScope) return;
    setLinkActionError(null);
    const { data, error } = await supabase.functions.invoke("project-map-review-link", {
      body: { action: "revoke", ...linkScope, link_id: linkId },
    });
    if (error || data?.error || data?.revoked !== true) {
      setLinkActionError(error ? await reviewLinkError(error) : String(data?.error ?? "The signed review link could not be revoked."));
      return;
    }
    setCreatedLink("");
    await queryClient.invalidateQueries({ queryKey: ["project-map-review-links", linkScope.tenant_id, linkScope.project_id, linkScope.phase_id] });
  }

  if (workspaceLoading || previewQuery.isLoading) return <LoadingState label="Loading private phase map preview" />;
  if (workspaceError) return <ErrorState message={workspaceError} />;
  if (!workspace) return <ErrorState message="Choose an assigned project and phase to preview its map." />;
  if (previewQuery.error) return <ErrorState message={(previewQuery.error as Error).message} />;
  if (!previewQuery.data) {
    return <main className="v2-page-shell"><h1 className="v2-page-title">Private map review</h1><p className="rounded-md border border-dashed bg-muted p-4 text-sm text-muted-foreground">No unpublished Map Studio package is available in this assigned phase.</p></main>;
  }

  const preview = previewQuery.data;
  const canvas = record(preview.packageRow.package_data).canvas;
  const canvasData = record(canvas);
  const width = positiveNumber(canvasData.width) ?? 100;
  const height = positiveNumber(canvasData.height) ?? 100;

  return (
    <main className="v2-page-shell">
      <header className="v2-page-header">
        <p className="v2-page-kicker">Internal review · private to this assigned phase</p>
        <h1 className="v2-page-title">Private map preview</h1>
        <p className="v2-page-description">{workspace.tenantName} · {workspace.projectName} · {workspace.phaseName}</p>
      </header>
      <div className="v2-workflow-panel grid gap-1 p-4 text-sm" role="status" aria-label="Map revision details">
        <p><strong>Map revision:</strong> {preview.snapshot.snapshot_version} · package revision {revision(preview.packageRow.package_data)}</p>
        <p><strong>Visibility:</strong> unpublished; accessible only to users assigned to this phase</p>
      </div>
      {canManageReviewLinks ? (
        <section className="v2-workflow-panel grid gap-4 p-4" aria-labelledby="reviewer-link-heading">
          <div>
            <h2 id="reviewer-link-heading" className="font-semibold text-primary">Signed reviewer link</h2>
            <p className="mt-1 text-sm text-muted-foreground">Create a read-only link for this exact reviewed revision and its current form settings. It is available before publication and never opens public intake.</p>
          </div>
          {!preview.features.length || !preview.features.every((feature) => record(feature.provenance).reviewed === true) ? (
            <p role="status" className="text-sm text-muted-foreground">Admin sign-off is required for every outline before a reviewer link can be issued.</p>
          ) : null}
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm font-medium" htmlFor="review-link-expiry">
              Link expires
              <select id="review-link-expiry" value={expiresInSeconds} onChange={(event) => setExpiresInSeconds(event.target.value)} className="min-h-10 rounded-md border bg-background px-3">
                <option value="60">In 1 minute</option>
                <option value="3600">In 1 hour</option>
                <option value="86400">In 24 hours</option>
                <option value="604800">In 7 days</option>
                <option value="2592000">In 30 days</option>
              </select>
            </label>
            <button type="button" onClick={() => void createReviewerLink()} disabled={!preview.features.length || !preview.features.every((feature) => record(feature.provenance).reviewed === true)} className="min-h-10 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">
              Create reviewer link
            </button>
          </div>
          {createdLink ? (
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <label className="grid gap-1 text-sm font-medium" htmlFor="new-review-link">Copy this signed link now
                <input id="new-review-link" aria-label="New signed reviewer link" readOnly value={createdLink} className="min-h-10 w-full rounded-md border bg-background px-3 font-normal" />
              </label>
              <button type="button" className="min-h-10 rounded-md border px-4 text-sm font-semibold" onClick={() => {
                void navigator.clipboard.writeText(createdLink).then(() => setCopiedLink(true)).catch(() => setLinkActionError("Clipboard access was unavailable; select and copy the link manually."));
              }}>{copiedLink ? "Copied" : "Copy link"}</button>
            </div>
          ) : null}
          {linksQuery.error ? <p role="alert" className="text-sm text-red-700">{(linksQuery.error as Error).message}</p> : null}
          {linkActionError ? <p role="alert" className="text-sm text-red-700">{linkActionError}</p> : null}
          {linksQuery.data?.length ? (
            <ul className="grid gap-2" aria-label="Reviewer links for this phase">
              {linksQuery.data.map((link) => {
                const expired = Date.parse(link.expires_at) <= Date.now();
                return (
                  <li key={link.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm" data-review-link-id={link.id}>
                    <span>
                      <strong>{link.revoked_at ? "Revoked" : expired ? "Expired" : "Active"}</strong>
                      <span className="ml-2 text-muted-foreground">Expires {new Date(link.expires_at).toLocaleString()}</span>
                    </span>
                    {!link.revoked_at && !expired ? <button type="button" onClick={() => void revokeReviewerLink(link.id)} className="min-h-9 rounded-md border px-3 font-semibold">Revoke reviewer link</button> : null}
                  </li>
                );
              })}
            </ul>
          ) : linksQuery.isLoading ? <p role="status" className="text-sm text-muted-foreground">Loading reviewer-link status…</p> : <p className="text-sm text-muted-foreground">No reviewer links have been created for this phase.</p>}
          <p className="text-xs text-muted-foreground">Reviewers can view this map and form preview only. Revocation blocks future map and asset requests; the link does not grant Admin access or application submission.</p>
        </section>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="overflow-hidden rounded-lg border bg-muted" aria-label="Private phase map canvas">
          <svg className="aspect-square w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Unpublished phase map outlines">
            {preview.backgroundUrl ? <MapRasterLayer src={preview.backgroundUrl} x={0} y={0} width={width} height={height} preserveAspectRatio="none" /> : null}
            {preview.features.map((feature) => {
              const coordinates = polygon(feature.map_polygon);
              if (coordinates.length < 3) return null;
              const isSelected = selectedIdentityId === feature.identity_id;
              return <MapPolygon
                key={feature.identity_id}
                coordinates={coordinates}
                role="button"
                tabIndex={0}
                aria-label={`Select outline ${feature.demo_label}`}
                aria-pressed={isSelected}
                onClick={() => setSelectedIdentityId(isSelected ? null : feature.identity_id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedIdentityId(isSelected ? null : feature.identity_id);
                  }
                }}
                fill={isSelected ? "rgba(45, 121, 86, 0.42)" : "rgba(255, 255, 255, 0.16)"}
                stroke={isSelected ? "#14532d" : "#ffffff"}
                strokeWidth={Math.max(width, height) / 250}
                className="cursor-pointer outline-none focus:stroke-[#14532d]"
                data-outline-id={feature.identity_id}
              />;
            })}
          </svg>
        </div>
        <aside className="v2-workflow-panel grid content-start gap-3 p-4">
          <h2 className="font-semibold text-primary">Choose an outline to review</h2>
          <p className="text-sm text-muted-foreground">The outline ID is a stable map identity. It is not saleable inventory.</p>
          {preview.features.map((feature) => (
            <button
              key={feature.identity_id}
              type="button"
              aria-pressed={selectedIdentityId === feature.identity_id}
              onClick={() => setSelectedIdentityId(selectedIdentityId === feature.identity_id ? null : feature.identity_id)}
              className="min-h-11 rounded-md border px-3 text-left text-sm font-medium hover:bg-primary-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              data-outline-id={feature.identity_id}
            >
              Select outline {feature.demo_label}
            </button>
          ))}
          <p role="status" aria-label="Selected outline">
            {selectedIdentityId
              ? `Selected outline ID ${selectedIdentityId}`
              : "No outline selected"}
          </p>
        </aside>
      </div>
    </main>
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function revision(value: unknown): string | number {
  const current = record(value).revision;
  return typeof current === "string" || typeof current === "number" ? current : "unknown";
}

function polygon(value: unknown): Coordinate[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { x: number; y: number } =>
    Boolean(item && typeof item === "object" && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).x === "number"
      && typeof (item as Record<string, unknown>).y === "number"))
    .map(({ x, y }) => ({ x, y }));
}

async function reviewLinkError(error: unknown): Promise<string> {
  const context = error && typeof error === "object" && "context" in error
    ? (error as { context?: Response }).context
    : undefined;
  if (context && typeof context.clone === "function") {
    const body = await context.clone().json().catch(() => ({}));
    if (typeof body?.error === "string") return body.error;
  }
  return error instanceof Error ? error.message : "The review-link request failed.";
}
