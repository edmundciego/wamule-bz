import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleSuperAdminConsole } from "../_shared/super-admin-console.mjs";

const env = {
  SUPABASE_URL: Deno.env.get("SUPABASE_URL"),
  SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY"),
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  // Local verification explicitly sets this to "local". Deployed staging is
  // pinned by default; production and arbitrary projects are rejected by the
  // shared provisioning service before any RPC is called.
  WAMULE_EXPECTED_SUPABASE_PROJECT_REF: Deno.env.get("WAMULE_EXPECTED_SUPABASE_PROJECT_REF") ?? "kvocwmrcuhiaezlcgzjf",
};

Deno.serve((request) => handleSuperAdminConsole(request, { env, createClient }));
