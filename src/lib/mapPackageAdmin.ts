import { supabase } from "./supabase";
import {
  mapPackageCore,
  verifyMapPackageAsset,
  sha256Bytes,
  type MapPackage,
} from "./mapPackage.mjs";
import type { WorkspaceChoice } from "../components/auth/workspaceScopeContext";

export async function stageMapPackage(map: MapPackage, scope: WorkspaceChoice) {
  const bytes = await verifyMapPackageAsset(map);
  let path: string | null = null;
  if (bytes && map.canvas.background) {
    const asset = map.canvas.background;
    const ext =
      asset.mime === "image/png"
        ? "png"
        : asset.mime === "image/jpeg"
          ? "jpg"
          : "webp";
    path = `${scope.tenantId}/${scope.projectId}/${scope.phaseId}/${asset.sha256}.${ext}`;
    const { error } = await supabase.storage
      .from("project-map-packages")
      .upload(path, bytes, { contentType: asset.mime, upsert: false });
    if (error) {
      // A retry may find the immutable asset already present. Verify its bytes;
      // never overwrite it or ignore an unrelated upload/authentication error.
      const result = await supabase.storage
        .from("project-map-packages")
        .download(path);
      if (
        result.error ||
        !result.data ||
        (await sha256Bytes(await result.data.arrayBuffer())) !== asset.sha256
      )
        throw new Error(error.message);
    }
  }
  const result = await supabase.rpc("stage_project_map_package", {
    p_tenant_id: scope.tenantId,
    p_project_id: scope.projectId,
    p_phase_id: scope.phaseId,
    p_package: mapPackageCore(map),
    p_background_path: path,
  });
  if (result.error) throw new Error(result.error.message);
  return result.data as {
    id: string;
    snapshot_id: string;
    reused: boolean;
    total: number;
    new_plots?: number;
    matched?: number;
  };
}
