import { resolveInquirySubmitError } from "./functions";
import { supabase } from "./supabase";

/** Shared transport and error contract for tenant-bound public submissions. */
export async function submitPublicFunction<T = Record<string, unknown>>(functionName: string, body: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke(functionName, { body: body as Record<string, unknown> });
  if (error) throw new Error(await resolveInquirySubmitError(error));
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error(String(data.error));
  }
  return data as T;
}
