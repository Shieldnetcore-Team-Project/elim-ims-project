import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ALL_MODULES, MODULE_LABELS, ALL_ACTIONS, type ModuleKey, type Action } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

// Same queries/mutations as the per-user override editor on the Roles &
// Permissions page, just parameterized by a required userId instead of
// having its own user-picker — lets the Account Approvals "approve" dialog
// set an override for the account being approved in the same action.
export function UserPermissionOverridesEditor({ userId, isSuperAdmin }: { userId: string; isSuperAdmin: boolean }) {
  const qc = useQueryClient();
  const [module, setModule] = useState<ModuleKey>("expenses");
  const [action, setAction] = useState<Action>("approve");
  const [grant, setGrant] = useState<"true" | "false">("true");

  const overrides = useQuery({
    queryKey: ["permission-overrides-for-user", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("permission_overrides")
        .select("user_id,module,action,granted,granted_at")
        .eq("user_id", userId)
        .order("granted_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["permission-overrides-for-user", userId] });
    qc.invalidateQueries({ queryKey: ["permission-overrides-list"] });
    qc.invalidateQueries({ queryKey: ["my-permissions"] });
  };

  const add = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("permission_overrides").upsert({ user_id: userId, module, action, granted: grant === "true" });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Override saved"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (row: { module: string; action: string }) => {
      const { error } = await supabase.from("permission_overrides").delete().eq("user_id", userId).eq("module", row.module).eq("action", row.action);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Override removed"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card className="rounded-2xl">
      <CardHeader><CardTitle>Permission overrides</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          For the rare exception that doesn't fit a whole role — grant or explicitly revoke one action, for one module. Takes priority over the role's grants.
        </p>
        {isSuperAdmin && (
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="text-xs text-muted-foreground">Module</label>
              <Select value={module} onValueChange={(v) => setModule(v as ModuleKey)}>
                <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                <SelectContent>{ALL_MODULES.map((m) => (<SelectItem key={m} value={m}>{MODULE_LABELS[m]}</SelectItem>))}</SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Action</label>
              <Select value={action} onValueChange={(v) => setAction(v as Action)}>
                <SelectTrigger className="w-36 capitalize"><SelectValue /></SelectTrigger>
                <SelectContent>{ALL_ACTIONS.map((a) => (<SelectItem key={a} value={a} className="capitalize">{a}</SelectItem>))}</SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Effect</label>
              <Select value={grant} onValueChange={(v) => setGrant(v as "true" | "false")}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Grant</SelectItem>
                  <SelectItem value="false">Revoke</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => add.mutate()} disabled={add.isPending}>{add.isPending ? "Saving…" : "Add override"}</Button>
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Module</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Effect</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(overrides.data ?? []).map((o) => (
              <TableRow key={`${o.module}-${o.action}`}>
                <TableCell>{MODULE_LABELS[o.module as ModuleKey] ?? o.module}</TableCell>
                <TableCell className="capitalize">{o.action}</TableCell>
                <TableCell><Badge variant={o.granted ? "secondary" : "destructive"}>{o.granted ? "Granted" : "Revoked"}</Badge></TableCell>
                <TableCell>
                  {isSuperAdmin && (
                    <Button variant="ghost" size="icon" onClick={() => remove.mutate(o)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {(overrides.data?.length ?? 0) === 0 && (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-6">No overrides — following the role's grants.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
