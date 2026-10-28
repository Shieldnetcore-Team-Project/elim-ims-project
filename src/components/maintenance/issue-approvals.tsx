import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Ban, Check, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { logAudit } from "@/lib/audit";
import { money, num } from "@/lib/format";
import { usePermissions, useIsSuperAdmin } from "@/lib/permissions";
import { matchesSearch, useSearchQuery } from "@/lib/search";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RefId } from "@/components/shared/ref-id";
import { SearchBox } from "@/components/shared/search-box";
import {
  db,
  ISSUE_STATUS_LABELS,
  MAINTENANCE_QUERY_KEYS,
  useMaintenanceIssues,
  useMaintenanceLogs,
  type IssueRow,
} from "./shared";

const statusVariant = (s: string): "default" | "secondary" | "outline" | "destructive" =>
  s === "approved"
    ? "secondary"
    : s === "rejected" || s === "cancelled"
      ? "destructive"
      : "outline";

export function IssueApprovalsTab({ factoryId }: { factoryId: string | null | undefined }) {
  const qc = useQueryClient();
  const [q, setQ] = useSearchQuery();
  const [statusFilter, setStatusFilter] = useState("pending_approval");
  const [rejecting, setRejecting] = useState<IssueRow | null>(null);
  const [reason, setReason] = useState("");
  const { canApprove, canReject, canCancel, canWrite } = usePermissions();
  const isSuperAdmin = useIsSuperAdmin().data ?? false;
  const { data: me } = useQuery({
    queryKey: ["auth-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
  });

  const issues = useMaintenanceIssues(factoryId);
  const logs = useMaintenanceLogs(factoryId);
  const logNumber = new Map((logs.data ?? []).map((l) => [l.id, l.log_number]));

  const rows = (issues.data ?? [])
    .filter((i) => statusFilter === "all" || i.status === statusFilter)
    .filter((i) => matchesSearch(q, { ...i, part: i.maintenance_parts?.name }));

  const invalidate = () =>
    MAINTENANCE_QUERY_KEYS.forEach((queryKey) => qc.invalidateQueries({ queryKey }));

  const decide = useMutation({
    mutationFn: async ({
      row,
      approve,
      note,
    }: {
      row: IssueRow;
      approve: boolean;
      note?: string;
    }) => {
      const { error } = await db.rpc("decide_maintenance_issue", {
        p_id: row.id,
        p_approve: approve,
        p_note: note || null,
      });
      if (error) throw error;
    },
    onSuccess: (_, { row, approve, note }) => {
      toast.success(approve ? "Approved — stock issued" : "Rejected — stock unchanged");
      logAudit({
        action: "update",
        entity: "maintenance_issue_requests",
        entityId: row.id,
        factoryId,
        newValue: { action: approve ? "approve" : "reject", note: note || null },
      });
      invalidate();
      setRejecting(null);
      setReason("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const withdraw = useMutation({
    mutationFn: async (row: IssueRow) => {
      const { error } = await db.rpc("cancel_maintenance_issue", { p_id: row.id });
      if (error) throw error;
    },
    onSuccess: (_, row) => {
      toast.success("Request withdrawn");
      logAudit({
        action: "update",
        entity: "maintenance_issue_requests",
        entityId: row.id,
        factoryId,
        newValue: { action: "cancel" },
      });
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {Object.entries(ISSUE_STATUS_LABELS).map(([k, label]) => (
              <SelectItem key={k} value={k}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Stock is only taken out once an issue is approved. Nobody can approve their own request.
        </p>
      </div>
      <Card className="rounded-2xl">
        <CardContent className="overflow-x-auto pt-6">
          <SearchBox value={q} onChange={setQ} className="mb-3" />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Issue #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Part</TableHead>
                <TableHead className="text-right">Qty out</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>For</TableHead>
                <TableHead>Requested by</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((i) => {
                const pending = i.status === "pending_approval";
                const own = i.requested_by === me;
                const mayDecide = pending && (!own || isSuperAdmin);
                const mayWithdraw =
                  pending && (canCancel("logistics") || (own && canWrite("logistics")));
                const part = i.maintenance_parts;
                return (
                  <TableRow key={i.id}>
                    <TableCell>
                      <RefId id={i.id} />
                    </TableCell>
                    <TableCell className="font-medium whitespace-nowrap">
                      {i.issue_number}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {new Date(i.movement_date).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      {part?.name ?? "—"}
                      {pending && part && (
                        <div className="text-xs text-muted-foreground">
                          {num(Number(part.quantity_on_hand))} {part.unit} on hand
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {num(Number(i.quantity))} {part?.unit}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {part?.last_unit_cost != null
                        ? money(Number(i.quantity) * Number(part.last_unit_cost))
                        : "—"}
                    </TableCell>
                    <TableCell className="max-w-56 text-xs">
                      {i.kind === "adjustment" ? (
                        <Badge variant="outline" className="mb-1">
                          Stock adjustment
                        </Badge>
                      ) : null}
                      <div>
                        {[i.log_id ? logNumber.get(i.log_id) : null, i.issued_to, i.notes]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </div>
                      {i.decision_note && (
                        <div className="text-muted-foreground">Note: {i.decision_note}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {i.requested_by_name ?? "—"}
                      <div className="text-muted-foreground">
                        {new Date(i.created_at).toLocaleDateString()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(i.status)} className="whitespace-nowrap">
                        {ISSUE_STATUS_LABELS[i.status] ?? i.status}
                      </Badge>
                      {i.decided_by_name && !pending && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          by {i.decided_by_name}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {mayDecide && canApprove("logistics") && (
                          <Button
                            size="sm"
                            disabled={decide.isPending}
                            onClick={() => decide.mutate({ row: i, approve: true })}
                          >
                            <Check className="mr-1 h-4 w-4" /> Approve
                          </Button>
                        )}
                        {mayDecide && canReject("logistics") && (
                          <Button size="sm" variant="destructive" onClick={() => setRejecting(i)}>
                            <X className="mr-1 h-4 w-4" /> Reject
                          </Button>
                        )}
                        {mayWithdraw && (
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Withdraw"
                            disabled={withdraw.isPending}
                            onClick={() => withdraw.mutate(i)}
                          >
                            <Ban className="h-4 w-4" />
                          </Button>
                        )}
                        {pending && own && !isSuperAdmin && (
                          <span className="self-center text-xs text-muted-foreground">
                            Waiting for another approver
                          </span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                    {issues.isError
                      ? "Couldn't load issue requests."
                      : statusFilter === "pending_approval"
                        ? "Nothing waiting for approval."
                        : "No issue requests."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={!!rejecting}
        onOpenChange={(v) => {
          if (!v) {
            setRejecting(null);
            setReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject {rejecting?.issue_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Reason</Label>
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={!reason.trim() || decide.isPending}
              onClick={() =>
                rejecting && decide.mutate({ row: rejecting, approve: false, note: reason })
              }
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
