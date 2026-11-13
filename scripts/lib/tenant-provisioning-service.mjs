import { randomUUID } from "node:crypto";

const PRODUCTION_PROJECT_REF = "mtjlvzrtihslcftxnlso";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ALL_PHASES_CONFIRMATION = "all_current_and_future_phases_in_this_project";

export function projectRefFromUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SUPABASE_URL must be a valid Supabase project URL.");
  }
  if (["localhost", "127.0.0.1"].includes(url.hostname)) return "local";
  const match = url.hostname.match(/^([a-z0-9]+)\.supabase\.co$/i);
  if (!match) throw new Error("SUPABASE_URL must identify a Supabase project; custom hosts require a reviewed resolver.");
  return match[1];
}

export function assertTargetIdentity({ supabaseUrl, expectedProjectRef, apply = false }) {
  if (!supabaseUrl) throw new Error("SUPABASE_URL is required for a full provisioning preflight.");
  const actualProjectRef = projectRefFromUrl(supabaseUrl);
  if (actualProjectRef === PRODUCTION_PROJECT_REF) {
    throw new Error("The production Wamule project is blocked by this provisioning utility.");
  }
  if (expectedProjectRef && expectedProjectRef !== actualProjectRef) {
    throw new Error(`Target mismatch: configured project ${actualProjectRef} does not match expected ${expectedProjectRef}. No RPC was called.`);
  }
  if (apply && !expectedProjectRef) {
    throw new Error("--apply requires --expected-project-ref to match the configured backend exactly.");
  }
  return actualProjectRef;
}

function fail(problems) {
  const error = new Error(`Invalid provisioning manifest: ${problems.map((problem) => `${problem.code}${problem.path ? ` at ${problem.path}` : ""}`).join(", ")}`);
  error.code = "INVALID_PROVISIONING_MANIFEST";
  error.problems = problems;
  throw error;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkKeys(value, allowed, path, problems) {
  if (!object(value)) {
    problems.push({ code: "object_required", path });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push({ code: "unknown_field", path: `${path}.${key}` });
  }
}

function validName(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSlug(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

function normalizeManifest(input, { apply = false } = {}) {
  if (!object(input)) return input;
  const normalized = structuredClone(input);
  if (normalized.operation_id === undefined && !apply) normalized.operation_id = randomUUID();
  if (object(normalized.company)) {
    normalized.company.slug = normalizeSlug(normalized.company.slug);
    normalized.company.default_project_slug = normalizeSlug(normalized.company.default_project_slug);
    if (typeof normalized.company.name === "string") normalized.company.name = normalized.company.name.trim();
  }
  if (Array.isArray(normalized.projects)) {
    for (const project of normalized.projects) {
      if (!object(project)) continue;
      project.slug = normalizeSlug(project.slug);
      project.default_phase_slug = normalizeSlug(project.default_phase_slug);
      if (typeof project.name === "string") project.name = project.name.trim();
      if (Array.isArray(project.phases)) {
        for (const phase of project.phases) {
          if (!object(phase)) continue;
          phase.slug = normalizeSlug(phase.slug);
          if (typeof phase.name === "string") phase.name = phase.name.trim();
        }
      }
    }
  }
  if (Array.isArray(normalized.users)) {
    for (const user of normalized.users) {
      if (!object(user) || !Array.isArray(user.memberships)) continue;
      if (typeof user.auth_user_id === "string") user.auth_user_id = user.auth_user_id.toLowerCase();
      if (object(user.identity)) {
        if (typeof user.identity.auth_user_id === "string") user.identity.auth_user_id = user.identity.auth_user_id.toLowerCase();
        if (typeof user.identity.email === "string") user.identity.email = user.identity.email.trim().toLowerCase();
        if (typeof user.identity.full_name === "string") user.identity.full_name = user.identity.full_name.trim();
      }
      for (const membership of user.memberships) {
        if (!object(membership)) continue;
        membership.project_slug = normalizeSlug(membership.project_slug);
        if (Array.isArray(membership.phase_slugs)) membership.phase_slugs = membership.phase_slugs.map(normalizeSlug);
      }
    }
  }
  return normalized;
}

const RESERVATION_KEYS = [
  "default_reservation_expiry_days", "default_deposit_due_days", "default_expected_deposit_amount",
  "require_expiry_date", "require_expected_deposit_amount", "default_reservation_status", "default_deposit_status",
  "prompt_release_alternates_after_deposit_confirmed", "prompt_release_alternates_after_contract_started",
  "show_reservation_explanations",
];
const RESERVATION_STATUS = new Set(["draft", "reserved", "deposit_pending", "deposit_submitted", "deposit_confirmed", "converted_to_application", "converted_to_contract", "expired", "cancelled", "released"]);
const DEPOSIT_STATUS = new Set(["not_requested", "pending", "proof_submitted", "confirmed", "overdue", "waived", "cancelled"]);

export function validateProvisioningManifest(input, options = {}) {
  input = normalizeManifest(input, options);
  const problems = [];
  if (!object(input)) fail([{ code: "object_required", path: "manifest" }]);
  checkKeys(input, ["schema_version", "operation_id", "company", "projects", "users"], "manifest", problems);
  if (input.schema_version !== 1) problems.push({ code: "unsupported_schema_version", path: "schema_version" });
  if ((options.apply && typeof input.operation_id !== "string") || (input.operation_id !== undefined && (typeof input.operation_id !== "string" || !UUID.test(input.operation_id)))) {
    problems.push({ code: "invalid_operation_id", path: "operation_id" });
  }

  checkKeys(input.company, ["slug", "name", "default_project_slug", "settings"], "company", problems);
  if (!SLUG.test(input.company?.slug ?? "")) problems.push({ code: "invalid_slug", path: "company.slug" });
  if (!validName(input.company?.name)) problems.push({ code: "name_required", path: "company.name" });
  if (!SLUG.test(input.company?.default_project_slug ?? "")) problems.push({ code: "invalid_slug", path: "company.default_project_slug" });
  const companySettingsInput = input.company?.settings === undefined ? {} : input.company.settings;
  checkKeys(companySettingsInput, ["company_profile", "reservation_workflow_settings"], "company.settings", problems);
  const companySettings = object(companySettingsInput) ? companySettingsInput : {};
  if (companySettings.company_profile !== undefined && !object(companySettings.company_profile)) {
    problems.push({ code: "object_required", path: "company.settings.company_profile" });
  }
  if (companySettings.reservation_workflow_settings !== undefined) {
    const reservation = companySettings.reservation_workflow_settings;
    if (!object(reservation)) problems.push({ code: "object_required", path: "company.settings.reservation_workflow_settings" });
    else if (Object.hasOwn(reservation, "use_default")) {
      if (reservation.use_default !== true || Object.keys(reservation).length !== 1) {
        problems.push({ code: "invalid_default_selector", path: "company.settings.reservation_workflow_settings" });
      }
    } else {
      checkKeys(reservation, RESERVATION_KEYS, "company.settings.reservation_workflow_settings", problems);
      for (const key of ["default_reservation_expiry_days", "default_deposit_due_days"]) {
        if (Object.hasOwn(reservation, key) && (!Number.isInteger(reservation[key]) || reservation[key] < 0)) {
          problems.push({ code: "invalid_reservation_numeric_setting", path: `company.settings.reservation_workflow_settings.${key}` });
        }
      }
      if (Object.hasOwn(reservation, "default_expected_deposit_amount")
        && reservation.default_expected_deposit_amount !== null
        && (typeof reservation.default_expected_deposit_amount !== "number" || !Number.isFinite(reservation.default_expected_deposit_amount) || reservation.default_expected_deposit_amount < 0)) {
        problems.push({ code: "invalid_reservation_numeric_setting", path: "company.settings.reservation_workflow_settings.default_expected_deposit_amount" });
      }
      for (const key of ["require_expiry_date", "require_expected_deposit_amount", "prompt_release_alternates_after_deposit_confirmed", "prompt_release_alternates_after_contract_started", "show_reservation_explanations"]) {
        if (Object.hasOwn(reservation, key) && typeof reservation[key] !== "boolean") {
          problems.push({ code: "invalid_reservation_boolean_setting", path: `company.settings.reservation_workflow_settings.${key}` });
        }
      }
      if (Object.hasOwn(reservation, "default_reservation_status") && !RESERVATION_STATUS.has(reservation.default_reservation_status)) {
        problems.push({ code: "invalid_reservation_status_setting", path: "company.settings.reservation_workflow_settings.default_reservation_status" });
      }
      if (Object.hasOwn(reservation, "default_deposit_status") && !DEPOSIT_STATUS.has(reservation.default_deposit_status)) {
        problems.push({ code: "invalid_reservation_status_setting", path: "company.settings.reservation_workflow_settings.default_deposit_status" });
      }
    }
  }

  if (!Array.isArray(input.projects) || input.projects.length === 0) {
    problems.push({ code: "projects_required", path: "projects" });
  } else {
    const projectSlugs = new Set();
    for (const [projectIndex, project] of input.projects.entries()) {
      const path = `projects[${projectIndex}]`;
      checkKeys(project, ["slug", "name", "mode", "default_phase_slug", "inventory", "demo_fixture_bundle", "settings", "phases"], path, problems);
      if (!SLUG.test(project?.slug ?? "")) problems.push({ code: "invalid_slug", path: `${path}.slug` });
      if (projectSlugs.has(project?.slug)) problems.push({ code: "duplicate_project_slug", path: `${path}.slug` });
      projectSlugs.add(project?.slug);
      if (!validName(project?.name)) problems.push({ code: "name_required", path: `${path}.name` });
      if (!SLUG.test(project?.default_phase_slug ?? "")) problems.push({ code: "invalid_slug", path: `${path}.default_phase_slug` });
      if (!["sales", "demo"].includes(project?.mode)) problems.push({ code: "mode_required", path: `${path}.mode` });
      if (project?.mode === "sales" && (!object(project.inventory) || project.inventory.seed !== "empty" || Object.keys(project.inventory).length !== 1)) {
        problems.push({ code: "sales_inventory_must_start_empty", path: `${path}.inventory` });
      }
      if (project?.mode === "demo" && !Object.hasOwn(project, "demo_fixture_bundle")) {
        problems.push({ code: "demo_fixture_bundle_required", path: `${path}.demo_fixture_bundle`, accepted: null });
      }
      if (project?.mode === "demo" && project.demo_fixture_bundle !== null) {
        problems.push({ code: "unsupported_demo_fixture", path: `${path}.demo_fixture_bundle`, fixture: project.demo_fixture_bundle ?? null });
      }
      if (project?.mode === "sales" && Object.hasOwn(project, "demo_fixture_bundle")) {
        problems.push({ code: "demo_fixture_not_allowed_for_sales", path: `${path}.demo_fixture_bundle` });
      }
      if (project?.mode === "demo" && Object.hasOwn(project, "inventory")) {
        problems.push({ code: "demo_inventory_not_supported", path: `${path}.inventory` });
      }
      const settingsInput = project?.settings === undefined ? {} : project.settings;
      checkKeys(settingsInput, ["company_profile", "tenant_theme", "public_application"], `${path}.settings`, problems);
      const settings = object(settingsInput) ? settingsInput : {};
      for (const key of ["company_profile", "tenant_theme", "public_application"]) {
        if (settings[key] !== undefined && !object(settings[key])) problems.push({ code: "object_required", path: `${path}.settings.${key}` });
      }
      if (settings.phase_pricing !== undefined || settings.lot_phase !== undefined || settings.phase_inheritance !== undefined) {
        problems.push({ code: "unsupported_phase_pricing_or_inheritance", path: `${path}.settings` });
      }
      const publicApplicationSettings = object(settings.public_application) ? settings.public_application : {};
      for (const key of ["applications_open", "show_lot_prices_publicly", "show_available_lot_count_publicly"]) {
        if (Object.hasOwn(publicApplicationSettings, key) && publicApplicationSettings[key] !== false) {
          problems.push({ code: "new_project_applications_must_start_closed", path: `${path}.settings.public_application.${key}` });
        }
      }
      if (!Array.isArray(project?.phases) || project.phases.length === 0) {
        problems.push({ code: "phases_required", path: `${path}.phases` });
        continue;
      }
      const phaseSlugs = new Set();
      let defaultCount = 0;
      for (const [phaseIndex, phase] of project.phases.entries()) {
        const phasePath = `${path}.phases[${phaseIndex}]`;
        if (!object(phase)) {
          checkKeys(phase, ["slug", "name"], phasePath, problems);
          continue;
        }
        for (const key of Object.keys(phase)) {
          if (["settings", "pricing", "lot_phase", "phase_pricing", "phase_inheritance", "inheritance"].includes(key)) {
            problems.push({ code: "unsupported_phase_pricing_or_inheritance", path: `${phasePath}.${key}` });
          } else if (!["slug", "name"].includes(key)) {
            problems.push({ code: "unknown_field", path: `${phasePath}.${key}` });
          }
        }
        if (!SLUG.test(phase?.slug ?? "")) problems.push({ code: "invalid_slug", path: `${phasePath}.slug` });
        if (phaseSlugs.has(phase?.slug)) problems.push({ code: "duplicate_phase_slug", path: `${phasePath}.slug` });
        phaseSlugs.add(phase?.slug);
        if (!validName(phase?.name)) problems.push({ code: "name_required", path: `${phasePath}.name` });
        if (phase?.slug === project.default_phase_slug) defaultCount += 1;
      }
      if (defaultCount !== 1) problems.push({ code: "invalid_default_phase", path: `${path}.default_phase_slug` });
    }
    if (!projectSlugs.has(input.company?.default_project_slug)) {
      problems.push({ code: "invalid_default_project", path: "company.default_project_slug" });
    }
  }

  if (input.users !== undefined && !Array.isArray(input.users)) problems.push({ code: "array_required", path: "users" });
  const assignedUsers = new Set();
  for (const [userIndex, user] of (Array.isArray(input.users) ? input.users : []).entries()) {
    const path = `users[${userIndex}]`;
    checkKeys(user, ["auth_user_id", "identity", "profile_role", "memberships"], path, problems);
    let identityKey = null;
    if (user?.identity !== undefined) {
      checkKeys(user.identity, ["mode", "auth_user_id", "email", "full_name"], `${path}.identity`, problems);
      if (user.identity?.mode === "existing") {
        if (typeof user.identity.auth_user_id !== "string" || !UUID.test(user.identity.auth_user_id)) problems.push({ code: "invalid_auth_user_id", path: `${path}.identity.auth_user_id` });
        if (Object.hasOwn(user.identity ?? {}, "email")) problems.push({ code: "existing_identity_requires_selected_auth_id", path: `${path}.identity.email` });
        identityKey = user.identity.auth_user_id;
      } else if (user.identity?.mode === "create") {
        if (typeof user.identity.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.identity.email)) problems.push({ code: "invalid_identity_email", path: `${path}.identity.email` });
        if (Object.hasOwn(user.identity ?? {}, "auth_user_id")) problems.push({ code: "new_identity_cannot_select_auth_id", path: `${path}.identity.auth_user_id` });
        if (Object.hasOwn(user.identity ?? {}, "full_name") && typeof user.identity.full_name !== "string") problems.push({ code: "invalid_identity_full_name", path: `${path}.identity.full_name` });
        identityKey = user.identity.email;
      } else {
        problems.push({ code: "identity_mode_required", path: `${path}.identity.mode` });
      }
      if (Object.hasOwn(user ?? {}, "auth_user_id")) problems.push({ code: "use_explicit_identity", path: `${path}.auth_user_id` });
    } else {
      if (typeof user?.auth_user_id !== "string" || !UUID.test(user.auth_user_id)) problems.push({ code: "invalid_auth_user_id", path: `${path}.auth_user_id` });
      identityKey = user?.auth_user_id;
    }
    if (typeof identityKey === "string") {
      identityKey = identityKey.toLowerCase();
      if (assignedUsers.has(identityKey)) problems.push({ code: "duplicate_user_assignment", path: `${path}.identity` });
      assignedUsers.add(identityKey);
    }
    if (!["Staff", "Read Only"].includes(user?.profile_role)) problems.push({ code: "profile_role_not_supported_in_m42", path: `${path}.profile_role` });
    if (!Array.isArray(user?.memberships) || user.memberships.length === 0) {
      problems.push({ code: "memberships_required_for_assignment", path: `${path}.memberships` });
      continue;
    }
    for (const [membershipIndex, membership] of user.memberships.entries()) {
      const memberPath = `${path}.memberships[${membershipIndex}]`;
      checkKeys(membership, ["project_slug", "member_role", "phase_slugs", "all_phases", "confirm_scope"], memberPath, problems);
      const project = input.projects?.find((item) => item?.slug === membership?.project_slug);
      if (!project) problems.push({ code: "membership_project_not_in_manifest", path: `${memberPath}.project_slug` });
      if (!["staff", "read_only"].includes(membership?.member_role)
        || (user?.profile_role === "Read Only" && membership?.member_role !== "read_only")) {
        problems.push({ code: "role_cap_denied", path: `${memberPath}.member_role` });
      }
      const allPhases = membership?.all_phases === true;
      const hasAllPhases = Object.hasOwn(membership ?? {}, "all_phases");
      const hasExactPhases = Object.hasOwn(membership ?? {}, "phase_slugs");
      const exactPhases = Array.isArray(membership?.phase_slugs) && membership.phase_slugs.length > 0;
      if (hasAllPhases === hasExactPhases || (hasAllPhases && !allPhases) || (hasExactPhases && !exactPhases)) {
        problems.push({ code: "invalid_membership_scope", path: memberPath });
      }
      if (!allPhases && Object.hasOwn(membership ?? {}, "confirm_scope")) {
        problems.push({ code: "invalid_membership_confirmation_scope", path: `${memberPath}.confirm_scope` });
      }
      if (allPhases && membership?.confirm_scope !== ALL_PHASES_CONFIRMATION) {
        problems.push({ code: "all_phase_confirmation_required", path: `${memberPath}.confirm_scope` });
      }
      if (exactPhases && project) {
        const phaseSet = new Set(project.phases.map((phase) => phase?.slug));
        const assignedScopes = new Set();
        for (const phaseSlug of membership.phase_slugs) {
          if (!phaseSet.has(phaseSlug)) problems.push({ code: "membership_phase_not_in_project", path: `${memberPath}.phase_slugs`, phase_slug: phaseSlug });
          const scopeKey = `${membership.project_slug}:${phaseSlug}`;
          if (assignedScopes.has(scopeKey)) problems.push({ code: "duplicate_membership_phase", path: `${memberPath}.phase_slugs`, phase_slug: phaseSlug });
          assignedScopes.add(scopeKey);
        }
      }
    }
  }
  if (problems.length) fail(problems);
  return structuredClone(input);
}

export function createTenantProvisioningService({ supabase, supabaseUrl, expectedProjectRef }) {
  const actualProjectRef = assertTargetIdentity({ supabaseUrl, expectedProjectRef });

  async function request(client, functionName, args) {
    const { data, error } = await client.rpc(functionName, args);
    if (error) throw new Error(`Provisioning service failed: ${error.message}`);
    if (!object(data)) throw new Error("Provisioning service returned an invalid result.");
    return data;
  }

  const provisionStructure = (manifest, apply) => request(supabase, "provision_workspace_v1", {
    p_manifest: { ...manifest, users: [] },
    p_apply: apply,
  });

  function resolveMemberships(manifest, workspace) {
    const projectBySlug = new Map((workspace.projects ?? []).map((project) => [project.slug, project]));
    const resolved = [];
    for (const membership of manifest.users[0].memberships) {
      const project = projectBySlug.get(membership.project_slug);
      if (!project?.id) throw new Error(`Applied workspace did not return project ID for ${membership.project_slug}.`);
      if (membership.all_phases === true) {
        resolved.push({ project_id: project.id, phase_id: null, member_role: membership.member_role, all_phases_confirmed: true });
        continue;
      }
      const phaseBySlug = new Map((project.phases ?? []).map((phase) => [phase.slug, phase]));
      for (const phaseSlug of membership.phase_slugs) {
        const phase = phaseBySlug.get(phaseSlug);
        if (!phase?.id) throw new Error(`Applied workspace did not return phase ID for ${membership.project_slug}/${phaseSlug}.`);
        resolved.push({ project_id: project.id, phase_id: phase.id, member_role: membership.member_role, all_phases_confirmed: false });
      }
    }
    return resolved;
  }

  async function verifyOperator(operator, accessToken) {
    if (!operator || typeof accessToken !== "string" || accessToken.length === 0) {
      throw new Error("Workspace user assignment requires SUPABASE_OPERATOR_ACCESS_TOKEN and an authenticated operator client.");
    }
    const { data, error } = await operator.auth.getUser(accessToken);
    if (error || !data?.user?.id) throw new Error("The operator access token could not be verified; no account was created.");
    return data.user;
  }

  async function onboardMember(manifestInput, {
    apply = false,
    operator,
    operatorAccessToken,
    authAdmin,
    onPreflight = () => {},
  } = {}) {
    if (apply) assertTargetIdentity({ supabaseUrl, expectedProjectRef, apply: true });
    const manifest = validateProvisioningManifest(manifestInput, { apply });
    if (!Array.isArray(manifest.users) || manifest.users.length !== 1 || !object(manifest.users[0]?.identity)) {
      throw new Error("M4.3 requires exactly one user with explicit identity.mode 'existing' or 'create'.");
    }
    const identity = manifest.users[0].identity;
    if (!operator) throw new Error("Workspace user assignment requires the authenticated operator client.");
    if (apply && identity.mode === "create" && typeof authAdmin?.createUser !== "function") {
      throw new Error("New-user onboarding requires the server-side Auth Admin createUser adapter.");
    }

    const workspacePreflight = await provisionStructure(manifest, false);
    const actor = await verifyOperator(operator, operatorAccessToken);
    const memberPreflight = await request(operator, "preflight_workspace_member_onboarding_v1", { p_manifest: manifest });
    if (memberPreflight.operator?.id && memberPreflight.operator.id.toLowerCase() !== actor.id.toLowerCase()) {
      throw new Error("The verified operator does not match the database authorization subject.");
    }
    const preflight = {
      status: workspacePreflight.can_apply && memberPreflight.can_apply ? "dry_run" : "blocked",
      can_apply: workspacePreflight.can_apply === true && memberPreflight.can_apply === true,
      writes: 0,
      workspace: workspacePreflight,
      membership: memberPreflight,
      identity: {
        mode: identity.mode,
        selected_existing_user: identity.mode === "existing",
        account_creation_required: identity.mode === "create" && !memberPreflight.identity?.user_id,
        invitation_sent: false,
      },
      readiness: {
        workspace_creation_ready: workspacePreflight.readiness?.workspace_creation ?? workspacePreflight.can_apply,
        membership_ready: memberPreflight.membership_plan?.[0]?.already_assigned === true,
        workspace_access_ready: memberPreflight.membership_plan?.[0]?.already_assigned === true,
        provider_sign_in_ready: false,
        provider_sign_in_status: identity.mode === "create" ? "pending_account_creation" : "not_verified",
        sales_setup_ready: workspacePreflight.readiness?.sales_setup_ready === true,
        map_publication_ready: workspacePreflight.readiness?.map_publication_ready === true,
        domain_ready: workspacePreflight.readiness?.domain_ready === true,
      },
      missing_prerequisites: workspacePreflight.missing_prerequisites ?? [],
      conflicts: [...(workspacePreflight.conflicts ?? []), ...(memberPreflight.conflicts ?? [])],
    };
    onPreflight(preflight);
    if (!apply || !preflight.can_apply) {
      return { applied: false, preflight, result: preflight, auth_effects: { create_user_calls: 0, outbound_messages: 0 } };
    }

    const workspace = await provisionStructure(manifest, true);
    if (!workspace.can_apply || !["applied", "replayed"].includes(workspace.status)) {
      return {
        applied: false, preflight,
        result: { status: "workspace_creation_blocked", workspace, workspace_access_ready: false, provider_sign_in_ready: false },
        auth_effects: { create_user_calls: 0, outbound_messages: 0 },
      };
    }

    let prepared;
    try {
      prepared = await request(supabase, "prepare_workspace_identity_onboarding_v1", { p_manifest: manifest });
    } catch (error) {
      return {
        applied: false, preflight,
        result: { status: "workspace_access_pending", workspace_created: true, auth_status: "not_started",
          workspace_access_ready: false, provider_sign_in_ready: false,
          recovery: "Retry with the same operation_id after the identity ledger is available.",
          error: error instanceof Error ? error.message : String(error) },
        auth_effects: { create_user_calls: 0, outbound_messages: 0 },
      };
    }
    if (prepared.status !== "ready") {
      return { applied: false, preflight, result: { status: "workspace_access_pending", workspace_created: true,
        auth_status: "not_started", workspace_access_ready: false, provider_sign_in_ready: false,
        conflicts: prepared.conflicts ?? [] }, auth_effects: { create_user_calls: 0, outbound_messages: 0 } };
    }

    let authUserId = prepared.auth_user_id;
    let createUserCalls = 0;
    if (identity.mode === "create" && !authUserId) {
      createUserCalls += 1;
      let createResponse;
      try {
        createResponse = await authAdmin.createUser({
          email: identity.email,
          email_confirm: false,
          user_metadata: identity.full_name ? { full_name: identity.full_name } : {},
          app_metadata: { wamule_workspace_onboarding: { operation_id: manifest.operation_id, payload_hash: prepared.payload_hash } },
        });
      } catch (error) {
        createResponse = { error };
      }
      const createdUser = createResponse?.data?.user ?? createResponse?.user;
      if (createResponse?.error || !createdUser?.id) {
        try {
          prepared = await request(supabase, "prepare_workspace_identity_onboarding_v1", { p_manifest: manifest });
          authUserId = prepared.auth_user_id;
        } catch {
          authUserId = null;
        }
        if (!authUserId) {
          const reason = createResponse?.error?.message ?? "Auth createUser returned no identity.";
          return {
            applied: false, preflight,
            result: { status: "auth_creation_pending", workspace_created: true, auth_status: "not_created_or_response_unknown",
              auth_user_id: null, workspace_access_ready: false, provider_sign_in_ready: false,
              recovery: "Retry with the same operation_id. A matching Auth marker will be recovered; an unrelated same-email account will not be adopted.",
              error: reason },
            auth_effects: { create_user_calls: createUserCalls, outbound_messages: 0 },
          };
        }
      } else {
        authUserId = createdUser.id;
      }
      if (authUserId && prepared.auth_user_id !== authUserId) {
        try {
          prepared = await request(supabase, "record_workspace_identity_onboarding_v1", { p_manifest: manifest, p_auth_user_id: authUserId });
        } catch {
          try { prepared = await request(supabase, "prepare_workspace_identity_onboarding_v1", { p_manifest: manifest }); }
          catch { prepared = { status: "blocked" }; }
        }
        if (prepared.status !== "ready" || prepared.auth_user_id !== authUserId) {
          return {
            applied: false, preflight,
            result: { status: "workspace_access_pending", workspace_created: true, auth_status: "created", auth_user_id: authUserId,
              identity_source: "created_by_operation", workspace_access_ready: false, provider_sign_in_ready: false,
              recovery: "Retry the same operation_id; the protected Auth app_metadata marker identifies this account." },
            auth_effects: { create_user_calls: createUserCalls, outbound_messages: 0 },
          };
        }
      }
    }
    if (!authUserId) authUserId = prepared.auth_user_id;
    if (!authUserId) {
      return { applied: false, preflight, result: { status: "workspace_access_pending", workspace_created: true,
        auth_status: "unresolved", workspace_access_ready: false, provider_sign_in_ready: false },
      auth_effects: { create_user_calls: createUserCalls, outbound_messages: 0 } };
    }

    let assigned;
    try {
      assigned = await request(operator, "assign_workspace_member_onboarding_v1", {
        p_manifest: manifest,
        p_auth_user_id: authUserId,
        p_tenant_id: workspace.company.id,
        p_resolved_memberships: resolveMemberships(manifest, workspace),
      });
    } catch (error) {
      return {
        applied: false, preflight,
        result: { status: "workspace_access_pending", workspace_created: true,
          auth_status: identity.mode === "create" ? "created_by_operation" : "explicit_existing",
          auth_user_id: authUserId, identity_source: identity.mode === "create" ? "created_by_operation" : "explicit_existing",
          workspace_access_ready: false, provider_sign_in_ready: false,
          recovery: "Retry with the same operation_id and identity selection; the Auth identity is already recorded.",
          error: error instanceof Error ? error.message : String(error) },
        auth_effects: { create_user_calls: createUserCalls, outbound_messages: 0 },
      };
    }
    if (!['assigned', 'replayed'].includes(assigned.status)) {
      return {
        applied: false, preflight,
        result: { status: "workspace_access_pending", workspace_created: true, auth_user_id: authUserId,
          identity_source: identity.mode === "create" ? "created_by_operation" : "explicit_existing",
          workspace_access_ready: false, provider_sign_in_ready: false,
          conflicts: assigned.conflicts ?? [], recovery: "Retry only after resolving the reported membership conflict." },
        auth_effects: { create_user_calls: createUserCalls, outbound_messages: 0 },
      };
    }
    return {
      applied: true, preflight,
      result: {
        ...assigned,
        workspace: { company: workspace.company, projects: workspace.projects },
        readiness: {
          workspace_creation_ready: true,
          membership_ready: true,
          workspace_access_ready: true,
          provider_sign_in_ready: false,
          provider_sign_in_status: identity.mode === "create" ? "pending_email_confirmation" : "not_verified",
          sales_setup_ready: workspace.readiness?.sales_setup_ready === true,
          map_publication_ready: workspace.readiness?.map_publication_ready === true,
          domain_ready: workspace.readiness?.domain_ready === true,
          public_blockers: workspace.readiness?.public_blockers ?? [],
        },
      },
      auth_effects: { create_user_calls: createUserCalls, outbound_messages: 0 },
    };
  }

  return {
    actualProjectRef,
    async run(manifestInput, { apply = false, onPreflight = () => {} } = {}) {
      if (apply) assertTargetIdentity({ supabaseUrl, expectedProjectRef, apply: true });
      const manifest = validateProvisioningManifest(manifestInput, { apply });
      if (Array.isArray(manifest.users) && manifest.users.length > 0) {
        throw new Error("User assignments must use onboardMember so the M3.4 authorization and Auth recovery path runs.");
      }
      const preflight = await provisionStructure(manifest, false);
      onPreflight(preflight);
      if (!apply || preflight.can_apply !== true) {
        return { preflight, result: preflight, applied: false };
      }
      const result = await provisionStructure(manifest, true);
      return { preflight, result, applied: result.status === "applied" || result.status === "replayed" };
    },
    onboardMember,
  };
}

export { ALL_PHASES_CONFIRMATION, PRODUCTION_PROJECT_REF };
