import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { RequireAccess } from "@/components/layout/require-access";
import { useAllRoles, useIsSuperAdmin, type Role } from "@/lib/permissions";
import { UserPermissionOverridesEditor } from "@/components/permissions/user-permission-overrides";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  Eye,
  Check,
  X,
  PauseCircle,
  PowerOff,
  KeyRound,
  Trash2,
  RotateCcw,
  UserCheck,
  Copy,
} from "lucide-react";

export const Route = createFileRoute("/_app/account-approvals")({
  head: () => ({
    meta: [{ title: "Account Approvals — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="account-approvals">
      <AccountApprovalsPage />
    </RequireAccess>
  ),
});

type Account = {
  id: string;
  full_name: string | null;
  username: string | null;
  email: string | null;
  phone: string | null;
  department: string | null;
  role_requested: Role | null;
  requested_factory_id: string | null;
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
type Factory = { id: string; name: string };

const STATUS_TABS = ["pending", "active", "suspended", "rejected", "deactivated", "all"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

const statusVariant = (status: string): "default" | "secondary" | "outline" | "destructive" => {
  if (status === "active") return "secondary";
  if (status === "pending") return "outline";
  return "destructive";
};

function AccountApprovalsPage() {
  const qc = useQueryClient();
  const isSuperAdmin = useIsSuperAdmin();
  const roles = useAllRoles();
  const roleLabel = (slug: string | null) =>
    slug ? (roles.data?.find((r) => r.slug === slug)?.label ?? slug) : "—";
  const [tab, setTab] = useState<StatusTab>("pending");
  const [detail, setDetail] = useState<Account | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Account | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [approveTarget, setApproveTarget] = useState<Account | null>(null);
  const [approveRole, setApproveRole] = useState<Role | "">("");
  const [approveDepartment, setApproveDepartment] = useState("");

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
      return (data ?? []) as Factory[];
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["all-accounts"] });

  const filtered = useMemo(() => {
    const rows = accounts.data ?? [];
    return tab === "all" ? rows : rows.filter((a) => a.status === tab);
  }, [accounts.data, tab]);

  const counts = useMemo(() => {
    const rows = accounts.data ?? [];
    const c: Record<string, number> = {
      pending: 0,
      active: 0,
      suspended: 0,
      rejected: 0,
      deactivated: 0,
    };
    rows.forEach((a) => {
      c[a.status] = (c[a.status] ?? 0) + 1;
    });
    return c;
  }, [accounts.data]);

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
      setApproveTarget(null);
      invalidate();
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
      setRejectTarget(null);
      setRejectReason("");
      invalidate();
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
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("delete_user_account", { target_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Account deleted");
      invalidate();
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

  const copyId = (id: string) => {
    navigator.clipboard.writeText(id);
    toast.success("User ID copied");
  };

  const factoryName = (id: string | null) =>
    id ? (factories.data?.find((f) => f.id === id)?.name ?? "—") : "—";
  const lastLoginLabel = (id: string) => {
    const v = lastLogins.data?.get(id);
    return v ? new Date(v).toLocaleString() : "Never";
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account Approvals</h1>
        <p className="text-sm text-muted-foreground">
          Review new registrations and manage account access. Admin only.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((t) => (
          <Button
            key={t}
            size="sm"
            variant={tab === t ? "default" : "outline"}
            className="capitalize gap-1.5"
            onClick={() => setTab(t)}
          >
            {t}
            {t !== "all" && (
              <Badge variant="secondary" className="ml-1 px-1.5">
                {counts[t] ?? 0}
              </Badge>
            )}
          </Button>
        ))}
      </div>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="capitalize">
            {tab} accounts ({filtered.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead></TableHead>
                <TableHead>Full Name</TableHead>
                <TableHead>User ID</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created By</TableHead>
                <TableHead>Created Date</TableHead>
                <TableHead>Last Login</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Avatar className="h-8 w-8">
                      {a.avatar_url && <AvatarImage src={a.avatar_url} alt={a.full_name ?? ""} />}
                      <AvatarFallback>
                        {(a.full_name || a.email || "?").slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  </TableCell>
                  <TableCell className="font-medium">{a.full_name ?? "—"}</TableCell>
                  <TableCell>
                    <button
                      onClick={() => copyId(a.id)}
                      className="flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                      title={a.id}
                    >
                      {a.id.slice(0, 8)}… <Copy className="h-3 w-3" />
                    </button>
                  </TableCell>
                  <TableCell className="text-xs">{a.email ?? "—"}</TableCell>
                  <TableCell>{a.department ?? "—"}</TableCell>
                  <TableCell>{roleLabel(a.role_requested)}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(a.status)} className="capitalize">
                      {a.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.created_by ? "Admin-created" : "Self-registered"}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {new Date(a.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {lastLoginLabel(a.id)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="View details"
                        onClick={() => setDetail(a)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {a.status === "pending" && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Approve"
                            onClick={() => {
                              setApproveTarget(a);
                              setApproveRole(a.role_requested ?? "");
                              setApproveDepartment(a.department ?? "");
                            }}
                          >
                            <Check className="h-4 w-4 text-success" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Reject"
                            onClick={() => setRejectTarget(a)}
                          >
                            <X className="h-4 w-4 text-destructive" />
                          </Button>
                        </>
                      )}
                      {a.status === "active" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Suspend"
                          onClick={() => setStatus.mutate({ id: a.id, status: "suspended" })}
                        >
                          <PauseCircle className="h-4 w-4 text-warning" />
                        </Button>
                      )}
                      {(a.status === "suspended" ||
                        a.status === "deactivated" ||
                        a.status === "rejected") && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Reinstate"
                          onClick={() => setStatus.mutate({ id: a.id, status: "active" })}
                        >
                          <RotateCcw className="h-4 w-4 text-success" />
                        </Button>
                      )}
                      {a.status !== "deactivated" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Deactivate"
                          onClick={() => setStatus.mutate({ id: a.id, status: "deactivated" })}
                        >
                          <PowerOff className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Reset password"
                        onClick={() => resetPassword(a.email)}
                      >
                        <KeyRound className="h-4 w-4" />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" title="Delete account">
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete this account?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This removes {a.full_name ?? a.email}'s profile and role assignments.
                              This cannot be undone from here.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => remove.mutate(a.id)}>
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                    No {tab === "all" ? "" : tab} accounts.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        {detail && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{detail.full_name ?? detail.email}</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">User ID:</span>{" "}
                <span className="font-mono text-xs">{detail.id}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Username:</span> {detail.username ?? "—"}
              </div>
              <div>
                <span className="text-muted-foreground">Email:</span> {detail.email ?? "—"}
              </div>
              <div>
                <span className="text-muted-foreground">Phone:</span> {detail.phone ?? "—"}
              </div>
              <div>
                <span className="text-muted-foreground">Department:</span>{" "}
                {detail.department ?? "—"}
              </div>
              <div>
                <span className="text-muted-foreground">Role requested:</span>{" "}
                {roleLabel(detail.role_requested)}
              </div>
              <div>
                <span className="text-muted-foreground">Factory:</span>{" "}
                {factoryName(detail.requested_factory_id)}
              </div>
              <div>
                <span className="text-muted-foreground">Created by:</span>{" "}
                {detail.created_by ? "Admin-created" : "Self-registered"}
              </div>
              <div>
                <span className="text-muted-foreground">Created date:</span>{" "}
                {new Date(detail.created_at).toLocaleString()}
              </div>
              <div>
                <span className="text-muted-foreground">Last login:</span>{" "}
                {lastLoginLabel(detail.id)}
              </div>
              <div>
                <span className="text-muted-foreground">Status:</span>{" "}
                <Badge variant={statusVariant(detail.status)} className="capitalize">
                  {detail.status}
                </Badge>
              </div>
              {detail.approved_at && (
                <div className="col-span-2">
                  <span className="text-muted-foreground">Approved:</span>{" "}
                  {new Date(detail.approved_at).toLocaleString()}
                </div>
              )}
              {detail.rejected_at && (
                <>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">Rejected:</span>{" "}
                    {new Date(detail.rejected_at).toLocaleString()}
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">Reason:</span> {detail.rejected_reason}
                  </div>
                </>
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={!!approveTarget} onOpenChange={(v) => !v && setApproveTarget(null)}>
        {approveTarget && (
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <UserCheck className="h-5 w-5 text-success" /> Approve{" "}
                {approveTarget.full_name ?? approveTarget.email}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                New accounts don't get unrestricted access automatically — set the role, department,
                and (optionally) any permission exceptions now.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Role to grant</Label>
                  <Select value={approveRole} onValueChange={(v) => setApproveRole(v as Role)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(roles.data ?? []).map((r) => (
                        <SelectItem key={r.slug} value={r.slug}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Department</Label>
                  <Input
                    value={approveDepartment}
                    onChange={(e) => setApproveDepartment(e.target.value)}
                    placeholder="e.g. Production"
                  />
                </div>
              </div>
              <UserPermissionOverridesEditor
                userId={approveTarget.id}
                isSuperAdmin={!!isSuperAdmin.data}
              />
            </div>
            <DialogFooter>
              <Button
                disabled={!approveRole || approve.isPending}
                onClick={() =>
                  approveRole &&
                  approve.mutate({
                    account: approveTarget,
                    role: approveRole,
                    department: approveDepartment,
                  })
                }
              >
                {approve.isPending ? "Approving…" : "Approve account"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        open={!!rejectTarget}
        onOpenChange={(v) => {
          if (!v) {
            setRejectTarget(null);
            setRejectReason("");
          }
        }}
      >
        {rejectTarget && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reject {rejectTarget.full_name ?? rejectTarget.email}</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              <Label>Reason for rejection *</Label>
              <Textarea
                rows={3}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Explain why this registration is being declined…"
              />
            </div>
            <DialogFooter>
              <Button
                variant="destructive"
                disabled={!rejectReason.trim() || reject.isPending}
                onClick={() =>
                  reject.mutate({ account: rejectTarget, reason: rejectReason.trim() })
                }
              >
                {reject.isPending ? "Rejecting…" : "Reject account"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
