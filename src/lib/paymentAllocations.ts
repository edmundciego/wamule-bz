export type PaymentAllocationTarget = {
  kind: "contract" | "reservation" | "fee_charge";
  id: number | string;
  currency: string;
  scopeKind: "phase" | "project" | "company";
  projectId: string | null;
  phaseId: string | null;
};

export type PaymentAllocationInput = {
  amount: number;
  currency: string;
  scope_kind: PaymentAllocationTarget["scopeKind"] | "unallocated";
  project_id?: string;
  phase_id?: string;
  contract_id?: number;
  reservation_id?: string;
  fee_charge_id?: number;
  allocation_reason?: string;
};

export function buildPaymentAllocations({
  totalAmount,
  currency,
  allocations,
  unallocatedReason,
}: {
  totalAmount: number;
  currency: string;
  allocations: Array<{ target: PaymentAllocationTarget; amount: number }>;
  unallocatedReason?: string | null;
}): PaymentAllocationInput[] {
  const totalCents = cents(totalAmount);
  if (totalCents <= 0) throw new Error("Receipt amount must be greater than zero.");
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Choose a configured three-letter currency.");
  if (!allocations.length && !unallocatedReason?.trim()) {
    throw new Error("Select an obligation or explain why the full receipt remains unallocated.");
  }

  const result: PaymentAllocationInput[] = [];
  let allocatedCents = 0;
  for (const item of allocations) {
    const amountCents = cents(item.amount);
    if (amountCents <= 0) throw new Error("Each obligation allocation must be greater than zero.");
    if (item.target.currency !== currency) {
      throw new Error("All selected obligations must use the receipt currency.");
    }
    if (item.target.scopeKind === "phase" && (!item.target.projectId || !item.target.phaseId)) {
      throw new Error("A phase allocation must include its verified project and phase.");
    }
    if (item.target.scopeKind === "project" && (!item.target.projectId || item.target.phaseId)) {
      throw new Error("A project allocation must include only its verified project.");
    }
    if (item.target.scopeKind === "company" && (item.target.projectId || item.target.phaseId)) {
      throw new Error("A company allocation cannot carry a project or phase.");
    }
    allocatedCents += amountCents;
    if (allocatedCents > totalCents) throw new Error("Allocations cannot exceed the receipt amount.");

    result.push({
      amount: amountCents / 100,
      currency,
      scope_kind: item.target.scopeKind,
      ...(item.target.projectId ? { project_id: item.target.projectId } : {}),
      ...(item.target.phaseId ? { phase_id: item.target.phaseId } : {}),
      ...(item.target.kind === "contract" ? { contract_id: Number(item.target.id) } : {}),
      ...(item.target.kind === "reservation" ? { reservation_id: String(item.target.id) } : {}),
      ...(item.target.kind === "fee_charge" ? { fee_charge_id: Number(item.target.id) } : {}),
    });
  }

  const remainderCents = totalCents - allocatedCents;
  if (remainderCents > 0) {
    if (!unallocatedReason?.trim()) {
      throw new Error("Explain why the remaining receipt amount is unallocated.");
    }
    result.push({
      amount: remainderCents / 100,
      currency,
      scope_kind: "unallocated",
      allocation_reason: unallocatedReason.trim(),
    });
  }

  return result;
}

function cents(value: number) {
  if (!Number.isFinite(value)) throw new Error("Enter a valid amount.");
  return Math.round((value + Number.EPSILON) * 100);
}
