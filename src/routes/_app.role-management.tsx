import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { RequireAccess } from "@/components/layout/require-access";
import { useAllRoles, useIsSuperAdmin } from "@/lib/permissions";
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
import { Badge } from "@/components/ui/badge";
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
import { ShieldPlus, Pencil, Trash2, ShieldAlert, Lock } from "lucide-react";

export const Route = createFileRoute("/_app/role-management")({
  head: () => ({
    meta: [{ title: "Role Management — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="users">
      <RoleManagementPage />
    </RequireAccess>
  ),
});

const slugify = (label: string) =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

function RoleManagementPage() {
  const qc = useQueryClient();
  const isSuperAdmin = useIsSuperAdmin();
  const roles = useAllRoles();

  const assignedCounts = useQuery({
    queryKey: ["user-roles-counts"],
    queryFn: async () => {
      const { data, error } = await supabase.from("user_roles").select("role");
      if (error) throw error;
      const counts: Record<string, number> = {};
      for (const r of data ?? []) counts[r.role] = (counts[r.role] ?? 0) + 1;
      return counts;
    },
  });

  const [editing, setEditing] = useState<{
    slug: string;
    label: string;
    description: string;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [formLabel, setFormLabel] = useState("");
  const [formSlug, setFormSlug] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["all-roles"] });
    qc.invalidateQueries({ queryKey: ["user-roles-counts"] });
  };

  const openCreate = () => {
    setCreating(true);
    setFormLabel("");
    setFormSlug("");
    setFormDescription("");
    setSlugTouched(false);
  };

  const openEdit = (r: { slug: string; label: string; description: string | null }) => {
    setEditing({ slug: r.slug, label: r.label, description: r.description ?? "" });
    setFormLabel(r.label);
    setFormDescription(r.description ?? "");
  };

  const create = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("roles")
        .insert({ slug: formSlug, label: formLabel, description: formDescription || null });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Role created");
      setCreating(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: async () => {
      if (!editing) return;
      const { error } = await supabase
        .from("roles")
        .update({ label: formLabel, description: formDescription || null })
        .eq("slug", editing.slug);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Role updated");
      setEditing(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (slug: string) => {
      const { error } = await supabase.from("roles").delete().eq("slug", slug);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Role deleted");
      invalidate();
    },
    onError: (e: Error) =>
      toast.error(
        e.message.includes("foreign key")
          ? "Still assigned to at least one user — remove those assignments first."
          : e.message,
      ),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Role Management</h1>
          <p className="text-sm text-muted-foreground">
            Create and configure roles based on actual job responsibilities. Who can do what within
            a role is set on the Roles &amp; Permissions matrix.
          </p>
        </div>
        {isSuperAdmin.data && (
          <Button onClick={openCreate} className="gap-1.5">
            <ShieldPlus className="h-4 w-4" /> New role
          </Button>
        )}
      </div>

      {!isSuperAdmin.data && !isSuperAdmin.isLoading && (
        <Card className="rounded-2xl border-dashed">
          <CardContent className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <ShieldAlert className="h-4 w-4" /> You can view roles, but only an Admin can
            create or change them.
          </CardContent>
        </Card>
      )}

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Roles ({roles.data?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Users</TableHead>
                <TableHead></TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(roles.data ?? []).map((r) => {
                const count = assignedCounts.data?.[r.slug] ?? 0;
                const blocked = r.is_system || count > 0;
                return (
                  <TableRow key={r.slug}>
                    <TableCell className="font-medium">{r.label}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.slug}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r.description ?? "—"}
                    </TableCell>
                    <TableCell>{count}</TableCell>
                    <TableCell>
                      {r.is_system && (
                        <Badge variant="outline" className="gap-1">
                          <Lock className="h-3 w-3" /> System
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {isSuperAdmin.data && (
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Edit"
                            onClick={() => openEdit(r)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                title={
                                  blocked
                                    ? r.is_system
                                      ? "System roles can't be deleted"
                                      : "Still assigned to users"
                                    : "Delete"
                                }
                                disabled={blocked}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete "{r.label}"?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This also removes its entries in the permission matrix. This
                                  cannot be undone.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => remove.mutate(r.slug)}>
                                  Delete
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {(roles.data?.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No roles yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New role</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Label</Label>
              <Input
                value={formLabel}
                onChange={(e) => {
                  setFormLabel(e.target.value);
                  if (!slugTouched) setFormSlug(slugify(e.target.value));
                }}
                placeholder="e.g. Store Checker"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Slug</Label>
              <Input
                value={formSlug}
                onChange={(e) => {
                  setFormSlug(slugify(e.target.value));
                  setSlugTouched(true);
                }}
                placeholder="e.g. store_checker"
              />
              <p className="text-xs text-muted-foreground">
                Used internally, can't be changed after creation.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Textarea
                rows={2}
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="What this role is responsible for"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={!formLabel.trim() || !formSlug.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Creating…" : "Create role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit role</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Label</Label>
              <Input value={formLabel} onChange={(e) => setFormLabel(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Textarea
                rows={2}
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={!formLabel.trim() || update.isPending}
              onClick={() => update.mutate()}
            >
              {update.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
