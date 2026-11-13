import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeWorkspaceActivePhase } from "../_shared/workspace-auth.ts";
import { resolvePublicApplicationSettings } from "../_shared/public-application-settings.mjs";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const signingSecret = Deno.env.get("MAP_REVIEW_LINK_SIGNING_SECRET") ?? "";
const tokenEncoder = new TextEncoder();
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
};
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type ReviewLink = {
  id: string;
  tenant_id: string;
  project_id: string;
  phase_id: string;
  package_id: string;
  snapshot_id: string;
  package_digest: string;
  snapshot_fingerprint: string;
  settings_snapshot: Record<string, unknown>;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};

type LinkBody = {
  action?: unknown;
  token?: unknown;
  tenant_id?: unknown;
  project_id?: unknown;
  phase_id?: unknown;
  package_id?: unknown;
  link_id?: unknown;
  expires_in_seconds?: unknown;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!signingSecret) return json({ error: "Map review links are not configured." }, 503);

  const body = await request.json().catch(() => null) as LinkBody | null;
  if (!body || typeof body.action !== "string") return json({ error: "A valid action is required." }, 400);

  if (body.action === "resolve" || body.action === "asset") {
    const link = await verifiedLink(body.token);
    if (!link.ok) return json({ error: link.error }, link.status);

    // A phase hint is optional for the reviewer page, but when supplied it
    // must match the immutable phase bound into this capability.
    if (body.phase_id !== undefined && body.phase_id !== link.row.phase_id) {
      return json({ error: "This review link is not available for that phase." }, 404);
    }

    if (body.action === "asset") return await streamReviewedBackground(link.row);
    const data = await reviewedMap(link.row);
    if (!data.ok) return json({ error: data.error }, data.status);
    return json(data.payload, 200);
  }

  const identity = await authenticatedAdmin(request);
  if (!identity.ok) return json({ error: identity.error }, identity.status);
  const authorization = await authorizeWorkspaceActivePhase(
    supabase,
    identity.userId,
    body.tenant_id,
    body.project_id,
    body.phase_id,
    ["Super Admin", "Admin"],
  );
  if (!authorization.ok) return json({ error: authorization.error }, authorization.status);

  if (body.action === "list") {
    const { data, error } = await supabase.from("project_map_review_links")
      .select("id,package_id,snapshot_id,created_at,expires_at,revoked_at,settings_snapshot")
      .eq("tenant_id", authorization.tenantId).eq("project_id", body.project_id)
      .eq("phase_id", body.phase_id).order("created_at", { ascending: false }).limit(25);
    if (error) return json({ error: "Review links could not be loaded." }, 503);
    return json({ links: data ?? [] }, 200);
  }

  if (body.action === "revoke") {
    const linkId = asUuid(body.link_id);
    if (!linkId) return json({ error: "A valid review link ID is required." }, 400);
    const { data: existing, error: readError } = await supabase.from("project_map_review_links")
      .select("id,revoked_at").eq("id", linkId).eq("tenant_id", authorization.tenantId)
      .eq("project_id", body.project_id).eq("phase_id", body.phase_id).maybeSingle();
    if (readError) return json({ error: "Review link could not be checked." }, 503);
    if (!existing) return json({ error: "Review link was not found in this phase." }, 404);
    if (!existing.revoked_at) {
      const { error } = await supabase.from("project_map_review_links").update({
        revoked_at: new Date().toISOString(), revoked_by: identity.userId,
      }).eq("id", linkId).eq("tenant_id", authorization.tenantId)
        .eq("project_id", body.project_id).eq("phase_id", body.phase_id).is("revoked_at", null);
      if (error) return json({ error: "Review link could not be revoked." }, 503);
    }
    return json({ revoked: true, link_id: linkId }, 200);
  }

  if (body.action === "create") {
    const packageId = asUuid(body.package_id);
    const ttl = Number(body.expires_in_seconds);
    if (!packageId) return json({ error: "A valid reviewed package is required." }, 400);
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 30 * 24 * 60 * 60) {
      return json({ error: "Link expiry must be between 1 second and 30 days." }, 400);
    }

    const reviewScope = await verifiedReviewScope(
      authorization.tenantId,
      String(body.project_id),
      String(body.phase_id),
      packageId,
    );
    if (!reviewScope.ok) return json({ error: reviewScope.error }, reviewScope.status);

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + ttl * 1000);
    const settingsSnapshot = await captureReviewedSettings(
      authorization.tenantId,
      String(body.project_id),
      String(body.phase_id),
      reviewScope.project,
      reviewScope.phase,
    );
    if (!settingsSnapshot.ok) return json({ error: settingsSnapshot.error }, settingsSnapshot.status);

    const { data: inserted, error } = await supabase.from("project_map_review_links").insert({
      tenant_id: authorization.tenantId,
      project_id: reviewScope.project.id,
      phase_id: reviewScope.phase.id,
      package_id: reviewScope.package.id,
      snapshot_id: reviewScope.snapshot.id,
      package_digest: reviewScope.package.package_digest,
      snapshot_fingerprint: reviewScope.snapshot.snapshot_fingerprint,
      settings_snapshot: settingsSnapshot.value,
      created_by: identity.userId,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    }).select("id,created_at,expires_at,settings_snapshot").single();
    if (error || !inserted) return json({ error: "The reviewed map link could not be created." }, 503);

    const tokenExpiry = Math.ceil(Date.parse(inserted.expires_at) / 1000);
    const token = await signToken(inserted.id, tokenExpiry);
    return json({
      link_id: inserted.id,
      token,
      created_at: inserted.created_at,
      expires_at: inserted.expires_at,
      settings_snapshot: inserted.settings_snapshot,
    }, 201);
  }

  return json({ error: "Unsupported review-link action." }, 400);
});

async function authenticatedAdmin(request: Request): Promise<
  | { ok: true; userId: string }
  | { ok: false; status: number; error: string }
> {
  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, status: 401, error: "A signed-in Admin session is required." };
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return { ok: false, status: 401, error: "The Admin session is invalid." };
  return { ok: true, userId: data.user.id };
}

async function verifiedReviewScope(tenantId: string, projectId: string, phaseId: string, packageId: string) {
  const [projectResult, phaseResult, packageResult] = await Promise.all([
    supabase.from("projects").select("id,tenant_id,name,slug").eq("id", projectId).eq("tenant_id", tenantId).maybeSingle(),
    supabase.from("development_phases").select("id,tenant_id,project_id,name,slug,is_active")
      .eq("id", phaseId).eq("tenant_id", tenantId).eq("project_id", projectId).eq("is_active", true).maybeSingle(),
    supabase.from("project_map_packages").select("id,tenant_id,project_id,phase_id,snapshot_id,package_digest,package_data,background_path")
      .eq("id", packageId).eq("tenant_id", tenantId).eq("project_id", projectId).eq("phase_id", phaseId).maybeSingle(),
  ]);
  if (projectResult.error || phaseResult.error || packageResult.error) {
    return { ok: false as const, status: 503, error: "The map review scope could not be verified." };
  }
  const project = projectResult.data;
  const phase = phaseResult.data;
  const packageRow = packageResult.data;
  if (!project || !phase || !packageRow || !packageRow.snapshot_id || !packageRow.package_digest) {
    return { ok: false as const, status: 404, error: "The reviewed map package was not found in this phase." };
  }

  const [snapshotResult, featuresResult] = await Promise.all([
    supabase.from("map_feature_snapshots").select("id,tenant_id,project_id,phase_id,snapshot_fingerprint,snapshot_version,outline_count")
      .eq("id", packageRow.snapshot_id).eq("tenant_id", tenantId).eq("project_id", projectId).eq("phase_id", phaseId).maybeSingle(),
    supabase.from("map_features").select("identity_id,provenance")
      .eq("tenant_id", tenantId).eq("project_id", projectId).eq("phase_id", phaseId).eq("snapshot_id", packageRow.snapshot_id),
  ]);
  if (snapshotResult.error || featuresResult.error) {
    return { ok: false as const, status: 503, error: "The reviewed map revision could not be checked." };
  }
  const snapshot = snapshotResult.data;
  const features = featuresResult.data ?? [];
  if (!snapshot || !snapshot.snapshot_fingerprint || snapshot.outline_count < 1
      || features.length !== snapshot.outline_count
      || features.some((feature) => objectValue(feature.provenance).reviewed !== true)) {
    return { ok: false as const, status: 409, error: "Every outline in this revision must be reviewed before a link can be issued." };
  }
  return { ok: true as const, project, phase, package: packageRow, snapshot };
}

async function captureReviewedSettings(tenantId: string, projectId: string, phaseId: string, project: Record<string, unknown>, phase: Record<string, unknown>) {
  const [tenantResult, projectSettingsResult, tenantSettingsResult] = await Promise.all([
    supabase.from("organizations").select("name,is_active").eq("id", tenantId).maybeSingle(),
    supabase.from("project_settings").select("key,value").eq("tenant_id", tenantId).eq("project_id", projectId)
      .in("key", ["tenant_theme", "public_application"]),
    supabase.from("business_settings").select("key,value").eq("tenant_id", tenantId)
      .in("key", ["public_application"]),
  ]);
  if (tenantResult.error || projectSettingsResult.error || tenantSettingsResult.error || !tenantResult.data?.is_active) {
    return { ok: false as const, status: 503, error: "Reviewed project settings are unavailable." };
  }
  const projectSettings = settingsByKey(projectSettingsResult.data ?? []);
  const tenantSettings = settingsByKey(tenantSettingsResult.data ?? []);
  const theme = objectValue(projectSettings.tenant_theme);
  const experience = objectValue(theme.site_experience);
  const projectApplication = objectValue(projectSettings.public_application);
  const tenantApplication = objectValue(tenantSettings.public_application);
  const effective = resolvePublicApplicationSettings(tenantApplication, projectApplication, phaseId);
  const rawTemplate = experience.templateId;
  const templateId = rawTemplate === "hopkins-project" ? "hopkins-project" : "wamule-classic";
  const enabledModules = objectValue(experience.enabledModules);
  return {
    ok: true as const,
    value: {
      tenant_name: cleanText(tenantResult.data.name, 120),
      project_name: cleanText(project.name, 120),
      project_slug: cleanText(project.slug, 80),
      phase_name: cleanText(phase.name, 120),
      phase_slug: cleanText(phase.slug, 80),
      template_id: templateId,
      enabled_modules: {
        map: enabledModules.map === true,
        inquiry: enabledModules.inquiry === true,
        application: enabledModules.application === true,
        pricing: enabledModules.pricing === true,
      },
      application_type: projectApplication.application_type === "project_application"
        ? "project_application"
        : "land_purchase",
      public_application: {
        applications_open: effective.applicationsOpen && effective.noticesComplete,
        notices_complete: effective.noticesComplete,
        public_notice_text: effective.publicNoticeText,
        application_acknowledgment_text: effective.acknowledgmentText,
        notice_version: cleanText(projectApplication.notice_version ?? tenantApplication.notice_version, 80),
        intended_uses: textArray(projectApplication.allowed_intended_uses ?? tenantApplication.allowed_intended_uses, 40),
        max_map_preferences: boundedInteger(projectApplication.max_map_preferences ?? tenantApplication.max_map_preferences, 0, 10, 5),
        confirmation_message: cleanText(projectApplication.default_confirmation_message ?? tenantApplication.default_confirmation_message, 500),
      },
    },
  };
}

async function reviewedMap(row: ReviewLink) {
  const scope = await verifyStoredScope(row);
  if (!scope.ok) return { ok: false as const, status: scope.status, error: scope.error };
  const [snapshotResult, featuresResult] = await Promise.all([
    supabase.from("map_feature_snapshots").select("id,snapshot_version,outline_count,snapshot_fingerprint")
      .eq("id", row.snapshot_id).eq("tenant_id", row.tenant_id).eq("project_id", row.project_id).eq("phase_id", row.phase_id).maybeSingle(),
    supabase.from("map_features").select("identity_id,demo_label,map_polygon")
      .eq("tenant_id", row.tenant_id).eq("project_id", row.project_id).eq("phase_id", row.phase_id)
      .eq("snapshot_id", row.snapshot_id).order("demo_label", { ascending: true }),
  ]);
  if (snapshotResult.error || featuresResult.error || !snapshotResult.data) {
    return { ok: false as const, status: 503, error: "The reviewed map could not be loaded." };
  }
  const features = featuresResult.data ?? [];
  if (features.length !== snapshotResult.data.outline_count) {
    return { ok: false as const, status: 409, error: "The reviewed map revision no longer matches its approved outline count." };
  }
  return {
    ok: true as const,
    payload: {
      scope: row.settings_snapshot,
      revision: {
        snapshot_id: row.snapshot_id,
        snapshot_version: snapshotResult.data.snapshot_version,
      },
      canvas: safeCanvas(scope.package.package_data),
      background_available: Boolean(scope.package.background_path),
      features,
    },
  };
}

async function verifyStoredScope(row: ReviewLink) {
  const [tenantResult, phaseResult, packageResult, snapshotResult] = await Promise.all([
    supabase.from("organizations").select("id,is_active").eq("id", row.tenant_id).maybeSingle(),
    supabase.from("development_phases").select("id,is_active").eq("id", row.phase_id).eq("tenant_id", row.tenant_id)
      .eq("project_id", row.project_id).maybeSingle(),
    supabase.from("project_map_packages").select("id,tenant_id,project_id,phase_id,snapshot_id,package_digest,package_data,background_path")
      .eq("id", row.package_id).maybeSingle(),
    supabase.from("map_feature_snapshots").select("id,tenant_id,project_id,phase_id,snapshot_fingerprint")
      .eq("id", row.snapshot_id).maybeSingle(),
  ]);
  if ([tenantResult.error, phaseResult.error, packageResult.error, snapshotResult.error].some(Boolean)) {
    return { ok: false as const, status: 503, error: "The review link scope could not be checked." };
  }
  const tenant = tenantResult.data;
  const phase = phaseResult.data;
  const packageRow = packageResult.data;
  const snapshot = snapshotResult.data;
  if (!tenant?.is_active || !phase?.is_active || !packageRow || !snapshot
      || packageRow.tenant_id !== row.tenant_id || packageRow.project_id !== row.project_id
      || packageRow.phase_id !== row.phase_id || packageRow.snapshot_id !== row.snapshot_id
      || packageRow.package_digest !== row.package_digest
      || snapshot.tenant_id !== row.tenant_id || snapshot.project_id !== row.project_id
      || snapshot.phase_id !== row.phase_id || snapshot.snapshot_fingerprint !== row.snapshot_fingerprint) {
    return { ok: false as const, status: 404, error: "This review link is no longer available." };
  }
  return { ok: true as const, package: packageRow };
}

async function streamReviewedBackground(row: ReviewLink): Promise<Response> {
  const scope = await verifyStoredScope(row);
  if (!scope.ok) return json({ error: scope.error }, scope.status);
  const path = scope.package.background_path;
  if (typeof path !== "string" || path.length < 1) return json({ error: "This reviewed map has no background image." }, 404);
  const { data, error } = await supabase.storage.from("project-map-packages").download(path);
  if (error || !data) return json({ error: "The reviewed map background could not be loaded." }, 503);
  if (data.size < 1 || data.size > 20 * 1024 * 1024) return json({ error: "The reviewed map background is outside the supported size limit." }, 413);
  const mediaType = imageMediaType(path, data.type);
  if (!mediaType) return json({ error: "This reviewed map background format is not supported." }, 415);
  return new Response(data.stream(), { status: 200, headers: { ...corsHeaders, "Content-Type": mediaType } });
}

async function verifiedLink(tokenInput: unknown): Promise<
  | { ok: true; row: ReviewLink }
  | { ok: false; status: number; error: string }
> {
  const token = typeof tokenInput === "string" ? tokenInput : "";
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !asUuid(parts[1]) || !/^\d{10,12}$/.test(parts[2])
      || !/^[A-Za-z0-9_-]{43}$/.test(parts[3])) {
    return { ok: false, status: 404, error: "This review link is invalid." };
  }
  const signedText = `${parts[0]}.${parts[1]}.${parts[2]}`;
  let signature: Uint8Array;
  try {
    signature = decodeBase64Url(parts[3]);
  } catch {
    return { ok: false, status: 404, error: "This review link is invalid." };
  }
  const validSignature = await crypto.subtle.verify(
    "HMAC", await signingKey(), signature, tokenEncoder.encode(signedText),
  ).catch(() => false);
  if (!validSignature) return { ok: false, status: 404, error: "This review link is invalid." };
  const { data, error } = await supabase.from("project_map_review_links").select("*").eq("id", parts[1]).maybeSingle();
  if (error) return { ok: false, status: 503, error: "This review link could not be checked." };
  if (!data) return { ok: false, status: 404, error: "This review link is invalid." };
  const row = data as ReviewLink;
  const storedExpiry = Math.ceil(Date.parse(row.expires_at) / 1000);
  if (row.revoked_at || !Number.isFinite(storedExpiry) || storedExpiry !== Number(parts[2])
      || Date.now() >= Date.parse(row.expires_at) || Date.now() >= Number(parts[2]) * 1000) {
    return { ok: false, status: 410, error: "This review link has expired or been revoked." };
  }
  return { ok: true, row };
}

async function signToken(id: string, expiresAtSeconds: number): Promise<string> {
  const payload = `v1.${id}.${expiresAtSeconds}`;
  const signature = await crypto.subtle.sign("HMAC", await signingKey(), tokenEncoder.encode(payload));
  return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

let keyPromise: Promise<CryptoKey> | null = null;
function signingKey(): Promise<CryptoKey> {
  keyPromise ??= crypto.subtle.importKey(
    "raw", tokenEncoder.encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
  return keyPromise;
}

function safeCanvas(value: unknown) {
  const packageData = objectValue(value);
  const canvas = objectValue(packageData.canvas);
  return {
    width: positiveNumber(canvas.width) ?? 100,
    height: positiveNumber(canvas.height) ?? 100,
    package_revision: cleanRevision(packageData.revision),
  };
}

function imageMediaType(path: string, storedType: string): string | null {
  const lowerPath = path.toLowerCase();
  const allowed = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"]]);
  const extension = [...allowed.keys()].find((value) => lowerPath.endsWith(value));
  if (!extension) return null;
  const expected = allowed.get(extension)!;
  return storedType && storedType !== "application/octet-stream" && storedType !== expected ? null : expected;
}

function settingsByKey(rows: Array<{ key: string; value: unknown }>): Record<string, unknown> {
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function cleanRevision(value: unknown): string | number {
  return typeof value === "string" || typeof value === "number" ? value : "unknown";
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function textArray(value: unknown, maxLength: number): string[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const text = cleanText(item, maxLength);
    return text ? [text] : [];
  }).slice(0, 20) : [];
}

function asUuid(value: unknown): string | null {
  const text = typeof value === "string" ? value : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text) ? text : null;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Malformed signature.");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(`${normalized}=`);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) throw new Error("Non-canonical signature.");
  return bytes;
}

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
