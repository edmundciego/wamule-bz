import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../../lib/supabase";
import { money } from "../../../lib/utils";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Field, Input } from "../../ui/Field";
import { ErrorState, LoadingState } from "../../ui/State";
import type { LotTier } from "../../../types/database";

interface TierCatalogManagerProps {
  tenantId: string | null;
}

const TIER_KEY_PATTERN = /^[a-z0-9_]+$/;
const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

interface TierDraft {
  tier_key: string;
  label: string;
  priceDollars: string;
  cornerDollars: string;
  color_hex: string;
}

function toDraft(tier: LotTier): TierDraft {
  return {
    tier_key: tier.tier_key,
    label: tier.label,
    priceDollars: String(Number(tier.price_cents) / 100),
    cornerDollars: String(Number(tier.corner_premium_cents) / 100),
    color_hex: tier.color_hex,
  };
}

export function TierCatalogManager({ tenantId }: TierCatalogManagerProps) {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, TierDraft>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [newTier, setNewTier] = useState<TierDraft>({ tier_key: "", label: "", priceDollars: "", cornerDollars: "0", color_hex: "#22c55e" });
  const [creating, setCreating] = useState(false);

  const { data: tiers, isLoading, error } = useQuery({
    queryKey: ["lot-tiers", tenantId],
    queryFn: async () => {
      if (!tenantId) return [] as LotTier[];
      const { data, error: queryError } = await supabase
        .from("lot_tiers")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("sort_order")
        .order("tier_key");
      if (queryError) throw queryError;
      return (data ?? []) as LotTier[];
    },
    enabled: tenantId !== null,
  });

  useEffect(() => {
    if (!tiers) return;
    setDrafts(Object.fromEntries(tiers.map((tier) => [tier.id, toDraft(tier)])));
  }, [tiers]);

  if (!tenantId) {
    return <p className="text-sm text-muted-foreground">Tier catalogue appears once your login is linked to a tenant.</p>;
  }
  if (isLoading) return <LoadingState label="Loading tier catalogue" />;
  if (error) return <ErrorState message={(error as Error).message} />;

  function validateDraft(draft: TierDraft, allowKey = true): string | null {
    if (allowKey && !TIER_KEY_PATTERN.test(draft.tier_key)) return "Tier key must be lowercase letters, digits, or underscores.";
    if (!draft.label.trim()) return "Label is required.";
    const price = Number(draft.priceDollars);
    if (!Number.isFinite(price) || price < 0) return "Price must be a non-negative dollar amount.";
    const corner = Number(draft.cornerDollars || "0");
    if (!Number.isFinite(corner) || corner < 0) return "Corner premium must be non-negative.";
    if (!HEX_PATTERN.test(draft.color_hex.trim())) return "Colour must be a #rrggbb hex.";
    return null;
  }

  async function handleSave(tier: LotTier) {
    const draft = drafts[tier.id];
    if (!draft) return;
    const violation = validateDraft(draft);
    if (violation) {
      setFormError(violation);
      return;
    }
    setFormError(null);
    setSavedMessage(null);
    setSavingId(tier.id);
    const { error: updateError } = await supabase
      .from("lot_tiers")
      .update({
        label: draft.label.trim(),
        price_cents: Math.round(Number(draft.priceDollars) * 100),
        corner_premium_cents: Math.round(Number(draft.cornerDollars || "0") * 100),
        color_hex: draft.color_hex.trim(),
      })
      .eq("id", tier.id)
      .eq("tenant_id", tenantId);
    setSavingId(null);
    if (updateError) {
      setFormError(updateError.message);
      return;
    }
    setSavedMessage(`Tier ${draft.tier_key} saved. Public embeds pick up the new price immediately.`);
    await queryClient.invalidateQueries({ queryKey: ["lot-tiers", tenantId] });
    await queryClient.invalidateQueries({ queryKey: ["lot-board"] });
  }

  async function handleCreate() {
    const violation = validateDraft(newTier);
    if (violation) {
      setFormError(violation);
      return;
    }
    setFormError(null);
    setSavedMessage(null);
    setCreating(true);
    const { error: insertError } = await supabase.from("lot_tiers").insert({
      tenant_id: tenantId,
      tier_key: newTier.tier_key.trim(),
      label: newTier.label.trim(),
      price_cents: Math.round(Number(newTier.priceDollars) * 100),
      corner_premium_cents: Math.round(Number(newTier.cornerDollars || "0") * 100),
      color_hex: newTier.color_hex.trim(),
      sort_order: (tiers ?? []).length * 10,
    });
    setCreating(false);
    if (insertError) {
      setFormError(insertError.message);
      return;
    }
    setNewTier({ tier_key: "", label: "", priceDollars: "", cornerDollars: "0", color_hex: "#22c55e" });
    setSavedMessage("Tier added.");
    await queryClient.invalidateQueries({ queryKey: ["lot-tiers", tenantId] });
  }

  return (
    <div className="grid gap-4">
      <div className="v2-workflow-panel p-4 text-sm text-primary">
        The catalogue is the price source of truth: public embeds compute each lot&apos;s price from its tier (plus
        corner premium), so edits here apply instantly without re-ingesting geometry. Per-lot overrides in the lot
        editor still win when set.
      </div>
      {formError ? <ErrorState message={formError} /> : null}
      {savedMessage ? (
        <div className="crm-success-panel p-3 text-sm" role="status">
          {savedMessage}
        </div>
      ) : null}
      {!tiers?.length ? (
        <p className="rounded-md border border-dashed bg-muted p-4 text-sm text-muted-foreground">
          No tiers yet. Add the first tier below (e.g. key <code>standard</code>) — ingest assigns these keys to lots.
        </p>
      ) : null}
      <div className="grid gap-3">
        {(tiers ?? []).map((tier) => {
          const draft = drafts[tier.id] ?? toDraft(tier);
          return (
            <div key={tier.id} className="grid gap-3 rounded-md border border-border bg-card p-3">
              <div className="flex items-center gap-2">
                <span className="inline-block h-4 w-4 rounded" style={{ backgroundColor: tier.color_hex }} aria-hidden />
                <strong className="text-sm text-primary">
                  {tier.label} <span className="text-muted-foreground">({tier.tier_key})</span>
                </strong>
                <span className="ml-auto flex gap-1">
                  <Badge tone="green">{money(Number(tier.price_cents) / 100)}</Badge>
                  {Number(tier.corner_premium_cents) > 0 ? (
                    <Badge tone="amber">+{money(Number(tier.corner_premium_cents) / 100)} corner</Badge>
                  ) : null}
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <Field label="Label">
                  <Input value={draft.label} onChange={(event) => setDrafts((current) => ({ ...current, [tier.id]: { ...draft, label: event.target.value } }))} />
                </Field>
                <Field label="Price (BZD)">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={draft.priceDollars}
                    onChange={(event) => setDrafts((current) => ({ ...current, [tier.id]: { ...draft, priceDollars: event.target.value } }))}
                  />
                </Field>
                <Field label="Corner premium (BZD)">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={draft.cornerDollars}
                    onChange={(event) => setDrafts((current) => ({ ...current, [tier.id]: { ...draft, cornerDollars: event.target.value } }))}
                  />
                </Field>
                <Field label="Colour hex">
                  <Input value={draft.color_hex} maxLength={7} onChange={(event) => setDrafts((current) => ({ ...current, [tier.id]: { ...draft, color_hex: event.target.value } }))} />
                </Field>
                <div className="flex items-end">
                  <Button type="button" disabled={savingId === tier.id} onClick={() => void handleSave(tier)}>
                    {savingId === tier.id ? "Saving…" : "Save tier"}
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="grid gap-3 rounded-md border border-dashed border-border p-3">
        <p className="text-sm font-semibold text-primary">Add tier</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <Field label="Key">
            <Input value={newTier.tier_key} placeholder="standard" onChange={(event) => setNewTier({ ...newTier, tier_key: event.target.value })} />
          </Field>
          <Field label="Label">
            <Input value={newTier.label} placeholder="Standard Interior" onChange={(event) => setNewTier({ ...newTier, label: event.target.value })} />
          </Field>
          <Field label="Price (BZD)">
            <Input type="number" min="0" step="0.01" value={newTier.priceDollars} onChange={(event) => setNewTier({ ...newTier, priceDollars: event.target.value })} />
          </Field>
          <Field label="Corner premium (BZD)">
            <Input type="number" min="0" step="0.01" value={newTier.cornerDollars} onChange={(event) => setNewTier({ ...newTier, cornerDollars: event.target.value })} />
          </Field>
          <Field label="Colour hex">
            <Input value={newTier.color_hex} maxLength={7} onChange={(event) => setNewTier({ ...newTier, color_hex: event.target.value })} />
          </Field>
          <div className="flex items-end">
            <Button type="button" variant="outline" disabled={creating} onClick={() => void handleCreate()}>
              {creating ? "Adding…" : "Add tier"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
