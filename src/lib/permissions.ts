import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// Roles are real data (public.roles), not a fixed enum, so a super_admin can
// create/rename/describe roles from the UI without a code deploy. `Role` is
// just whatever slug a role row happens to have.
export type Role = string;

export type RoleRow = {
  slug: string;
  label: string;
  description: string | null;
  is_system: boolean;
};

export function useAllRoles() {
  return useQuery({
    queryKey: ["all-roles"],
    queryFn: async (): Promise<RoleRow[]> => {
      const { data, error } = await supabase
        .from("roles")
        .select("slug,label,description,is_system")
        .order("label");
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 60_000,
  });
}

export function useIsSuperAdmin() {
  return useQuery({
    queryKey: ["is-super-admin"],
    queryFn: async () => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return false;
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userData.user.id)
        .eq("role", "super_admin")
        .maybeSingle();
      if (error) throw error;
      return !!data;
    },
  });
}

export type ModuleKey =
  | "dashboard"
  | "sales"
  | "production"
  | "production-requests"
  | "purchase-orders"
  | "raw-materials"
  | "finished-goods"
  | "finance"
  | "expenses"
  | "payroll"
  | "payments"
  | "receipts-payments"
  | "cash-flow"
  | "debts"
  | "customers"
  | "suppliers"
  | "employees"
  | "reports"
  | "users"
  | "account-approvals"
  | "audit-logs"
  | "settings"
  | "costing"
  | "logistics"
  | "distribution"
  | "approvals"
  | "goods-receiving";

export const ALL_MODULES: ModuleKey[] = [
  "dashboard",
  "sales",
  "production",
  "production-requests",
  "purchase-orders",
  "raw-materials",
  "finished-goods",
  "finance",
  "expenses",
  "payroll",
  "payments",
  "receipts-payments",
  "cash-flow",
  "debts",
  "customers",
  "suppliers",
  "employees",
  "reports",
  "users",
  "account-approvals",
  "audit-logs",
  "settings",
  "costing",
  "logistics",
  "distribution",
  "approvals",
  "goods-receiving",
];

export const MODULE_LABELS: Record<ModuleKey, string> = {
  dashboard: "Dashboard",
  sales: "Sales",
  production: "Production",
  "production-requests": "Purchase/Production Requests",
  "purchase-orders": "Purchase Orders",
  "raw-materials": "Raw Materials",
  "finished-goods": "Finished Goods (Store)",
  finance: "Finance",
  expenses: "Expenses",
  payroll: "Payroll",
  payments: "Payments",
  "receipts-payments": "Receipts & Payments",
  "cash-flow": "Cash Flow",
  debts: "Debts",
  customers: "Customers",
  suppliers: "Suppliers",
  employees: "Employees",
  reports: "Reports",
  users: "Users",
  "account-approvals": "Account Approvals",
  "audit-logs": "Audit Logs",
  settings: "Settings",
  costing: "Costing",
  logistics: "Logistics",
  distribution: "Distribution (Sales Reps)",
  approvals: "Approvals",
  "goods-receiving": "Goods Receiving",
};

// Level 2 of the dual-operation model: independent, non-hierarchical action
// grants (see supabase/migrations/20260815094000_action_permission_and_status_engine.sql).
// Holding APPROVE on a module implies nothing about CREATE, and vice versa —
// unlike the old read/write/approve rank, these are separate on/off switches.
export type Action =
  | "view"
  | "create"
  | "edit"
  | "submit"
  | "approve"
  | "reject"
  | "confirm"
  | "post"
  | "reverse"
  | "cancel"
  | "export"
  | "print"
  | "delete";

export const ALL_ACTIONS: Action[] = [
  "view",
  "create",
  "edit",
  "submit",
  "approve",
  "reject",
  "confirm",
  "post",
  "reverse",
  "cancel",
  "export",
  "print",
  "delete",
];

// Permissions are never hardcoded here. role_permissions + permission_overrides
// in the database are the single source of truth (has_permission()/
// get_my_permissions() in supabase/migrations/20260815094000_...) — this hook
// only asks the server which (module, action) pairs the caller holds, so the
// UI can never drift from what RLS and the RPC guards actually enforce. A
// signed-out caller gets nothing back, which is what makes DB/RPC-level
// enforcement visible in the UI instead of silently failing underneath an
// interface that still looks usable.
export function useMyPermissions() {
  return useQuery({
    queryKey: ["my-permissions"],
    queryFn: async (): Promise<{ access: Record<string, Set<Action>>; signedIn: boolean }> => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return { access: {}, signedIn: false };

      const { data, error } = await supabase.rpc("get_my_permissions");
      if (error) throw error;

      const access: Record<string, Set<Action>> = {};
      for (const row of (data ?? []) as { module: ModuleKey; action: Action }[]) {
        const set = access[row.module] ?? (access[row.module] = new Set());
        set.add(row.action);
      }
      return { access, signedIn: true };
    },
    staleTime: 60_000,
  });
}

// Raw role list for the signed-in user — used where the UI needs to pick a
// variant (e.g. which dashboard layout to show) rather than a yes/no gate.
// Permission checks everywhere else should keep using usePermissions(), not
// this — roles are an implementation detail, actions/modules are the contract.
export function useMyRoles() {
  return useQuery({
    queryKey: ["my-roles"],
    queryFn: async (): Promise<Role[]> => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return [];
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userData.user.id);
      if (error) throw error;
      return (data ?? []).map((r) => r.role as Role);
    },
    staleTime: 60_000,
  });
}

export type ProductionScope = "NYLON" | "WATER" | "BOTH";

// The caller's own production_scope (profiles.production_scope) — NYLON/WATER
// restrict which factory's Production module they can see/act in (enforced
// server-side by has_production_scope_access()); BOTH (the default for every
// existing account) means unrestricted, matching pre-feature behaviour.
export function useMyProductionScope() {
  return useQuery({
    queryKey: ["my-production-scope"],
    queryFn: async (): Promise<ProductionScope> => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return "BOTH";
      const { data, error } = await supabase
        .from("profiles")
        .select("production_scope")
        .eq("id", userData.user.id)
        .maybeSingle();
      if (error) throw error;
      return (data?.production_scope as ProductionScope | undefined) ?? "BOTH";
    },
    staleTime: 60_000,
  });
}

export function usePermissions() {
  const { data, isLoading } = useMyPermissions();
  const access = data?.access ?? {};
  const signedIn = data?.signedIn ?? false;

  const can = (module: ModuleKey, action: Action = "view"): boolean =>
    access[module]?.has(action) ?? false;

  return {
    signedIn,
    loading: isLoading,
    can,
    canView: (m: ModuleKey) => can(m, "view"),
    canCreate: (m: ModuleKey) => can(m, "create"),
    canEdit: (m: ModuleKey) => can(m, "edit"),
    canSubmit: (m: ModuleKey) => can(m, "submit"),
    canApprove: (m: ModuleKey) => can(m, "approve"),
    canReject: (m: ModuleKey) => can(m, "reject"),
    canConfirm: (m: ModuleKey) => can(m, "confirm"),
    canPost: (m: ModuleKey) => can(m, "post"),
    canReverse: (m: ModuleKey) => can(m, "reverse"),
    canCancel: (m: ModuleKey) => can(m, "cancel"),
    canExport: (m: ModuleKey) => can(m, "export"),
    canPrint: (m: ModuleKey) => can(m, "print"),
    canDelete: (m: ModuleKey) => can(m, "delete"),
    // Backward-compat alias used across the non-workflow pages: "can I create/
    // edit here at all" — maps to CREATE, the closest fine-grained equivalent
    // of the old blanket 'write' tier for plain CRUD modules.
    canWrite: (m: ModuleKey) => can(m, "create"),
  };
}
