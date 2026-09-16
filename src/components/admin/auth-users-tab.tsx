import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminListAuthUsers } from "@/lib/admin-users";
import { useAccountsAdmin } from "@/lib/use-accounts-admin";
import { usePermissions } from "@/lib/permissions";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
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
import { RefreshCw, Trash2, AlertTriangle } from "lucide-react";

// The raw Supabase Auth record list -- separate from `profiles`, since
// that's a client-readable app table while auth.users only exists via the
// Admin API. This is what makes an orphan (an auth credential with no
// matching profile -- the exact failure mode that motivated this feature)
// visible and one click away from a real, permanent delete.
export function AuthUsersTab() {
  const qc = useQueryClient();
  const { accounts, remove } = useAccountsAdmin();
  const { canWrite, canEdit, canDelete } = usePermissions();
  const canRemove =
    canWrite("account-approvals") || canEdit("account-approvals") || canDelete("account-approvals");

  const authUsers = useQuery({
    queryKey: ["admin-panel", "auth-users"],
    queryFn: async () => {
      const result = await adminListAuthUsers();
      if (!result.ok) throw new Error(result.error);
      return result.users;
    },
  });

  const sync = () => {
    qc.invalidateQueries({ queryKey: ["admin-panel", "auth-users"] });
    qc.invalidateQueries({ queryKey: ["all-accounts"] });
  };

  const profileIds = new Set((accounts.data ?? []).map((a) => a.id));
  const rows = authUsers.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {rows.length} user{rows.length === 1 ? "" : "s"} in Supabase
        </p>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={sync}
          disabled={authUsers.isFetching}
        >
          <RefreshCw className={`h-4 w-4 ${authUsers.isFetching ? "animate-spin" : ""}`} /> Sync
        </Button>
      </div>

      {authUsers.isError && (
        <Card className="rounded-2xl border-dashed">
          <CardContent className="py-4 text-sm text-destructive">
            {(authUsers.error as Error).message}
          </CardContent>
        </Card>
      )}

      <Card className="rounded-2xl">
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last Sign-in</TableHead>
                <TableHead>Profile</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((u) => {
                const orphan = !profileIds.has(u.id);
                return (
                  <TableRow key={u.id}>
                    <TableCell className="text-xs">{u.email ?? "—"}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {new Date(u.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : "Never"}
                    </TableCell>
                    <TableCell>
                      {orphan ? (
                        <Badge variant="destructive" className="gap-1">
                          <AlertTriangle className="h-3 w-3" /> No profile (orphaned)
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Synced</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {canRemove && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" title="Delete permanently">
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                Permanently delete {u.email ?? "this user"}?
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                {orphan
                                  ? "This removes the leftover Supabase Auth credential. The email will be free for a fresh signup afterward."
                                  : "This removes their profile, roles, and login credential entirely. This cannot be undone."}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => remove.mutate(u.id, { onSuccess: () => sync() })}
                              >
                                Delete permanently
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && !authUsers.isLoading && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    No users found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
