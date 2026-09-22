import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { RequireAccess } from "@/components/layout/require-access";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UsersTab } from "@/components/admin/users-tab";
import { PendingTab } from "@/components/admin/pending-tab";
import { PermissionsTab } from "@/components/admin/permissions-tab";
import { FactoryTab } from "@/components/admin/factory-tab";
import { AuthUsersTab } from "@/components/admin/auth-users-tab";
import { DeleteRequestsTab } from "@/components/admin/delete-requests-tab";
import { DeletedSalesTab } from "@/components/admin/deleted-sales-tab";
import { AuditLogsPage } from "./_app.audit-logs";
import { useIsSuperAdmin } from "@/lib/permissions";

export const Route = createFileRoute("/_app/admin")({
  head: () => ({
    meta: [{ title: "Admin Panel — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="users">
      <AdminPanelPage />
    </RequireAccess>
  ),
});

function AdminPanelPage() {
  const [tab, setTab] = useState("users");
  const isSuperAdmin = useIsSuperAdmin();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Admin Panel</h1>
        <p className="text-sm text-muted-foreground">System administration</p>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <div className="overflow-x-auto pb-1">
          <TabsList className="w-max">
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="pending">Pending</TabsTrigger>
            {isSuperAdmin.data && (
              <TabsTrigger value="delete-requests">Delete Requests</TabsTrigger>
            )}
            {isSuperAdmin.data && (
              <TabsTrigger value="deleted-sales">Deleted Sales</TabsTrigger>
            )}
            <TabsTrigger value="permissions">Permissions</TabsTrigger>
            <TabsTrigger value="audit-log">Audit Log</TabsTrigger>
            <TabsTrigger value="factory">Factory</TabsTrigger>
            <TabsTrigger value="auth-users">Auth Users</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="users">
          <UsersTab />
        </TabsContent>
        <TabsContent value="pending">
          <PendingTab />
        </TabsContent>
        {isSuperAdmin.data && (
          <TabsContent value="delete-requests">
            <DeleteRequestsTab />
          </TabsContent>
        )}
        {isSuperAdmin.data && (
          <TabsContent value="deleted-sales">
            <DeletedSalesTab />
          </TabsContent>
        )}
        <TabsContent value="permissions">
          <PermissionsTab />
        </TabsContent>
        <TabsContent value="audit-log">
          <AuditLogsPage />
        </TabsContent>
        <TabsContent value="factory">
          <FactoryTab />
        </TabsContent>
        <TabsContent value="auth-users">
          <AuthUsersTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
