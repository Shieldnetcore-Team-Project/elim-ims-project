import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// Service-role client — bypasses RLS entirely. Only ever used inside an Edge
// Function after authGuard.ts has independently verified the caller (never
// pass the caller's own JWT through to this client). Deno.env, not
// import.meta.env — Edge Functions run on Deno, not Vite.
export function createServiceRoleClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the function's environment");
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Caller-scoped client — every query still goes through RLS as that specific
// user. Use this (not the service-role client) whenever a function should
// only be able to do what the calling user could already do directly.
export function createUserScopedClient(authHeader: string): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in the function's environment");
  }
  return createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
