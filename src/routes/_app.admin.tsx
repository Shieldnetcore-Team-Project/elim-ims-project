import { createFileRoute } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { RequireAccess } from "@/components/layout/require-access";
import { useAllRoles } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  KeyRound,
  Mail,
  UserCheck,
  UserCog,
  Users as UsersIcon,
  PauseCircle,
  ShieldPlus,
} from "lucide-react";
import { UsersPage } from "./_app.users";
import { RoleManagementPage } from "./_app.role-management";
import { PermissionsPage } from "./_app.permissions";
import { ApprovalWorkflowsPage } from "./_app.approval-workflows";
import { AccountApprovalsPage } from "./_app.account-approvals";
import { AuditLogsPage } from "./_app.audit-logs";
import { SettingsPage } from "./_app.settings";

export const Route = createFileRoute("/_app/admin")({
  head: () => ({
    meta: [{ title: "Admin Panel — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="users">
      <AdminPanelPage />
    </RequireAccess>
  ),
});

type PendingAccount = {
  id: string;
  full_name: string | null;
  email: string | null;
  role_requested: string | null;
  created_at: string;
};

// Each area tab renders the real page component, wrapped in its own access
// gate so per-module permissions still apply inside the panel. Descriptions
// mirror the tab list the user walks through.
const AREA_TABS: {
  value: string;
  label: string;
  description: string;
  render: () => ReactNode;
}[] = [
  {
    value: "users",
    label: "Users & Roles",
    description: "Assign or remove roles, set production scope. Changes go through maker-checker.",
    render: () => (
      <RequireAccess module="users">
        <UsersPage />
      </RequireAccess>
    ),
  },
  {
    value: "role-management",
    label: "Role Management",
    description: "Create, rename, and describe roles.",
    render: () => (
      <RequireAccess module="users">
        <RoleManagementPage />
      </RequireAccess>
    ),
  },
  {
    value: "permissions",
    label: "Roles & Permissions",
    description: "Set which module actions each role can perform.",
    render: () => (
      <RequireAccess module="users">
        <PermissionsPage />
      </RequireAccess>
    ),
  },
  {
    value: "approval-workflows",
    label: "Approval Workflows",
    description: "Configure who approves what, and in how many steps.",
    render: () => (
      <RequireAccess module="users">
        <ApprovalWorkflowsPage />
      </RequireAccess>
    ),
  },
  {
    value: "account-approvals",
    label: "Account Approvals",
    description:
      "Approve or reject new registrations; suspend, deactivate, reinstate, reset password, or delete accounts.",
    render: () => (
      <RequireAccess module="account-approvals">
        <AccountApprovalsPage />
      </RequireAccess>
    ),
  },
  {
    value: "audit-logs",
    label: "Audit Logs",
    description: "Every action, who did it, and when.",
    render: () => (
      <RequireAccess module="audit-logs">
        <AuditLogsPage />
      </RequireAccess>
    ),
  },
  {
    value: "settings",
    label: "System Settings",
    description: "Factory-wide configuration.",
    render: () => (
      <RequireAccess module="settings">
        <SettingsPage />
      </RequireAccess>
    ),
  },
];

function AdminPanelPage() {
  const [tab, setTab] = useState("overview");
  const allRoles = useAllRoles();
  const roleLabel = (slug: string | null) =>
    slug ? (allRoles.data?.find((r) => r.slug === slug)?.label ?? slug) : "—";

  const [resetEmail, setResetEmail] = useState("");
  const [sendingReset, setSendingReset] = useState(false);

  const accounts = useQuery({
    queryKey: ["admin-panel", "accounts-summary"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name,email,role_requested,status,created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as (PendingAccount & { status: string })[];
    },
  });

  const roleRequests = useQuery({
    queryKey: ["admin-panel", "role-grant-requests"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("role_grant_requests")
        .select("id,status")
        .in("status", ["pending_approval", "approved", "posted"]);
      if (error) throw error;
      return (data ?? []) as { id: string; status: string }[];
    },
  });

  const rows = accounts.data ?? [];
  const pending = rows.filter((a) => a.status === "pending");
  const suspended = rows.filter(
    (a) => a.status === "suspended" || a.status === "deactivated",
  ).length;
  const pendingRoleChanges = (roleRequests.data ?? []).filter(
    (r) => r.status === "pending_approval",
  ).length;

  const stats = [
    { label: "Pending approvals", value: pending.length, goto: "account-approvals", icon: UserCheck },
    { label: "Pending role changes", value: pendingRoleChanges, goto: "users", icon: UserCog },
    { label: "Total accounts", value: rows.length, goto: "account-approvals", icon: UsersIcon },
    {
      label: "Suspended / inactive",
      value: suspended,
      goto: "account-approvals",
      icon: PauseCircle,
    },
    {
      label: "Roles defined",
      value: allRoles.data?.length ?? 0,
      goto: "role-management",
      icon: ShieldPlus,
    },
  ];

  const sendReset = async () => {
    const email = resetEmail.trim();
    if (!email) return toast.error("Enter the user's email");
    setSendingReset(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setSendingReset(false);
    if (error) return toast.error(error.message);
    toast.success(`Password reset email sent to ${email}`);
    setResetEmail("");
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Admin Panel</h1>
        <p className="text-sm text-muted-foreground">
          User access, account approvals, roles, permissions, and password resets — all in one
          place.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <div className="overflow-x-auto pb-1">
          <TabsList className="w-max">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            {AREA_TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {stats.map((s) => (
              <button key={s.label} type="button" onClick={() => setTab(s.goto)} className="text-left">
                <Card className="rounded-2xl transition-colors hover:border-primary/40">
                  <CardContent className="flex items-center justify-between gap-2 py-4">
                    <div>
                      <div className="text-2xl font-semibold">{s.value}</div>
                      <div className="text-xs text-muted-foreground">{s.label}</div>
                    </div>
                    <s.icon className="h-5 w-5 shrink-0 text-muted-foreground" />
                  </CardContent>
                </Card>
              </button>
            ))}
          </div>

          <Card className="rounded-2xl">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <UserCheck className="h-4 w-4" /> Accounts awaiting approval
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTab("account-approvals")}
              >
                Open Account Approvals
              </Button>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Role requested</TableHead>
                    <TableHead>Registered</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pending.slice(0, 8).map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium">{a.full_name ?? "—"}</TableCell>
                      <TableCell className="text-xs">{a.email ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{roleLabel(a.role_requested)}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(a.created_at).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                  {pending.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                        No accounts waiting for approval.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              {pending.length > 8 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  +{pending.length - 8} more on the Account Approvals tab.
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-4 w-4" /> Send a password reset
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Emails the user a secure link to set a new password. They stay signed out until
                they use it.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="reset-email">User email</Label>
                  <Input
                    id="reset-email"
                    type="email"
                    placeholder="user@example.com"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && sendReset()}
                  />
                </div>
                <Button onClick={sendReset} disabled={sendingReset} className="gap-1">
                  <Mail className="h-4 w-4" />
                  {sendingReset ? "Sending…" : "Send reset link"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                You can also reset a specific account from the Account Approvals tab.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {AREA_TABS.map((t) => (
          <TabsContent key={t.value} value={t.value} className="space-y-4">
            <p className="text-sm text-muted-foreground">{t.description}</p>
            {t.render()}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
