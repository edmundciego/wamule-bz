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

/** m² → ft² for dual-unit lot area lines. */
const SQFT_PER_SQM = 10.7639;

export function formatAreaDualUnit(areaSqm: number): string {
  return `${Math.round(areaSqm).toLocaleString("en-US")} m² · ${Math.round(areaSqm * SQFT_PER_SQM).toLocaleString("en-US")} sq ft`;
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-BZ", { dateStyle: "medium", timeZone: "America/Belize" }).format(new Date(value));
}
