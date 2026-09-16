import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RoleManagementPage } from "@/routes/_app.role-management";
import { PermissionsPage } from "@/routes/_app.permissions";
import { ApprovalWorkflowsPage } from "@/routes/_app.approval-workflows";

// Three previously-separate admin pages (role CRUD, the module×action
// permission matrix, and the maker-checker step-count config for every
// other module) live as sections of one tab here -- consolidating the
// Admin Panel's tab count without dropping any of the three screens.
export function PermissionsTab() {
  const [sub, setSub] = useState("roles");

  return (
    <Tabs value={sub} onValueChange={setSub} className="space-y-4">
      <TabsList>
        <TabsTrigger value="roles">Roles</TabsTrigger>
        <TabsTrigger value="matrix">Permission Matrix</TabsTrigger>
        <TabsTrigger value="workflows">Approval Workflows</TabsTrigger>
      </TabsList>
      <TabsContent value="roles">
        <RoleManagementPage />
      </TabsContent>
      <TabsContent value="matrix">
        <PermissionsPage />
      </TabsContent>
      <TabsContent value="workflows">
        <ApprovalWorkflowsPage />
      </TabsContent>
    </Tabs>
  );
}
