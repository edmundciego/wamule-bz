import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../ui/Button";
import { Field, Select } from "../../ui/Field";
import { ErrorState } from "../../ui/State";
import { supabase } from "../../../lib/supabase";
import type { WorkspaceChoice } from "../../auth/workspaceScopeContext";
import type { MapFeature, ProjectMapPackage } from "../../../types/database";

type FeatureReview = Pick<MapFeature, "identity_id" | "provenance">;

function packageRevision(value: ProjectMapPackage["package_data"]): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const revision = (value as Record<string, unknown>).revision;
  return typeof revision === "number" && Number.isInteger(revision) ? revision : null;
}

async function readReviewRows(snapshotId: string, workspace: WorkspaceChoice): Promise<{ rows: FeatureReview[]; total: number }> {
  const pageSize = 500;
  const rows: FeatureReview[] = [];
  let total = 0;
  for (let from = 0; ; from += pageSize) {
    const result = await supabase.from("map_features")
      .select("identity_id,provenance", { count: "exact" })
      .eq("snapshot_id", snapshotId)
      .eq("tenant_id", workspace.tenantId)
      .eq("project_id", workspace.projectId)
      .eq("phase_id", workspace.phaseId)
      .order("identity_id")
      .range(from, from + pageSize - 1);
    if (result.error) throw result.error;
    const page = (result.data ?? []) as FeatureReview[];
    rows.push(...page);
    total = result.count ?? rows.length;
    if (page.length < pageSize || rows.length >= total) break;
  }
  return { rows, total };
}

export function ProjectMapPackagePublisher({
  workspace,
  canManage,
  requestedPackageId = null,
}: { workspace: WorkspaceChoice; canManage: boolean; requestedPackageId?: string | null }) {
  const client = useQueryClient();
  const queryKey = ["map-package-publisher", workspace.tenantId, workspace.projectId, workspace.phaseId];
  const [selectedId, setSelectedId] = useState("");
  const [completedHandoffId, setCompletedHandoffId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const state = useQuery({
    queryKey,
    queryFn: async () => {
      const [packages, active] = await Promise.all([
        supabase.from("project_map_packages").select("id,tenant_id,project_id,phase_id,snapshot_id,dataset_id,package_digest,package_data,background_path,created_by,created_at,published_at")
          .eq("tenant_id", workspace.tenantId).eq("project_id", workspace.projectId).eq("phase_id", workspace.phaseId)
          .order("created_at", { ascending: false }).limit(100),
        supabase.from("map_feature_snapshots").select("id")
          .eq("tenant_id", workspace.tenantId).eq("project_id", workspace.projectId).eq("phase_id", workspace.phaseId)
          .eq("is_active", true).maybeSingle(),
      ]);
      if (packages.error) throw packages.error;
      if (active.error) throw active.error;
      return { packages: packages.data ?? [], activeSnapshotId: active.data?.id ?? null };
    },
  });
  const pinnedPackageId = requestedPackageId?.trim() || null;
  const effectiveSelectedId = pinnedPackageId ?? selectedId;
  const selected = state.data?.packages.find((item) => item.id === effectiveSelectedId) ?? null;
  const review = useQuery({
    queryKey: [...queryKey, selected?.id, selected?.snapshot_id, "review"],
    enabled: Boolean(selected),
    queryFn: () => readReviewRows(selected!.snapshot_id, workspace),
  });
  const reviewedCount = review.data?.rows.filter((feature) => {
    const provenance = feature.provenance && typeof feature.provenance === "object" && !Array.isArray(feature.provenance)
      ? feature.provenance as Record<string, unknown>
      : {};
    return provenance.reviewed === true;
  }).length ?? 0;
  const fullyReviewed = Boolean(review.data && review.data.total > 0 && review.data.rows.length === review.data.total && reviewedCount === review.data.total);
  const revision = selected ? packageRevision(selected.package_data) : null;
  const published = Boolean(selected && selected.snapshot_id === state.data?.activeSnapshotId);
  const packageHandoffError = pinnedPackageId && state.data && !selected
    ? "The reviewed package is not available in the selected tenant, project, and phase."
    : pinnedPackageId && selected && selected.published_at !== null && completedHandoffId !== selected.id
      ? "The review handoff only accepts an unpublished package."
      : null;
  const displayError = errorMessage ?? packageHandoffError
    ?? (state.error instanceof Error ? state.error.message : review.error instanceof Error ? review.error.message : null);

  async function publish() {
    if (!selected || revision === null || !canManage || !fullyReviewed || published || !confirmReplace) return;
    setBusy(true);
    setErrorMessage(null);
    setNotice(null);
    const result = await supabase.rpc("publish_project_map_package", {
      p_package_id: selected.id,
      p_expected_active_id: state.data?.activeSnapshotId ?? null,
      p_replace_current: true,
    });
    setBusy(false);
    setConfirming(false);
    setConfirmReplace(false);
    if (result.error) {
      setErrorMessage(result.error.message);
      return;
    }
    if (pinnedPackageId) setCompletedHandoffId(pinnedPackageId);
    setNotice(`Revision ${revision} is now published for ${workspace.phaseName}. Intake settings were not changed.`);
    await client.invalidateQueries({ queryKey });
    await client.invalidateQueries({ queryKey: ["public-site-experience"] });
  }

  const packages = useMemo(() => state.data?.packages ?? [], [state.data]);
  return (
    <section className="grid gap-4 rounded-xl border border-border bg-card p-5" aria-labelledby="phase-map-publisher">
      <div>
        <h2 id="phase-map-publisher" className="font-semibold text-primary">Publish reviewed map package</h2>
        <p className="mt-1 text-sm text-muted-foreground">Map publication uses the existing scope and active-revision checks. It does not change tenant or project intake settings.</p>
      </div>
      {displayError ? <ErrorState message={displayError} /> : null}
      {notice ? <p role="status" className="rounded-md border border-secondary/30 bg-secondary/5 p-3 text-sm text-primary">{notice}</p> : null}
      <Field label="Map Studio packages for this phase">
        <Select aria-label="Map Studio packages for this phase" value={effectiveSelectedId} disabled={state.isLoading || busy || Boolean(pinnedPackageId)} onChange={(event) => { setSelectedId(event.target.value); setConfirming(false); setConfirmReplace(false); setErrorMessage(null); }}>
          <option value="">Select a package</option>
          {packages.map((item) => {
            const itemRevision = packageRevision(item.package_data);
            return <option key={item.id} value={item.id}>{String((item.package_data as Record<string, unknown>)?.title ?? "Map package")} · revision {itemRevision ?? "unknown"}{item.snapshot_id === state.data?.activeSnapshotId ? " · active" : ""}</option>;
          })}
        </Select>
      </Field>
      {selected ? (
        <div className="grid gap-2 rounded-md bg-muted/40 p-3 text-sm">
          {pinnedPackageId ? <p role="status"><strong>Reviewed package handoff:</strong> this package is locked to the review selection.</p> : null}
          <p><strong>Target tenant and project:</strong> {workspace.tenantName} · {workspace.projectName}</p>
          <p><strong>Target phase:</strong> {workspace.phaseName} <span className="text-muted-foreground">({workspace.phaseSlug})</span></p>
          <p><strong>Package revision:</strong> {revision ?? "Unavailable"}</p>
          {review.isLoading ? <p role="status">Checking reviewed outlines…</p> : review.isError ? <p className="text-danger">Review state could not be loaded.</p> : <p>{reviewedCount} of {review.data?.total ?? 0} outlines reviewed{fullyReviewed ? " · ready to publish" : " · all outlines must be reviewed first"}.</p>}
          {published ? <p className="font-semibold text-secondary">This package is already the active map for this phase.</p> : null}
          {canManage && !published && !packageHandoffError ? <Button type="button" variant="outline" disabled={!fullyReviewed || revision === null || busy || review.isLoading} onClick={() => { setErrorMessage(null); setConfirmReplace(false); setConfirming(true); }}>Review publish details</Button> : null}
        </div>
      ) : null}
      {confirming && selected && !published ? (
        <div role="alertdialog" aria-labelledby="publish-map-confirm-title" aria-describedby="publish-map-confirm-body" className="grid gap-3 rounded-lg border border-primary/30 bg-primary-soft/30 p-4">
          <h3 id="publish-map-confirm-title" className="font-semibold">Confirm map publication</h3>
          <p id="publish-map-confirm-body" className="text-sm">This publishes revision {revision} to phase {workspace.phaseName}. The existing map and history remain retained; application intake gates are not changed.</p>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" checked={confirmReplace} disabled={busy} onChange={(event) => setConfirmReplace(event.target.checked)} />
            <span>I confirm this reviewed package should become the displayed map for {workspace.phaseName}.</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={!confirmReplace || busy} onClick={() => void publish()}>{busy ? "Publishing…" : "Publish map"}</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => { setConfirming(false); setConfirmReplace(false); }}>Cancel</Button>
          </div>
        </div>
      ) : null}
      {!canManage ? <p className="text-xs text-muted-foreground">Publishing requires an authorized Admin for the selected tenant, project, and phase.</p> : null}
    </section>
  );
}
