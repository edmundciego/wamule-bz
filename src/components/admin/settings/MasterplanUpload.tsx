import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../../lib/supabase";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/Button";
import { Field, Input } from "../../ui/Field";
import { ErrorState } from "../../ui/State";

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

/** Best-effort extraction of the storage object path from a public URL. */
function objectPathFromPublicUrl(url: string): string | null {
  const marker = "/business-assets/";
  const index = url.indexOf(marker);
  if (index === -1) return null;
  return decodeURIComponent(url.slice(index + marker.length).split("?")[0]) || null;
}

export function MasterplanUpload({ tenantId, canManage, onChanged }: MasterplanUploadProps) {
  const queryClient = useQueryClient();
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [loadingCurrent, setLoadingCurrent] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadCurrent() {
      if (!tenantId) {
        setCurrentUrl(null);
        setLoadingCurrent(false);
        return;
      }
      setLoadingCurrent(true);
      const { data, error: queryError } = await supabase
        .from("organizations")
        .select("masterplan_image_url")
        .eq("id", tenantId)
        .maybeSingle();
      if (cancelled) return;
      setLoadingCurrent(false);
      if (queryError) {
        setError(queryError.message);
        return;
      }
      setCurrentUrl((data as { masterplan_image_url: string | null } | null)?.masterplan_image_url ?? null);
    }
    void loadCurrent();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

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
    setStatus("Map image ready to upload.");
  }, []);

  async function persistUrl(url: string | null, previousUrl: string | null) {
    if (!tenantId) {
      setError("No tenant context. Sign in again before managing the masterplan.");
      return;
    }
    const { error: rpcError } = await supabase.rpc("set_tenant_masterplan", {
      p_organization_id: tenantId,
      p_masterplan_image_url: url,
    });
    if (rpcError) throw new Error(rpcError.message);

    // Backward-compatibility mirror for readers of business_settings.
    const { data: session } = await supabase.auth.getSession();
    const { error: settingsError } = await supabase.from("business_settings").upsert({
      key: "masterplan_image_url",
      value: { url },
      updated_by: session.session?.user.id ?? null,
    });
    if (settingsError) throw new Error(settingsError.message);

    // Best-effort cleanup of the replaced object; the DB update already won.
    const previousPath = previousUrl ? objectPathFromPublicUrl(previousUrl) : null;
    if (previousPath && previousPath !== (url ? objectPathFromPublicUrl(url) : null)) {
      await supabase.storage.from("business-assets").remove([previousPath]);
    }

    setCurrentUrl(url);
    setFile(null);
    onChanged?.(url);
    await queryClient.invalidateQueries({ queryKey: ["tenant-masterplan", tenantId] });
    await queryClient.invalidateQueries({ queryKey: ["lot-board-masterplan"] });
  }

  async function handleUpload() {
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
      const previousUrl = currentUrl;
      await persistUrl(data.publicUrl, previousUrl);
      setStatus("Masterplan map saved.");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (!currentUrl || !tenantId) return;
    setError(null);
    setSaving(true);
    setStatus("Removing map...");
    try {
      const previousUrl = currentUrl;
      await persistUrl(null, previousUrl);
      setStatus("Masterplan map removed.");
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Remove failed.");
    } finally {
      setSaving(false);
    }
  }

  const shownUrl = previewUrl ?? currentUrl;
  const aspect = dimensions ? `${dimensions.width} × ${dimensions.height}px (${(dimensions.width / dimensions.height).toFixed(2)}:1)` : null;

  return (
    <div className="grid gap-3">
      {error ? <ErrorState message={error} /> : null}
      {loadingCurrent ? <p className="text-sm text-muted-foreground">Loading current masterplan…</p> : null}
      {shownUrl ? (
        <div className="overflow-hidden rounded-md border border-border">
          <img
            src={shownUrl}
            alt={previewUrl ? "New masterplan preview" : "Current masterplan"}
            className="block max-h-64 w-full object-contain bg-muted"
            onLoad={(event) => {
              const img = event.currentTarget;
              if (img.naturalWidth) setDimensions({ width: img.naturalWidth, height: img.naturalHeight });
            }}
          />
        </div>
      ) : !loadingCurrent ? (
        <p className="rounded-md border border-dashed bg-muted p-4 text-sm text-muted-foreground">
          No masterplan uploaded yet. Parcel boundaries will render on an empty grid until a map is set.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {aspect ? <span>{aspect}</span> : null}
        {file ? <span>{file.name} · {formatBytes(file.size)}</span> : null}
        {currentUrl && !previewUrl ? <span className="truncate">Current map saved for this tenant.</span> : null}
      </div>
      <Field label={currentUrl ? "Replace masterplan map" : "Upload masterplan map"}>
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
          <p className="text-xs text-muted-foreground">Drag and drop an image here, or use the file picker. JPG, PNG, or WEBP up to 10MB.</p>
        </div>
      </Field>
      {status ? <p className="text-sm text-muted-foreground" role="status">{status}</p> : null}
      <div className="flex flex-wrap gap-2">
        {!currentUrl ? (
          <Button type="button" disabled={!canManage || !file || saving || !tenantId} onClick={() => void handleUpload()}>
            {saving ? "Uploading…" : "Upload New Map"}
          </Button>
        ) : (
          <>
            <Button type="button" disabled={!canManage || !file || saving || !tenantId} onClick={() => void handleUpload()}>
              {saving ? "Uploading…" : "Replace Map"}
            </Button>
            <Button type="button" variant="outline" disabled={!canManage || saving || !tenantId} onClick={() => void handleRemove()}>
              Remove Map
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
