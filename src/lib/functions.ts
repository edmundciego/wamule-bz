export function edgeFunctionErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown Edge Function error.");
  if (message.includes("Failed to send a request to the Edge Function")) {
    return `${message} Confirm the Edge Function is active, your session is still signed in, and the deployed site can reach Supabase Functions.`;
  }
  return message;
}
