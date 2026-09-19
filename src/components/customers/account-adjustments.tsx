import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions, useMyRoles } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { useCustomerAccount } from "@/lib/customer-account";
import { money } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Check, X, Ban } from "lucide-react";

export type AdjustmentEffect = "credit_up" | "credit_down" | "debt_up" | "debt_down" | "refund";

export const EFFECT_LABEL: Record<AdjustmentEffect, string> = {
  credit_up: "Add to advance",
  credit_down: "Reduce advance",
  debt_up: "Add to debt",
  debt_down: "Reduce debt",
  refund: "Refund advance to customer",
};

type PaymentMethod = "cash" | "transfer" | "pos" | "card" | "cheque";

type AdjustmentRow = {
  id: string;
  customer_id: string;
  effect: AdjustmentEffect;
  amount: number;
  reason: string;
  payment_method: string | null;
  status: string;
  submitted_by: string;
  submitted_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  customers: { name: string } | null;
};

// What the balances become if this adjustment is approved — the same rules the
// approval enforces server-side, shown up front so a request can't be filed
// for something that could never be approved.
function projected(
  effect: AdjustmentEffect,
  amount: number,
  credit: number,
  debt: number,
): { credit: number; debt: number; problem: string | null } {
  switch (effect) {
    case "credit_up":
      return { credit: credit + amount, debt, problem: null };
    case "credit_down":
    case "refund":
      return {
        credit: credit - amount,
        debt,
        problem: amount > credit ? `The customer only has ${money(credit)} of advance.` : null,
      };
    case "debt_up":
      return { credit, debt: debt + amount, problem: null };
    case "debt_down":
      return {
        credit,
        debt: debt - amount,
        problem: amount > debt ? `The customer only owes ${money(debt)}.` : null,
      };
  }
}

// Accountant files a correction; an admin approves it. Nothing touches the
// account until approval, and every request needs a written reason.
export function AdjustmentRequestDialog({
  factoryId,
  customerId: presetCustomerId,
  customerName: presetName,
  onDone,
}: {
  factoryId: string;
  customerId?: string;
  customerName?: string;
  onDone: () => void;
}) {
  const customers = useQuery({
    queryKey: ["customers-brief", factoryId],
    enabled: !presetCustomerId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("id,name")
        .eq("factory_id", factoryId)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const [customerId, setCustomerId] = useState(presetCustomerId ?? "");
  const [effect, setEffect] = useState<AdjustmentEffect>("credit_up");
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reason, setReason] = useState("");

  const account = useCustomerAccount(customerId || undefined);
  const credit = account.data?.summary.available_advance ?? 0;
  const debt = account.data?.summary.outstanding_debt ?? 0;
  const after = projected(effect, amount, credit, debt);

  const submit = useMutation({
    mutationFn: async () => {
      if (!customerId) throw new Error("Select a customer");
      if (amount <= 0) throw new Error("Amount must be greater than 0");
      if (!reason.trim()) throw new Error("A reason is required");
      if (amount > 0 && after.problem) throw new Error(after.problem);
      const { error } = await (supabase as any).rpc("request_customer_adjustment", {
        payload: {
          factory_id: factoryId,
          customer_id: customerId,
          effect,
          amount,
          reason: reason.trim(),
          payment_method: effect === "refund" ? method : null,
        },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Adjustment submitted — awaiting approval");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const name =
    presetName ?? (customers.data ?? []).find((c) => c.id === customerId)?.name ?? "the customer";

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Request account adjustment</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          For corrections that no sale or payment can make. It changes nothing until an admin
          approves it, and both the request and the approval are recorded.
        </p>
        {!presetCustomerId && (
          <div>
            <Label>Customer</Label>
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a customer…" />
              </SelectTrigger>
              <SelectContent>
                {(customers.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {customerId && account.data && (
          <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/30 p-3 text-sm">
            <div>
              <span className="block text-muted-foreground">Available Advance</span>
              <span className={credit > 0 ? "font-medium text-success" : "font-medium"}>
                {money(credit)}
              </span>
            </div>
            <div>
              <span className="block text-muted-foreground">Outstanding Debt</span>
              <span className={debt > 0 ? "font-medium text-destructive" : "font-medium"}>
                {money(debt)}
              </span>
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Adjustment</Label>
            <Select value={effect} onValueChange={(v) => setEffect(v as AdjustmentEffect)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(EFFECT_LABEL) as AdjustmentEffect[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {EFFECT_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Amount</Label>
            <MoneyInput value={amount} onChange={setAmount} />
          </div>
        </div>
        {effect === "refund" && (
          <div>
            <Label>Refund paid by</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["cash", "transfer", "pos", "card", "cheque"] as PaymentMethod[]).map((m) => (
                  <SelectItem key={m} value={m} className="capitalize">
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {customerId && amount > 0 && (
          <div className="space-y-1 rounded-md border p-3 text-sm">
            <div className="flex justify-between">
              <span>Advance for {name} after approval</span>
              <span className="font-medium">{money(Math.max(after.credit, 0))}</span>
            </div>
            <div className="flex justify-between">
              <span>Debt after approval</span>
              <span className="font-medium">{money(Math.max(after.debt, 0))}</span>
            </div>
            {after.problem && <p className="pt-1 text-xs text-destructive">{after.problem}</p>}
            {effect === "refund" && !after.problem && (
              <p className="pt-1 text-xs text-muted-foreground">
                A refund reduces the customer's advance. The money itself is handed back outside
                this system.
              </p>
            )}
          </div>
        )}
        <div>
          <Label>Reason (required)</Label>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What is being corrected and why"
          />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={
            submit.isPending || !customerId || amount <= 0 || !reason.trim() || !!after.problem
          }
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? "Submitting…" : "Submit for approval"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

const statusBadge = (s: string): "default" | "secondary" | "outline" | "destructive" =>
  s === "posted" ? "secondary" : s === "rejected" || s === "cancelled" ? "destructive" : "outline";

function useProfileNames() {
  return useQuery({
    queryKey: ["profiles-map"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id,full_name");
      if (error) throw error;
      const map: Record<string, string> = {};
      (data ?? []).forEach((p) => {
        map[p.id] = p.full_name ?? "—";
      });
      return map;
    },
  });
}

// Adjustments for a factory (or one customer): pending ones for an admin to
// approve or reject, the rest as a record of what was decided and why.
export function AccountAdjustmentsCard({
  factoryId,
  customerId,
  title = "Account adjustments",
}: {
  factoryId: string;
  customerId?: string;
  title?: string;
}) {
  const qc = useQueryClient();
  const { canSubmit, canApprove, canReject } = usePermissions();
  // The server lets super_admin and chairman act on their own requests; every
  // other approver role is blocked from approving what they submitted.
  const roles = useMyRoles().data ?? [];
  const isAdmin = roles.includes("super_admin") || roles.includes("chairman");
  const profiles = useProfileNames();
  const [showAll, setShowAll] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [approveTarget, setApproveTarget] = useState<AdjustmentRow | null>(null);
  const [rejectTarget, setRejectTarget] = useState<AdjustmentRow | null>(null);
  const [note, setNote] = useState("");

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });
  const uid = currentUser.data;

  useRealtimeInvalidate(["customer_account_adjustments"], [["customer-adjustments"]]);

  const list = useQuery({
    queryKey: ["customer-adjustments", factoryId, customerId ?? "all"],
    queryFn: async () => {
      let q = (supabase as any)
        .from("customer_account_adjustments")
        .select("*, customers(name)")
        .eq("factory_id", factoryId)
        .order("submitted_at", { ascending: false })
        .limit(200);
      if (customerId) q = q.eq("customer_id", customerId);
      const { data, error } = await q;
      if (error) throw error;
      return ((data ?? []) as AdjustmentRow[]).map((r) => ({ ...r, amount: Number(r.amount) }));
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["customer-adjustments"] });
    qc.invalidateQueries({ queryKey: ["customer-account"] });
    qc.invalidateQueries({ queryKey: ["fin-customer-accounts"] });
    qc.invalidateQueries({ queryKey: ["customers"] });
    qc.invalidateQueries({ queryKey: ["pending-attention"] });
  };

  const approve = useMutation({
    mutationFn: async (row: AdjustmentRow) => {
      const { error } = await (supabase as any).rpc("approve_customer_adjustment", {
        p_id: row.id,
        p_comment: note.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Adjustment approved and posted to the account");
      setApproveTarget(null);
      setNote("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reject = useMutation({
    mutationFn: async (row: AdjustmentRow) => {
      if (!note.trim()) throw new Error("A rejection reason is required");
      const { error } = await (supabase as any).rpc("reject_customer_adjustment", {
        p_id: row.id,
        p_reason: note.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Adjustment rejected");
      setRejectTarget(null);
      setNote("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancel = useMutation({
    mutationFn: async (row: AdjustmentRow) => {
      const { error } = await (supabase as any).rpc("cancel_customer_adjustment", {
        p_id: row.id,
        p_reason: null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Adjustment cancelled");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const all = list.data ?? [];
  const pendingCount = all.filter((r) => r.status === "pending_approval").length;
  const rows = showAll ? all : all.filter((r) => r.status === "pending_approval");
  const canRequest = canSubmit("customers");

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          {title}
          {pendingCount > 0 && <Badge variant="secondary">{pendingCount} pending</Badge>}
        </CardTitle>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Pending only" : "Show all"}
          </Button>
          {canRequest && (
            <Button size="sm" className="gap-1.5" onClick={() => setRequestOpen(true)}>
              <Plus className="h-4 w-4" /> Request adjustment
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              {!customerId && <TableHead>Customer</TableHead>}
              <TableHead>Adjustment</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Submitted by</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
                  {showAll ? "No adjustments yet." : "Nothing awaiting approval."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const pending = r.status === "pending_approval";
                const own = r.submitted_by === uid;
                const canDecide = pending && (!own || isAdmin);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {new Date(r.submitted_at).toLocaleDateString()}
                    </TableCell>
                    {!customerId && (
                      <TableCell className="font-medium">{r.customers?.name ?? "—"}</TableCell>
                    )}
                    <TableCell>{EFFECT_LABEL[r.effect] ?? r.effect}</TableCell>
                    <TableCell className="text-right">{money(r.amount)}</TableCell>
                    <TableCell className="max-w-[220px]">
                      <div className="truncate" title={r.reason}>
                        {r.reason}
                      </div>
                      {r.review_note && (
                        <div
                          className="truncate text-xs text-muted-foreground"
                          title={r.review_note}
                        >
                          Decision: {r.review_note}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {profiles.data?.[r.submitted_by] ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusBadge(r.status)} className="capitalize">
                        {r.status.replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {pending && (
                        <div className="flex justify-end gap-1">
                          {canDecide && canApprove("customers") && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Approve"
                              onClick={() => {
                                setNote("");
                                setApproveTarget(r);
                              }}
                            >
                              <Check className="h-4 w-4 text-success" />
                            </Button>
                          )}
                          {canDecide && canReject("customers") && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Reject"
                              onClick={() => {
                                setNote("");
                                setRejectTarget(r);
                              }}
                            >
                              <X className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                          {(own || isAdmin) && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Cancel request"
                              disabled={cancel.isPending}
                              onClick={() => cancel.mutate(r)}
                            >
                              <Ban className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={requestOpen} onOpenChange={setRequestOpen}>
        {requestOpen && (
          <AdjustmentRequestDialog
            factoryId={factoryId}
            customerId={customerId}
            onDone={() => {
              setRequestOpen(false);
              refresh();
            }}
          />
        )}
      </Dialog>

      <Dialog open={!!approveTarget} onOpenChange={(v) => !v && setApproveTarget(null)}>
        {approveTarget && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Approve adjustment</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 text-sm">
              <p>
                <strong>{approveTarget.customers?.name ?? "Customer"}</strong> —{" "}
                {EFFECT_LABEL[approveTarget.effect]}: <strong>{money(approveTarget.amount)}</strong>
              </p>
              <p className="rounded-md bg-muted/40 p-2 text-muted-foreground">
                {approveTarget.reason}
              </p>
              <p className="text-xs text-muted-foreground">
                Approving posts this to the customer's account straight away and cannot be edited
                afterwards — a mistake would need a new adjustment.
              </p>
              <div>
                <Label>Comment (optional)</Label>
                <Input value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button disabled={approve.isPending} onClick={() => approve.mutate(approveTarget)}>
                {approve.isPending ? "Posting…" : "Approve & post"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={!!rejectTarget} onOpenChange={(v) => !v && setRejectTarget(null)}>
        {rejectTarget && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reject adjustment</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 text-sm">
              <p>
                <strong>{rejectTarget.customers?.name ?? "Customer"}</strong> —{" "}
                {EFFECT_LABEL[rejectTarget.effect]}: <strong>{money(rejectTarget.amount)}</strong>
              </p>
              <div>
                <Label>Reason for rejecting (required)</Label>
                <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="destructive"
                disabled={reject.isPending || !note.trim()}
                onClick={() => reject.mutate(rejectTarget)}
              >
                {reject.isPending ? "Rejecting…" : "Reject"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </Card>
  );
}
