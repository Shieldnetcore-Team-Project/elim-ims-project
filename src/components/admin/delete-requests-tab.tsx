import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Badge } from "@/components/ui/badge";
import { Check, X } from "lucide-react";
import { toast } from "sonner";

type DeleteRequestRow = {
  id: string;
  table_name: string;
  entity_label: string;
  reason: string;
  requested_by: string;
  requested_at: string;
};

// Keep in sync with the CHECK constraint on delete_requests.table_name
// (supabase/migrations/20260920090000_delete_request_approval.sql).
const TABLE_LABELS: Record<string, string> = {
  employees: "Employee",
  employee_documents: "Employee Document",
  sales_reps: "Sales Rep",
  vehicles: "Vehicle",
  drivers: "Driver",
  expenses: "Expense",
  cash_transactions: "Cash Transaction",
  product_units: "Packaging Rule",
};

// Storage bucket to best-effort clean up after an approved delete, keyed by
// the storage-path field request_delete() captured into delete_requests.payload.
const STORAGE_BUCKET: Record<string, string> = {
  employees: "employee-files",
  employee_documents: "employee-files",
  expenses: "expense-attachments",
};

function useRequesterNames(userIds: string[]) {
  return useQuery({
    queryKey: ["delete-requests-requesters", userIds],
    enabled: userIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name,email")
        .in("id", userIds);
      if (error) throw error;
      const map: Record<string, string> = {};
      for (const p of data ?? []) map[p.id] = p.full_name ?? p.email ?? p.id;
      return map;
    },
  });
}

export function DeleteRequestsTab() {
  const qc = useQueryClient();
  const [rejectTarget, setRejectTarget] = useState<DeleteRequestRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const requests = useQuery({
    queryKey: ["delete-requests-pending"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("delete_requests")
        .select("id,table_name,entity_label,reason,requested_by,requested_at")
        .eq("review_status", "pending")
        .order("requested_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as DeleteRequestRow[];
    },
  });

  const rows = requests.data ?? [];
  const requesterIds = [...new Set(rows.map((r) => r.requested_by))];
  const requesterNames = useRequesterNames(requesterIds);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["delete-requests-pending"] });

  const approve = useMutation({
    mutationFn: async (row: DeleteRequestRow) => {
      const { data, error } = await supabase.rpc("approve_delete", { p_id: row.id });
      if (error) throw error;
      return data as { approved: boolean; payload: Record<string, string> | null };
    },
    onSuccess: async (data, row) => {
      toast.success("Deletion approved");
      // Best-effort storage cleanup — SQL can't reach into Storage, so this
      // mirrors the cleanup the old direct-delete mutations used to do,
      // just deferred until an admin actually approves the request.
      const bucket = STORAGE_BUCKET[row.table_name];
      const path =
        data?.payload?.photo_url || data?.payload?.file_path || data?.payload?.attachment_url;
      if (bucket && path) {
        try {
          await supabase.storage.from(bucket).remove([path]);
        } catch {
          // Non-fatal — the record is already deleted either way.
        }
      }
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reject = useMutation({
    mutationFn: async ({ row, reason }: { row: DeleteRequestRow; reason: string }) => {
      const { error } = await supabase.rpc("reject_delete", { p_id: row.id, p_reason: reason });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Deletion request rejected");
      setRejectTarget(null);
      setRejectReason("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {rows.length} deletion request{rows.length === 1 ? "" : "s"} waiting for review.
      </p>

      <Card className="rounded-2xl">
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Record</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Requested by</TableHead>
                <TableHead>Requested</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Badge variant="outline">{TABLE_LABELS[r.table_name] ?? r.table_name}</Badge>
                  </TableCell>
                  <TableCell className="font-medium">{r.entity_label}</TableCell>
                  <TableCell className="max-w-xs truncate text-sm" title={r.reason}>
                    {r.reason}
                  </TableCell>
                  <TableCell className="text-xs">
                    {requesterNames.data?.[r.requested_by] ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {new Date(r.requested_at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Approve"
                        disabled={approve.isPending}
                        onClick={() => approve.mutate(r)}
                      >
                        <Check className="h-4 w-4 text-success" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Reject"
                        onClick={() => setRejectTarget(r)}
                      >
                        <X className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    No deletion requests waiting for review.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

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
              <DialogTitle>Reject deletion — {rejectTarget.entity_label}</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              <Label>Reason (optional)</Label>
              <Textarea
                rows={3}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Let the requester know why this was declined…"
              />
            </div>
            <DialogFooter>
              <Button
                variant="destructive"
                disabled={reject.isPending}
                onClick={() => reject.mutate({ row: rejectTarget, reason: rejectReason.trim() })}
              >
                {reject.isPending ? "Rejecting…" : "Reject request"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
