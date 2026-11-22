export const FIXTURE_IDS = Object.freeze({
  tenant: "11111111-1111-4111-8111-111111111111",
  otherTenant: "22222222-2222-4222-8222-222222222222",
  project: "33333333-3333-4333-8333-333333333333",
  secondProject: "44444444-4444-4444-8444-444444444444",
  otherProject: "55555555-5555-4555-8555-555555555555",
  phase: "66666666-6666-4666-8666-666666666666",
  secondPhase: "77777777-7777-4777-8777-777777777777",
  inactivePhase: "88888888-8888-4888-8888-888888888888",
  otherPhase: "99999999-9999-4999-8999-999999999999",
  snapshot: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  secondSnapshot: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  otherSnapshot: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  feature: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  secondFeature: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  otherFeature: "ffffffff-ffff-4fff-8fff-ffffffffffff",
});

let previousGlobals;

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function createPublicIntakeFixture(options = {}) {
  const ids = FIXTURE_IDS;
  const applicationType = options.applicationType ?? "land_purchase";
  const companySettings = (tenantId) => ({
    applications_open: options.companyOpen !== false,
    public_notice_text: "Company public notice",
    application_acknowledgment_text: "Company acknowledgment",
  });
  const projectApp = (projectId, phaseIds = [ids.phase, ids.secondPhase]) => ({
    applications_open: options.projectOpen !== false,
    application_type: applicationType,
    allowed_phase_ids: options.disallowedPhase ? [ids.phase] : phaseIds,
    public_notice_text: options.missingNotice ? "" : "Project public notice",
    application_acknowledgment_text: "Project acknowledgment",
    notice_version: applicationType === "project_application" ? "notice-v1" : undefined,
    allowed_intended_uses: applicationType === "project_application" ? ["Residential", "Commercial"] : undefined,
    max_map_preferences: 5,
    default_confirmation_message: "Received for review.",
  });
  const scope = (tenantId, projectId, phaseId) => ({ tenant_id: tenantId, project_id: projectId, phase_id: phaseId });
  const db = {
    organizations: [
      { id: ids.tenant, slug: "example", inbound_alias: "sample", is_active: true, name: "Example" },
      { id: ids.otherTenant, slug: "other", inbound_alias: null, is_active: true, name: "Other" },
      { id: uuid(5), slug: "inactive", inbound_alias: null, is_active: false, name: "Inactive" },
    ],
    projects: [
      { id: ids.project, tenant_id: ids.tenant, slug: "project", name: "Project", is_default: true, map_experience_mode: "sales" },
      { id: ids.secondProject, tenant_id: ids.tenant, slug: "second-project", name: "Second Project", is_default: false, map_experience_mode: "sales" },
      { id: ids.otherProject, tenant_id: ids.otherTenant, slug: "other-project", name: "Other Project", is_default: true, map_experience_mode: "sales" },
    ],
    development_phases: [
      { id: ids.phase, tenant_id: ids.tenant, project_id: ids.project, slug: "initial", name: "Initial", is_default: true, is_active: true },
      { id: ids.secondPhase, tenant_id: ids.tenant, project_id: ids.project, slug: "second", name: "Second", is_default: false, is_active: true },
      { id: ids.inactivePhase, tenant_id: ids.tenant, project_id: ids.project, slug: "inactive", name: "Inactive", is_default: false, is_active: false },
      { id: uuid(4), tenant_id: ids.tenant, project_id: ids.secondProject, slug: "initial", name: "Initial", is_default: true, is_active: true },
      { id: ids.otherPhase, tenant_id: ids.otherTenant, project_id: ids.otherProject, slug: "other-initial", name: "Other Initial", is_default: true, is_active: true },
    ],
    business_settings: [
      { tenant_id: ids.tenant, key: "public_application", value: companySettings(ids.tenant) },
      { tenant_id: ids.otherTenant, key: "public_application", value: companySettings(ids.otherTenant) },
    ],
    project_settings: [
      { tenant_id: ids.tenant, project_id: ids.project, key: "public_application", value: projectApp(ids.project) },
      { tenant_id: ids.tenant, project_id: ids.secondProject, key: "public_application", value: projectApp(ids.secondProject) },
      { tenant_id: ids.otherTenant, project_id: ids.otherProject, key: "public_application", value: projectApp(ids.otherProject, [ids.otherPhase]) },
      { tenant_id: ids.tenant, project_id: ids.project, key: "company_profile", value: { company_name: "Example Company" } },
    ],
    map_feature_snapshots: options.unpublished ? [] : [
      { ...scope(ids.tenant, ids.project, ids.phase), id: ids.snapshot, is_active: true },
      { ...scope(ids.tenant, ids.project, ids.secondPhase), id: ids.secondSnapshot, is_active: true },
      { ...scope(ids.otherTenant, ids.otherProject, ids.otherPhase), id: ids.otherSnapshot, is_active: true },
    ],
    project_map_packages: options.unpublishedPackage ? [] : [
      { ...scope(ids.tenant, ids.project, ids.phase), id: uuid(20), snapshot_id: ids.snapshot, published_at: "2026-01-01" },
      { ...scope(ids.tenant, ids.project, ids.secondPhase), id: uuid(21), snapshot_id: ids.secondSnapshot, published_at: "2026-01-01" },
      { ...scope(ids.otherTenant, ids.otherProject, ids.otherPhase), id: uuid(22), snapshot_id: ids.otherSnapshot, published_at: "2026-01-01" },
    ],
    map_features: [
      { ...scope(ids.tenant, ids.project, ids.phase), snapshot_id: ids.snapshot, identity_id: ids.feature, is_active: options.inactiveOutline !== true, public_visible: true },
      { ...scope(ids.tenant, ids.project, ids.secondPhase), snapshot_id: ids.secondSnapshot, identity_id: ids.secondFeature, is_active: true, public_visible: true },
      { ...scope(ids.otherTenant, ids.otherProject, ids.otherPhase), snapshot_id: ids.otherSnapshot, identity_id: ids.otherFeature, is_active: true, public_visible: true },
    ],
    project_plot_content: [
      { ...scope(ids.tenant, ids.project, ids.phase), identity_id: ids.feature, parcel_id: 42, public_visible: options.hiddenLot !== true },
      { ...scope(ids.tenant, ids.project, ids.secondPhase), identity_id: ids.secondFeature, parcel_id: 43, public_visible: true },
      { ...scope(ids.otherTenant, ids.otherProject, ids.otherPhase), identity_id: ids.otherFeature, parcel_id: 84, public_visible: true },
    ],
    masterplan_versions: [],
    parcels: [
      { ...scope(ids.tenant, ids.project, ids.phase), id: 42, lot_number: "42", dimensions: "50 x 100", base_price: 10000, status: options.lotStatus ?? "Available", needs_review: false, masterplan_version_id: null },
      { ...scope(ids.tenant, ids.project, ids.secondPhase), id: 43, lot_number: "43", dimensions: "50 x 100", base_price: 11000, status: "Available", needs_review: false, masterplan_version_id: null },
      { ...scope(ids.otherTenant, ids.otherProject, ids.otherPhase), id: 84, lot_number: "84", dimensions: "50 x 100", base_price: 12000, status: "Available", needs_review: false, masterplan_version_id: null },
    ],
    applications: [], leads: [], lead_activities: [], follow_up_tasks: [],
  };
  if (options.inactivePhaseTest) db.development_phases.find((row) => row.id === ids.secondPhase).is_active = false;

  const hostBindings = {
    "example.test": { tenant_slug: "example", project_slug: "project", phase_slug: "initial" },
    "other.example.test": { tenant_slug: "example", project_slug: "project", phase_slug: "initial" },
    "second.example.test": { tenant_slug: "example", project_slug: "second-project", phase_slug: "initial" },
    "phase2.example.test": { tenant_slug: "example", project_slug: "project", phase_slug: "second" },
    "other.test": { tenant_slug: "other", project_slug: "other-project", phase_slug: "other-initial" },
  };
  const s = {
    env: {
      SUPABASE_URL: "https://supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "test-role",
      SUPPRESS_OUTBOUND_EMAILS: "true",
      TURNSTILE_SECRET_KEY: "test-turnstile-secret",
      RESEND_API_KEY: "test-resend-key",
      EMAIL_FROM_ADDRESS: "test@example.test",
      WAMULE_LEGACY_INQUIRY_TENANT_SLUG: "example",
      WAMULE_LEGACY_INQUIRY_PROJECT_SLUG: "project",
      WAMULE_LEGACY_INQUIRY_PHASE_SLUG: "initial",
      ...options.env,
    },
    options, db, calls: [], writes: [], sends: [], botChecks: [], quotaReservations: [], events: [], queries: [], logs: [], inquiries: new Map(), handler: null,
  };

  class Query {
    constructor(table) { this.table = table; this.filters = []; this.pendingInsert = null; this.limitValue = null; s.queries.push(table); }
    select() { return this; }
    eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
    in(key, values) { this.filters.push((row) => values.includes(row[key])); return this; }
    is(key, value) { this.filters.push((row) => (row[key] ?? null) === value); return this; }
    not(key, operator, value) { if (operator === "is") this.filters.push((row) => (row[key] ?? null) !== value); return this; }
    or() { return this; }
    order() { return this; }
    limit(value) { this.limitValue = value; return this.resolve(); }
    insert(row) { this.pendingInsert = row; return this; }
    resolve() {
      let data = (db[this.table] ?? []).filter((row) => this.filters.every((filter) => filter(row)));
      if (this.limitValue !== null) data = data.slice(0, this.limitValue);
      return { data, error: null };
    }
    commitInsert() {
      if (!this.pendingInsert) return this.resolve();
      if (this.table === "applications" && this.pendingInsert.submission_reference
        && db.applications.some((row) => row.tenant_id === this.pendingInsert.tenant_id
          && row.submission_reference === this.pendingInsert.submission_reference)) {
        return { data: null, error: { code: "23505", message: "duplicate submission reference" } };
      }
      const row = { id: db[this.table].length + 1, ...this.pendingInsert };
      db[this.table].push(row); s.writes.push({ table: this.table, row });
      return { data: row, error: null };
    }
    async maybeSingle() { const { data, error } = this.resolve(); return { data: data[0] ?? null, error }; }
    async single() { return this.commitInsert(); }
    then(resolve, reject) { return Promise.resolve(this.pendingInsert ? this.commitInsert() : this.resolve()).then(resolve, reject); }
  }

  s.client = {
    from(table) { return new Query(table); },
    async rpc(name, args) {
      s.calls.push({ name, args }); s.events.push(name);
      if (name === "resolve_public_hostname") {
        const host = String(args.p_hostname).toLowerCase();
        return hostBindings[host]
          ? { data: [{ resolution: "resolved", reason: null, ...hostBindings[host] }], error: null }
          : { data: [{ resolution: "unresolved", reason: "unknown_host", tenant_slug: null, project_slug: null, phase_slug: null }], error: null };
      }
      if (name === "reserve_inquiry_confirmation_quota") {
        s.quotaReservations.push(args);
        return { data: options.quotaAllowed !== false, error: null };
      }
      if (name === "create_scoped_public_inquiry") {
        options.beforeInquiryPersist?.(args, db, hostBindings);
        if (args.p_hostname) {
          const binding = hostBindings[args.p_hostname];
          const tenant = db.organizations.find((row) => row.id === args.p_tenant_id && row.is_active);
          const project = db.projects.find((row) => row.id === args.p_project_id && row.tenant_id === args.p_tenant_id);
          const phase = db.development_phases.find((row) => row.id === args.p_phase_id
            && row.tenant_id === args.p_tenant_id && row.project_id === args.p_project_id && row.is_active);
          if (!binding || binding.tenant_slug !== tenant?.slug || binding.project_slug !== project?.slug
            || binding.phase_slug !== phase?.slug) {
            return { data: null, error: { message: "verified hostname scope changed before persistence" } };
          }
        }
        const existing = s.inquiries.get(args.p_client_reference_id);
        if (existing) {
          if (existing.p_submission_fingerprint !== args.p_submission_fingerprint) return { data: { ok: false, conflict: true }, error: null };
          return { data: { ok: true, deduplicated: true, lead_id: existing.lead_id, follow_up_created: true, unverified_lot: existing.unverified_lot }, error: null };
        }
        let parcelId = args.p_parcel_id;
        let unverifiedLotReference = null;
        if (parcelId !== null && parcelId !== undefined) {
          const parcel = db.parcels.find((row) => row.id === parcelId);
          const publicParcel = parcel && parcel.tenant_id === args.p_tenant_id
            && parcel.project_id === args.p_project_id && parcel.phase_id === args.p_phase_id
            && parcel.needs_review === false && ["Available", "Reserved"].includes(parcel.status)
            && (parcel.masterplan_version_id === null || db.masterplan_versions.some((version) =>
              version.id === parcel.masterplan_version_id && version.tenant_id === args.p_tenant_id
              && version.project_id === args.p_project_id && version.phase_id === args.p_phase_id && version.is_active))
            && db.map_feature_snapshots.some((snapshot) => snapshot.tenant_id === args.p_tenant_id
              && snapshot.project_id === args.p_project_id && snapshot.phase_id === args.p_phase_id && snapshot.is_active
              && db.project_map_packages.some((pkg) => pkg.tenant_id === args.p_tenant_id
                && pkg.project_id === args.p_project_id && pkg.phase_id === args.p_phase_id
                && pkg.snapshot_id === snapshot.id && pkg.published_at)
              && db.map_features.some((feature) => feature.tenant_id === args.p_tenant_id
                && feature.project_id === args.p_project_id && feature.phase_id === args.p_phase_id
                && feature.snapshot_id === snapshot.id && feature.is_active && feature.public_visible
                && db.project_plot_content.some((content) => content.identity_id === feature.identity_id
                  && content.tenant_id === args.p_tenant_id && content.project_id === args.p_project_id
                  && content.phase_id === args.p_phase_id && content.public_visible && content.parcel_id === parcelId)));
          if (!publicParcel) {
            parcelId = null;
            unverifiedLotReference = args.p_unverified_lot_reference ?? "[unavailable]";
          }
        } else if (args.p_unverified_lot_reference) {
          unverifiedLotReference = args.p_unverified_lot_reference;
        }
        const leadId = uuid(100 + s.inquiries.size);
        const record = { ...args, p_parcel_id: parcelId, unverified_lot: Boolean(unverifiedLotReference), lead_id: leadId };
        s.inquiries.set(args.p_client_reference_id, record);
        db.leads.push({ id: leadId, tenant_id: args.p_tenant_id, project_id: args.p_project_id, phase_id: args.p_phase_id, parcel_id: parcelId, notes: unverifiedLotReference ? `Unverified buyer-supplied lot reference: ${unverifiedLotReference} (unverified).` : null, client_reference_id: args.p_client_reference_id });
        db.lead_activities.push({ lead_id: leadId, activity_type: "note", description: unverifiedLotReference ? `Unverified buyer-supplied lot reference: ${unverifiedLotReference} (unverified).` : null, metadata: { source: "public_inquiry", submission_fingerprint: args.p_submission_fingerprint, unverified_lot_reference: unverifiedLotReference } });
        db.follow_up_tasks.push({ lead_id: leadId, status: "open", description: unverifiedLotReference ? "Contact the buyer and follow up with currently available options; the submitted lot reference is unverified." : "Contact the buyer about their public project information request and answer their questions." });
        s.writes.push({ table: "leads", row: record }, { table: "lead_activities", row: db.lead_activities.at(-1) }, { table: "follow_up_tasks", row: db.follow_up_tasks.at(-1) });
        return { data: { ok: true, deduplicated: false, lead_id: leadId, follow_up_created: true, unverified_lot: Boolean(unverifiedLotReference) }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  return s;
}

export async function installEdgeHandler(s, file) {
  const { build } = await import("esbuild");
  const { readFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const absolutePath = fileURLToPath(new URL(file, import.meta.url));
  if (!previousGlobals) previousGlobals = {
    Deno: globalThis.Deno,
    fetch: globalThis.fetch,
    consoleInfo: console.info,
    crypto: Object.getOwnPropertyDescriptor(globalThis, "crypto"),
  };
  const sourceDirectory = dirname(absolutePath);
  let source = await readFile(absolutePath, "utf8");
  source = source.replace('import { createClient } from "https://esm.sh/@supabase/supabase-js@2";', "const createClient = () => globalThis.__publicIntakeTestClient;");
  if (source.includes('import { createClient } from "https://esm.sh/@supabase/supabase-js@2";')) throw new Error("failed to install synthetic Supabase client");
  const bundled = await build({ stdin: { contents: source, resolveDir: sourceDirectory, loader: "ts" }, bundle: true, write: false, platform: "neutral", format: "esm" });
  globalThis.__publicIntakeTestClient = s.client;
  globalThis.Deno = { env: { get: (key) => s.env[key] }, serve: (handler) => { s.handler = handler; } };
  globalThis.fetch = async (...args) => {
    const requestUrl = args[0] instanceof Request ? args[0].url : String(args[0]);
    const init = args[1] ?? {};
    if (requestUrl === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      if (s.options.turnstileFetchError) throw new Error("synthetic Turnstile network failure");
      const form = new URLSearchParams(init.body);
      s.botChecks.push({ hasSecret: form.has("secret"), hasResponse: form.has("response"), idempotencyKey: form.get("idempotency_key") });
      const configured = typeof s.options.turnstileResponse === "function"
        ? s.options.turnstileResponse(s)
        : s.options.turnstileResponse;
      const data = configured ?? { success: true, hostname: s.requestHostname ?? "example.test", action: "public_inquiry" };
      const status = s.options.turnstileResponseStatus ?? 200;
      return new Response(JSON.stringify(data), { status });
    }
    if (requestUrl === "https://api.resend.com/emails") {
      s.sends.push({ url: requestUrl, body: JSON.parse(init.body) });
      if (s.options.resendFetchError) throw new Error("synthetic provider network failure");
      return new Response(JSON.stringify(s.options.resendResponseBody ?? {}), { status: s.options.resendResponseStatus ?? 200 });
    }
    throw new Error(`Unexpected fetch target ${requestUrl}`);
  };
  console.info = (...args) => { s.logs.push(args.map(String).join(" ")); };
  if (!globalThis.crypto) {
    const { webcrypto } = await import("node:crypto");
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  }
  await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}#${Math.random()}`);
}

export function cleanupEdgeHandler() {
  if (previousGlobals) {
    if (previousGlobals.Deno === undefined) delete globalThis.Deno;
    else globalThis.Deno = previousGlobals.Deno;
    if (previousGlobals.fetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousGlobals.fetch;
    console.info = previousGlobals.consoleInfo;
    if (previousGlobals.crypto) Object.defineProperty(globalThis, "crypto", previousGlobals.crypto);
    else delete globalThis.crypto;
    previousGlobals = undefined;
  }
  delete globalThis.__publicIntakeTestClient;
  delete globalThis.Deno;
}
