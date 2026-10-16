export const GEMINI_FALLBACK_MODEL = "gemini-3.1-flash-lite";

export function geminiModelOrder(primary: string) {
  const model = /^gemini-[a-z0-9.-]+$/.test(primary.trim()) ? primary.trim() : GEMINI_FALLBACK_MODEL;
  return [...new Set([model, GEMINI_FALLBACK_MODEL])];
}

/** One bounded attempt per distinct model; provider failure never bypasses auth or database errors. */
export async function generateGeminiJson({
  apiKey, model, prompt, maxOutputTokens, timeoutMs = 9000, fetcher = fetch, onFailure,
}: {
  apiKey: string; model: string; prompt: string; maxOutputTokens: number;
  timeoutMs?: number; fetcher?: typeof fetch;
  onFailure?: (failure: { model: string; status?: number; reason: string }) => void;
}): Promise<{ value: Record<string, unknown>; model: string } | null> {
  if (!apiKey) return null;
  for (const candidate of geminiModelOrder(model)) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        (async () => {
          const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidate)}:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            signal: controller.signal,
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: {
              temperature: 0.2, maxOutputTokens, responseMimeType: "application/json",
            } }),
          });
          if (!response.ok) {
            onFailure?.({ model: candidate, status: response.status, reason: "provider_http_error" });
            return { stop: [400, 401, 403].includes(response.status), value: null };
          }
          const payload = await response.json();
          const finish = payload?.candidates?.[0]?.finishReason;
          if (payload?.promptFeedback?.blockReason || ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(finish)) {
            onFailure?.({ model: candidate, reason: "provider_content_filter" });
            return { stop: true, value: null };
          }
          const text = (payload?.candidates?.[0]?.content?.parts ?? [])
            .filter((part: { text?: unknown; thought?: boolean }) => !part.thought && typeof part.text === "string")
            .map((part: { text: string }) => part.text).join("");
          if (!text) return { stop: false, value: null };
          const value = JSON.parse(text);
          if (!value || Array.isArray(value) || typeof value !== "object" || typeof value.summary !== "string" || !value.summary.trim()) return { stop: false, value: null };
          return { stop: false, value: value as Record<string, unknown> };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("AI provider timeout")); }, timeoutMs);
        }),
      ]);
      if (result.value) return { value: result.value, model: candidate };
      if (result.stop) return null;
    } catch {
      onFailure?.({ model: candidate, reason: controller.signal.aborted ? "timeout" : "invalid_or_unavailable_response" });
      // A transient provider failure or malformed output can use the secondary model.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }
  return null;
}
