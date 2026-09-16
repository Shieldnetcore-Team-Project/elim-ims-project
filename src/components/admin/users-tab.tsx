import { useState } from "react";
import { useAccountsAdmin, type Account } from "@/lib/use-accounts-admin";
import { useAllRoles, usePermissions, type ProductionScope, type Role } from "@/lib/permissions";
import { adminUpdateUser } from "@/lib/admin-users";
import { useMutation } from "@tanstack/react-query";
import { CreateUserDialog } from "@/components/admin/create-user-dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Eye, EyeOff, RefreshCw, Copy, KeyRound, Trash2, Pencil, ShieldCheck } from "lucide-react";

const statusVariant = (status: string): "default" | "secondary" | "outline" | "destructive" => {
  if (status === "active") return "secondary";
  return "destructive";
};

const SCOPES: { value: ProductionScope; label: string }[] = [
  { value: "BOTH", label: "All Factories" },
  { value: "NYLON", label: "Nylon Factory" },
  { value: "WATER", label: "Water Factory" },
];

const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%";
function generatePassword(length = 14): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join("");
}

export function UsersTab() {
  const { accounts, lastLogins, rolesFor, remove, resetPassword } = useAccountsAdmin();
  const allRoles = useAllRoles();
  const { canWrite, canEdit, canDelete } = usePermissions();
  const canRemove =
    canWrite("account-approvals") || canEdit("account-approvals") || canDelete("account-approvals");
  const [editTarget, setEditTarget] = useState<Account | null>(null);

  const roleLabel = (slug: string | null) =>
    slug ? (allRoles.data?.find((r) => r.slug === slug)?.label ?? slug) : "—";

  const primaryRole = (userId: string) => rolesFor(userId).find((r) => !r.factory_id)?.role ?? null;

  const lastLoginLabel = (id: string) => {
    const v = lastLogins.data?.get(id);
    return v ? new Date(v).toLocaleString() : "Never";
  };

  const rows = (accounts.data ?? []).filter((a) => a.status !== "pending");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{rows.length} users</p>
        <CreateUserDialog />
      </div>

      <Card className="rounded-2xl">
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead></TableHead>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Factory</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Login</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Avatar className="h-8 w-8">
                      {a.avatar_url && <AvatarImage src={a.avatar_url} alt={a.full_name ?? ""} />}
                      <AvatarFallback>
                        {(a.full_name || a.email || "?").slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => setEditTarget(a)}
                      className="group text-left"
                      title="Edit user"
                    >
                      <div className="flex items-center gap-1.5 font-medium group-hover:text-primary group-hover:underline">
                        {a.full_name ?? "—"}
                        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100" />
                      </div>
                      <div className="text-xs text-muted-foreground">{a.email ?? "—"}</div>
                    </button>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="gap-1">
                      <ShieldCheck className="h-3 w-3" /> {roleLabel(primaryRole(a.id))}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {SCOPES.find((s) => s.value === a.production_scope)?.label ??
                      a.production_scope}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(a.status)} className="capitalize">
                      {a.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {lastLoginLabel(a.id)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Reset password"
                        onClick={() => resetPassword(a.email)}
                      >
                        <KeyRound className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Edit user"
                        onClick={() => setEditTarget(a)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {canRemove && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" title="Delete user permanently">
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                Permanently delete {a.full_name ?? a.email}?
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                This removes their profile, roles, and login credential entirely —
                                including from Supabase Auth. They could sign up again from scratch
                                afterward. This cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => remove.mutate(a.id)}>
                                Delete permanently
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    No users yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!editTarget} onOpenChange={(v) => !v && setEditTarget(null)}>
        {editTarget && <EditUserDialog account={editTarget} onDone={() => setEditTarget(null)} />}
      </Dialog>
    </div>
  );
}

function EditUserDialog({ account, onDone }: { account: Account; onDone: () => void }) {
  const { rolesFor, setProductionScope, setRole, setStatus } = useAccountsAdmin();
  const allRoles = useAllRoles();
  const currentRole = rolesFor(account.id).find((r) => !r.factory_id)?.role ?? "";

  const [fullName, setFullName] = useState(account.full_name ?? "");
  const [email, setEmail] = useState(account.email ?? "");
  const [phone, setPhone] = useState(account.phone ?? "");
  const [role, setRoleValue] = useState<Role>(currentRole);
  const [scope, setScope] = useState<ProductionScope>(account.production_scope);
  const [status, setStatusValue] = useState(account.status);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [savedPassword, setSavedPassword] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const result = await adminUpdateUser({
        data: {
          target_id: account.id,
          full_name: fullName.trim(),
          phone: phone.trim() || undefined,
          email: email.trim() !== (account.email ?? "") ? email.trim() : undefined,
          password: password || undefined,
        },
      });
      if (!result.ok) throw new Error(result.error);

      if (role && role !== currentRole) {
        await setRole.mutateAsync({ userId: account.id, role });
      }
      if (scope !== account.production_scope) {
        await setProductionScope.mutateAsync({ userId: account.id, scope });
      }
      if (
        status !== account.status &&
        (status === "active" || status === "suspended" || status === "deactivated")
      ) {
        await setStatus.mutateAsync({ id: account.id, status });
      }
    },
    onSuccess: () => {
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
        <DialogTitle>Edit User</DialogTitle>
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
              <Label>Full Name *</Label>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Email Address *</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Password</Label>
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
                <p className="text-[11px] text-destructive">
                  Password must be at least 8 characters.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Phone Number</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRoleValue(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {(allRoles.data ?? []).map((r) => (
                    <SelectItem key={r.slug} value={r.slug}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Factory</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as ProductionScope)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCOPES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatusValue}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                  <SelectItem value="deactivated">Deactivated</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">
              {missing ? "Name and a valid email are required." : ""}
            </span>
            <Button disabled={missing || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save Changes"}
            </Button>
          </DialogFooter>
        </div>
      )}
    </DialogContent>
  );
}
