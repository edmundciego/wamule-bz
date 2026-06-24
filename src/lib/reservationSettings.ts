import { supabase } from "./supabase";
import type { DepositStatus, ReservationStatus, ReservationWorkflowSettings } from "../types/database";

export const reservationWorkflowSettingsKey = "reservation_workflow_settings" as const;

export const reservationWorkflowDefaults: ReservationWorkflowSettings = {
  default_reservation_expiry_days: 14,
  default_deposit_due_days: 7,
  default_expected_deposit_amount: null,
  require_expiry_date: false,
  require_expected_deposit_amount: false,
  default_reservation_status: "draft",
  default_deposit_status: "not_requested",
  prompt_release_alternates_after_deposit_confirmed: true,
  prompt_release_alternates_after_contract_started: true,
  show_reservation_explanations: true,
};

export const reservationStatusOptions: ReservationStatus[] = [
  "draft",
  "reserved",
  "deposit_pending",
  "deposit_submitted",
  "deposit_confirmed",
  "converted_to_application",
  "converted_to_contract",
  "expired",
  "cancelled",
  "released",
];

export const depositStatusOptions: DepositStatus[] = [
  "not_requested",
  "pending",
  "proof_submitted",
  "confirmed",
  "overdue",
  "waived",
  "cancelled",
];

function asBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function asNullableNumber(value: unknown, fallback: number | null) {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : fallback;
}

function asReservationStatus(value: unknown, fallback: ReservationStatus): ReservationStatus {
  return reservationStatusOptions.includes(value as ReservationStatus) ? value as ReservationStatus : fallback;
}

function asDepositStatus(value: unknown, fallback: DepositStatus): DepositStatus {
  return depositStatusOptions.includes(value as DepositStatus) ? value as DepositStatus : fallback;
}

export function normalizeReservationWorkflowSettings(value: unknown): ReservationWorkflowSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

  return {
    default_reservation_expiry_days: asNullableNumber(raw.default_reservation_expiry_days, reservationWorkflowDefaults.default_reservation_expiry_days),
    default_deposit_due_days: asNullableNumber(raw.default_deposit_due_days, reservationWorkflowDefaults.default_deposit_due_days),
    default_expected_deposit_amount: asNullableNumber(raw.default_expected_deposit_amount, reservationWorkflowDefaults.default_expected_deposit_amount),
    require_expiry_date: asBoolean(raw.require_expiry_date, reservationWorkflowDefaults.require_expiry_date),
    require_expected_deposit_amount: asBoolean(raw.require_expected_deposit_amount, reservationWorkflowDefaults.require_expected_deposit_amount),
    default_reservation_status: asReservationStatus(raw.default_reservation_status, reservationWorkflowDefaults.default_reservation_status),
    default_deposit_status: asDepositStatus(raw.default_deposit_status, reservationWorkflowDefaults.default_deposit_status),
    prompt_release_alternates_after_deposit_confirmed: asBoolean(
      raw.prompt_release_alternates_after_deposit_confirmed,
      reservationWorkflowDefaults.prompt_release_alternates_after_deposit_confirmed,
    ),
    prompt_release_alternates_after_contract_started: asBoolean(
      raw.prompt_release_alternates_after_contract_started,
      reservationWorkflowDefaults.prompt_release_alternates_after_contract_started,
    ),
    show_reservation_explanations: asBoolean(raw.show_reservation_explanations, reservationWorkflowDefaults.show_reservation_explanations),
  };
}

export async function fetchReservationWorkflowSettings() {
  const { data, error } = await supabase
    .from("business_settings")
    .select("value")
    .eq("key", reservationWorkflowSettingsKey)
    .maybeSingle();

  if (error) throw error;
  return normalizeReservationWorkflowSettings(data?.value);
}

export function futureIsoFromDays(days: number | null) {
  if (days === null || !Number.isFinite(days)) return null;
  const date = new Date();
  date.setDate(date.getDate() + Math.max(0, Number(days)));
  return date.toISOString();
}
