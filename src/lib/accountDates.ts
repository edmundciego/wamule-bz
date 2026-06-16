type ContractDueInput = {
  start_date: string;
  payment_due_day: number;
};

export function accountDueDate(contract: ContractDueInput, today = new Date()) {
  const start = startOfDay(new Date(contract.start_date));
  const current = startOfDay(today);
  const dueDay = Math.max(1, Math.min(31, Number(contract.payment_due_day || 1)));
  const firstDue = dueDateForMonth(start.getFullYear(), start.getMonth(), dueDay);

  if (firstDue < start) {
    firstDue.setMonth(firstDue.getMonth() + 1);
  }

  if (current <= firstDue) return firstDue;

  const cycleDue = dueDateForMonth(current.getFullYear(), current.getMonth(), dueDay);
  if (cycleDue < firstDue) return firstDue;
  if (cycleDue <= current) return cycleDue;
  return cycleDue;
}

export function isDueSoon(dueDate: Date, today = new Date(), days = 7) {
  const current = startOfDay(today);
  const due = startOfDay(dueDate);
  const diff = Math.ceil((due.getTime() - current.getTime()) / 86400000);
  return diff >= 0 && diff <= days;
}

export function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dueDateForMonth(year: number, month: number, dueDay: number) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(dueDay, lastDay));
}
