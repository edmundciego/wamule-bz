import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

// Live staging config: explicit env first, local .env.staging fallback.
// Absent in CI -> live tests skip instead of failing.
function loadStagingConfig() {
  const fromEnv = {
    url: process.env.STAGING_SUPABASE_URL,
    anonKey: process.env.STAGING_ANON_KEY,
    dbPassword: process.env.STAGING_DB_PASSWORD,
    site: process.env.STAGING_SITE_URL,
  };
  const stagingFile = new URL(".env.staging", root);
  let fileVars = {};
  if (existsSync(stagingFile)) {
    fileVars = Object.fromEntries(
      readFileSync(stagingFile, "utf8")
        .split("\n")
        .map((line) => line.split(/=(.*)/s))
        .filter(([key, value]) => key && value !== undefined && !key.startsWith("#"))
        .map(([key, value]) => [key.trim(), value.trim()]),
    );
  }
  const poolerFile = new URL("supabase/.temp/pooler-url", root);
  const poolerUrl = existsSync(poolerFile) ? readFileSync(poolerFile, "utf8").trim() : null;
  const config = {
    url: fromEnv.url ?? fileVars.VITE_SUPABASE_URL,
    anonKey: fromEnv.anonKey ?? fileVars.VITE_SUPABASE_ANON_KEY,
    dbPassword: fromEnv.dbPassword ?? fileVars.SUPABASE_DB_PASSWORD,
    poolerUrl,
    site: fromEnv.site ?? "https://wamule-staging.netlify.app",
    tenantSlug: "wamule",
    expectedTenantId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  };
  if (!config.url || !config.anonKey || !config.dbPassword || !config.poolerUrl) return null;
  try {
    execFileSync("python3", ["-c", "import psycopg"], { stdio: "ignore" });
  } catch {
    return null;
  }
  return config;
}

const staging = loadStagingConfig();
// The roundtrip test writes to staging. Never run any live check as a side
// effect of the default `npm test`; require an explicit operator opt-in.
const LIVE = Boolean(staging) && process.env.WAMULE_RUN_LIVE_E2E === "1";
const stagingTurnstileTokens = (process.env.STAGING_TURNSTILE_TEST_TOKENS ?? "")
  .split(",").map((token) => token.trim()).filter(Boolean);
const stagingInquiryEmail = process.env.STAGING_CONTROLLED_INQUIRY_EMAIL?.trim() ?? "";
const LIVE_INQUIRY = LIVE && stagingTurnstileTokens.length >= 6 && Boolean(stagingInquiryEmail);
const skipReason = staging
  ? "live staging checks are opt-in (set WAMULE_RUN_LIVE_E2E=1 deliberately)"
  : "live staging env (URL, anon key, DB password, psycopg) not available";
const inquirySkipReason = LIVE
  ? "live inquiry test also requires six fresh Turnstile tokens and STAGING_CONTROLLED_INQUIRY_EMAIL"
  : skipReason;

function functionsUrl(path) {
  return `${staging.url.replace(/\/$/, "")}/functions/v1/${path}`;
}

function anonHeaders() {
  return { apikey: staging.anonKey, Authorization: `Bearer ${staging.anonKey}` };
}

function sha256(value) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

/** Direct-DB read via pooler (staging only). Never logs credentials. */
function dbRows(sql, params = []) {
  const script = [
    "import json, sys, psycopg",
    "pooler = sys.argv[1]",
    "pw = sys.argv[2]",
    "sql = sys.argv[3]",
    "params = json.loads(sys.argv[4])",
    "user, _, host = pooler.replace('postgresql://', '').partition('@')",
    "with psycopg.connect(f'postgresql://{user}:{pw}@{host}?sslmode=require', autocommit=True) as conn:",
    "    with conn.cursor() as cur:",
    "        cur.execute(sql, params)",
    "        rows = cur.fetchall() if cur.description else []",
    "    print(json.dumps(rows, default=str))",
  ].join("\n");
  const output = execFileSync(
    "python3",
    ["-c", script, staging.poolerUrl, staging.dbPassword, sql, JSON.stringify(params)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(output);
}

function cleanupLeadIds(ids) {
  for (const id of ids) {
    dbRows("delete from public.follow_up_tasks where lead_id = %s", [id]);
    dbRows("delete from public.lead_activities where lead_id = %s", [id]);
    dbRows("delete from public.leads where id = %s", [id]);
  }
}

test("e2e payload contract matches the inquiry function", async () => {
  // Guards spec-vs-API drift: the function validates via the shared contract
  // module, whose keys are covered by test/inquiry-contract.test.mjs.
  const source = read("supabase/functions/submit-public-inquiry/index.ts");
  assert.ok(source.includes("../_shared/inquiry-contract.ts"), "function must use the shared inquiry contract");
  assert.ok(source.includes("validateInquiryPayload"), "function must validate via the shared schema");
  const contract = read("supabase/functions/_shared/inquiry-contract.ts");
  for (const key of ["name?: unknown", "specific_lot_ref?: unknown", "tenant?: unknown"]) {
    assert.ok(contract.includes(key), `shared contract must declare ${key}`);
  }
});

test("public lots endpoint returns tenant availability with open CORS", { skip: !LIVE && skipReason }, async () => {
  const response = await fetch(`${functionsUrl("get-public-lots")}?tenant=${staging.tenantSlug}`, {
    headers: anonHeaders(),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const body = await response.json();
  assert.ok(body.tenant?.name, "tenant.name present");
  assert.ok("masterplan_image_url" in body, "masterplan_image_url key present");
  assert.ok(Array.isArray(body.parcels) && body.parcels.length > 0, "parcels array non-empty");
  for (const parcel of body.parcels) {
    assert.ok(Array.isArray(parcel.map_polygon), `parcel ${parcel.lot_number} map_polygon is an array`);
    assert.ok(typeof parcel.price === "number", "price is numeric");
    assert.ok(!("id" in parcel), "public parcel payload must not expose its database id");
  }
});

test("embed page serves without auth redirects", { skip: !LIVE && skipReason }, async () => {
  const response = await fetch(`${staging.site.replace(/\/$/, "")}/embed/${staging.tenantSlug}`, {
    redirect: "manual",
  });
  assert.ok([200].includes(response.status), `embed page HTTP ${response.status}`);
  const html = await response.text();
  assert.ok(html.includes('id="root"'), "SPA mount point served (no login redirect)");
});

test("live inquiry roundtrip sends one confirmation and lands in the tenant pipeline", { skip: !LIVE_INQUIRY && inquirySkipReason }, async (t) => {
  const referenceId = randomUUID();
  const legacyEmail = `legacy-${randomUUID()}@example.test`;
  const outsideEmail = `outside-${randomUUID()}@example.test`;
  const b1LegacyEmail = `lead-limit-${randomUUID()}@example.test`;
  const outsideReferenceId = randomUUID();
  const b1DeniedReferenceId = randomUUID();
  const email = stagingInquiryEmail;
  // Cleanup is limited to the unique rows this opted-in test may create.
  t.after(() => {
    const ids = dbRows("select id from public.leads where client_reference_id = any(%s) or email = any(%s)",
      [[referenceId, outsideReferenceId, b1DeniedReferenceId], [legacyEmail, outsideEmail, b1LegacyEmail]]).map(([id]) => id);
    cleanupLeadIds(ids);
  });

  const lotsResponse = await fetch(`${functionsUrl("get-public-lots")}?tenant=${staging.tenantSlug}`, {
    headers: anonHeaders(),
  });
  assert.equal(lotsResponse.status, 200);
  const lots = await lotsResponse.json();
  // Regression guard: prefer a real published lot number (L-001 style).
  // The legacy two-digit view used to 400 every genuine inquiry.
  const available = lots.parcels.find((parcel) => parcel.status === "Available" && parcel.public_ref);
  assert.ok(available, "staging has an Available lot with a public reference to inquire about");

  const targetProject = dbRows(`select p.id from public.projects p
    join public.organizations o on o.id=p.tenant_id
    join public.development_phases ph on ph.project_id=p.id and ph.tenant_id=p.tenant_id
    where o.slug='wamule' and p.slug='wamule' and ph.slug='default' and ph.is_active`);
  assert.equal(targetProject.length, 1, "the Wamule default phase resolves to one project");
  const projectId = targetProject[0][0];
  const originalLeadLimit = dbRows("select max_leads, rolling_window::text from public.project_public_inquiry_limits where project_id=%s", [projectId]);
  assert.equal(originalLeadLimit.length, 1, "the staging project has its configured B1 allowance");
  assert.equal(originalLeadLimit[0][0], 100, "the staging project uses the approved B1 cap");
  assert.equal(originalLeadLimit[0][1], "24:00:00", "the staging project uses a rolling 24-hour B1 window");
  const restoreLeadLimit = () => dbRows(`update public.project_public_inquiry_limits
    set max_leads=%s, rolling_window=%s::interval, updated_at=clock_timestamp() where project_id=%s`,
  [originalLeadLimit[0][0], originalLeadLimit[0][1], projectId]);
  t.after(restoreLeadLimit);
  const baselineProjectLeads = Number(dbRows(`select count(*) from public.leads where project_id=%s
    and source='public_inquiry' and created_at > now() - interval '24 hours'`, [projectId])[0][0]);

  // The recipient address is outside the staging code allowlist. Its lead and
  // follow-up are saved, but no email quota row or Resend send is created.
  const outside = await fetch(functionsUrl("submit-public-inquiry"), {
    method: "POST",
    headers: { ...anonHeaders(), "Content-Type": "application/json", Origin: staging.site },
    body: JSON.stringify({
      name: "Outside Allowlist Tester", email: outsideEmail, phone: null,
      interests: ["General project interest"], message: "Testing allowlist suppression.",
      tenant: staging.tenantSlug, project: "wamule", phase: "default",
      page_url: `${staging.site}/embed/${staging.tenantSlug}`, client_reference_id: outsideReferenceId,
      turnstile_token: stagingTurnstileTokens[0],
    }),
  });
  assert.equal(outside.status, 200);
  const outsideResult = await outside.json();
  assert.equal(outsideResult.leadCreated, true);
  assert.equal(outsideResult.followUpCreated, true);
  assert.equal(outsideResult.emailSent, false);
  assert.equal(outsideResult.emailSuppressed, true);
  assert.equal(dbRows("select count(*) from public.inquiry_confirmation_email_attempts where recipient_hash=%s", [sha256(outsideEmail)])[0][0], 0);

  // Exercise B1 with a temporary two-new-lead allowance: the earlier modern
  // allowlist request and this legacy request fill it, then a third request is refused.
  dbRows("update public.project_public_inquiry_limits set max_leads=%s, rolling_window=interval '24 hours', updated_at=clock_timestamp() where project_id=%s", [baselineProjectLeads + 2, projectId]);
  const b1LegacyPayload = {
    name: "Legacy Compatibility Tester", email: b1LegacyEmail, phone: "+501-600-0001",
    interests: ["General project interest"], specific_lot_id: null,
    message: "Testing the temporary legacy inquiry adapter.",
    page_url: `${staging.site}/embed/${staging.tenantSlug}`,
  };
  const b1Legacy = await fetch(functionsUrl("submit-public-inquiry"), {
    method: "POST",
    headers: { ...anonHeaders(), "Content-Type": "application/json", Origin: staging.site },
    body: JSON.stringify(b1LegacyPayload),
  });
  assert.equal(b1Legacy.status, 200);
  const b1LegacyResult = await b1Legacy.json();
  assert.equal(b1LegacyResult.leadCreated, true);
  assert.equal(b1LegacyResult.followUpCreated, true);
  assert.equal(b1LegacyResult.emailSent, false);
  assert.equal(b1LegacyResult.emailSuppressed, true);
  const legacyRetry = await fetch(functionsUrl("submit-public-inquiry"), {
    method: "POST",
    headers: { ...anonHeaders(), "Content-Type": "application/json", Origin: staging.site },
    body: JSON.stringify(b1LegacyPayload),
  });
  assert.equal(legacyRetry.status, 200);
  const legacyRetryResult = await legacyRetry.json();
  assert.equal(legacyRetryResult.deduplicated, true, "an existing lead retries successfully even at the full B1 cap");
  assert.equal(legacyRetryResult.leadCreated, false);
  assert.equal(legacyRetryResult.emailSent, false);
  const b1Modern = await fetch(functionsUrl("submit-public-inquiry"), {
    method: "POST",
    headers: { ...anonHeaders(), "Content-Type": "application/json", Origin: staging.site },
    body: JSON.stringify({
      name: "B1 Limit Tester", email, interests: ["General project interest"],
      tenant: staging.tenantSlug, project: "wamule", phase: "default",
      page_url: `${staging.site}/embed/${staging.tenantSlug}`, client_reference_id: b1DeniedReferenceId,
      turnstile_token: stagingTurnstileTokens[1],
    }),
  });
  assert.equal(b1Modern.status, 429, "a new modern request shares the project slot used by the legacy payload");
  assert.equal(dbRows("select count(*) from public.leads where client_reference_id=%s", [b1DeniedReferenceId])[0][0], 0);
  const b1LegacyRows = dbRows("select id from public.leads where email=%s and source='public_inquiry'", [b1LegacyEmail]);
  assert.equal(b1LegacyRows.length, 1);
  assert.equal(dbRows("select count(*) from public.follow_up_tasks where lead_id=%s", [b1LegacyRows[0][0]])[0][0], 1);
  cleanupLeadIds([b1LegacyRows[0][0]]);
  restoreLeadLimit();

  const payload = {
    name: "Integration Tester",
    email,
    phone: "+501-600-0000",
    interests: ["Available lots", "A specific lot"],
    specific_lot_ref: available.public_ref,
    message: "Testing public map inquiry submission.",
    page_url: `${staging.site}/embed/${staging.tenantSlug}`,
    tenant: staging.tenantSlug,
    client_reference_id: referenceId,
  };

  const invalidToken = await fetch(functionsUrl("submit-public-inquiry"), {
    method: "POST",
    headers: { ...anonHeaders(), "Content-Type": "application/json", Origin: staging.site },
    body: JSON.stringify({ ...payload, client_reference_id: randomUUID(), turnstile_token: "invalid-staging-token" }),
  });
  assert.equal(invalidToken.status, 403, "invalid challenge is rejected before database writes");

  const submit = await fetch(functionsUrl("submit-public-inquiry"), {
    method: "POST",
    headers: { ...anonHeaders(), "Content-Type": "application/json", Origin: staging.site, "CF-Connecting-IP": "192.0.2.55" },
    body: JSON.stringify({ ...payload, turnstile_token: stagingTurnstileTokens[2] }),
  });
  assert.equal(submit.status, 200);
  const result = await submit.json();
  assert.equal(result.ok, true);
  assert.equal(result.leadCreated, true);
  assert.equal(result.emailSent, true, "one confirmation reaches the configured controlled inbox");

  // Retry with the same idempotency key: no duplicate lead.
  const retry = await fetch(functionsUrl("submit-public-inquiry"), {
    method: "POST",
    headers: { ...anonHeaders(), "Content-Type": "application/json", Origin: staging.site },
    body: JSON.stringify({ ...payload, turnstile_token: stagingTurnstileTokens[3] }),
  });
  assert.equal(retry.status, 200);
  const retryResult = await retry.json();
  assert.equal(retryResult.ok, true);
  assert.equal(retryResult.deduplicated, true);
  assert.ok(!("leadId" in retryResult), "dedupe response carries no lead data");

  // Same key, divergent payload: 409, still a single row.
  const conflict = await fetch(functionsUrl("submit-public-inquiry"), {
    method: "POST",
    headers: { ...anonHeaders(), "Content-Type": "application/json", Origin: staging.site },
    body: JSON.stringify({ ...payload, name: "Someone Else", turnstile_token: stagingTurnstileTokens[4] }),
  });
  assert.equal(conflict.status, 409);

  // Unknown tenant slug with no usable fallback: 400, no row.
  const unknownTenant = await fetch(functionsUrl("submit-public-inquiry"), {
    method: "POST",
    headers: { ...anonHeaders(), "Content-Type": "application/json", Origin: staging.site },
    body: JSON.stringify({ ...payload, tenant: "no-such-development", client_reference_id: randomUUID(), turnstile_token: stagingTurnstileTokens[5] }),
  });
  assert.equal(unknownTenant.status, 400);

  const leads = dbRows("select id, tenant_id, email, project_id from public.leads where client_reference_id = %s", [referenceId]);
  assert.equal(leads.length, 1, "exactly one lead row for the test buyer");
  assert.equal(leads[0][1], staging.expectedTenantId, "lead tenant_id set to the embed tenant");
  const activities = dbRows("select id from public.lead_activities where lead_id = %s", [leads[0][0]]);
  assert.ok(activities.length >= 1, "lead activity recorded for the inquiry");
  const followUps = dbRows("select id from public.follow_up_tasks where lead_id = %s", [leads[0][0]]);
  assert.equal(followUps.length, 1, "exactly one staff follow-up is created");
  const emailAttempts = dbRows(`select ip_hash from public.inquiry_confirmation_email_attempts
    where project_id = %s and recipient_hash = %s order by attempted_at desc limit 1`, [leads[0][3], sha256(email)]);
  assert.equal(emailAttempts.length, 1, "the email allowance was reserved before Resend");
  assert.equal(emailAttempts[0][0], null, "unverified CF-Connecting-IP is ignored while delivery remains eligible");
  const duplicateRecipient = dbRows("select public.reserve_inquiry_confirmation_quota(%s, %s, null)", [leads[0][3], sha256(email)]);
  assert.equal(duplicateRecipient[0][0], false, "the same recipient is refused a second attempt in the rolling window");

  const usedProjectAttempts = Number(dbRows(`select count(*) from public.inquiry_confirmation_email_attempts
    where project_id=%s and attempted_at > now() - interval '24 hours'`, [leads[0][3]])[0][0]);
  const projectCapHashes = Array.from({ length: Math.max(0, 50 - usedProjectAttempts) }, (_, index) =>
    sha256(`slice-b-project-cap-${referenceId}-${index}`));
  t.after(() => {
    if (projectCapHashes.length) dbRows(`delete from public.inquiry_confirmation_email_attempts
      where project_id=%s and recipient_hash=any(%s::text[])`, [leads[0][3], projectCapHashes]);
  });
  if (projectCapHashes.length) {
    dbRows(`insert into public.inquiry_confirmation_email_attempts(project_id,recipient_hash,ip_hash,attempted_at)
      select %s, fake_hash, null, clock_timestamp() from unnest(%s::text[]) as seed(fake_hash)`, [leads[0][3], projectCapHashes]);
  }
  const cappedProjectAttempts = Number(dbRows(`select count(*) from public.inquiry_confirmation_email_attempts
    where project_id=%s and attempted_at > now() - interval '24 hours'`, [leads[0][3]])[0][0]);
  assert.ok(cappedProjectAttempts >= 50, "the project test reaches the approved 50-attempt boundary");
  const projectProbe = sha256(`slice-b-project-cap-probe-${referenceId}`);
  assert.equal(dbRows("select public.reserve_inquiry_confirmation_quota(%s, %s, null)", [leads[0][3], projectProbe])[0][0], false,
    "the project cap refuses the next distinct recipient");

  // 90b3c86's exact seven-field request is accepted only by the temporary
  // scoped adapter. It still creates one lead and follow-up and never emails.
  const legacyPayload = {
    name: "Legacy Compatibility Tester",
    email: legacyEmail,
    phone: "+501-600-0001",
    interests: ["General project interest"],
    specific_lot_id: null,
    message: "Testing the temporary legacy inquiry adapter.",
    page_url: `${staging.site}/embed/${staging.tenantSlug}`,
  };
  const finalLegacy = await fetch(functionsUrl("submit-public-inquiry"), {
    method: "POST",
    headers: { ...anonHeaders(), "Content-Type": "application/json", Origin: staging.site },
    body: JSON.stringify(legacyPayload),
  });
  assert.equal(finalLegacy.status, 200);
  const finalLegacyResult = await finalLegacy.json();
  assert.equal(finalLegacyResult.leadCreated, true);
  assert.equal(finalLegacyResult.followUpCreated, true);
  assert.equal(finalLegacyResult.emailSent, false);
  assert.equal(finalLegacyResult.emailSuppressed, true);
  const legacyRows = dbRows("select id, tenant_id from public.leads where email = %s and source='public_inquiry'", [legacyEmail]);
  assert.equal(legacyRows.length, 1, "one legacy public inquiry is saved");
  assert.equal(legacyRows[0][1], staging.expectedTenantId, "legacy lead has the configured tenant");
  assert.equal(dbRows("select id from public.follow_up_tasks where lead_id = %s", [legacyRows[0][0]]).length, 1);

});
