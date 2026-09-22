import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { RequireAccess } from "@/components/layout/require-access";
import { CreateUserDialog } from "@/components/admin/create-user-dialog";
import { adminUpdateUser } from "@/lib/admin-users";
import { useAllRoles, usePermissions, type Role } from "@/lib/permissions";
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  X,
  Plus,
  ShieldCheck,
  Check,
  Send,
  Ban,
  Undo2,
  Pencil,
  Eye,
  EyeOff,
  RefreshCw,
  Copy,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/users")({
  head: () => ({
    meta: [{ title: "Users & Roles — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="users">
      <UsersPage />
    </RequireAccess>
  ),
});

// No departments table exists yet -- this mirrors the "Sales", "Production",
// "Finance" already used on Employees/Production Requests, plus the two
// factories, so the dropdown reflects how the business is actually organized.
// "Other…" (below) covers anything that doesn't fit, and keeps this list from
// blocking an edit just because it's incomplete.
const DEPARTMENT_OPTIONS = [
  "Admin",
  "Sales",
  "Production",
  "Finance & Accounts",
  "Inventory / Store",
  "Water Factory",
  "Nylon Factory",
];

type ProductionScope = "NYLON" | "WATER" | "BOTH";
type Profile = {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  username: string | null;
  department: string | null;
  production_scope: ProductionScope;
};
type UserRoleRow = { id: string; user_id: string; role: Role; factory_id: string | null };
type Factory = { id: string; name: string };
type RoleGrantRequest = {
  id: string;
  target_user_id: string;
  role: Role;
  factory_id: string | null;
  action: string;
  requested_by: string;
  requested_at: string;
  status: string;
};

export function UsersPage() {
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
  const [editTarget, setEditTarget] = useState<Profile | null>(null);

  const profiles = useQuery({
    queryKey: ["all-profiles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name,email,phone,username,department,production_scope")
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as Profile[];
    },
  });

  const roles = useQuery({
    queryKey: ["all-user-roles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("id,user_id,role,factory_id");
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
      const { error } = await supabase.rpc("request_role_grant", {
        p_target_user_id: userId,
        p_role: role,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Role grant submitted for approval");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setScope = useMutation({
    mutationFn: async ({ userId, scope }: { userId: string; scope: ProductionScope }) => {
      const { error } = await supabase.rpc("set_production_scope", {
        p_user_id: userId,
        p_scope: scope,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Production scope updated");
      qc.invalidateQueries({ queryKey: ["all-profiles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: async (r: UserRoleRow) => {
      const { error } = await supabase.rpc("request_role_revoke", {
        p_user_id: r.user_id,
        p_role: r.role,
        p_factory_id: r.factory_id ?? undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Role removal submitted for approval");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const review = useMutation({
    mutationFn: async ({ id, doApprove }: { id: string; doApprove: boolean }) => {
      const { error } = await supabase.rpc(doApprove ? "approve_role_grant" : "reject_role_grant", {
        p_request_id: id,
      } as any);
      if (error) throw error;
    },
    onSuccess: (_r, vars) => {
      toast.success(
        vars.doApprove ? "Role change approved — post it next to apply" : "Role change rejected",
      );
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const postGrant = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("post_role_grant", { p_request_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Role change posted");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelGrant = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("cancel_role_grant", { p_request_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Role change cancelled");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reverseGrant = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc("reverse_role_grant", {
        p_request_id: id,
        p_reason: reason,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Role change reversed");
      invalidate();
      setReverseTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rolesFor = (userId: string) => (roles.data ?? []).filter((r) => r.user_id === userId);
  const nameFor = (userId: string) =>
    profiles.data?.find((p) => p.id === userId)?.full_name ??
    profiles.data?.find((p) => p.id === userId)?.email ??
    "—";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users & Roles</h1>
          <p className="text-sm text-muted-foreground">
            Role changes are submitted for a second person's approval before they take effect.
          </p>
        </div>
        <div className="shrink-0">
          <CreateUserDialog />
        </div>
      </div>

      {(pendingRequests.data ?? []).length > 0 && (
        <Card className="rounded-2xl border-dashed">
          <CardHeader>
            <CardTitle>Role Change Requests</CardTitle>
          </CardHeader>
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
                      <TableCell>
                        <Badge
                          variant={r.action === "grant" ? "secondary" : "destructive"}
                          className="capitalize"
                        >
                          {r.action}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {roleLabel(r.role)}
                        {r.factory_id &&
                          ` · ${factories.data?.find((f) => f.id === r.factory_id)?.name ?? ""}`}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">
                          {r.status.replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(r.requested_at).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {r.status === "pending_approval" && approve && !isSelf && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Approve"
                              onClick={() => review.mutate({ id: r.id, doApprove: true })}
                            >
                              <Check className="h-4 w-4 text-success" />
                            </Button>
                          )}
                          {r.status === "pending_approval" && approve && !isSelf && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Reject"
                              onClick={() => review.mutate({ id: r.id, doApprove: false })}
                            >
                              <X className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                          {r.status === "approved" && post && !isSelf && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Post"
                              onClick={() => postGrant.mutate(r.id)}
                            >
                              <Send className="h-4 w-4 text-success" />
                            </Button>
                          )}
                          {(r.status === "pending_approval" || r.status === "approved") &&
                            cancel && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Cancel"
                                onClick={() => cancelGrant.mutate(r.id)}
                              >
                                <Ban className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            )}
                          {r.status === "posted" && reverse && !isSelf && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Reverse"
                              onClick={() => setReverseTarget(r)}
                            >
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
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Accounts
          </CardTitle>
        </CardHeader>
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
                    <Avatar className="h-8 w-8">
                      <AvatarFallback>
                        {(p.full_name || p.email || "?").slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  </TableCell>
                  <TableCell>
                    {write ? (
                      <button
                        type="button"
                        onClick={() => setEditTarget(p)}
                        className="group text-left"
                        title="Edit user"
                      >
                        <div className="flex items-center gap-1.5 font-medium group-hover:text-primary group-hover:underline">
                          {p.full_name ?? "—"}
                          <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100" />
                        </div>
                        <div className="text-xs text-muted-foreground">{p.email ?? "—"}</div>
                      </button>
                    ) : (
                      <>
                        <div className="font-medium">{p.full_name ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">{p.email ?? "—"}</div>
                      </>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {rolesFor(p.id).map((r) => (
                        <Badge key={r.id} variant="secondary" className="gap-1">
                          {roleLabel(r.role)}
                          {r.factory_id &&
                            ` · ${factories.data?.find((f) => f.id === r.factory_id)?.name ?? ""}`}
                          {write && (
                            <button
                              onClick={() => revoke.mutate(r)}
                              className="ml-1 hover:text-destructive"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          )}
                        </Badge>
                      ))}
                      {rolesFor(p.id).length === 0 && (
                        <span className="text-xs text-muted-foreground">No roles</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={p.production_scope}
                      onValueChange={(v) =>
                        setScope.mutate({ userId: p.id, scope: v as ProductionScope })
                      }
                      disabled={!write || setScope.isPending}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="BOTH">Both factories</SelectItem>
                        <SelectItem value="NYLON">Nylon only</SelectItem>
                        <SelectItem value="WATER">Water only</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Only isolates the Production module.
                    </p>
                  </TableCell>
                  <TableCell>
                    {write && (
                      <div className="flex gap-2">
                        <Select
                          value={pendingRole[p.id] ?? ""}
                          onValueChange={(v) =>
                            setPendingRole((s) => ({ ...s, [p.id]: v as Role }))
                          }
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue placeholder="Select role…" />
                          </SelectTrigger>
                          <SelectContent>
                            {(allRoles.data ?? []).map((r) => (
                              <SelectItem key={r.slug} value={r.slug}>
                                {r.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1 shrink-0"
                          disabled={!write || !pendingRole[p.id] || assign.isPending}
                          onClick={() => {
                            const role = pendingRole[p.id];
                            if (!role) return;
                            const already = rolesFor(p.id).some(
                              (r) => r.role === role && r.factory_id === null,
                            );
                            if (already) {
                              toast.error(
                                `${p.full_name ?? "This user"} already has the ${roleLabel(role)} role`,
                              );
                              return;
                            }
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
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    No accounts yet — they appear here once someone signs in.
                  </TableCell>
                </TableRow>
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

      <Dialog open={!!editTarget} onOpenChange={(v) => !v && setEditTarget(null)}>
        {editTarget && (
          <EditUserDialog
            profile={editTarget}
            onDone={() => {
              setEditTarget(null);
              qc.invalidateQueries({ queryKey: ["all-profiles"] });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

// Avoids look-alike characters (0/O, 1/l/I) so a password read off a screen
// and typed by hand doesn't bounce. Mirrors create-user-dialog.tsx's helper.
const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%";
function generatePassword(length = 14): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join("");
}

function EditUserDialog({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const [fullName, setFullName] = useState(profile.full_name ?? "");
  const [email, setEmail] = useState(profile.email ?? "");
  const [username, setUsername] = useState(profile.username ?? "");
  const [phone, setPhone] = useState(profile.phone ?? "");
  const isKnownDepartment = profile.department && DEPARTMENT_OPTIONS.includes(profile.department);
  const [departmentChoice, setDepartmentChoice] = useState(
    !profile.department ? "none" : isKnownDepartment ? profile.department : "__custom__",
  );
  const [customDepartment, setCustomDepartment] = useState(
    !isKnownDepartment ? (profile.department ?? "") : "",
  );
  const department =
    departmentChoice === "none" ? "" : departmentChoice === "__custom__" ? customDepartment : departmentChoice;
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [savedPassword, setSavedPassword] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      return await adminUpdateUser({
        data: {
          target_id: profile.id,
          full_name: fullName.trim(),
          username: username.trim() || undefined,
          phone: phone.trim() || undefined,
          department: department.trim() || undefined,
          email: email.trim() !== (profile.email ?? "") ? email.trim() : undefined,
          password: password || undefined,
        },
      });
    },
    onSuccess: (result) => {
      if (!result.ok) return toast.error(result.error);
      toast.success("User updated");
      if (password) {
        setSavedPassword(password);
        setPassword("");
        return;
      }
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const copyPassword = async () => {
    if (!savedPassword) return;
    await navigator.clipboard.writeText(savedPassword);
    toast.success("Password copied");
  };

  const missing = !fullName.trim() || !/^\S+@\S+\.\S+$/.test(email.trim());

  return (
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Edit User — {profile.full_name ?? profile.email}</DialogTitle>
      </DialogHeader>

      {savedPassword ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
            <div className="font-medium">Password changed — share the new one now</div>
            <div className="mt-1 font-mono text-xs break-all">{savedPassword}</div>
            <p className="mt-2 text-xs text-muted-foreground">
              This won't be shown again. The user should sign in with it right away.
            </p>
            <Button size="sm" variant="outline" className="mt-2 gap-1" onClick={copyPassword}>
              <Copy className="h-3.5 w-3.5" /> Copy
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={onDone}>Done</Button>
          </DialogFooter>
        </div>
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Full name</Label>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              {email.trim() !== (profile.email ?? "") && (
                <p className="text-[11px] text-warning">
                  This changes their login email — no confirmation mail is sent.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Username</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Department</Label>
              <Select value={departmentChoice} onValueChange={setDepartmentChoice}>
                <SelectTrigger>
                  <SelectValue placeholder="Select department…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  {DEPARTMENT_OPTIONS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                  <SelectItem value="__custom__">Other…</SelectItem>
                </SelectContent>
              </Select>
              {departmentChoice === "__custom__" && (
                <Input
                  className="mt-1.5"
                  value={customDepartment}
                  onChange={(e) => setCustomDepartment(e.target.value)}
                  placeholder="Enter department"
                />
              )}
            </div>
          </div>

          <div className="space-y-1.5 border-t pt-4">
            <Label>Set a new password</Label>
            <div className="flex gap-2">
              <Input
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank to keep the current password"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                title={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="gap-1 whitespace-nowrap"
                onClick={() => {
                  setPassword(generatePassword());
                  setShowPassword(true);
                }}
              >
                <RefreshCw className="h-4 w-4" /> Generate
              </Button>
            </div>
            {password && password.length < 8 && (
              <p className="text-[11px] text-destructive">Password must be at least 8 characters.</p>
            )}
          </div>

          <DialogFooter>
            <Button
              disabled={missing || (password.length > 0 && password.length < 8) || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </div>
      )}
    </DialogContent>
  );
}

function ReverseRoleGrantDialog({
  request,
  roleLabel,
  userName,
  onSubmit,
  saving,
}: {
  request: RoleGrantRequest;
  roleLabel: string;
  userName: string;
  onSubmit: (reason: string) => void;
  saving: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Reverse Role Change — {userName}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          This undoes the posted {request.action} of <strong>{roleLabel}</strong> for {userName}.
        </p>
        <div>
          <Label>Reason</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button
          variant="destructive"
          disabled={saving || !reason.trim()}
          onClick={() => onSubmit(reason)}
        >
          {saving ? "Reversing…" : "Reverse"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
