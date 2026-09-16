import { useState } from "react";
import { useAccountsAdmin, type Account } from "@/lib/use-accounts-admin";
import { useAllRoles, useIsSuperAdmin, type Role } from "@/lib/permissions";
import { UserPermissionOverridesEditor } from "@/components/permissions/user-permission-overrides";
import { Card, CardContent } from "@/components/ui/card";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check, X, UserCheck } from "lucide-react";

export function PendingTab() {
  const { accounts, approve, reject } = useAccountsAdmin();
  const isSuperAdmin = useIsSuperAdmin();
  const allRoles = useAllRoles();
  const roleLabel = (slug: string | null) =>
    slug ? (allRoles.data?.find((r) => r.slug === slug)?.label ?? slug) : "—";
  const [approveTarget, setApproveTarget] = useState<Account | null>(null);
  const [approveRole, setApproveRole] = useState<Role | "">("");
  const [approveDepartment, setApproveDepartment] = useState("");
  const [rejectTarget, setRejectTarget] = useState<Account | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const rows = (accounts.data ?? []).filter((a) => a.status === "pending");

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {rows.length} account{rows.length === 1 ? "" : "s"} waiting for approval.
      </p>

      <Card className="rounded-2xl">
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead></TableHead>
                <TableHead>Full Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Role Requested</TableHead>
                <TableHead>Registered</TableHead>
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
                  <TableCell className="font-medium">{a.full_name ?? "—"}</TableCell>
                  <TableCell className="text-xs">{a.email ?? "—"}</TableCell>
                  <TableCell>{a.department ?? "—"}</TableCell>
                  <TableCell className="text-xs">{roleLabel(a.role_requested)}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {new Date(a.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
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
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    No accounts waiting for approval.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

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
              <ApproveRoleFields
                role={approveRole}
                setRole={setApproveRole}
                department={approveDepartment}
                setDepartment={setApproveDepartment}
              />
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
                  approve.mutate(
                    { account: approveTarget, role: approveRole, department: approveDepartment },
                    { onSuccess: () => setApproveTarget(null) },
                  )
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
                  reject.mutate(
                    { account: rejectTarget, reason: rejectReason.trim() },
                    {
                      onSuccess: () => {
                        setRejectTarget(null);
                        setRejectReason("");
                      },
                    },
                  )
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

function ApproveRoleFields({
  role,
  setRole,
  department,
  setDepartment,
}: {
  role: Role | "";
  setRole: (r: Role | "") => void;
  department: string;
  setDepartment: (d: string) => void;
}) {
  const roles = useAllRoles();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label>Role to grant</Label>
        <Select value={role} onValueChange={(v) => setRole(v as Role)}>
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
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
          placeholder="e.g. Production"
        />
      </div>
    </div>
  );
}
