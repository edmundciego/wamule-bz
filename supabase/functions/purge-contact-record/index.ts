const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * Deliberately disabled.
 *
 * The historical purge implementation is preserved in git history, but its
 * database foundation was retired when financial records became immutable.
 * Do not deploy a destructive purge endpoint until an approved replacement
 * migration, role test plan, storage cleanup design, and recovery procedure
 * exist and have been verified in an isolated environment.
 */
Deno.serve((request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return Response.json(
    { error: "Record purge is disabled. Use the approved correction, cancellation, archival, or anonymization workflows." },
    { status: 503, headers: corsHeaders },
  );
});
