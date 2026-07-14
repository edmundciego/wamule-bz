import { accountDueDate, startOfDay } from "./accountDates";

export const landPaymentTypes = ["Down Payment", "Land Installment"] as const;

type ContractLike = {
  id: number;
  is_active: boolean;
  status?: string | null;
  final_purchase_price: number;
  monthly_payment: number;
  start_date: string;
  payment_due_day: number;
};

type TransactionLike = {
  amount: number;
  contract_id?: number | null;
  transaction_type: string;
  status?: string | null;
  created_at?: string;
};

type PaymentRequestLike = { status: string };

export function isActiveContract(contract: Pick<ContractLike, "is_active" | "status"> | null | undefined) {
  return Boolean(contract?.is_active && contract.status === "active");
}

export function activeContract<T extends ContractLike>(contracts: T[] | null | undefined): T | null {
  return contracts?.find((contract) => isActiveContract(contract)) ?? null;
}

export function isPostedLandPaymentForContract(transaction: TransactionLike, contractId: number) {
  return transaction.status === "posted"
    && transaction.contract_id === contractId
    && landPaymentTypes.includes(transaction.transaction_type as (typeof landPaymentTypes)[number]);
}

export function postedLandPaymentsForContract<T extends TransactionLike>(transactions: T[] | null | undefined, contractId: number): T[] {
  return (transactions ?? []).filter((transaction) => isPostedLandPaymentForContract(transaction, contractId));
}

export function totalPostedLandPayments(transactions: TransactionLike[] | null | undefined, contractId: number) {
  return postedLandPaymentsForContract(transactions, contractId)
    .reduce((sum, transaction) => sum + Number(transaction.amount), 0);
}

export function remainingLandBalance(contract: ContractLike | null | undefined, transactions: TransactionLike[] | null | undefined) {
  if (!contract || !isActiveContract(contract)) return null;
  return Math.max(Number(contract.final_purchase_price) - totalPostedLandPayments(transactions, contract.id), 0);
}

export function nextContractDueDate(contract: ContractLike | null | undefined, today = new Date()) {
  return contract && isActiveContract(contract) ? accountDueDate(contract, today) : null;
}

export function isContractOverdue(contract: ContractLike | null | undefined, transactions: TransactionLike[] | null | undefined, today = new Date()) {
  const balance = remainingLandBalance(contract, transactions);
  const dueDate = nextContractDueDate(contract, today);
  return Boolean(balance && balance > 0 && dueDate && dueDate < startOfDay(today));
}

export function openPaymentRequests<T extends PaymentRequestLike>(requests: T[] | null | undefined): T[] {
  return (requests ?? []).filter((request) => request.status === "Draft" || request.status === "Sent");
}
