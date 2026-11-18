import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  verifyDnsTxtHostname,
  verifyNetlifyDefaultHostname,
} from "../_shared/public-hostname.mjs";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const netlifySiteId = Deno.env.get("NETLIFY_SITE_ID") ?? "";
const netlifyAuthToken = Deno.env.get("NETLIFY_AUTH_TOKEN") ?? "";
const bindingIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Verifier is not configured." }, 503);

  // This internal verification endpoint accepts only a server-side service key.
  // Never place this key in frontend environment variables.
  if (request.headers.get("authorization") !== `Bearer ${serviceRoleKey}`) {
    return json({ error: "Service authorization is required." }, 401);
  }

  const body = await request.json().catch(() => null) as { binding_id?: unknown } | null;
  const bindingId = typeof body?.binding_id === "string" ? body.binding_id.trim() : "";
  if (!bindingIdPattern.test(bindingId)) return json({ error: "A valid binding_id is required." }, 400);

  const service = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: challengeRows, error: challengeError } = await service.rpc(
    "get_public_hostname_verification_challenge",
    { p_binding_id: bindingId },
  );
  const challenge = Array.isArray(challengeRows) ? challengeRows[0] : null;
  if (challengeError || !challenge) return json({ error: "The hostname challenge could not be loaded." }, 409);

  try {
    const hostname = String(challenge.canonical_hostname ?? "");
    const token = String(challenge.verification_challenge ?? "");
    const evidence = hostname.endsWith(".netlify.app")
      ? await verifyNetlifyDefaultHostname(hostname, token, {
        siteId: netlifySiteId,
        authToken: netlifyAuthToken,
      })
      : await verifyDnsTxtHostname(hostname, token);

    const { data: result, error } = await service.rpc("record_public_hostname_verification", {
      p_binding_id: bindingId,
      p_evidence: evidence,
    });
    if (error || result !== "verified") {
      return json({ error: "Verified evidence could not be recorded." }, 409);
    }
    return json({ status: "verified" }, 200);
  } catch (error) {
    // Do not echo DNS answers, provider payloads, or challenge material.
    console.error("Hostname verification failed", error instanceof Error ? error.message : "Unknown error");
    return json({ error: "Hostname ownership could not be verified." }, 422);
  }
});

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, max-age=0",
      "CDN-Cache-Control": "no-store",
      "Surrogate-Control": "no-store",
    },
  });
}
