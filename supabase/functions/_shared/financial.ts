export const landPaymentTypes = new Set(["Down Payment", "Land Installment"]);

export function isActiveContract(contract: Record<string, unknown> | null | undefined) {
  return Boolean(contract?.is_active === true && contract.status === "active");
}

export function activeContract(contracts: Record<string, unknown>[]) {
  return contracts.find((contract) => isActiveContract(contract)) ?? null;
}

export function postedLandPaymentsForContract(payments: Record<string, unknown>[], contractId: unknown) {
  return payments.filter((payment) =>
    payment.status === "posted"
    && payment.contract_id === contractId
    && landPaymentTypes.has(String(payment.transaction_type)),
  );
}

export function totalPostedLandPayments(payments: Record<string, unknown>[], contractId: unknown) {
  return postedLandPaymentsForContract(payments, contractId)
    .reduce((total, payment) => total + Number(payment.amount ?? 0), 0);
}

export function remainingLandBalance(contract: Record<string, unknown> | null, payments: Record<string, unknown>[]) {
  if (!isActiveContract(contract)) return null;
  return Math.max(Number(contract?.final_purchase_price ?? 0) - totalPostedLandPayments(payments, contract?.id), 0);
}
