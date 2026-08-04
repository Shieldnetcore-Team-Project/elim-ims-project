// admin-provision-user
//
// The one privileged path this backend foundation actually needs: every new
// signup lands with the zero-permission 'Unassigned' role (see
// handle_new_user, 20260803120000) — secure by default. This function is how
// a System administrator turns that into a real account: invite by email
// (which fires handle_new_user() the same as any other signup), then assign
// the real role_id/employee_id.
//
// POST body: { email: string, fullName?: string, roleId: string, employeeId?: string }
import { handleCorsPreflight, corsHeaders } from "../_shared/cors.ts";
import { createServiceRoleClient } from "../_shared/supabaseClient.ts";
import { requireSuperAdmin, ForbiddenError, UnauthorizedError } from "../_shared/authGuard.ts";

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    await requireSuperAdmin(req);

    const { email, fullName, roleId, employeeId } = await req.json();
    if (!email || !roleId) {
      return new Response(JSON.stringify({ error: "email and roleId are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createServiceRoleClient();

    // Fires handle_new_user() (20260803120000) — provisions a public.users
    // row with the 'Unassigned' role, same as any other signup.
    const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
      data: fullName ? { full_name: fullName } : undefined,
    });
    if (inviteError) throw inviteError;

    const { data: updated, error: updateError } = await admin
      .from("users")
      .update({ role_id: roleId, employee_id: employeeId ?? null })
      .eq("auth_user_id", invited.user.id)
      .select()
      .single();
    if (updateError) throw updateError;

    return new Response(JSON.stringify({ user: updated }), {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const status = err instanceof UnauthorizedError || err instanceof ForbiddenError ? err.status : 500;
    const message = err instanceof Error ? err.message : "Unexpected error";
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
