import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UsersTab } from "@/components/admin/users-tab";
import { PendingTab } from "@/components/admin/pending-tab";
import { PermissionsTab } from "@/components/admin/permissions-tab";
import { FactoryTab } from "@/components/admin/factory-tab";
import { AuthUsersTab } from "@/components/admin/auth-users-tab";
import { DeleteRequestsTab } from "@/components/admin/delete-requests-tab";
import { DeletedSalesTab } from "@/components/admin/deleted-sales-tab";
import { AuditLogsPage } from "./_app.audit-logs";
import { usePermissions, type ModuleKey } from "@/lib/permissions";

export const Route = createFileRoute("/_app/admin")({
  head: () => ({
    meta: [{ title: "Admin Panel — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
  component: AdminPanelPage,
});

// Every tab is its own permission, so an admin can hand someone one tab
// without the rest (Permissions -> Page access, or a role). The page opens for
// anyone holding at least one tab and shows only those. The database enforces
// the same keys (migration 20261014210000), so a granted tab actually loads.
const TABS: { value: string; label: string; module: ModuleKey; render: () => React.ReactNode }[] = [
  { value: "users", label: "Users", module: "users", render: () => <UsersTab /> },
  { value: "pending", label: "Pending", module: "account-approvals", render: () => <PendingTab /> },
  {
    value: "delete-requests",
    label: "Delete Requests",
    module: "delete-requests",
    render: () => <DeleteRequestsTab />,
  },
  {
    value: "deleted-sales",
    label: "Deleted Sales",
    module: "deleted-sales",
    render: () => <DeletedSalesTab />,
  },
  {
    value: "permissions",
    label: "Permissions",
    module: "permissions",
    render: () => <PermissionsTab />,
  },
  { value: "audit-log", label: "Audit Log", module: "audit-logs", render: () => <AuditLogsPage /> },
  // A count of users per factory -- part of user administration.
  { value: "factory", label: "Factory", module: "users", render: () => <FactoryTab /> },
  {
    value: "auth-users",
    label: "Auth Users",
    module: "auth-users",
    render: () => <AuthUsersTab />,
  },
];

function AdminPanelPage() {
  const { can, loading } = usePermissions();
  const visible = TABS.filter((t) => can(t.module));
  const [tab, setTab] = useState<string | null>(null);
  const current = visible.find((t) => t.value === tab)?.value ?? visible[0]?.value;

  if (loading) return null;
  if (visible.length === 0) {
    return (
      <Card className="rounded-2xl border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" /> Access restricted
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          You don&apos;t have access to any part of the Admin Panel. Ask an admin to grant the tab
          you need.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Admin Panel</h1>
        <p className="text-sm text-muted-foreground">System administration</p>
      </div>

      <Tabs value={current} onValueChange={setTab} className="space-y-4">
        <div className="overflow-x-auto pb-1">
          <TabsList className="w-max">
            {visible.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {visible.map((t) => (
          <TabsContent key={t.value} value={t.value}>
            {t.render()}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
