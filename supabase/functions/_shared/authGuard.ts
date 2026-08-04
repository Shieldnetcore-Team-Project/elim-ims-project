import { createUserScopedClient } from "./supabaseClient.ts";

export class UnauthorizedError extends Error {
  status = 401;
}
export class ForbiddenError extends Error {
  status = 403;
}

// Verifies the caller's JWT is valid and returns the authenticated
// auth.users id. Throws UnauthorizedError (never returns null) so callers
// can skip an explicit null-check and just let it propagate to a 401.
export async function requireUser(req: Request): Promise<{ authUserId: string; authHeader: string }> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new UnauthorizedError("Missing Authorization header");

  const client = createUserScopedClient(authHeader);
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new UnauthorizedError("Invalid or expired session");

  return { authUserId: data.user.id, authHeader };
}

// Calls the is_super_admin() RLS helper (20260803120200) via RPC as the
// caller's own scoped client — so this reuses the exact same check RLS
// policies already use, rather than a second, potentially-divergent
// definition of "who's an admin" living in application code.
export async function requireSuperAdmin(req: Request): Promise<{ authUserId: string }> {
  const { authUserId, authHeader } = await requireUser(req);
  const client = createUserScopedClient(authHeader);
  const { data, error } = await client.rpc("is_super_admin");
  if (error) throw error;
  if (!data) throw new ForbiddenError("System administrator access required");
  return { authUserId };
}
