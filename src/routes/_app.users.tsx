import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { RequireAccess } from "@/components/layout/require-access";
import { useAllRoles, usePermissions, type Role } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { X, Plus, ShieldCheck, Check, Send, Ban, Undo2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/users")({
  head: () => ({ meta: [{ title: "Users & Roles — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="users">
      <UsersPage />
    </RequireAccess>
  ),
});

type ProductionScope = "NYLON" | "WATER" | "BOTH";
type Profile = { id: string; full_name: string | null; email: string | null; phone: string | null; production_scope: ProductionScope };
type UserRoleRow = { id: string; user_id: string; role: Role; factory_id: string | null };
type Factory = { id: string; name: string };
type RoleGrantRequest = {
  id: string; target_user_id: string; role: Role; factory_id: string | null; action: string;
  requested_by: string; requested_at: string; status: string;
};

function UsersPage() {
  const qc = useQueryClient();
  const allRoles = useAllRoles();
  const roleLabel = (slug: string) => allRoles.data?.find((r) => r.slug === slug)?.label ?? slug;
  const { canWrite, canApprove, canPost, canCancel, canReverse } = usePermissions();
  const write = canWrite("users");
  const approve = canApprove("users");
  const post = canPost("users");
  const cancel = canCancel("users");
  const reverse = canReverse("users");
  const [pendingRole, setPendingRole] = useState<Record<string, Role>>({});
  const [reverseTarget, setReverseTarget] = useState<RoleGrantRequest | null>(null);

  const profiles = useQuery({
    queryKey: ["all-profiles"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id,full_name,email,phone,production_scope").order("full_name");
      if (error) throw error;
      return (data ?? []) as Profile[];
    },
  });

  const roles = useQuery({
    queryKey: ["all-user-roles"],
    queryFn: async () => {
      const { data, error } = await supabase.from("user_roles").select("id,user_id,role,factory_id");
      if (error) throw error;
      return (data ?? []) as UserRoleRow[];
    },
  });

  const factories = useQuery({
    queryKey: ["factories-all"],
    queryFn: async () => {
      const { data, error } = await supabase.from("factories").select("id,code,name").order("name");
      if (error) throw error;
      return (data ?? []) as Factory[];
    },
  });

  const pendingRequests = useQuery({
    queryKey: ["role-grant-requests"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("role_grant_requests")
        .select("id,target_user_id,role,factory_id,action,requested_by,requested_at,status")
        .in("status", ["pending_approval", "approved", "posted"])
        .order("requested_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as RoleGrantRequest[];
    },
  });

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["all-user-roles"] });
    qc.invalidateQueries({ queryKey: ["role-grant-requests"] });
  };

  const assign = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: Role }) => {
      const { error } = await supabase.rpc("request_role_grant", { p_target_user_id: userId, p_role: role });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Role grant submitted for approval"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const setScope = useMutation({
    mutationFn: async ({ userId, scope }: { userId: string; scope: ProductionScope }) => {
      const { error } = await supabase.rpc("set_production_scope", { p_user_id: userId, p_scope: scope });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Production scope updated"); qc.invalidateQueries({ queryKey: ["all-profiles"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: async (r: UserRoleRow) => {
      const { error } = await supabase.rpc("request_role_revoke", { p_user_id: r.user_id, p_role: r.role, p_factory_id: r.factory_id ?? undefined });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Role removal submitted for approval"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const review = useMutation({
    mutationFn: async ({ id, doApprove }: { id: string; doApprove: boolean }) => {
      const { error } = await supabase.rpc(doApprove ? "approve_role_grant" : "reject_role_grant", { p_request_id: id } as any);
      if (error) throw error;
    },
    onSuccess: (_r, vars) => { toast.success(vars.doApprove ? "Role change approved — post it next to apply" : "Role change rejected"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const postGrant = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("post_role_grant", { p_request_id: id });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Role change posted"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelGrant = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("cancel_role_grant", { p_request_id: id });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Role change cancelled"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const reverseGrant = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc("reverse_role_grant", { p_request_id: id, p_reason: reason });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Role change reversed"); invalidate(); setReverseTarget(null); },
    onError: (e: Error) => toast.error(e.message),
  });

  const rolesFor = (userId: string) => (roles.data ?? []).filter((r) => r.user_id === userId);
  const nameFor = (userId: string) => profiles.data?.find((p) => p.id === userId)?.full_name ?? profiles.data?.find((p) => p.id === userId)?.email ?? "—";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Users & Roles</h1>
        <p className="text-sm text-muted-foreground">Role changes are submitted for a second person's approval before they take effect.</p>
      </div>

      {(pendingRequests.data ?? []).length > 0 && (
        <Card className="rounded-2xl border-dashed">
          <CardHeader><CardTitle>Role Change Requests</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(pendingRequests.data ?? []).map((r) => {
                  const isSelf = r.requested_by === currentUser.data;
                  return (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{nameFor(r.target_user_id)}</TableCell>
                    <TableCell><Badge variant={r.action === "grant" ? "secondary" : "destructive"} className="capitalize">{r.action}</Badge></TableCell>
                    <TableCell>{roleLabel(r.role)}{r.factory_id && ` · ${factories.data?.find((f) => f.id === r.factory_id)?.name ?? ""}`}</TableCell>
                    <TableCell><Badge variant="outline" className="capitalize">{r.status.replace(/_/g, " ")}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(r.requested_at).toLocaleString()}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {r.status === "pending_approval" && approve && !isSelf && (
                          <Button variant="ghost" size="icon" title="Approve" onClick={() => review.mutate({ id: r.id, doApprove: true })}>
                            <Check className="h-4 w-4 text-success" />
                          </Button>
                        )}
                        {r.status === "pending_approval" && approve && !isSelf && (
                          <Button variant="ghost" size="icon" title="Reject" onClick={() => review.mutate({ id: r.id, doApprove: false })}>
                            <X className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                        {r.status === "approved" && post && !isSelf && (
                          <Button variant="ghost" size="icon" title="Post" onClick={() => postGrant.mutate(r.id)}>
                            <Send className="h-4 w-4 text-success" />
                          </Button>
                        )}
                        {(r.status === "pending_approval" || r.status === "approved") && cancel && (
                          <Button variant="ghost" size="icon" title="Cancel" onClick={() => cancelGrant.mutate(r.id)}>
                            <Ban className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        )}
                        {r.status === "posted" && reverse && !isSelf && (
                          <Button variant="ghost" size="icon" title="Reverse" onClick={() => setReverseTarget(r)}>
                            <Undo2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card className="rounded-2xl">
        <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Accounts</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead></TableHead>
                <TableHead>User</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead className="w-[200px]">Production Scope</TableHead>
                <TableHead className="w-[260px]">Assign role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(profiles.data ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Avatar className="h-8 w-8"><AvatarFallback>{(p.full_name || p.email || "?").slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{p.full_name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{p.email ?? "—"}</div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {rolesFor(p.id).map((r) => (
                        <Badge key={r.id} variant="secondary" className="gap-1">
                          {roleLabel(r.role)}
                          {r.factory_id && ` · ${factories.data?.find((f) => f.id === r.factory_id)?.name ?? ""}`}
                          {write && (
                            <button onClick={() => revoke.mutate(r)} className="ml-1 hover:text-destructive">
                              <X className="h-3 w-3" />
                            </button>
                          )}
                        </Badge>
                      ))}
                      {rolesFor(p.id).length === 0 && <span className="text-xs text-muted-foreground">No roles</span>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={p.production_scope}
                      onValueChange={(v) => setScope.mutate({ userId: p.id, scope: v as ProductionScope })}
                      disabled={!write || setScope.isPending}
                    >
                      <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="BOTH">Both factories</SelectItem>
                        <SelectItem value="NYLON">Nylon only</SelectItem>
                        <SelectItem value="WATER">Water only</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="mt-1 text-[11px] text-muted-foreground">Only isolates the Production module.</p>
                  </TableCell>
                  <TableCell>
                    {write && (
                      <div className="flex gap-2">
                        <Select value={pendingRole[p.id] ?? ""} onValueChange={(v) => setPendingRole((s) => ({ ...s, [p.id]: v as Role }))}>
                          <SelectTrigger className="h-8"><SelectValue placeholder="Select role…" /></SelectTrigger>
                          <SelectContent>
                            {(allRoles.data ?? []).map((r) => (<SelectItem key={r.slug} value={r.slug}>{r.label}</SelectItem>))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm" variant="outline" className="gap-1 shrink-0"
                          disabled={!write || !pendingRole[p.id] || assign.isPending}
                          onClick={() => {
                            const role = pendingRole[p.id];
                            if (!role) return;
                            const already = rolesFor(p.id).some((r) => r.role === role && r.factory_id === null);
                            if (already) { toast.error(`${p.full_name ?? "This user"} already has the ${roleLabel(role)} role`); return; }
                            assign.mutate({ userId: p.id, role });
                          }}
                        >
                          <Plus className="h-4 w-4" /> Add
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {(profiles.data ?? []).length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No accounts yet — they appear here once someone signs in.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!reverseTarget} onOpenChange={(v) => !v && setReverseTarget(null)}>
        {reverseTarget && (
          <ReverseRoleGrantDialog
            request={reverseTarget}
            roleLabel={roleLabel(reverseTarget.role)}
            userName={nameFor(reverseTarget.target_user_id)}
            onSubmit={(reason) => reverseGrant.mutate({ id: reverseTarget.id, reason })}
            saving={reverseGrant.isPending}
          />
        )}
      </Dialog>
    </div>
  );
}

function ReverseRoleGrantDialog({ request, roleLabel, userName, onSubmit, saving }: {
  request: RoleGrantRequest; roleLabel: string; userName: string; onSubmit: (reason: string) => void; saving: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Reverse Role Change — {userName}</DialogTitle></DialogHeader>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          This undoes the posted {request.action} of <strong>{roleLabel}</strong> for {userName}.
        </p>
        <div><Label>Reason</Label><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      <DialogFooter>
        <Button variant="destructive" disabled={saving || !reason.trim()} onClick={() => onSubmit(reason)}>
          {saving ? "Reversing…" : "Reverse"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
