import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

type Client = SupabaseClient;
type Row = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Keep the caller's RLS in effect and require tenant predicates on every AI query. */
export function withAiTenant(client: Client, tenantId: string): Client {
  const scopedValues = (values: Row | Row[]) => {
    const scope = (row: Row) => {
      if (row.tenant_id != null && row.tenant_id !== tenantId) {
        throw new Error("AI output belongs to a different workspace.");
      }
      return { ...row, tenant_id: tenantId };
    };
    return Array.isArray(values) ? values.map(scope) : scope(values);
  };
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "from") return Reflect.get(target, property, receiver);
      return (table: string) => {
        const builder = target.from(table);
        return new Proxy(builder, {
          get(query, method, queryReceiver) {
            if (method === "select") return (...args: Parameters<typeof query.select>) => query.select(...args).eq("tenant_id", tenantId);
            if (method === "update") return (values: Row, options?: Parameters<typeof query.update>[1]) => query.update(scopedValues(values), options).eq("tenant_id", tenantId);
            if (method === "delete") return (...args: Parameters<typeof query.delete>) => query.delete(...args).eq("tenant_id", tenantId);
            if (method === "insert") return (values: Row | Row[], options?: Parameters<typeof query.insert>[1]) => query.insert(scopedValues(values), options);
            if (method === "upsert") return (values: Row | Row[], options?: Parameters<typeof query.upsert>[1]) => query.upsert(scopedValues(values), options);
            return Reflect.get(query, method, queryReceiver);
          },
        });
      };
    },
  });
}

export async function resolveAiWorkspace(
  token: string,
  profile: { role?: unknown; tenant_id?: unknown } | null,
  requestedTenant: unknown,
) {
  const tenantId = requestedTenant == null ? String(profile?.tenant_id ?? "") : String(requestedTenant);
  if (!uuid.test(tenantId)) return { ok: false as const, status: 400, error: "Choose a valid workspace before generating AI content." };
  if (profile?.role !== "Super Admin" && tenantId !== profile?.tenant_id) {
    return { ok: false as const, status: 403, error: "You do not have access to this workspace." };
  }
  const caller = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await caller.from("organizations").select("id, name").eq("id", tenantId).eq("is_active", true).maybeSingle();
  if (error) return { ok: false as const, status: 500, error: "Could not verify the selected workspace." };
  if (!data) return { ok: false as const, status: 403, error: "The selected workspace is unavailable." };
  return { ok: true as const, tenantId, tenantName: String(data.name), client: withAiTenant(caller, tenantId) };
}

export async function resolveAiProviderKey(server: Client, tenantId: string): Promise<string> {
  const { data, error } = await server.rpc("get_organization_gemini_api_key", { p_tenant_id: tenantId });
  if (error) throw new Error("Could not load the workspace AI configuration.");
  return (typeof data === "string" ? data.trim() : "") || Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_API_KEY") || "";
}
