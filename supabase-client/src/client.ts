import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

// Vite-flavored env access (import.meta.env) — this package targets the
// future React 19/Vite frontend. Edge Functions (supabase/functions/) run on
// Deno and read Deno.env instead; they have their own client factory in
// supabase/functions/_shared/supabaseClient.ts, not this one.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  throw new Error(
    "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (see supabase/config.toml for local values).",
  );
}

export const supabase = createClient<Database>(url, anonKey);
