import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type RootType = "lead" | "application" | "customer";
type RequestBody = {
  action?: "search" | "preview" | "execute";
  query?: string;
  root_type?: RootType;
  root_id?: string;
  reason?: string;
  confirmation?: boolean;
  typed_name?: string;
  typed_purge?: string;
  typed_financial_confirmation?: string;
  remove_linked_auth?: boolean;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const token = request.headers.get("Authorization")?.replace("Bearer ", "").trim();
  if (!token) return json({ error: "Missing authorization token." }, 401);
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) return json({ error: "Invalid authorization token." }, 401);
  const actor = userData.user;
  const { data: profile, error: profileError } = await supabase.from("admin_profiles").select("role, full_name, email").eq("user_id", actor.id).maybeSingle();
  if (profileError) return json({ error: "Could not verify your role." }, 500);
  if (profile?.role !== "Super Admin") return json({ error: "Only Super Admin users can purge records." }, 403);

  const body = await request.json().catch(() => null) as RequestBody | null;
  if (!body?.action) return json({ error: "An action is required." }, 400);

  try {
    if (body.action === "search") return json({ records: await searchRecords(supabase, body.query ?? "") });
    if (!isRoot(body.root_type, body.root_id)) return json({ error: "Choose one exact lead, application, or customer record." }, 400);

    const preview = await getPreview(supabase, body.root_type, body.root_id);
    if (body.action === "preview") return json({ preview, possible_related_records: await possibleRelatedRecords(supabase, body.root_type, body.root_id) });

    const reason = body.reason?.trim() ?? "";
    const displayName = String(preview.display_name ?? "").trim();
    const counts = (preview.counts ?? {}) as Record<string, number>;
    const hasFinancialHistory = ["contracts", "payments", "payment_documents", "payment_requests"].some((key) => Number(counts[key] ?? 0) > 0);
    if (!reason || !body.confirmation || body.typed_name?.trim() !== displayName || body.typed_purge?.trim() !== "PURGE") {
      return json({ error: "Provide a reason, confirm the record is test data or created in error, enter the exact displayed name, and type PURGE." }, 400);
    }
    if (hasFinancialHistory && body.typed_financial_confirmation?.trim() !== "PURGE FINANCIAL HISTORY") {
      return json({ error: "This record has contract or financial history. Type PURGE FINANCIAL HISTORY to continue." }, 400);
    }
    if (String(preview.linked_auth_user_id ?? "") === actor.id && body.remove_linked_auth) {
      return json({ error: "You cannot purge your own linked login account." }, 403);
    }

    const { data: result, error: purgeError } = await supabase.rpc("purge_contact_record", {
      p_root_type: body.root_type,
      p_root_id: body.root_id,
      p_actor_id: actor.id,
      p_reason: reason,
      p_remove_linked_auth: Boolean(body.remove_linked_auth),
    });
    if (purgeError || !result) throw new Error(purgeError?.message ?? "The database purge did not return a result.");

    const cleanup = await cleanStorage(supabase, result as Record<string, unknown>);
    const authResult = await cleanLinkedAuth(supabase, result as Record<string, unknown>, Boolean(body.remove_linked_auth), actor.id);
    await updatePurgeAudit(supabase, result as Record<string, unknown>, cleanup, authResult);

    return json({ ...(result as Record<string, unknown>), storage_cleanup: cleanup, linked_auth_result: authResult });
  } catch (error) {
    console.error("purge-contact-record failed", error);
    return json({ error: error instanceof Error ? error.message : "Purge failed. No database success was recorded." }, 500);
  }
});

function isRoot(type: unknown, id: unknown): type is RootType {
  return (type === "lead" || type === "application" || type === "customer") && typeof id === "string" && id.trim().length > 0;
}

async function getPreview(supabase: ReturnType<typeof createClient>, rootType: RootType, rootId: string) {
  const { data, error } = await supabase.rpc("purge_contact_preview", { p_root_type: rootType, p_root_id: rootId });
  if (error || !data) throw new Error(error?.message ?? "The selected record could not be previewed.");
  return data as Record<string, unknown>;
}

async function searchRecords(supabase: ReturnType<typeof createClient>, rawQuery: string) {
  const query = rawQuery.trim();
  if (query.length < 2) return [];
  const term = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const [leads, applications, customers] = await Promise.all([
    supabase.from("leads").select("id, full_name, email, phone, created_at").or(`full_name.ilike.${term},email.ilike.${term},phone.ilike.${term}`).limit(12),
    supabase.from("applications").select("id, first_name, last_name, email, phone, created_at").or(`first_name.ilike.${term},last_name.ilike.${term},email.ilike.${term},phone.ilike.${term}`).limit(12),
    supabase.from("customers").select("id, first_name, last_name, email, phone, created_at").or(`first_name.ilike.${term},last_name.ilike.${term},email.ilike.${term},phone.ilike.${term}`).limit(12),
  ]);
  if (leads.error || applications.error || customers.error) throw new Error("Search failed. Try a more specific name, email, or phone number.");
  return [
    ...(leads.data ?? []).map((row) => ({ root_type: "lead", root_id: String(row.id), display_name: row.full_name || "Unnamed lead", email: row.email, phone: row.phone, created_at: row.created_at })),
    ...(applications.data ?? []).map((row) => ({ root_type: "application", root_id: String(row.id), display_name: [row.first_name, row.last_name].filter(Boolean).join(" ") || "Unnamed application", email: row.email, phone: row.phone, created_at: row.created_at })),
    ...(customers.data ?? []).map((row) => ({ root_type: "customer", root_id: String(row.id), display_name: [row.first_name, row.last_name].filter(Boolean).join(" ") || "Unnamed customer", email: row.email, phone: row.phone, created_at: row.created_at })),
  ];
}

async function possibleRelatedRecords(supabase: ReturnType<typeof createClient>, rootType: RootType, rootId: string) {
  const source = rootType === "lead"
    ? await supabase.from("leads").select("email, phone").eq("id", rootId).maybeSingle()
    : rootType === "application"
      ? await supabase.from("applications").select("email, phone").eq("id", rootId).maybeSingle()
      : await supabase.from("customers").select("email, phone").eq("id", rootId).maybeSingle();
  if (source.error || !source.data || (!source.data.email && !source.data.phone)) return [];
  const fields = [source.data.email ? `email.eq.${source.data.email}` : null, source.data.phone ? `phone.eq.${source.data.phone}` : null].filter(Boolean).join(",");
  const [leads, applications, customers] = await Promise.all([
    supabase.from("leads").select("id, full_name, email, phone").or(fields).limit(25),
    supabase.from("applications").select("id, first_name, last_name, email, phone").or(fields).limit(25),
    supabase.from("customers").select("id, first_name, last_name, email, phone").or(fields).limit(25),
  ]);
  return [
    ...(leads.data ?? []).map((row) => ({ root_type: "lead", root_id: String(row.id), display_name: row.full_name, email: row.email, phone: row.phone })),
    ...(applications.data ?? []).map((row) => ({ root_type: "application", root_id: String(row.id), display_name: [row.first_name, row.last_name].filter(Boolean).join(" "), email: row.email, phone: row.phone })),
    ...(customers.data ?? []).map((row) => ({ root_type: "customer", root_id: String(row.id), display_name: [row.first_name, row.last_name].filter(Boolean).join(" "), email: row.email, phone: row.phone })),
  ].filter((record) => !(record.root_type === rootType && record.root_id === rootId));
}

async function cleanStorage(supabase: ReturnType<typeof createClient>, result: Record<string, unknown>) {
  const reference = String(result.purge_reference ?? "");
  const files = Array.isArray(result.storage_files) ? result.storage_files as Array<{ bucket_id?: string; object_path?: string }> : [];
  const groups = new Map<string, string[]>();
  for (const file of files) {
    if (!file.bucket_id || !file.object_path) continue;
    groups.set(file.bucket_id, [...(groups.get(file.bucket_id) ?? []), file.object_path]);
  }
  const warnings: string[] = [];
  let removed = 0;
  for (const [bucket, paths] of groups) {
    const { error } = await supabase.storage.from(bucket).remove(paths);
    if (error) warnings.push(`${bucket}: ${error.message}`);
    else removed += paths.length;
    await supabase.from("purge_storage_cleanup_tasks").update({ status: error ? "failed" : "removed", last_error: error?.message ?? null, completed_at: new Date().toISOString() }).eq("purge_reference", reference).eq("bucket_id", bucket).in("object_path", paths);
  }
  return { attempted: files.length, removed, completed: warnings.length === 0, warnings };
}

async function cleanLinkedAuth(supabase: ReturnType<typeof createClient>, result: Record<string, unknown>, requested: boolean, actorId: string) {
  const target = typeof result.linked_auth_user_id === "string" ? result.linked_auth_user_id : null;
  if (!requested || !target) return { requested, removed: false, warning: null };
  if (target === actorId) return { requested, removed: false, warning: "Current Super Admin login was retained." };
  const { error } = await supabase.auth.admin.deleteUser(target);
  return { requested, removed: !error, warning: error?.message ?? null };
}

async function updatePurgeAudit(supabase: ReturnType<typeof createClient>, result: Record<string, unknown>, storage: Record<string, unknown>, auth: Record<string, unknown>) {
  const auditId = typeof result.audit_event_id === "string" ? result.audit_event_id : null;
  if (!auditId) return;
  const { data } = await supabase.from("audit_events").select("metadata").eq("id", auditId).maybeSingle();
  await supabase.from("audit_events").update({ metadata: { ...(data?.metadata ?? {}), storage_cleanup: storage, linked_auth_result: auth } }).eq("id", auditId);
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}
