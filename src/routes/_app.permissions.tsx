import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { RequireAccess } from "@/components/layout/require-access";
import {
  ALL_MODULES,
  MODULE_LABELS,
  ALL_ACTIONS,
  useAllRoles,
  useIsSuperAdmin,
  type ModuleKey,
  type Action,
  type Role,
} from "@/lib/permissions";
import { UserPermissionOverridesEditor } from "@/components/permissions/user-permission-overrides";
import { UserPageAccess } from "@/components/permissions/user-page-access";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { KeyRound, ShieldAlert, SlidersHorizontal, UserCheck } from "lucide-react";

export const Route = createFileRoute("/_app/permissions")({
  head: () => ({
    meta: [{ title: "Roles & Permissions — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="users">
      <PermissionsPage />
    </RequireAccess>
  ),
});

export function PermissionsPage() {
  const isSuperAdmin = useIsSuperAdmin();
  const roles = useAllRoles();
  const [module, setModule] = useState<ModuleKey>("expenses");
  const qc = useQueryClient();

  const grants = useQuery({
    queryKey: ["role-permissions", module],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("role_permissions")
        .select("role,action")
        .eq("module", module);
      if (error) throw error;
      const set = new Set((data ?? []).map((r) => `${r.role}:${r.action}`));
      return set;
    },
  });

  const toggle = useMutation({
    mutationFn: async ({ role, action, grant }: { role: Role; action: Action; grant: boolean }) => {
      if (grant) {
        const { error } = await supabase.from("role_permissions").insert({ role, module, action });
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("role_permissions")
          .delete()
          .eq("role", role)
          .eq("module", module)
          .eq("action", action);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["role-permissions", module] });
      qc.invalidateQueries({ queryKey: ["my-permissions"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Roles &amp; Permissions</h1>
        <p className="text-sm text-muted-foreground">
          Level 2 of the access model: which action each role can perform, per module. Backend RLS
          enforces this — this page only reflects and edits it.
        </p>
      </div>

      {!isSuperAdmin.data && !isSuperAdmin.isLoading && (
        <Card className="rounded-2xl border-dashed">
          <CardContent className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <ShieldAlert className="h-4 w-4" /> You can view this matrix, but only an Admin can
            change it.
          </CardContent>
        </Card>
      )}

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Role × Action matrix
          </CardTitle>
          <Select value={module} onValueChange={(v) => setModule(v as ModuleKey)}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ALL_MODULES.map((m) => (
                <SelectItem key={m} value={m}>
                  {MODULE_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-card">Role</TableHead>
                {ALL_ACTIONS.map((a) => (
                  <TableHead key={a} className="text-center capitalize">
                    {a}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(roles.data ?? [])
                .filter((r) => r.slug !== "super_admin")
                .map((role) => (
                  <TableRow key={role.slug}>
                    <TableCell className="sticky left-0 bg-card font-medium">
                      {role.label}
                    </TableCell>
                    {ALL_ACTIONS.map((action) => {
                      const checked = grants.data?.has(`${role.slug}:${action}`) ?? false;
                      return (
                        <TableCell key={action} className="text-center">
                          <Checkbox
                            checked={checked}
                            disabled={!isSuperAdmin.data || toggle.isPending}
                            onCheckedChange={(v) =>
                              toggle.mutate({ role: role.slug, action, grant: !!v })
                            }
                          />
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              <TableRow>
                <TableCell
                  colSpan={ALL_ACTIONS.length + 1}
                  className="text-center text-xs text-muted-foreground"
                >
                  Admin always has every action on every module and isn't shown here.
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <UserOverridesPicker isSuperAdmin={!!isSuperAdmin.data} />
    </div>
  );
}

function UserOverridesPicker({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const [userId, setUserId] = useState("");

  const users = useQuery({
    queryKey: ["profiles-list-for-overrides"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name,email")
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserCheck className="h-4 w-4" /> Page access for one user
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label className="text-xs text-muted-foreground">User</label>
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger className="w-72">
              <SelectValue placeholder="Choose a user to set their page access" />
            </SelectTrigger>
            <SelectContent>
              {(users.data ?? []).map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.full_name ?? u.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {userId ? (
          <>
            <UserPageAccess userId={userId} canEdit={isSuperAdmin} />

            {/* Page access is the `view` action only. This keeps the
                action-level editor available for the finer exceptions
                (approve, post, reverse …) on a single module. */}
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1">
                  <SlidersHorizontal className="h-3.5 w-3.5" /> Advanced: per-action overrides
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-4">
                <UserPermissionOverridesEditor userId={userId} isSuperAdmin={isSuperAdmin} />
              </CollapsibleContent>
            </Collapsible>
          </>
        ) : (
          <p className="py-4 text-sm text-muted-foreground">
            Pick a user above to tick the pages they should be able to open.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
