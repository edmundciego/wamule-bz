import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleSuperAdminConsole } from "../_shared/super-admin-console.mjs";

const expectedProjectRef = Deno.env.get("WAMULE_EXPECTED_SUPABASE_PROJECT_REF") ?? "kvocwmrcuhiaezlcgzjf";
const env = {
  SUPABASE_URL: Deno.env.get("SUPABASE_URL"),
  SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY"),
  // The CLI reserves SUPABASE_* names in --env-file. Its local injected key
  // can differ from the running stack's status key, so allow a test-only alias
  // only when this process is explicitly pinned to the disposable local ref.
  SUPABASE_SERVICE_ROLE_KEY: expectedProjectRef === "local"
    ? Deno.env.get("WAMULE_LOCAL_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  // Local verification explicitly sets this to "local". Deployed staging is
  // pinned by default; production and arbitrary projects are rejected by the
  // shared provisioning service before any RPC is called.
  WAMULE_EXPECTED_SUPABASE_PROJECT_REF: expectedProjectRef,
};

Deno.serve((request) => handleSuperAdminConsole(request, { env, createClient }));
