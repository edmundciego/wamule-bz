import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function money(value: number | null | undefined) {
  return new Intl.NumberFormat("en-BZ", {
    style: "currency",
    currency: "BZD",
  }).format(Number(value ?? 0));
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-BZ", { dateStyle: "medium", timeZone: "America/Belize" }).format(new Date(value));
}
