export function edgeFunctionErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown Edge Function error.");
  if (message.includes("Failed to send a request to the Edge Function")) {
    return `${message} Confirm the Edge Function is active, your session is still signed in, and the deployed site can reach Supabase Functions.`;
  }
  return message;
}

type EdgeFunctionFailure = {
  message?: string;
  status?: number;
  context?: unknown;
};

/**
 * Read a failed functions.invoke() result: HTTP status + the endpoint's own
 * `{"error": "..."}` body (server messages are curated for buyers). Always
 * logs status/body for diagnostics. Never surfaces the supabase-js library
 * text ("Edge Function returned a non-2xx status code") to buyers.
 */
export async function readEdgeFunctionError(error: unknown): Promise<{ status?: number; serverMessage?: string }> {
  const failure = (error ?? {}) as EdgeFunctionFailure;
  let status = typeof failure.status === "number" ? failure.status : undefined;
  let serverMessage: string | undefined;
  const context = failure.context as (Response & { status?: number }) | undefined;
  try {
    if (context && typeof context.json === "function") {
      if (typeof context.status === "number") status = context.status;
      const body = (await context.json().catch(() => null)) as { error?: unknown } | null;
      if (body && typeof body.error === "string" && body.error) serverMessage = body.error;
    }
  } catch {
    serverMessage = undefined;
  }
  try {
    console.error(`[edge-function] request failed (status ${status ?? "unknown"})`, {
      serverMessage,
      libraryMessage: typeof failure.message === "string" ? failure.message : undefined,
    });
  } catch {
    /* logging must never break the UI */
  }
  return { status, serverMessage };
}

/** Known technical server messages rewritten in buyer-friendly words. */
const INQUIRY_MESSAGE_OVERRIDES: Array<[RegExp, string]> = [
  [/available public lot/i, "That lot isn't currently listed for inquiry — please choose another available lot."],
  [/different development/i, "That lot belongs to a different development — please check the listing and try again."],
  [/valid lot/i, "Please choose a valid lot for your inquiry."],
];

const INQUIRY_FALLBACK = "We could not send your inquiry. Please try again.";

/** Buyer-facing message for a failed inquiry submission. Never library text. */
export function inquirySubmitErrorMessage(serverMessage: string | undefined): string {
  if (!serverMessage) return INQUIRY_FALLBACK;
  for (const [pattern, friendly] of INQUIRY_MESSAGE_OVERRIDES) {
    if (pattern.test(serverMessage)) return friendly;
  }
  return serverMessage;
}

/**
 * Full inquiry-failure flow: log status/body, resolve the buyer message.
 * Network failures (no response context) get connectivity guidance.
 */
export async function resolveInquirySubmitError(error: unknown): Promise<string> {
  const failure = (error ?? {}) as EdgeFunctionFailure;
  const hasContext = !!failure.context;
  const { serverMessage } = await readEdgeFunctionError(error);
  if (serverMessage) return inquirySubmitErrorMessage(serverMessage);
  if (!hasContext) return "We could not reach the server. Check your connection and try again.";
  return INQUIRY_FALLBACK;
}
