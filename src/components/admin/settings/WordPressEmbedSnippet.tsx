import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase";
import { Button } from "../../ui/Button";
import { Field, Input, Select } from "../../ui/Field";
import { ErrorState, LoadingState } from "../../ui/State";

type EmbedFilter = "all" | "available";

const HEIGHT_PRESETS = ["500px", "700px", "900px"];
const RADIUS_OPTIONS = ["0px", "8px", "12px", "20px"];

export function WordPressEmbedSnippet() {
  const [slug, setSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState("700px");
  const [radius, setRadius] = useState("12px");
  const [filter, setFilter] = useState<EmbedFilter>("available");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadTenantSlug() {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        if (!cancelled) {
          setError("Sign in again to load your tenant embed details.");
          setLoading(false);
        }
        return;
      }
      const { data: profile, error: profileError } = await supabase
        .from("admin_profiles")
        .select("tenant_id")
        .eq("user_id", sessionData.session.user.id)
        .maybeSingle();
      if (cancelled) return;
      if (profileError) {
        setError(profileError.message);
        setLoading(false);
        return;
      }
      const tenantId = (profile as { tenant_id: string | null } | null)?.tenant_id;
      if (!tenantId) {
        setError("No tenant is linked to your login.");
        setLoading(false);
        return;
      }
      const { data: org, error: orgError } = await supabase
        .from("organizations")
        .select("slug")
        .eq("id", tenantId)
        .maybeSingle();
      if (cancelled) return;
      setLoading(false);
      if (orgError) {
        setError(orgError.message);
        return;
      }
      setSlug((org as { slug: string } | null)?.slug ?? null);
    }
    void loadTenantSlug();
    return () => {
      cancelled = true;
    };
  }, []);

  const baseUrl = window.location.origin;
  const snippet = slug
    ? `<iframe src="${baseUrl}/embed/${slug}?filter=${filter}" width="100%" height="${height}" frameborder="0" style="border:0; border-radius:${radius}; width:100%; overflow:hidden;" allowfullscreen></iframe>`
    : "";

  async function handleCopy() {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copy failed. Select the code manually.");
    }
  }

  if (loading) return <LoadingState label="Loading embed details" />;

  return (
    <div className="grid gap-4">
      {error ? <ErrorState message={error} /> : null}
      {!slug && !error ? (
        <p className="rounded-md border border-dashed bg-muted p-4 text-sm text-muted-foreground">
          Embed details appear once your login is linked to a tenant.
        </p>
      ) : null}
      {slug ? (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Height">
              <Select value={height} onChange={(event) => setHeight(event.target.value)}>
                {HEIGHT_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>{preset}</option>
                ))}
              </Select>
            </Field>
            <Field label="Border radius">
              <Select value={radius} onChange={(event) => setRadius(event.target.value)}>
                {RADIUS_OPTIONS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </Select>
            </Field>
            <Field label="Default view">
              <Select value={filter} onChange={(event) => setFilter(event.target.value as EmbedFilter)}>
                <option value="all">All lots</option>
                <option value="available">Available only</option>
              </Select>
            </Field>
          </div>
          <Field label="Custom height (optional override)">
            <Input
              value={height}
              onChange={(event) => setHeight(event.target.value)}
              placeholder="700px"
              maxLength={12}
            />
          </Field>
          <Field label="Embed code — paste into a WordPress Custom HTML block">
            <textarea
              readOnly
              value={snippet}
              rows={6}
              onFocus={(event) => event.target.select()}
              className="focus-ring w-full min-w-0 max-w-full rounded-md border border-input bg-muted px-3 py-2 font-mono text-xs shadow-sm"
            />
          </Field>
          <div>
            <Button type="button" onClick={() => void handleCopy()}>
              {copied ? "Copied!" : "Copy to Clipboard"}
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Live map for tenant <strong>{slug}</strong>. Works in WordPress, Webflow, or any site that accepts iframes.
            Inquiries submitted inside the embed route to your tenant pipeline automatically.
          </p>
        </>
      ) : null}
    </div>
  );
}
