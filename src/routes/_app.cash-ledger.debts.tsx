import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
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
import { money } from "@/lib/format";
import { toast } from "sonner";
import {
  HandCoins,
  History,
  FileDown,
  Ban,
  Search,
  Users,
  Wallet,
  TrendingUp,
  AlertTriangle,
  Check,
  X,
  Send,
  Undo2,
} from "lucide-react";
import { generateReceiptPdf, generateDebtStatementPdf } from "@/lib/pdf";

export const Route = createFileRoute("/_app/cash-ledger/debts")({
  head: () => ({
    meta: [{ title: "Debt Management — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="debts">
      <DebtsPage />
    </RequireAccess>
  ),
});

type PaymentMethod = "cash" | "transfer" | "pos" | "card" | "cheque" | "credit";
type Debt = {
  id: string;
  total_amount: number;
  amount_paid: number;
  outstanding: number;
  status: "paid" | "partial" | "unpaid";
  customer_id: string | null;
  sale_id: string | null;
  created_at: string;
  writeoff_status: string | null;
  writeoff_requested_by: string | null;
  writeoff_reason: string | null;
  customers: { name: string; phone: string | null; address: string | null } | null;
  sales: {
    invoice_number: string;
    sale_items: {
      quantity: number;
      unit_price: number;
      line_total: number;
      products: { name: string } | null;
    }[];
  } | null;
};
type DebtPayment = {
  id: string;
  amount: number;
  payment_method: string;
  payment_date: string;
  created_at: string;
  received_by: string | null;
  remarks: string | null;
};

function SummaryCard({
  icon: Icon,
  label,
  value,
  tone = "primary",
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  tone?: "primary" | "success" | "warning" | "destructive";
}) {
  const toneClasses = {
    primary: "bg-primary/10 text-primary",
    success: "bg-success/10 text-success",
    warning: "bg-warning/15 text-warning",
    destructive: "bg-destructive/10 text-destructive",
  }[tone];
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-5 flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold">{value}</div>
        </div>
        <div className={`grid h-10 w-10 place-items-center rounded-xl ${toneClasses}`}>
          <Icon className="h-5 w-5" />
        </div>
      </CardContent>
    </Card>
  );
}

function DebtsPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const qc = useQueryClient();
  const { canApprove, canPost, canCancel, canReverse } = usePermissions();
  const approve = canApprove("debts");
  const post = canPost("debts");
  const cancel = canCancel("debts");
  const reverse = canReverse("debts");
  const [payTarget, setPayTarget] = useState<Debt | null>(null);
  const [historyTarget, setHistoryTarget] = useState<Debt | null>(null);
  const [writeoffTarget, setWriteoffTarget] = useState<Debt | null>(null);
  const [reverseTarget, setReverseTarget] = useState<Debt | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "paid" | "partial" | "unpaid">("all");

  const list = useQuery({
    queryKey: ["debts", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("debts")
        .select(
          `
          id,total_amount,amount_paid,outstanding,status,customer_id,sale_id,created_at,
          writeoff_status,writeoff_requested_by,writeoff_reason,
          customers(name,phone,address),
          sales(invoice_number, sale_items(quantity,unit_price,line_total,products(name)))
        `,
        )
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Debt[];
    },
  });

  const profiles = useQuery({
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

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const filtered = useMemo(() => {
    let rows = list.data ?? [];
    if (statusFilter !== "all") rows = rows.filter((d) => d.status === statusFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (d) =>
          (d.customers?.name ?? "").toLowerCase().includes(q) ||
          (d.sales?.invoice_number ?? "").toLowerCase().includes(q),
      );
    }
    return rows;
  }, [list.data, search, statusFilter]);

  const summary = useMemo(() => {
    const rows = list.data ?? [];
    const debtors = new Set(
      rows.filter((d) => Number(d.outstanding) > 0 && d.customer_id).map((d) => d.customer_id),
    );
    return {
      totalDebtors: debtors.size,
      totalDebt: rows.reduce((s, d) => s + Number(d.total_amount), 0),
      totalRecovered: rows.reduce((s, d) => s + Number(d.amount_paid), 0),
      outstanding: rows.reduce((s, d) => s + Number(d.outstanding), 0),
    };
  }, [list.data]);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["debts"] });
    qc.invalidateQueries({ queryKey: ["customers"] });
    qc.invalidateQueries({ queryKey: ["rp-receipts"] });
  };

  const pay = useMutation({
    mutationFn: async (input: {
      debt: Debt;
      amount: number;
      method: PaymentMethod;
      remarks: string;
    }) => {
      const { data, error } = await supabase.rpc("record_payment", {
        payload: {
          factory_id: factoryId,
          customer_id: input.debt.customer_id,
          debt_id: input.debt.id,
          sale_id: input.debt.sale_id,
          amount: input.amount,
          payment_method: input.method,
          remarks: input.remarks,
        } as any,
      });
      if (error) throw error;
      return { res: data as any, input };
    },
    onSuccess: ({ res, input }) => {
      toast.success(`Receipt ${res.receipt_number}`);
      generateReceiptPdf({
        company: {
          name: settings.data?.company_name ?? "FMIS",
          address: settings.data?.address,
          phone: settings.data?.phone,
          logo_url: settings.data?.logo_url,
        },
        receipt_number: res.receipt_number,
        payment_date: new Date().toISOString().slice(0, 10),
        customer_name: input.debt.customers?.name,
        invoice_number: input.debt.sales?.invoice_number,
        amount: input.amount,
        payment_method: input.method,
        remarks: input.remarks,
        currency: settings.data?.currency ?? "NGN",
      });
      invalidateAll();
      setPayTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const requestWriteoff = useMutation({
    mutationFn: async ({ debt, reason }: { debt: Debt; reason: string }) => {
      const { error } = await supabase.rpc("request_debt_writeoff", {
        p_debt_id: debt.id,
        p_reason: reason || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Write-off requested — awaiting approval");
      invalidateAll();
      setWriteoffTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reviewWriteoff = useMutation({
    mutationFn: async ({ debt, doApprove }: { debt: Debt; doApprove: boolean }) => {
      const { error } = await supabase.rpc(
        doApprove ? "approve_debt_writeoff" : "reject_debt_writeoff",
        { p_debt_id: debt.id } as any,
      );
      if (error) throw error;
    },
    onSuccess: (_r, vars) => {
      toast.success(
        vars.doApprove ? "Write-off approved — post it next to finalize" : "Write-off rejected",
      );
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const postWriteoff = useMutation({
    mutationFn: async (debt: Debt) => {
      const { error } = await supabase.rpc("post_debt_writeoff", { p_debt_id: debt.id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Debt write-off posted");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelWriteoff = useMutation({
    mutationFn: async (debt: Debt) => {
      const { error } = await supabase.rpc("cancel_debt_writeoff", { p_debt_id: debt.id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Write-off request cancelled");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reverseWriteoff = useMutation({
    mutationFn: async ({ debt, reason }: { debt: Debt; reason: string }) => {
      const { error } = await supabase.rpc("reverse_debt_writeoff", {
        p_debt_id: debt.id,
        p_reason: reason,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Write-off reversed — debt reopened");
      invalidateAll();
      setReverseTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const printStatement = async (debt: Debt) => {
    const { data, error } = await supabase
      .from("debt_payments")
      .select("amount,payment_method,payment_date,received_by")
      .eq("debt_id", debt.id)
      .order("payment_date");
    if (error) {
      toast.error(error.message);
      return;
    }
    generateDebtStatementPdf({
      company: {
        name: settings.data?.company_name ?? "FMIS",
        address: settings.data?.address,
        phone: settings.data?.phone,
        logo_url: settings.data?.logo_url,
      },
      customer: {
        name: debt.customers?.name ?? "Walk-in",
        phone: debt.customers?.phone,
        address: debt.customers?.address,
      },
      invoice_number: debt.sales?.invoice_number,
      products: (debt.sales?.sale_items ?? []).map((it) => ({
        name: it.products?.name ?? "—",
        quantity: Number(it.quantity),
        unit_price: Number(it.unit_price),
        line_total: Number(it.line_total),
      })),
      total_amount: Number(debt.total_amount),
      amount_paid: Number(debt.amount_paid),
      outstanding: Number(debt.outstanding),
      status: debt.status,
      payments: (data ?? []).map((p: any) => ({
        amount: Number(p.amount),
        payment_method: p.payment_method,
        payment_date: p.payment_date,
        received_by: p.received_by ? profiles.data?.[p.received_by] : undefined,
      })),
      currency: settings.data?.currency ?? "NGN",
    });
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard icon={Users} label="Total Debtors" value={String(summary.totalDebtors)} />
        <SummaryCard icon={Wallet} label="Total Debt" value={money(summary.totalDebt)} />
        <SummaryCard
          icon={TrendingUp}
          label="Total Recovered"
          value={money(summary.totalRecovered)}
          tone="success"
        />
        <SummaryCard
          icon={AlertTriangle}
          label="Outstanding Amount"
          value={money(summary.outstanding)}
          tone="destructive"
        />
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Debtors</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search customer or invoice…"
                className="pl-8 h-9 w-56"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}
            >
              <SelectTrigger className="h-9 w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="unpaid">Unpaid</SelectItem>
                <SelectItem value="partial">Partially paid</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{new Date(d.created_at).toLocaleDateString()}</TableCell>
                  <TableCell>{d.customers?.name ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {d.customers?.phone ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {d.sales?.invoice_number ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      className="capitalize"
                      variant={
                        d.status === "paid"
                          ? "secondary"
                          : d.status === "partial"
                            ? "outline"
                            : "destructive"
                      }
                    >
                      {d.status === "partial" ? "Partially Paid" : d.status}
                    </Badge>
                    {d.writeoff_status &&
                      !["rejected", "cancelled", "reversed"].includes(d.writeoff_status) && (
                        <Badge variant="outline" className="ml-1 capitalize">
                          Write-off {d.writeoff_status.replace(/_/g, " ")}
                        </Badge>
                      )}
                  </TableCell>
                  <TableCell className="text-right">{money(Number(d.total_amount))}</TableCell>
                  <TableCell className="text-right">{money(Number(d.amount_paid))}</TableCell>
                  <TableCell className="text-right font-medium">
                    {money(Number(d.outstanding))}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1"
                        disabled={d.status === "paid"}
                        onClick={() => setPayTarget(d)}
                      >
                        <HandCoins className="h-4 w-4" /> Receive
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1"
                        onClick={() => setHistoryTarget(d)}
                      >
                        <History className="h-4 w-4" /> History
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1"
                        onClick={() => printStatement(d)}
                      >
                        <FileDown className="h-4 w-4" /> Statement
                      </Button>
                      {d.writeoff_status === "pending_approval" &&
                        (approve && d.writeoff_requested_by !== currentUser.data ? (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="gap-1 text-success"
                              onClick={() => reviewWriteoff.mutate({ debt: d, doApprove: true })}
                            >
                              <Check className="h-4 w-4" /> Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="gap-1 text-destructive"
                              onClick={() => reviewWriteoff.mutate({ debt: d, doApprove: false })}
                            >
                              <X className="h-4 w-4" /> Reject
                            </Button>
                          </>
                        ) : (
                          <Badge variant="outline">Awaiting a different approver</Badge>
                        ))}
                      {d.writeoff_status === "approved" &&
                        post &&
                        d.writeoff_requested_by !== currentUser.data && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1 text-success"
                            onClick={() => postWriteoff.mutate(d)}
                          >
                            <Send className="h-4 w-4" /> Post
                          </Button>
                        )}
                      {(d.writeoff_status === "pending_approval" ||
                        d.writeoff_status === "approved") &&
                        cancel && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1"
                            onClick={() => cancelWriteoff.mutate(d)}
                          >
                            <Ban className="h-4 w-4" /> Cancel
                          </Button>
                        )}
                      {d.writeoff_status === "posted" &&
                        reverse &&
                        d.writeoff_requested_by !== currentUser.data && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1 text-destructive"
                            onClick={() => setReverseTarget(d)}
                          >
                            <Undo2 className="h-4 w-4" /> Reverse
                          </Button>
                        )}
                      {(!d.writeoff_status ||
                        ["rejected", "cancelled", "reversed"].includes(d.writeoff_status)) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1 text-destructive"
                          disabled={d.status === "paid"}
                          onClick={() => setWriteoffTarget(d)}
                        >
                          <Ban className="h-4 w-4" /> Request write-off
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    No debts match.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!payTarget} onOpenChange={(v) => !v && setPayTarget(null)}>
        {payTarget && (
          <PayDialog
            debt={payTarget}
            onSubmit={(amount, method, remarks) =>
              pay.mutate({ debt: payTarget, amount, method, remarks })
            }
            saving={pay.isPending}
          />
        )}
      </Dialog>

      <Dialog open={!!writeoffTarget} onOpenChange={(v) => !v && setWriteoffTarget(null)}>
        {writeoffTarget && (
          <WriteoffDialog
            debt={writeoffTarget}
            onSubmit={(reason) => requestWriteoff.mutate({ debt: writeoffTarget, reason })}
            saving={requestWriteoff.isPending}
          />
        )}
      </Dialog>

      <Dialog open={!!historyTarget} onOpenChange={(v) => !v && setHistoryTarget(null)}>
        {historyTarget && <HistoryDialog debt={historyTarget} profiles={profiles.data ?? {}} />}
      </Dialog>

      <Dialog open={!!reverseTarget} onOpenChange={(v) => !v && setReverseTarget(null)}>
        {reverseTarget && (
          <ReverseWriteoffDialog
            debt={reverseTarget}
            onSubmit={(reason) => reverseWriteoff.mutate({ debt: reverseTarget, reason })}
            saving={reverseWriteoff.isPending}
          />
        )}
      </Dialog>
    </div>
  );
}

function PayDialog({
  debt,
  onSubmit,
  saving,
}: {
  debt: Debt;
  onSubmit: (amount: number, method: PaymentMethod, remarks: string) => void;
  saving: boolean;
}) {
  const [amount, setAmount] = useState(Number(debt.outstanding));
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [remarks, setRemarks] = useState("");
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Receive Payment</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div className="rounded-md bg-muted/30 p-3 text-sm">
          <div className="flex justify-between">
            <span>Customer</span>
            <span>{debt.customers?.name ?? "—"}</span>
          </div>
          <div className="flex justify-between">
            <span>Invoice</span>
            <span className="font-mono">{debt.sales?.invoice_number ?? "—"}</span>
          </div>
          <div className="flex justify-between">
            <span>Outstanding</span>
            <span className="font-medium">{money(Number(debt.outstanding))}</span>
          </div>
        </div>
        <div>
          <Label>Amount</Label>
          <Input
            type="number"
            min={0.01}
            step="0.01"
            max={Number(debt.outstanding)}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
          />
        </div>
        <div>
          <Label>Method</Label>
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
        <div>
          <Label>Remarks</Label>
          <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={saving || amount <= 0 || amount > Number(debt.outstanding)}
          onClick={() => onSubmit(amount, method, remarks)}
        >
          {saving ? "Saving…" : "Record & Print Receipt"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function WriteoffDialog({
  debt,
  onSubmit,
  saving,
}: {
  debt: Debt;
  onSubmit: (reason: string) => void;
  saving: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Request Debt Write-off</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div className="rounded-md bg-muted/30 p-3 text-sm">
          <div className="flex justify-between">
            <span>Customer</span>
            <span>{debt.customers?.name ?? "—"}</span>
          </div>
          <div className="flex justify-between">
            <span>Outstanding to write off</span>
            <span className="font-medium">{money(Number(debt.outstanding))}</span>
          </div>
        </div>
        <div>
          <Label>Reason</Label>
          <Textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this debt being written off?"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          This submits a request — a different, authorized reviewer must approve it before the debt
          is marked paid.
        </p>
      </div>
      <DialogFooter>
        <Button variant="destructive" disabled={saving} onClick={() => onSubmit(reason)}>
          {saving ? "Submitting…" : "Submit write-off request"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ReverseWriteoffDialog({
  debt,
  onSubmit,
  saving,
}: {
  debt: Debt;
  onSubmit: (reason: string) => void;
  saving: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Reverse Write-off — {debt.customers?.name ?? "Debt"}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          This reopens the debt and restores the previously written-off amount as outstanding again.
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
          {saving ? "Reversing…" : "Reverse write-off"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function HistoryDialog({ debt, profiles }: { debt: Debt; profiles: Record<string, string> }) {
  const payments = useQuery({
    queryKey: ["debt-payments", debt.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("debt_payments")
        .select("id,amount,payment_method,payment_date,created_at,received_by,remarks")
        .eq("debt_id", debt.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as DebtPayment[];
    },
  });

  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>History — {debt.customers?.name ?? "Debt"}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div>
          <div className="mb-2 text-sm font-medium">Products purchased</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit Price</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(debt.sales?.sale_items ?? []).map((it, i) => (
                <TableRow key={i}>
                  <TableCell>{it.products?.name ?? "—"}</TableCell>
                  <TableCell className="text-right">{it.quantity}</TableCell>
                  <TableCell className="text-right">{money(Number(it.unit_price))}</TableCell>
                  <TableCell className="text-right">{money(Number(it.line_total))}</TableCell>
                </TableRow>
              ))}
              {(debt.sales?.sale_items ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-4">
                    No line items.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium">Payment history</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date & Time</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Received by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(payments.data ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(p.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">{money(Number(p.amount))}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {p.payment_method}
                    </Badge>
                  </TableCell>
                  <TableCell>{p.received_by ? (profiles[p.received_by] ?? "—") : "—"}</TableCell>
                </TableRow>
              ))}
              {(payments.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-4">
                    No payments recorded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </DialogContent>
  );
}
