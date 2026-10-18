import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
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

const updateUserInput = z.object({
  target_id: z.string().uuid(),
  full_name: z.string().trim().min(1, "Full name is required"),
  username: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  department: z.string().trim().optional(),
  email: z.string().trim().email("Enter a valid email").optional().or(z.literal("")),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .optional()
    .or(z.literal("")),
});

export type AdminUpdateUserInput = z.infer<typeof updateUserInput>;
export type AdminUpdateUserResult = { ok: true } | { ok: false; error: string };

// Editing an account's name/phone/department/username is a plain profiles
// update (admin_update_profile RPC, runs as the caller so has_permission +
// audit_logs work like everywhere else). Email and password are different:
// they live on auth.users, not profiles, and Supabase only lets the Admin API
// (service-role key) touch them -- so those two fields, when present, go
// through the same server-only admin client adminCreateUser uses above,
// before the RPC call folds the (possibly new) email back into profiles.email
// so it stays in sync with the real login address.
export const adminUpdateUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => updateUserInput.parse(data))
  .handler(async ({ data, context }): Promise<AdminUpdateUserResult> => {
    const { supabase } = context;

    const { data: grants, error: grantsError } = await supabase.rpc("get_my_permissions");
    if (grantsError) return { ok: false, error: grantsError.message };

    const allowed = (grants ?? []).some(
      (g) => g.module === "users" && (g.action === "edit" || g.action === "create"),
    );
    if (!allowed) return { ok: false, error: "You don't have permission to edit user accounts" };

    const newEmail = data.email?.trim() || undefined;
    const newPassword = data.password?.trim() || undefined;

    if (newEmail || newPassword) {
      // The Admin API below bypasses every database guard, so check here that
      // the caller may change this login: only an Admin/Chairman can reset an
      // Admin's or the Chairman's email or password (20261018110000).
      const { data: canManage, error: manageError } = await supabase.rpc("can_manage_account", {
        target_id: data.target_id,
      });
      if (manageError) return { ok: false, error: manageError.message };
      if (!canManage) {
        return {
          ok: false,
          error: "Only an Admin or the Chairman can change an Admin or Chairman login",
        };
      }

      let admin: ReturnType<typeof createAdminClient>;
      try {
        admin = createAdminClient();
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Server is not configured" };
      }

      const patch: { email?: string; password?: string; email_confirm?: boolean } = {};
      if (newEmail) {
        patch.email = newEmail;
        patch.email_confirm = true;
      }
      if (newPassword) patch.password = newPassword;

      const { error: authError } = await admin.auth.admin.updateUserById(data.target_id, patch);
      if (authError) return { ok: false, error: authError.message };
    }

    const { error: profileError } = await supabase.rpc("admin_update_profile", {
      target_id: data.target_id,
      p_full_name: data.full_name,
      p_phone: data.phone || undefined,
      p_department: data.department || undefined,
      p_username: data.username || undefined,
      p_email: newEmail,
    });
    if (profileError) return { ok: false, error: profileError.message };

    return { ok: true };
  });

const deleteUserInput = z.object({ target_id: z.string().uuid() });
export type AdminDeleteUserResult = { ok: true } | { ok: false; error: string };

// A "delete" that only removes profiles/user_roles (delete_user_account, the
// RPC this calls first) leaves the auth.users credential behind. That's the
// exact bug that motivated this function: the email becomes permanently
// stuck -- a later signup with the same address silently no-ops (Supabase's
// anti-enumeration behavior) instead of creating a fresh account. Purging
// auth.users needs the Admin API, hence the service-role client below.
export const adminDeleteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => deleteUserInput.parse(data))
  .handler(async ({ data, context }): Promise<AdminDeleteUserResult> => {
    const { supabase } = context;

    const { data: grants, error: grantsError } = await supabase.rpc("get_my_permissions");
    if (grantsError) return { ok: false, error: grantsError.message };

    const allowed = (grants ?? []).some(
      (g) =>
        g.module === "account-approvals" &&
        (g.action === "create" || g.action === "edit" || g.action === "delete"),
    );
    if (!allowed) return { ok: false, error: "You don't have permission to delete user accounts" };
    if (data.target_id === context.userId) {
      return { ok: false, error: "You cannot delete your own account" };
    }

    // Cleans profiles/user_roles and writes the audit row as the calling
    // admin. Safe to call even if the profile is already gone (an orphaned
    // auth-only record) -- its DELETEs just affect 0 rows, no error.
    const { error: rpcError } = await supabase.rpc("delete_user_account", {
      target_id: data.target_id,
    });
    if (rpcError) return { ok: false, error: rpcError.message };

    let admin: ReturnType<typeof createAdminClient>;
    try {
      admin = createAdminClient();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Server is not configured" };
    }

    const { error: authError } = await admin.auth.admin.deleteUser(data.target_id);
    // "User not found" just means the credential was already gone -- treat
    // that as success rather than surfacing it as a failure to the admin.
    if (authError && !/not.?found/i.test(authError.message)) {
      return { ok: false, error: authError.message };
    }

    return { ok: true };
  });

export type AuthUserRow = {
  id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
};
export type AdminListAuthUsersResult =
  { ok: true; users: AuthUserRow[] } | { ok: false; error: string };

// profiles/user_roles are readable straight from the client with the anon
// key (RLS handles authorization there); the raw auth.users list is not --
// it only exists via the Admin API. This is read-only and exists so the Auth
// Users tab can show every real Supabase Auth record and flag any that have
// no matching profile (an orphan, like the one that started this feature).
export const adminListAuthUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AdminListAuthUsersResult> => {
    const { supabase } = context;

    const { data: grants, error: grantsError } = await supabase.rpc("get_my_permissions");
    if (grantsError) return { ok: false, error: grantsError.message };

    // The Auth Users tab is its own grant; account-approvals managers keep the
    // access they had.
    const allowed = (grants ?? []).some(
      (g) =>
        (g.module === "auth-users" && g.action === "view") ||
        (g.module === "account-approvals" &&
          (g.action === "view" ||
            g.action === "create" ||
            g.action === "edit" ||
            g.action === "delete")),
    );
    if (!allowed) return { ok: false, error: "You don't have permission to view auth users" };

    let admin: ReturnType<typeof createAdminClient>;
    try {
      admin = createAdminClient();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Server is not configured" };
    }

    const { data: listed, error: listError } = await admin.auth.admin.listUsers({
      perPage: 1000,
    });
    if (listError) return { ok: false, error: listError.message };

    const users: AuthUserRow[] = listed.users.map((u) => ({
      id: u.id,
      email: u.email ?? null,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at ?? null,
      email_confirmed_at: u.email_confirmed_at ?? null,
    }));

    return { ok: true, users };
  });

// Public self-signup, used by the sign-up form instead of supabase.auth.signUp.
// signUp sends a confirmation email whenever "Confirm email" is on for the
// hosted project, and Supabase's built-in mailer only allows a few auth emails
// an hour, so signups past that failed with "email rate limit exceeded".
// Creating the user through the Admin API with email_confirm sends no mail.
// Nothing is granted here: handle_new_user() gives the account a 'pending'
// profile, and roles only come from an admin approving it, exactly as with
// signUp. No auth middleware -- the caller isn't signed in yet -- so the input
// is limited to the same fields the form sent to signUp.
const signUpInput = z.object({
  email: z.string().trim().min(1, "Email is required").email("Enter a valid email"),
  password: z.string().min(6, "Password must be at least 6 characters").max(72),
  full_name: z.string().trim().min(1, "Full name is required").max(120),
  username: z.string().trim().max(60).optional(),
  phone: z.string().trim().max(30).optional(),
  department: z.string().trim().max(60).optional(),
  role_requested: z.string().trim().min(1, "Select the role you're requesting").max(60),
});

export type PublicSignUpResult = { ok: true } | { ok: false; error: string };

// This endpoint is open to the internet and creates confirmed accounts with
// the secret key, so cap how fast one address can call it. In-memory is
// enough for the single Render instance; a restart just resets the counts.
const SIGNUP_WINDOW_MS = 15 * 60 * 1000;
const SIGNUP_MAX_PER_WINDOW = 5;
const signUpAttempts = new Map<string, number[]>();

function signUpRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (signUpAttempts.get(ip) ?? []).filter((t) => now - t < SIGNUP_WINDOW_MS);
  recent.push(now);
  signUpAttempts.set(ip, recent);
  if (signUpAttempts.size > 10_000) {
    for (const [key, times] of signUpAttempts) {
      if (times.every((t) => now - t >= SIGNUP_WINDOW_MS)) signUpAttempts.delete(key);
    }
  }
  return recent.length > SIGNUP_MAX_PER_WINDOW;
}

export const publicSignUp = createServerFn({ method: "POST" })
  .validator((data: unknown) => signUpInput.parse(data))
  .handler(async ({ data }): Promise<PublicSignUpResult> => {
    const headers = getRequest()?.headers;
    const ip =
      headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      headers?.get("x-real-ip") ||
      "unknown";
    if (signUpRateLimited(ip)) {
      return { ok: false, error: "Too many sign-up attempts. Please try again in a few minutes." };
    }

    let admin: ReturnType<typeof createAdminClient>;
    try {
      admin = createAdminClient();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Server is not configured" };
    }

    // The requested role is only a note for the approving admin, but keep it to
    // real, non-owner roles so the Pending list never shows nonsense (and the
    // Approve dialog, which pre-fills it, never offers Admin or Chairman).
    const { data: role } = await admin
      .from("roles")
      .select("slug")
      .eq("slug", data.role_requested)
      .maybeSingle();
    if (!role || data.role_requested === "super_admin" || data.role_requested === "chairman") {
      return { ok: false, error: "Select a valid role" };
    }

    const { error } = await admin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: {
        full_name: data.full_name,
        username: data.username || undefined,
        phone: data.phone || undefined,
        department: data.department || undefined,
        role_requested: data.role_requested,
      },
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });
