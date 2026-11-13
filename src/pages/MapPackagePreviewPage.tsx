import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPolygon, MapRasterLayer } from "../components/map/MapPolygon";
import { ErrorState, LoadingState } from "../components/ui/State";
import { useWorkspaceScope } from "../components/auth/workspaceScopeContext";
import { supabase } from "../lib/supabase";
import type { MapFeature, MapFeatureSnapshot, ProjectMapPackage } from "../types/database";

type PreviewData = {
  packageRow: Pick<ProjectMapPackage, "id" | "snapshot_id" | "package_data" | "background_path" | "published_at">;
  snapshot: Pick<MapFeatureSnapshot, "id" | "snapshot_version" | "outline_count" | "is_active">;
  features: Array<Pick<MapFeature, "identity_id" | "demo_label" | "map_polygon">>;
  backgroundUrl: string | null;
};

type Coordinate = { x: number; y: number };

export function MapPackagePreviewPage() {
  const { workspace, isLoading: workspaceLoading, error: workspaceError } = useWorkspaceScope();
  const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(null);
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
        supabase.from("map_features").select("identity_id,demo_label,map_polygon")
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
