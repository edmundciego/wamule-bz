import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageHeader } from "../components/layout/PageHeader";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Field, Input } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { supabase } from "../lib/supabase";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["fee-settings"],
    queryFn: async () => {
      const { data: settings, error: queryError } = await supabase.from("community_fee_settings").select("*").eq("is_active", true).maybeSingle();
      if (queryError) throw queryError;
      return settings;
    },
  });
  const [garbage, setGarbage] = useState("");
  const [road, setRoad] = useState("");

  async function save() {
    setError(null);
    const garbageAmount = Number(garbage || data?.garbage_fee_amount || 0);
    const roadAmount = Number(road || data?.road_maintenance_fee_amount || 0);
    const { error: updateError } = await supabase
      .from("community_fee_settings")
      .update({
        garbage_fee_amount: garbageAmount,
        road_maintenance_fee_amount: roadAmount,
        effective_date: new Date().toISOString().slice(0, 10),
        is_active: true,
      })
      .eq("is_active", true);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["fee-settings"] });
  }

  return (
    <>
      <PageHeader title="Settings" description="Admin-only system and community fee settings." />
      <Card className="max-w-xl">
        <CardHeader><CardTitle>Community Fees</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          {isLoading ? <LoadingState /> : null}
          {error ? <ErrorState message={error} /> : null}
          <Field label="Garbage fee amount">
            <Input type="number" min="0" step="0.01" placeholder={String(data?.garbage_fee_amount ?? 0)} value={garbage} onChange={(event) => setGarbage(event.target.value)} />
          </Field>
          <Field label="Road maintenance fee amount">
            <Input type="number" min="0" step="0.01" placeholder={String(data?.road_maintenance_fee_amount ?? 0)} value={road} onChange={(event) => setRoad(event.target.value)} />
          </Field>
          <Button type="button" onClick={() => void save()}>Save settings</Button>
        </CardContent>
      </Card>
    </>
  );
}
