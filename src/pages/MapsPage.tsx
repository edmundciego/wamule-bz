import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  useWorkspaceScope,
  type WorkspaceChoice,
} from "../components/auth/workspaceScopeContext";
import { Button } from "../components/ui/Button";
import { Field, Input, Select, Textarea } from "../components/ui/Field";
import { MapPackagePreview } from "../components/maps/MapPackagePreview";
import { supabase } from "../lib/supabase";
import { getSessionAndProfile } from "../lib/data";
import { stageMapPackage } from "../lib/mapPackageAdmin";
import { readMapWorkspaceRows } from "../lib/mapPackagePages.mjs";
import { packagePrice } from "../lib/publishedMapPackage";
import {
  validateMapPackage,
  verifyMapPackageAsset,
  mapPackagePreview,
  buildMapEmbed,
  MAP_PACKAGE_MAX_BYTES,
  type MapPackage,
  type PackageCategory,
} from "../lib/mapPackage.mjs";

type StoredPackage = {
  id: string;
  snapshot_id: string;
  created_at: string;
  published_at: string | null;
  title: string;
  revision: number;
};
type PlotContent = {
  identity_id: string;
  plot_number: string | null;
  area_value: number | null;
  area_unit: "m2" | "ft2" | "acres" | null;
  area_basis: string;
  dimensions: string | null;
  category_key: string | null;
  price_cents: number | null;
  currency: string | null;
  price_basis: string | null;
  parcel_id: number | null;
  public_visible: boolean;
  revision: number;
};
type CategoryRow = {
  tier_key: string;
  label: string;
  color_hex: string;
  price_cents: number;
  currency: string | null;
  price_basis: string | null;
  map_price_is_set: boolean;
};
type FeatureRow = {
  identity_id: string;
  map_polygon: { x: number; y: number }[];
  provenance: { reviewed?: boolean; source_key?: string };
};
const missingUpgrade =
  "Map package support is not installed on this backend. This local feature needs its migration and public API update before hosted use.";

export function MapsPage() {
  const { workspace, isLoading } = useWorkspaceScope();
  if (isLoading) return <p role="status">Loading workspace…</p>;
  if (!workspace) return <p>Select a project and phase first.</p>;
  return (
    <MapsWorkspace
      key={`${workspace.tenantId}:${workspace.projectId}:${workspace.phaseId}`}
      scope={workspace}
    />
  );
}
function MapsWorkspace({ scope }: { scope: WorkspaceChoice }) {
  const cache = useQueryClient();
  const [incoming, setIncoming] = useState<MapPackage | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [replace, setReplace] = useState(false);
  const [embedBase, setEmbedBase] = useState(
    import.meta.env.VITE_PUBLIC_EMBED_BASE_URL || window.location.origin,
  );
  const qk = ["map-packages", scope.tenantId, scope.projectId, scope.phaseId];
  const { data: session } = useQuery({
    queryKey: ["session-profile"],
    queryFn: getSessionAndProfile,
  });
  const isAdmin =
    session?.profile?.role === "Admin" ||
    session?.profile?.role === "Super Admin";
  const state = useQuery({
    queryKey: qk,
    queryFn: async () => {
      const filter = {
        tenant_id: scope.tenantId,
        project_id: scope.projectId,
        phase_id: scope.phaseId,
      };
      const results = await Promise.all([
        readMapWorkspaceRows((from, to) =>
          supabase
            .from("project_map_packages")
            .select(
              "id,snapshot_id,created_at,published_at,title:package_data->>title,revision:package_data->revision",
              { count: "exact" },
            )
            .match(filter)
            .order("created_at", { ascending: false })
            .order("id")
            .range(from, to),
        ),
        readMapWorkspaceRows((from, to) =>
          supabase
            .from("map_feature_identities")
            .select("id,feature_key", { count: "exact" })
            .match(filter)
            .order("id")
            .range(from, to),
        ),
        readMapWorkspaceRows((from, to) =>
          supabase
            .from("project_plot_content")
            .select("*", { count: "exact" })
            .match(filter)
            .order("identity_id")
            .range(from, to),
        ),
        readMapWorkspaceRows((from, to) =>
          supabase
            .from("parcels")
            .select("id,lot_number,status", { count: "exact" })
            .match(filter)
            .order("id")
            .range(from, to),
        ),
        supabase
          .from("project_lot_tiers")
          .select(
            "tier_key,label,color_hex,price_cents,currency,price_basis,map_price_is_set",
          )
          .eq("tenant_id", scope.tenantId)
          .eq("project_id", scope.projectId),
        supabase
          .from("map_feature_snapshots")
          .select("id")
          .match(filter)
          .eq("is_active", true)
          .maybeSingle(),
      ]);
      const failed = results.find((r) => r.error);
      if (failed?.error)
        throw new Error(
          ["42P01", "PGRST205", "42703"].includes(failed.error.code)
            ? missingUpgrade
            : failed.error.message,
        );
      return {
        packages: results[0].data as unknown as StoredPackage[],
        identities: results[1].data as { id: string; feature_key: string }[],
        content: results[2].data as PlotContent[],
        parcels: results[3].data as {
          id: number;
          lot_number: string;
          status: string;
        }[],
        categories: results[4].data as CategoryRow[],
        activeId: results[5].data?.id as string | undefined,
      };
    },
  });
  const selected = state.data?.packages.find((p) => p.id === selectedId);
  const saved = useQuery({
    queryKey: [...qk, selectedId],
    enabled: Boolean(selectedId),
    queryFn: async () => {
      const result = await supabase
        .from("project_map_packages")
        .select("package_data,background_path,snapshot_id")
        .eq("id", selectedId!)
        .eq("tenant_id", scope.tenantId)
        .eq("project_id", scope.projectId)
        .eq("phase_id", scope.phaseId)
        .single();
      if (result.error) throw new Error(result.error.message);
      const featureResult = await readMapWorkspaceRows((from, to) =>
        supabase
          .from("map_features")
          .select("identity_id,map_polygon,provenance", { count: "exact" })
          .eq("snapshot_id", result.data.snapshot_id)
          .eq("tenant_id", scope.tenantId)
          .eq("project_id", scope.projectId)
          .eq("phase_id", scope.phaseId)
          .order("identity_id")
          .range(from, to),
      );
      if (featureResult.error) throw new Error(featureResult.error.message);
      let backgroundUrl: string | undefined;
      if (result.data.background_path) {
        const signed = await supabase.storage
          .from("project-map-packages")
          .createSignedUrl(result.data.background_path, 3600);
        if (signed.error) throw new Error(signed.error.message);
        backgroundUrl = signed.data.signedUrl;
      }
      const raw = result.data.package_data as MapPackage;
      return {
        map: validateMapPackage({
          ...raw,
          canvas: { ...raw.canvas, background: null },
        }),
        features: featureResult.data as FeatureRow[],
        backgroundUrl,
      };
    },
  });
  const map =
    incoming ??
    (saved.data && state.data
      ? {
          ...saved.data.map,
          categories: state.data.categories.map((c) => ({
            key: c.tier_key,
            label: c.label,
            color: c.color_hex,
            price_cents: c.map_price_is_set ? Number(c.price_cents) : null,
            currency: c.currency,
            price_basis: c.price_basis,
          })),
          plots: saved.data.map.plots.map((p) => {
            const feature = saved.data.features.find(
              (f) => f.provenance.source_key === p.key,
            );
            const details = state.data.content.find(
              (c) => c.identity_id === feature?.identity_id,
            );
            return details
              ? {
                  ...p,
                  number: details.plot_number,
                  polygon: feature?.map_polygon ?? p.polygon,
                  reviewed: feature?.provenance.reviewed === true,
                  area_value:
                    details.area_value === null
                      ? null
                      : Number(details.area_value),
                  area_unit: details.area_unit,
                  dimensions: details.dimensions,
                  category_key: details.category_key,
                  price_cents: details.price_cents,
                  currency: details.currency,
                  price_basis: details.price_basis,
                }
              : p;
          }),
        }
      : null);
  const comparison =
    incoming && state.data
      ? mapPackagePreview(incoming, state.data.identities)
      : null;
  const categoryConflicts = (incoming?.categories ?? []).flatMap((category) => {
    const existing = state.data?.categories.find(
      (c) => c.tier_key === category.key,
    );
    if (!existing) return [];
    const currentPrice = existing.map_price_is_set
      ? Number(existing.price_cents)
      : null;
    return existing.label !== category.label ||
      existing.color_hex.toLowerCase() !== category.color.toLowerCase() ||
      currentPrice !== category.price_cents ||
      existing.currency !== category.currency ||
      existing.price_basis !== category.price_basis
      ? [{ incoming: category, existing, currentPrice }]
      : [];
  });
  const feature = !incoming
    ? saved.data?.features.find((f) => f.provenance.source_key === selectedKey)
    : null;
  const content = state.data?.content.find(
    (c) => c.identity_id === feature?.identity_id,
  );
  const active = selected && selected.snapshot_id === state.data?.activeId;
  let embed: { url: string; html: string } | null = null;
  try {
    embed = buildMapEmbed(embedBase, scope);
  } catch {
    /* Field validation is shown in the embed section. */
  }
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      await cache.invalidateQueries({ queryKey: qk });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Map action failed.");
    } finally {
      setBusy(false);
    }
  }
  async function loadFile(file?: File) {
    if (!file) return;
    await action(async () => {
      if (file.size > MAP_PACKAGE_MAX_BYTES)
        throw new Error("Choose a package under 24 MB.");
      const pkg = validateMapPackage(JSON.parse(await file.text()));
      await verifyMapPackageAsset(pkg);
      setIncoming(pkg);
      setSelectedId(null);
      setSelectedKey(pkg.plots[0].key);
      setReplace(false);
    });
  }
  return (
    <div className="grid min-w-0 gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-primary">Project maps</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {scope.tenantName} · {scope.projectName} · {scope.phaseName}
          </p>
        </div>
        <Link
          className="text-sm font-semibold text-primary underline"
          to="/lots"
        >
          Manage inventory
        </Link>
      </div>
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="font-semibold text-primary">
          Prepare in Map Studio. Manage and publish here.
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Open the separate local tool with <code>npm run studio</code>. Extract
          a DXF, PDF or image, review its outlines, and export a map package.
        </p>
        <a
          className="mt-2 inline-block text-sm font-semibold text-primary underline"
          href="http://127.0.0.1:5340"
          target="_blank"
          rel="noreferrer"
        >
          Open local Map Studio
        </a>
        <p className="mt-2 text-sm text-muted-foreground">
          1. Open package &nbsp; 2. Compare &nbsp; 3. Import draft &nbsp; 4.
          Publish & copy embed
        </p>
      </section>
      {!isAdmin && (
        <p className="rounded-md bg-muted p-3 text-sm">
          Only Admins can import, edit or publish project maps.
        </p>
      )}
      {(error || state.error || saved.error) && (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/5 p-4 text-sm text-danger"
        >
          {error || state.error?.message || saved.error?.message}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-md border border-secondary/30 bg-secondary/5 p-4 text-sm text-primary"
        >
          {notice}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border bg-card p-5">
          <Field label="Map Studio package">
            <Input
              type="file"
              accept=".json"
              disabled={busy || !isAdmin}
              onChange={(e) => {
                void loadFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </Field>
          <p className="mt-2 text-xs text-muted-foreground">
            Opening a file only previews it. Import and publish are separate
            actions.
          </p>
        </section>
        <section className="rounded-xl border bg-card p-5">
          <Field label="Imported versions">
            <Select
              value={selectedId ?? ""}
              disabled={busy}
              onChange={(e) => {
                setIncoming(null);
                setSelectedId(e.target.value || null);
                setSelectedKey(null);
                setReplace(false);
              }}
            >
              <option value="">Choose a package…</option>
              {state.data?.packages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} · revision {p.revision} ·{" "}
                  {p.snapshot_id === state.data?.activeId
                    ? "Published"
                    : "Draft / retained"}
                </option>
              ))}
            </Select>
          </Field>
        </section>
      </div>
      {comparison && (
        <section className="rounded-xl border border-primary/20 bg-primary-soft p-5">
          <h2 className="font-semibold">Compare before importing</h2>
          <p className="my-3 text-sm">
            {comparison.total} outlines · {comparison.matched} stable matches ·{" "}
            {comparison.newPlots} new references · {comparison.unreviewed}{" "}
            boundaries to review.
          </p>
          <p className="mb-4 text-sm">
            {comparison.retained} existing map references are outside this
            package and remain in history. Existing plot details, inventory,
            leads and settings are preserved.
          </p>
          {categoryConflicts.length > 0 && (
            <div className="mb-4 rounded-md border bg-card p-3 text-sm">
              <p className="font-semibold">
                Existing project categories take precedence
              </p>
              <p className="mt-1">
                These codes already have different details in Admin. Import
                keeps the Admin values. Use a different code in Studio for a new
                category, or edit the existing category here after import.
              </p>
              <ul className="mt-3 grid gap-3">
                {categoryConflicts.map(
                  ({ incoming: category, existing, currentPrice }) => (
                    <li key={category.key}>
                      <code>{category.key}</code>
                      <p>
                        Keep: {existing.label} · {existing.color_hex} ·{" "}
                        {packagePrice(
                          currentPrice,
                          existing.currency,
                          existing.price_basis,
                        )}
                      </p>
                      <p className="text-muted-foreground">
                        Package: {category.label} · {category.color} ·{" "}
                        {packagePrice(
                          category.price_cents,
                          category.currency,
                          category.price_basis,
                        )}
                      </p>
                    </li>
                  ),
                )}
              </ul>
            </div>
          )}
          <Button
            disabled={busy || !isAdmin || !state.data}
            onClick={() =>
              void action(async () => {
                const receipt = await stageMapPackage(incoming!, scope);
                setIncoming(null);
                setSelectedId(receipt.id);
                setNotice(
                  receipt.reused
                    ? "This package is already imported; its existing draft was reused."
                    : "Package imported as a draft. Plot details can now be edited below.",
                );
              })
            }
          >
            Import as draft
          </Button>
        </section>
      )}
      {map && (
        <section className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 rounded-xl border bg-card p-4">
            <h2 className="font-semibold text-primary">
              {map.title} · {map.plots.length} outlines
            </h2>
            <MapPackagePreview
              map={map}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              backgroundUrl={!incoming ? saved.data?.backgroundUrl : undefined}
            />
          </div>
          <aside className="grid content-start gap-4 rounded-xl border bg-card p-4">
            <Field label="Choose an outline">
              <Select
                value={selectedKey ?? ""}
                onChange={(e) => setSelectedKey(e.target.value)}
              >
                <option value="">Select…</option>
                {map.plots.map((p) => (
                  <option value={p.key} key={p.key}>
                    {p.number || p.key}
                  </option>
                ))}
              </Select>
            </Field>
            {incoming ? (
              <p className="text-sm text-muted-foreground">
                Import this draft to edit its project records. You can continue
                extraction edits in Map Studio.
              </p>
            ) : content ? (
              <PlotEditor
                key={`${content.identity_id}:${content.revision}`}
                value={content}
                categories={map.categories}
                parcels={state.data?.parcels ?? []}
                disabled={busy || !isAdmin}
                onSave={(next) =>
                  action(async () => {
                    const result = await supabase.rpc(
                      "save_project_plot_content",
                      {
                        p_identity_id: content.identity_id,
                        p_expected_revision: content.revision,
                        p_content: next,
                      },
                    );
                    if (result.error) throw new Error(result.error.message);
                    setNotice("Plot details saved.");
                  })
                }
              />
            ) : null}
          </aside>
        </section>
      )}
      {selected && map && !incoming && (
        <section className="grid gap-4 rounded-xl border bg-card p-5">
          <h2 className="font-semibold">
            {active ? "Published map" : "Review & publish"}
          </h2>
          <p className="text-sm">
            {map.plots.filter((p) => p.reviewed).length} of {map.plots.length}{" "}
            boundaries reviewed. Unmatched plot numbers and prices may remain
            blank.
          </p>
          {!active && (
            <div className="flex flex-wrap items-center gap-4">
              <Button
                variant="outline"
                disabled={
                  busy || !isAdmin || map.plots.every((p) => p.reviewed)
                }
                onClick={() =>
                  void action(async () => {
                    const result = await supabase.rpc(
                      "review_project_map_package",
                      { p_package_id: selected.id },
                    );
                    if (result.error) throw new Error(result.error.message);
                    setNotice(
                      "The displayed package boundaries were marked reviewed.",
                    );
                  })
                }
              >
                Mark package boundaries reviewed
              </Button>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={replace}
                  onChange={(e) => setReplace(e.target.checked)}
                />{" "}
                Publish this package as the displayed phase map; retain existing
                records and history.
              </label>
              <Button
                disabled={
                  busy ||
                  !isAdmin ||
                  !replace ||
                  !map.plots.every((p) => p.reviewed)
                }
                onClick={() =>
                  void action(async () => {
                    const result = await supabase.rpc(
                      "publish_project_map_package",
                      {
                        p_package_id: selected.id,
                        p_expected_active_id: state.data?.activeId ?? null,
                        p_replace_current: replace,
                      },
                    );
                    if (result.error) throw new Error(result.error.message);
                    setNotice(
                      "Map published for this project and phase. Copy its embed below.",
                    );
                  })
                }
              >
                Publish map
              </Button>
            </div>
          )}
          {map.categories.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm font-semibold">
                Category colors and prices
              </summary>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                {map.categories.map((c) => (
                  <CategoryEditor
                    key={`${selected.id}:${c.key}:${c.price_cents}:${c.color}:${c.label}`}
                    value={c}
                    disabled={busy || !isAdmin}
                    onSave={(category) =>
                      action(async () => {
                        const result = await supabase.rpc(
                          "save_project_map_category",
                          {
                            p_tenant_id: scope.tenantId,
                            p_project_id: scope.projectId,
                            p_phase_id: scope.phaseId,
                            p_category: category,
                          },
                        );
                        if (result.error) throw new Error(result.error.message);
                        setNotice("Project category saved.");
                      })
                    }
                  />
                ))}
              </div>
            </details>
          )}
        </section>
      )}
      <section className="grid gap-3 rounded-xl border bg-card p-5">
        <h2 className="font-semibold text-primary">Website embed</h2>
        <Field label="Public map host">
          <Input
            type="url"
            value={embedBase}
            onChange={(e) => setEmbedBase(e.target.value)}
          />
        </Field>
        <p className="text-xs text-muted-foreground">
          Use the deployed frontend address. The URL includes this tenant,
          project and phase. A draft becomes visible only after publishing.
        </p>
        {embed ? (
          <>
            <a
              className="break-all text-sm text-primary underline"
              href={embed.url}
              target="_blank"
              rel="noreferrer"
            >
              {embed.url}
            </a>
            <Textarea
              aria-label="Website iframe code"
              readOnly
              value={embed.html}
            />
            <Button
              variant="outline"
              onClick={() =>
                void action(async () => {
                  await navigator.clipboard.writeText(embed!.html);
                  setNotice("Embed code copied.");
                })
              }
            >
              Copy embed code
            </Button>
          </>
        ) : (
          <p role="alert" className="text-sm text-danger">
            Enter an HTTP or HTTPS website address.
          </p>
        )}
      </section>
    </div>
  );
}
function PlotEditor({
  value,
  categories,
  parcels,
  disabled,
  onSave,
}: {
  value: PlotContent;
  categories: PackageCategory[];
  parcels: { id: number; lot_number: string; status: string }[];
  disabled: boolean;
  onSave: (next: PlotContent) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(draft);
      }}
    >
      <Field label="Plot number">
        <Input
          value={draft.plot_number ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, plot_number: e.target.value || null })
          }
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Area">
          <Input
            type="number"
            min="0.000001"
            step="any"
            value={draft.area_value ?? ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                area_value: e.target.value ? Number(e.target.value) : null,
                area_unit: e.target.value ? (draft.area_unit ?? "m2") : null,
                area_basis: "recorded",
              })
            }
          />
        </Field>
        <Field label="Unit">
          <Select
            value={draft.area_unit ?? ""}
            disabled={draft.area_value === null}
            onChange={(e) =>
              setDraft({
                ...draft,
                area_unit: e.target.value as PlotContent["area_unit"],
              })
            }
          >
            <option value="">Choose</option>
            <option value="m2">m²</option>
            <option value="ft2">ft²</option>
            <option value="acres">Acres</option>
          </Select>
        </Field>
      </div>
      <Field label="Dimensions">
        <Input
          value={draft.dimensions ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, dimensions: e.target.value || null })
          }
        />
      </Field>
      <Field label="Category">
        <Select
          value={draft.category_key ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, category_key: e.target.value || null })
          }
        >
          <option value="">Unassigned</option>
          {categories.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Price override">
        <Input
          type="number"
          min="0"
          step="0.01"
          disabled={draft.parcel_id !== null}
          value={draft.price_cents === null ? "" : draft.price_cents / 100}
          onChange={(e) =>
            setDraft({
              ...draft,
              price_cents: e.target.value
                ? Math.round(Number(e.target.value) * 100)
                : null,
            })
          }
        />
      </Field>
      <Field label="Currency (optional)">
        <Input
          maxLength={3}
          placeholder="BZD / USD"
          value={draft.currency ?? ""}
          onChange={(e) =>
            setDraft({
              ...draft,
              currency: e.target.value.toUpperCase() || null,
            })
          }
        />
      </Field>
      <Field label="Price basis">
        <Input
          placeholder="Per plot / per ¼ acre"
          value={draft.price_basis ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, price_basis: e.target.value || null })
          }
        />
      </Field>
      <Field label="Link existing inventory record">
        <Select
          value={draft.parcel_id ?? ""}
          onChange={(e) =>
            setDraft({
              ...draft,
              parcel_id: e.target.value ? Number(e.target.value) : null,
            })
          }
        >
          <option value="">Map reference only</option>
          {parcels.map((p) => (
            <option value={p.id} key={p.id}>
              {p.lot_number} · {p.status}
            </option>
          ))}
        </Select>
      </Field>
      {draft.parcel_id !== null && (
        <p className="text-xs text-muted-foreground">
          Linked inventory controls the public number, dimensions and price.
          Manage sales status on Lots.
        </p>
      )}
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.public_visible}
          onChange={(e) =>
            setDraft({ ...draft, public_visible: e.target.checked })
          }
        />{" "}
        Show on published map
      </label>
      <Button disabled={disabled} type="submit">
        Save plot details
      </Button>
    </form>
  );
}
function CategoryEditor({
  value,
  disabled,
  onSave,
}: {
  value: PackageCategory;
  disabled: boolean;
  onSave: (next: PackageCategory) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <form
      className="grid gap-2 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(draft);
      }}
    >
      <Field label="Category">
        <Input
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-[70px_1fr_80px] gap-2">
        <Field label="Color">
          <Input
            type="color"
            value={draft.color}
            onChange={(e) => setDraft({ ...draft, color: e.target.value })}
          />
        </Field>
        <Field label="Default price">
          <Input
            type="number"
            min="0"
            step="0.01"
            value={draft.price_cents === null ? "" : draft.price_cents / 100}
            onChange={(e) =>
              setDraft({
                ...draft,
                price_cents: e.target.value
                  ? Math.round(Number(e.target.value) * 100)
                  : null,
              })
            }
          />
        </Field>
        <Field label="Currency">
          <Input
            maxLength={3}
            value={draft.currency ?? ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                currency: e.target.value.toUpperCase() || null,
              })
            }
          />
        </Field>
      </div>
      <Field label="Price basis">
        <Input
          value={draft.price_basis ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, price_basis: e.target.value || null })
          }
        />
      </Field>
      <Button disabled={disabled} variant="outline">
        Save category
      </Button>
    </form>
  );
}
