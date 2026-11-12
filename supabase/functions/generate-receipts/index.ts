import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { gatewayJwtHasRole } from "../_shared/service-jwt-role.mjs";
import { runIfReceiptScopeActive } from "../_shared/receipt-state-guard.mjs";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, serviceRoleKey);

type ReceiptTransaction = {
  id: number;
  tenant_id: string;
  customer_id: number;
  contract_id: number | null;
  receipt_number: string;
  transaction_type: string;
  amount: number;
  currency: string | null;
  allocation_version: string | null;
  collection_method: string;
  bank_reference: string | null;
  created_at: string;
  authorized_by: string | null;
  status: string;
};

type ReceiptAllocation = {
  id: number;
  tenant_id: string;
  customer_id: number;
  amount: number;
  currency: string | null;
  scope_kind: string;
  allocation_kind: string;
  contract_id: number | null;
  reservation_id: string | null;
  fee_charge_id: number | null;
  project_id: string | null;
  phase_id: string | null;
  allocation_reason: string | null;
};

type VerifiedReceiptScope = {
  projectId: string | null;
  phaseId: string | null;
  label: string;
  amount: number;
  currency: string | null;
};

const RECEIPT_LEASE_PREFIX = "m77-receipt-lease:";
const RECEIPT_LEASE_MS = 10 * 60 * 1000;

Deno.serve(async (request) => {
  // The gateway validates the JWT signature (verify_jwt=true below). Requiring
  // its service_role claim prevents any ordinary signed-in user from invoking
  // the global service-key queue runner.
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  if (!gatewayJwtHasRole(request, "service_role")) {
    return Response.json({ error: "Only the trusted receipt worker may run this job." }, { status: 403 });
  }

  const { data: candidates, error: candidateError } = await supabase
    .from("receipt_jobs")
    .select("id, tenant_id, transaction_id, attempts, error_message")
    .eq("status", "Pending")
    .order("created_at", { ascending: true })
    .limit(100);

  if (candidateError) {
    return Response.json({ error: candidateError.message }, { status: 500 });
  }

  // A process can disappear after a successful claim. Leases are recorded in
  // the existing error_message field so this forward application change does
  // not depend on new database columns. Requeue only a token whose timestamp
  // has expired, using a compare-and-set update so an active claim cannot be
  // stolen. A worker run longer than the lease is still a managed-runtime
  // timing risk; normal receipt generation is expected to complete well under
  // ten minutes.
  const { data: processingJobs, error: processingError } = await supabase
    .from("receipt_jobs")
    .select("id, tenant_id, transaction_id, attempts, error_message")
    .eq("status", "Processing")
    .order("created_at", { ascending: true })
    .limit(100);
  if (processingError) return Response.json({ error: processingError.message }, { status: 500 });
  for (const stale of processingJobs ?? []) {
    const lease = parseReceiptLease(stale.error_message);
    if (!lease || Date.now() - lease.startedAt < RECEIPT_LEASE_MS) continue;
    await supabase.from("receipt_jobs").update({ status: "Pending", error_message: null })
      .eq("id", stale.id).eq("status", "Processing").eq("error_message", stale.error_message);
  }

  const { data: refreshedCandidates, error: refreshedError } = await supabase.from("receipt_jobs")
    .select("id, tenant_id, transaction_id, attempts, error_message")
    .eq("status", "Pending").order("created_at", { ascending: true }).limit(100);
  if (refreshedError) return Response.json({ error: refreshedError.message }, { status: 500 });
  const pendingCandidates = refreshedCandidates ?? candidates ?? [];

  const processed: Array<{ job_id: number; transaction_id: number; status: string }> = [];
  const candidateTenantIds = [...new Set(pendingCandidates.map((job) => job.tenant_id).filter(Boolean))];
  let batchTenantId: string | null = null;
  for (const candidateTenantId of candidateTenantIds) {
    const { data: candidateTenant, error: tenantError } = await supabase.from("organizations")
      .select("id,is_active").eq("id", candidateTenantId).eq("is_active", true).maybeSingle();
    if (!tenantError && candidateTenant) {
      batchTenantId = candidateTenantId;
      break;
    }
  }

  if (batchTenantId === null) {
    for (const candidate of pendingCandidates) {
      processed.push({ job_id: candidate.id, transaction_id: candidate.transaction_id, status: "Paused: workspace or transaction scope is not active" });
    }
    return Response.json({ processed });
  }

  // One invocation handles one verified tenant. This avoids mixing customer
  // documents across workspaces in a service-role batch.
  const { data: jobs, error: jobError } = await supabase.from("receipt_jobs")
    .select("id, tenant_id, transaction_id, attempts, error_message")
    .eq("status", "Pending").eq("tenant_id", batchTenantId)
    .order("created_at", { ascending: true }).limit(10);
  if (jobError) return Response.json({ error: jobError.message }, { status: 500 });

  for (const job of jobs ?? []) {
    const { data: transaction, error: transactionError } = await supabase
      .from("transactions")
      .select("id,tenant_id,customer_id,contract_id,receipt_number,transaction_type,amount,currency,allocation_version,collection_method,bank_reference,created_at,authorized_by,status,receipt_file_path")
      .eq("id", job.transaction_id)
      .single();

    if (transactionError) {
      await supabase.from("receipt_jobs").update({ status: "Failed", error_message: transactionError.message }).eq("id", job.id);
      processed.push({ job_id: job.id, transaction_id: job.transaction_id, status: "Failed" });
      continue;
    }

    const workspace = await verifyReceiptWorkspace(transaction);
    if (!workspace.ok || job.tenant_id !== transaction.tenant_id) {
      // Keep jobs pending so an authorized operator can reactivate/fix the
      // workspace and retry. No file upload or business-row mutation occurs.
      processed.push({ job_id: job.id, transaction_id: job.transaction_id, status: "Paused: workspace or transaction scope is not active" });
      continue;
    }

    const { data: customer, error: customerError } = await supabase.from("customers")
      .select("id,tenant_id,first_name,last_name")
      .eq("id", transaction.customer_id).eq("tenant_id", transaction.tenant_id).maybeSingle();
    if (customerError || !customer) {
      console.error("Receipt customer scope could not be verified", customerError?.message ?? "missing customer");
      processed.push({ job_id: job.id, transaction_id: job.transaction_id, status: "Paused: customer scope could not be verified" });
      continue;
    }

    const scopeResult = await resolveReceiptAllocations(transaction);
    if (!scopeResult.ok) {
      processed.push({ job_id: job.id, transaction_id: job.transaction_id, status: `Paused: ${scopeResult.reason}` });
      continue;
    }

    const leaseToken = makeReceiptLeaseToken();
    const { data: claimedJob, error: claimError } = await supabase.from("receipt_jobs")
      .update({ status: "Processing", attempts: job.attempts + 1, error_message: leaseToken })
      .eq("id", job.id).eq("status", "Pending").select("id").maybeSingle();
    if (claimError || !claimedJob) {
      processed.push({ job_id: job.id, transaction_id: job.transaction_id, status: "Skipped: job was already claimed" });
      continue;
    }

    // Recheck immediately before external Storage I/O and associated writes.
    // Storage and Postgres cannot share a transaction, so a concurrent
    // deactivation after this check remains a documented race.
    const path = `${safePathSegment(transaction.tenant_id)}/${transaction.customer_id}/${safePathSegment(transaction.receipt_number)}.pdf`;
    let result: { allowed: boolean };
    try {
      result = await runIfReceiptScopeActive(
        () => verifyReceiptWorkspace(transaction, scopeResult.scopes),
        async () => {
          const companyName = await loadCompanyName(transaction.tenant_id);
          const receiptLines = [
            companyName,
            `Receipt: ${transaction.receipt_number}`,
            `Customer: ${customer.first_name} ${customer.last_name}`,
            `Transaction type: ${transaction.transaction_type}`,
            `Amount paid: ${formatMoney(transaction.amount, transaction.currency)}`,
            `Collection method: ${transaction.collection_method}`,
            `Bank reference: ${transaction.bank_reference ?? "N/A"}`,
            `Payment date: ${transaction.created_at}`,
            `Authorized by: ${transaction.authorized_by}`,
            "Allocations:",
            ...scopeResult.scopes.map((scope) => `- ${formatMoney(scope.amount, scope.currency)} — ${scope.label}`),
          ];

          const { error: uploadError } = await supabase.storage
            .from("receipts")
            .upload(path, new Blob([createSimplePdf(receiptLines)], { type: "application/pdf" }), {
              contentType: "application/pdf",
              upsert: true,
            });
          if (uploadError) throw new Error(uploadError.message);

          const { error: transactionUpdateError } = await supabase.from("transactions")
            .update({ receipt_file_path: path }).eq("id", transaction.id).eq("tenant_id", transaction.tenant_id);
          if (transactionUpdateError) throw new Error(transactionUpdateError.message);

          const { error: completionError } = await supabase.from("receipt_jobs")
            .update({ status: "Completed", error_message: null }).eq("id", job.id)
            .eq("status", "Processing").eq("error_message", leaseToken);
          if (completionError) throw new Error(completionError.message);
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown receipt processing error.";
      await supabase.from("receipt_jobs").update({ status: "Failed", error_message: message }).eq("id", job.id)
        .eq("status", "Processing").eq("error_message", leaseToken);
      processed.push({ job_id: job.id, transaction_id: job.transaction_id, status: "Failed" });
      continue;
    }
    if (!result.allowed) {
      await supabase.from("receipt_jobs").update({ status: "Pending", attempts: job.attempts, error_message: null })
        .eq("id", job.id).eq("status", "Processing").eq("error_message", leaseToken);
      processed.push({ job_id: job.id, transaction_id: job.transaction_id, status: "Paused: workspace changed before receipt upload" });
      continue;
    }
    processed.push({ job_id: job.id, transaction_id: job.transaction_id, status: "Completed" });
  }

  return Response.json({ processed });
});

async function verifyReceiptWorkspace(
  transaction: ReceiptTransaction, scopes: VerifiedReceiptScope[] = [],
): Promise<{ ok: true } | { ok: false }> {
  if (!transaction.tenant_id || String(transaction.status).toLowerCase() !== "posted") return { ok: false };
  const { data: tenant, error: tenantError } = await supabase.from("organizations")
    .select("id,is_active").eq("id", transaction.tenant_id).eq("is_active", true).maybeSingle();
  if (tenantError || !tenant) return { ok: false };
  for (const scope of scopes) {
    if (scope.phaseId !== null && scope.projectId === null) return { ok: false };
    if (!scope.projectId) continue;
    // projects has no independent is_active state. The shared helper verifies
    // that the project belongs to this tenant and that the exact tenant/phase
    // scope remains active, using the same lifecycle rule as RLS and sales RPCs.
    const { data: activeScope, error: scopeError } = await supabase.rpc("workspace_scope_is_active", {
      p_tenant_id: transaction.tenant_id,
      p_project_id: scope.projectId,
      p_phase_id: scope.phaseId,
    });
    if (scopeError || activeScope !== true) return { ok: false };
  }
  return { ok: true };
}

async function resolveReceiptAllocations(transaction: ReceiptTransaction): Promise<
  { ok: true; scopes: VerifiedReceiptScope[] } | { ok: false; reason: string }
> {
  const { data: allocations, error } = await supabase.from("transaction_allocations")
    .select("id,tenant_id,customer_id,amount,currency,scope_kind,allocation_kind,contract_id,reservation_id,fee_charge_id,project_id,phase_id,allocation_reason")
    .eq("transaction_id", transaction.id).eq("tenant_id", transaction.tenant_id);
  if (error) return { ok: false, reason: "payment allocations could not be verified" };

  if (transaction.allocation_version !== "allocations_v1") {
    // M7.5 deliberately backfills history as unallocated where currency or
    // obligation scope cannot be proven. Preserve that uncertainty in the PDF.
    return {
      ok: true,
      scopes: [{
        projectId: null,
        phaseId: null,
        label: "Historical payment; obligation, currency, and sale phase not verified",
        amount: Number(transaction.amount),
        currency: null,
      }],
    };
  }
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return { ok: false, reason: "posted allocation rows are missing" };
  }
  const rows = allocations as ReceiptAllocation[];
  const sum = rows.reduce((total, row) => total + Number(row.amount), 0);
  if (rows.some((row) => row.tenant_id !== transaction.tenant_id || row.customer_id !== transaction.customer_id)
    || Math.round(sum * 100) !== Math.round(Number(transaction.amount) * 100)
    || rows.some((row) => row.currency !== transaction.currency || row.allocation_kind === "reversal")) {
    return { ok: false, reason: "posted allocation rows do not reconcile to the receipt" };
  }

  const scopes: VerifiedReceiptScope[] = [];
  for (const allocation of rows) {
    if (allocation.scope_kind === "unallocated") {
      if (allocation.project_id || allocation.phase_id || !allocation.allocation_reason) {
        return { ok: false, reason: "unallocated receipt scope is malformed" };
      }
      scopes.push({
        projectId: null,
        phaseId: null,
        label: `Unallocated — ${allocation.allocation_reason}`,
        amount: Number(allocation.amount),
        currency: allocation.currency,
      });
      continue;
    }
    if (Number(allocation.contract_id !== null) + Number(allocation.reservation_id !== null) + Number(allocation.fee_charge_id !== null) !== 1) {
      return { ok: false, reason: "allocation does not identify exactly one verified obligation" };
    }
    if (!allocation.project_id) return { ok: false, reason: "allocation project scope is missing" };
    let label: string;
    let verifiedProjectId: string | null = allocation.project_id;
    let verifiedPhaseId: string | null = allocation.phase_id;
    if (allocation.contract_id !== null) {
      const { data: contract, error: contractError } = await supabase.from("contracts")
        .select("id,tenant_id,customer_id,project_id,phase_id,parcel_id,currency")
        .eq("id", allocation.contract_id).eq("tenant_id", transaction.tenant_id)
        .eq("customer_id", transaction.customer_id).maybeSingle();
      if (contractError || !contract || contract.project_id !== allocation.project_id
        || contract.phase_id !== allocation.phase_id || contract.currency !== transaction.currency) {
        return { ok: false, reason: "contract allocation scope could not be verified" };
      }
      let lotLabel = "Lot N/A";
      if (contract.parcel_id !== null) {
        const { data: parcel, error: parcelError } = await supabase.from("parcels")
          .select("id,tenant_id,project_id,phase_id,lot_number")
          .eq("id", contract.parcel_id).eq("tenant_id", transaction.tenant_id)
          .eq("project_id", allocation.project_id).eq("phase_id", allocation.phase_id).maybeSingle();
        if (parcelError || !parcel) return { ok: false, reason: "contract parcel scope could not be verified" };
        lotLabel = `Lot ${parcel.lot_number ?? "N/A"}`;
      }
      const saleContext = await loadSaleContext(transaction.tenant_id, contract.project_id, contract.phase_id);
      if (!saleContext) return { ok: false, reason: "contract project and phase names could not be verified" };
      label = `Contract ${contract.id}, ${lotLabel} (${saleContext})`;
    } else if (allocation.reservation_id !== null) {
      const { data: reservation, error: reservationError } = await supabase.from("lot_reservations")
        .select("id,tenant_id,customer_id,project_id,phase_id,parcel_id,currency")
        .eq("id", allocation.reservation_id).eq("tenant_id", transaction.tenant_id)
        .eq("customer_id", transaction.customer_id).maybeSingle();
      if (reservationError || !reservation || reservation.project_id !== allocation.project_id
        || reservation.phase_id !== allocation.phase_id || reservation.currency !== transaction.currency) {
        return { ok: false, reason: "reservation allocation scope could not be verified" };
      }
      let lotLabel = "Lot N/A";
      if (reservation.parcel_id !== null) {
        const { data: parcel, error: parcelError } = await supabase.from("parcels")
          .select("id,tenant_id,project_id,phase_id,lot_number")
          .eq("id", reservation.parcel_id).eq("tenant_id", transaction.tenant_id)
          .eq("project_id", allocation.project_id).eq("phase_id", allocation.phase_id).maybeSingle();
        if (parcelError || !parcel) return { ok: false, reason: "reservation parcel scope could not be verified" };
        lotLabel = `Lot ${parcel.lot_number ?? "N/A"}`;
      }
      const saleContext = await loadSaleContext(transaction.tenant_id, reservation.project_id, reservation.phase_id);
      if (!saleContext) return { ok: false, reason: "reservation project and phase names could not be verified" };
      label = `Reservation ${reservation.id}, ${lotLabel} (${saleContext})`;
    } else {
      const { data: charge, error: chargeError } = await supabase.from("fee_charges")
        .select("id,tenant_id,customer_id,scope_kind,project_id,phase_id,currency")
        .eq("id", allocation.fee_charge_id).eq("tenant_id", transaction.tenant_id)
        .eq("customer_id", transaction.customer_id).maybeSingle();
      if (chargeError || !charge || charge.project_id !== allocation.project_id
        || charge.phase_id !== allocation.phase_id || charge.currency !== transaction.currency) {
        return { ok: false, reason: "fee allocation scope could not be verified" };
      }
      verifiedProjectId = charge.project_id;
      verifiedPhaseId = charge.phase_id;
      const saleContext = await loadSaleContext(transaction.tenant_id, charge.project_id, charge.phase_id);
      if (!saleContext) return { ok: false, reason: "fee project and phase names could not be verified" };
      label = `Fee charge ${charge.id} (${saleContext})`;
    }
    scopes.push({
      projectId: verifiedProjectId,
      phaseId: verifiedPhaseId,
      label,
      amount: Number(allocation.amount),
      currency: allocation.currency,
    });
  }
  return { ok: true, scopes };
}

async function loadSaleContext(tenantId: string, projectId: string, phaseId: string | null) {
  const { data: project, error: projectError } = await supabase.from("projects")
    .select("id,tenant_id,name,slug").eq("id", projectId).eq("tenant_id", tenantId).maybeSingle();
  if (projectError || !project) return null;
  const projectLabel = String(project.name ?? project.slug ?? "Project");
  if (phaseId === null) return projectLabel;
  const { data: phase, error: phaseError } = await supabase.from("development_phases")
    .select("id,tenant_id,project_id,name,slug").eq("id", phaseId).eq("tenant_id", tenantId)
    .eq("project_id", projectId).maybeSingle();
  if (phaseError || !phase) return null;
  return `${projectLabel} / ${String(phase.name ?? phase.slug ?? "Phase")}`;
}

function makeReceiptLeaseToken() {
  return `${RECEIPT_LEASE_PREFIX}${Date.now()}:${crypto.randomUUID()}`;
}

function parseReceiptLease(value: unknown) {
  if (typeof value !== "string" || !value.startsWith(RECEIPT_LEASE_PREFIX)) return null;
  const timestamp = Number(value.slice(RECEIPT_LEASE_PREFIX.length).split(":", 1)[0]);
  return Number.isFinite(timestamp) ? { startedAt: timestamp } : null;
}

function formatMoney(amount: number, currency: string | null) {
  return `${currency ?? "Currency unverified"} ${Number(amount).toFixed(2)}`;
}

function safePathSegment(value: string) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "receipt";
}

async function loadCompanyName(tenantId: string) {
  const { data } = await supabase
    .from("business_settings")
    .select("value")
    .eq("tenant_id", tenantId)
    .eq("key", "company_profile")
    .maybeSingle();
  const value = data?.value && typeof data.value === "object" ? data.value as Record<string, unknown> : {};
  const configuredName = typeof value.company_name === "string" ? value.company_name.trim() : "";
  return configuredName || "Wamule Development";
}

function createSimplePdf(lines: string[]) {
  const escapedLines = lines.map((line) => line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)"));
  const textCommands = escapedLines.map((line, index) => `BT /F1 12 Tf 72 ${740 - index * 18} Td (${line}) Tj ET`).join("\n");
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    `5 0 obj << /Length ${textCommands.length} >> stream\n${textCommands}\nendstream endobj`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += `${object}\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return pdf;
}
