import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { adminDeleteUser } from "@/lib/admin-users";
import type { ProductionScope, Role } from "@/lib/permissions";
import { toast } from "sonner";

// Shared data/mutations behind the Admin Panel's Users and Pending tabs --
// both are views over the same profiles/user_roles rows, split by
// `status`, so the queries and every mutation that changes a row live here
// once instead of twice.

export type Account = {
  id: string;
  full_name: string | null;
  username: string | null;
  email: string | null;
  phone: string | null;
  department: string | null;
  role_requested: Role | null;
  requested_factory_id: string | null;
  production_scope: ProductionScope;
  status: string;
  created_at: string;
  avatar_url: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_reason: string | null;
  rejected_at: string | null;
  created_by: string | null;
};

export type Factory = { id: string; name: string };
export type UserRoleRow = { user_id: string; role: Role; factory_id: string | null };

export function useAccountsAdmin() {
  const qc = useQueryClient();

  const accounts = useQuery({
    queryKey: ["all-accounts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Account[];
    },
  });

  const lastLogins = useQuery({
    queryKey: ["users-last-login"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_all_users_last_login");
      if (error) throw error;
      const map = new Map<string, string | null>();
      for (const row of data ?? []) map.set(row.id, row.last_sign_in_at);
      return map;
    },
  });

  const factories = useQuery({
    queryKey: ["factories-all"],
    queryFn: async () => {
      const { data, error } = await supabase.from("factories").select("id,code,name");
      if (error) throw error;
      return (data ?? []) as (Factory & { code: string })[];
    },
  });

  const userRoles = useQuery({
    queryKey: ["all-user-roles"],
    queryFn: async () => {
      const { data, error } = await supabase.from("user_roles").select("user_id,role,factory_id");
      if (error) throw error;
      return (data ?? []) as UserRoleRow[];
    },
  });

  const rolesFor = (userId: string) => (userRoles.data ?? []).filter((r) => r.user_id === userId);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["all-accounts"] });
    qc.invalidateQueries({ queryKey: ["all-user-roles"] });
    qc.invalidateQueries({ queryKey: ["admin-panel"] });
  };

  const approve = useMutation({
    mutationFn: async ({
      account,
      role,
      department,
    }: {
      account: Account;
      role: Role;
      department: string;
    }) => {
      const { error } = await supabase.rpc("approve_user", {
        target_id: account.id,
        granted_role: role,
        p_department: department || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Account approved");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reject = useMutation({
    mutationFn: async ({ account, reason }: { account: Account; reason: string }) => {
      const { error } = await supabase.rpc("reject_user", { target_id: account.id, reason });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Account rejected");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setStatus = useMutation({
    mutationFn: async ({
      id,
      status,
    }: {
      id: string;
      status: "suspended" | "deactivated" | "active";
    }) => {
      const { error } = await supabase.rpc("set_user_status", {
        target_id: id,
        new_status: status,
      });
      if (error) throw error;
    },
    onSuccess: (_r, vars) => {
      toast.success(`Account ${vars.status}`);
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setProductionScope = useMutation({
    mutationFn: async ({ userId, scope }: { userId: string; scope: ProductionScope }) => {
      const { error } = await supabase.rpc("set_production_scope", {
        p_user_id: userId,
        p_scope: scope,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Bypasses the request/approve/post maker-checker chain on purpose -- see
  // supabase/migrations/20260915090000_admin_direct_role_assign.sql. Only a
  // super_admin can call this; the RPC itself enforces that.
  const setRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: Role }) => {
      const { error } = await supabase.rpc("admin_set_user_role", {
        target_user_id: userId,
        new_role: role,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const result = await adminDeleteUser({ data: { target_id: id } });
      if (!result.ok) throw new Error(result.error);
    },
    onSuccess: () => {
      toast.success("Account permanently deleted");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resetPassword = async (email: string | null) => {
    if (!email) return toast.error("This account has no email on file");
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) return toast.error(error.message);
    toast.success(`Password reset email sent to ${email}`);
  };

  return {
    accounts,
    lastLogins,
    factories,
    userRoles,
    rolesFor,
    approve,
    reject,
    setStatus,
    setProductionScope,
    setRole,
    remove,
    resetPassword,
    invalidateAll,
  };
}
