import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../../lib/supabase";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/Button";
import { Field, Input } from "../../ui/Field";
import { ErrorState } from "../../ui/State";
import { MasterplanPreviewModal } from "./MasterplanPreviewModal";
import { MasterplanVersionGallery } from "./MasterplanVersionGallery";
import type { MasterplanVersion } from "../../../types/database";

const ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const ACCEPT_ATTR = "image/jpeg,image/png,image/webp";
const MAX_FILE_BYTES = 10 * 1024 * 1024;

type AcceptedMime = (typeof ACCEPTED_MIME_TYPES)[number];

interface MasterplanUploadProps {
  tenantId: string | null;
  canManage: boolean;
  onChanged?: (url: string | null) => void;
}

function extensionFor(mime: AcceptedMime): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MasterplanUpload({ tenantId, canManage, onChanged }: MasterplanUploadProps) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [pendingVersion, setPendingVersion] = useState<MasterplanVersion | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      setDimensions(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const pickFile = useCallback((candidate: File | undefined) => {
    setError(null);
    setStatus(null);
    setDimensions(null);
    if (!candidate) {
      setFile(null);
      return;
    }
    if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(candidate.type)) {
      setFile(null);
      setError("Unsupported file type. Upload a JPG, PNG, or WEBP image.");
      return;
    }
    if (candidate.size > MAX_FILE_BYTES) {
      setFile(null);
      setError(`File is too large (${formatBytes(candidate.size)}). Maximum is ${formatBytes(MAX_FILE_BYTES)}.`);
      return;
    }
    setFile(candidate);
    setStatus("Map image ready. Upload to preview alignment before publishing.");
  }, []);

  async function refreshTenantCaches(url: string | null) {
    onChanged?.(url);
    await queryClient.invalidateQueries({ queryKey: ["tenant-masterplan", tenantId] });
    await queryClient.invalidateQueries({ queryKey: ["lot-board-masterplan"] });
  }

  /** Uploads the file, stores it as an inactive version, and opens alignment preview. */
  async function handleUploadNew() {
    if (!file || !tenantId) return;
    setError(null);
    setSaving(true);
    setStatus("Uploading map...");
    try {
      const ext = extensionFor(file.type as AcceptedMime);
      const safeBase = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60) || "masterplan";
      const path = `${tenantId}/masterplan-${Date.now()}-${safeBase}.${ext}`;
      const { error: uploadError } = await supabase.storage.from("business-assets").upload(path, file, {
        contentType: file.type,
        upsert: false,
      });
      if (uploadError) throw new Error(uploadError.message);
      const { data } = supabase.storage.from("business-assets").getPublicUrl(path);

      const { data: version, error: insertError } = await supabase
        .from("masterplan_versions")
        .insert({
          tenant_id: tenantId,
          image_url: data.publicUrl,
          file_name: file.name,
          is_active: false,
        })
        .select("*")
        .single();
      if (insertError || !version) throw new Error(insertError?.message ?? "Version record failed.");

      setFile(null);
      setRefreshSignal((signal) => signal + 1);
      // Activation trigger assigns the version number; refetch for the preview label.
      const created = version as MasterplanVersion;
      setPendingVersion(created);
      setStatus("Map uploaded as a draft. Verify alignment, then publish.");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setSaving(false);
    }
  }

  /** Deactivates the live version and clears the tenant map (rollback to no map). */
  async function handleRemoveActive() {
    if (!tenantId) return;
    setError(null);
    setRemoving(true);
    try {
      const { data: active, error: activeError } = await supabase
        .from("masterplan_versions")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("is_active", true)
        .maybeSingle();
      if (activeError) throw new Error(activeError.message);
      if (active) {
        const { error: updateError } = await supabase
          .from("masterplan_versions")
          .update({ is_active: false })
          .eq("id", (active as { id: string }).id);
        if (updateError) throw new Error(updateError.message);
      }
      const { error: rpcError } = await supabase.rpc("set_tenant_masterplan", {
        p_organization_id: tenantId,
        p_masterplan_image_url: null,
      });
      if (rpcError) throw new Error(rpcError.message);
      setRefreshSignal((signal) => signal + 1);
      await refreshTenantCaches(null);
      setStatus("Masterplan map removed. Previous versions remain available below.");
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Remove failed.");
    } finally {
      setRemoving(false);
    }
  }

  const aspect = dimensions ? `${dimensions.width} × ${dimensions.height}px (${(dimensions.width / dimensions.height).toFixed(2)}:1)` : null;

  return (
    <div className="grid gap-4">
      {error ? <ErrorState message={error} /> : null}

      {previewUrl ? (
        <div className="overflow-hidden rounded-md border border-border">
          <img
            src={previewUrl}
            alt="New masterplan preview"
            className="block max-h-64 w-full object-contain bg-muted"
            onLoad={(event) => {
              const img = event.currentTarget;
              if (img.naturalWidth) setDimensions({ width: img.naturalWidth, height: img.naturalHeight });
            }}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {aspect ? <span>{aspect}</span> : null}
        {file ? <span>{file.name} · {formatBytes(file.size)}</span> : null}
      </div>

      <Field label="Upload new masterplan map">
        <div
          className={cn(
            "grid gap-2 rounded-md border border-dashed p-3 transition",
            dragging ? "border-primary bg-primary-soft" : "border-border",
          )}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!canManage) return;
            pickFile(event.dataTransfer.files?.[0]);
          }}
        >
          <Input
            type="file"
            accept={ACCEPT_ATTR}
            disabled={!canManage || saving}
            onChange={(event) => {
              pickFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <p className="text-xs text-muted-foreground">Drag and drop an image here, or use the file picker. JPG, PNG, or WEBP up to 10MB. Uploads open an alignment preview before anything goes live.</p>
        </div>
      </Field>
      {status ? <p className="text-sm text-muted-foreground" role="status">{status}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!canManage || !file || saving || !tenantId} onClick={() => void handleUploadNew()}>
          {saving ? "Uploading…" : "Upload New Map"}
        </Button>
        <Button type="button" variant="outline" disabled={!canManage || removing || !tenantId} onClick={() => void handleRemoveActive()}>
          {removing ? "Removing…" : "Remove Map"}
        </Button>
      </div>

      <MasterplanVersionGallery
        tenantId={tenantId}
        canManage={canManage}
        refreshSignal={refreshSignal}
        onChanged={(url) => {
          void refreshTenantCaches(url);
        }}
      />

      <MasterplanPreviewModal
        open={pendingVersion !== null}
        tenantId={tenantId}
        draftImageUrl={pendingVersion?.image_url ?? null}
        draftLabel={pendingVersion ? `New upload alignment check${pendingVersion.version_number ? ` (Version ${pendingVersion.version_number})` : ""}` : ""}
        draftVersionId={pendingVersion?.id ?? null}
        canManage={canManage}
        onClose={() => setPendingVersion(null)}
        onPublished={(url) => {
          setPendingVersion(null);
          setRefreshSignal((signal) => signal + 1);
          void refreshTenantCaches(url);
          setStatus("Masterplan published and live.");
        }}
      />
    </div>
  );
}
