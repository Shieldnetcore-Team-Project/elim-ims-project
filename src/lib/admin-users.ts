import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

// Creating a login credential needs the Supabase Admin API, which needs the
// service-role/secret key. That key must never reach the browser, so this runs
// as a server function: TanStack Start strips the `.handler()` body out of the
// client bundle, and the caller's own JWT arrives via `attachSupabaseAuth`
// (registered globally in src/start.ts) and is verified by `requireSupabaseAuth`
// before anything below executes.

const createUserInput = z.object({
  email: z.string().trim().min(1, "Email is required").email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  full_name: z.string().trim().min(1, "Full name is required"),
  username: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  department: z.string().trim().optional(),
  role: z.string().trim().min(1, "Select a role"),
  factory_id: z.string().uuid().optional(),
  production_scope: z.enum(["NYLON", "WATER", "BOTH"]).optional(),
});

export type AdminCreateUserInput = z.infer<typeof createUserInput>;

function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

// Same shape as the helper in client.ts / auth-middleware.ts. Those two files are
// marked auto-generated ("Do not edit it directly"), so this is copied rather
// than extracted into a shared module they'd both have to import.
function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    // New Supabase API keys are opaque strings, not bearer JWTs.
    if (
      isNewSupabaseApiKey(supabaseKey) &&
      headers.get("Authorization") === `Bearer ${supabaseKey}`
    ) {
      headers.delete("Authorization");
    }

    headers.set("apikey", supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

function createAdminClient() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  // `sb_secret_...` is the current key format; SUPABASE_SERVICE_ROLE_KEY is the
  // legacy JWT name. Either works.
  const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SECRET_KEY) {
    throw new Error(
      "Admin user creation is not configured on the server. Set SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) in the server environment.",
    );
  }

  return createClient<Database>(SUPABASE_URL, SECRET_KEY, {
    global: { fetch: createSupabaseFetch(SECRET_KEY) },
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
}

// Outcomes a caller can act on (already-taken email, missing permission, a
// failed provision) come back as data rather than thrown exceptions, so the UI
// gets the real message instead of whatever a serialized server-side throw
// happens to look like. Schema violations still throw from the validator —
// the form prevents those, so they only mean a tampered request.
export type AdminCreateUserResult =
  { ok: true; id: string; email: string } | { ok: false; error: string };

export const adminCreateUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => createUserInput.parse(data))
  .handler(async ({ data, context }): Promise<AdminCreateUserResult> => {
    const { supabase } = context;

    // admin_provision_user() enforces account-approvals:write itself, but that
    // guard only runs *after* the auth user exists. Check up front so a
    // non-admin can't use this to create login credentials at all.
    const { data: grants, error: grantsError } = await supabase.rpc("get_my_permissions");
    if (grantsError) return { ok: false, error: grantsError.message };

    // 'write' in the RPC guard is a legacy alias satisfied by create/edit/delete
    // (see 20260815094000) — mirror that here rather than inventing a stricter rule.
    const allowed = (grants ?? []).some(
      (g) =>
        g.module === "account-approvals" &&
        (g.action === "create" || g.action === "edit" || g.action === "delete"),
    );
    if (!allowed) return { ok: false, error: "You don't have permission to create user accounts" };

    let admin: ReturnType<typeof createAdminClient>;
    try {
      admin = createAdminClient();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Server is not configured" };
    }

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      // The whole point: no confirmation mail, no rate limit, account usable now.
      email_confirm: true,
      user_metadata: {
        full_name: data.full_name,
        username: data.username || undefined,
        phone: data.phone || undefined,
        department: data.department || undefined,
        role_requested: data.role,
        requested_factory_id: data.factory_id || undefined,
      },
    });

    if (createError || !created?.user) {
      return { ok: false, error: createError?.message ?? "Could not create the account" };
    }

    // handle_new_user() has already inserted a 'pending' profile by this point
    // (the trigger is synchronous). Finish it as the calling admin so
    // created_by/approved_by and the audit row name a real person, not the
    // service role.
    const { error: provisionError } = await supabase.rpc("admin_provision_user", {
      target_id: created.user.id,
      p_role: data.role,
      p_department: data.department || undefined,
      p_factory_id: data.factory_id || undefined,
      p_production_scope: data.production_scope || undefined,
    });

    if (provisionError) {
      // Don't leave a usable credential attached to a half-built account.
      await admin.auth.admin.deleteUser(created.user.id);
      return { ok: false, error: provisionError.message };
    }

    return { ok: true, id: created.user.id, email: data.email };
  });
