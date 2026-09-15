import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase";
import { formatDate } from "../../../lib/utils";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/Card";
import { ErrorState, LoadingState } from "../../ui/State";
import { MasterplanPreviewModal } from "./MasterplanPreviewModal";
import type { MasterplanVersion } from "../../../types/database";

interface MasterplanVersionGalleryProps {
  tenantId: string | null;
  canManage: boolean;
  refreshSignal?: number;
  onChanged?: (imageUrl: string | null) => void;
}

function VersionThumbnail({ url, label }: { url: string; label: string }) {
  const [size, setSize] = useState<string | null>(null);
  return (
    <div className="overflow-hidden rounded-md border border-border bg-muted">
      <img
        src={url}
        alt={label}
        className="block aspect-video w-full object-cover"
        loading="lazy"
        onLoad={(event) => {
          const img = event.currentTarget;
          if (img.naturalWidth) setSize(`${img.naturalWidth} × ${img.naturalHeight}px`);
        }}
      />
      {size ? <p className="px-2 py-1 text-xs text-muted-foreground">{size}</p> : null}
    </div>
  );
}

export function MasterplanVersionGallery({ tenantId, canManage, refreshSignal = 0, onChanged }: MasterplanVersionGalleryProps) {
  const [versions, setVersions] = useState<MasterplanVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [previewVersion, setPreviewVersion] = useState<MasterplanVersion | null>(null);

  const loadVersions = useCallback(async () => {
    if (!tenantId) {
      setVersions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: queryError } = await supabase
      .from("masterplan_versions")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("version_number", { ascending: false });
    setLoading(false);
    if (queryError) {
      setError(queryError.message);
      return;
    }
    setVersions((data ?? []) as MasterplanVersion[]);
  }, [tenantId]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions, refreshSignal]);

  async function handleActivate(version: MasterplanVersion) {
    if (!tenantId) return;
    setError(null);
    setActivatingId(version.id);
    const { error: updateError } = await supabase
      .from("masterplan_versions")
      .update({ is_active: true })
      .eq("id", version.id)
      .eq("tenant_id", tenantId);
    setActivatingId(null);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    // Single-active trigger deactivates the rest and syncs the tenant record.
    await loadVersions();
    onChanged?.(version.image_url);
  }

  if (!tenantId) return null;

  return (
    <Card className="v2-workflow-panel">
      <CardHeader><CardTitle>Version History</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        {error ? <ErrorState message={error} /> : null}
        {loading ? <LoadingState label="Loading versions" /> : null}
        {!loading && versions.length === 0 ? (
          <p className="rounded-md border border-dashed bg-muted p-4 text-sm text-muted-foreground">
            No map versions yet. Upload a masterplan above to create Version 1.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {versions.map((version) => (
            <div key={version.id} className="grid gap-2 rounded-md border border-border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <strong className="text-sm text-primary">Version {version.version_number}</strong>
                {version.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="slate">Inactive</Badge>}
              </div>
              <VersionThumbnail url={version.image_url} label={`Version ${version.version_number} masterplan`} />
              <p className="truncate text-xs text-muted-foreground" title={version.file_name}>{version.file_name}</p>
              <p className="text-xs text-muted-foreground">Uploaded {formatDate(version.created_at)}</p>
              <div className="flex flex-wrap gap-2">
                {!version.is_active ? (
                  <>
                    <Button type="button" variant="outline" disabled={!canManage} onClick={() => setPreviewVersion(version)}>
                      Preview
                    </Button>
                    <Button
                      type="button"
                      disabled={!canManage || activatingId === version.id}
                      onClick={() => void handleActivate(version)}
                    >
                      {activatingId === version.id ? "Activating…" : "Activate"}
                    </Button>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">Live on the lot map and public embeds.</span>
                )}
              </div>
            </div>
          ))}
        </div>
        <MasterplanPreviewModal
          open={previewVersion !== null}
          tenantId={tenantId}
          draftImageUrl={previewVersion?.image_url ?? null}
          draftLabel={previewVersion ? `Version ${previewVersion.version_number} alignment check` : ""}
          draftVersionId={previewVersion?.id ?? null}
          canManage={canManage}
          onClose={() => setPreviewVersion(null)}
          onPublished={(url) => {
            setPreviewVersion(null);
            void loadVersions();
            onChanged?.(url);
          }}
        />
      </CardContent>
    </Card>
  );
}
