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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Plus, Eye, Search, TrendingUp, TrendingDown, Wallet, HandCoins, Check, X, Undo2 } from "lucide-react";
import { money } from "@/lib/format";
import { toast } from "sonner";
import { generateReceiptPdf } from "@/lib/pdf";
import { logAudit } from "@/lib/audit";

export const Route = createFileRoute("/_app/cash-ledger/ledger")({
  head: () => ({ meta: [{ title: "Cash Ledger — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="receipts-payments">
      <LedgerPage />
    </RequireAccess>
  ),
});

type PaymentMethod = "cash" | "transfer" | "pos" | "card" | "cheque" | "credit";
type TxType = "receipt" | "payment";
type UnifiedRow = {
  id: string; number: string; date: string; type: TxType; category: string; description: string | null;
  amount: number; payment_method: string; payer_payee: string | null; related_reference: string | null;
  recorded_by: string | null;
  paymentId?: string; reviewStatus?: string; receivedBy?: string | null;
};
type Customer = { id: string; name: string };
type SaleBrief = { id: string; invoice_number: string; customer_id: string | null; customer_name: string | null; balance: number };

const CATEGORY_LABELS: Record<string, string> = {
  other_income: "Other Income",
  donation_endowment: "Donations / Endowments",
  other_inflow: "Other Cash Inflow",
  other_outflow: "Other Cash Outflow",
};

const reviewBadge = (s?: string): "default" | "secondary" | "outline" | "destructive" =>
  s === "confirmed" ? "secondary" : s === "rejected" || s === "reversed" ? "destructive" : "outline";

function LedgerPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const currency = settings.data?.currency ?? "NGN";
  const qc = useQueryClient();
  const { canWrite, canConfirm, canReject, canReverse } = usePermissions();
  const writeLedger = canWrite("receipts-payments");
  const writePayments = canWrite("payments");
  const confirmPayments = canConfirm("payments");
  const rejectPayments = canReject("payments");
  const reversePayments = canReverse("payments");
  const [formOpen, setFormOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<UnifiedRow | null>(null);
  const [reverseTarget, setReverseTarget] = useState<UnifiedRow | null>(null);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | TxType>("all");

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const profiles = useQuery({
    queryKey: ["profiles-map"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id,full_name");
      if (error) throw error;
      const map: Record<string, string> = {};
      (data ?? []).forEach((p) => { map[p.id] = p.full_name ?? "—"; });
      return map;
    },
  });

  const customers = useQuery({
    queryKey: ["customers-brief-p", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase.from("customers").select("id,name").eq("factory_id", factoryId!).order("name");
      if (error) throw error;
      return (data ?? []) as Customer[];
    },
  });

  const sales = useQuery({
    queryKey: ["sales-brief-p", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales").select("id,invoice_number,customer_id,customer_name,balance")
        .eq("factory_id", factoryId!).gt("balance", 0)
        .order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return (data ?? []) as SaleBrief[];
    },
  });

  const receipts = useQuery({
    queryKey: ["rp-receipts", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments_received")
        .select("id,receipt_number,payment_date,amount,payment_method,remarks,received_by,status,customers(name),sales(invoice_number)")
        .eq("factory_id", factoryId!).order("payment_date", { ascending: false }).limit(300);
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const payments = useQuery({
    queryKey: ["rp-payments", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expenses")
        .select("id,receipt_number,expense_date,amount,payment_method,description,vendor,requested_by_name,recorded_by,approval_status,expense_categories(name)")
        .eq("factory_id", factoryId!).order("expense_date", { ascending: false }).limit(300);
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const others = useQuery({
    queryKey: ["rp-cash-transactions", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cash_transactions")
        .select("id,transaction_number,transaction_date,transaction_type,category,description,amount,payment_method,payer_payee,related_reference,recorded_by_name")
        .eq("factory_id", factoryId!).order("transaction_date", { ascending: false }).limit(300);
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["rp-cash-transactions"] });
    qc.invalidateQueries({ queryKey: ["rp-receipts"] });
    qc.invalidateQueries({ queryKey: ["cf-cash-transactions"] });
    qc.invalidateQueries({ queryKey: ["debts"] });
    qc.invalidateQueries({ queryKey: ["sales-brief-p"] });
  };

  const rows: UnifiedRow[] = useMemo(() => {
    const fromReceipts: UnifiedRow[] = (receipts.data ?? []).map((r) => ({
      id: `r-${r.id}`, number: r.receipt_number, date: r.payment_date, type: "receipt",
      category: "Sales Income", description: r.remarks ?? (r.sales?.invoice_number ? `Payment for ${r.sales.invoice_number}` : "Payment received"),
      amount: Number(r.amount), payment_method: r.payment_method, payer_payee: r.customers?.name ?? null,
      related_reference: r.sales?.invoice_number ?? null,
      recorded_by: r.received_by ? profiles.data?.[r.received_by] ?? null : null,
      paymentId: r.id, reviewStatus: r.status, receivedBy: r.received_by,
    }));
    const fromPayments: UnifiedRow[] = (payments.data ?? []).filter((e) => e.approval_status === "approved").map((e) => ({
      id: `e-${e.id}`, number: e.receipt_number ?? "—", date: e.expense_date, type: "payment",
      category: e.expense_categories?.name ?? "Uncategorized", description: e.description,
      amount: Number(e.amount), payment_method: e.payment_method, payer_payee: e.vendor,
      related_reference: null,
      recorded_by: e.requested_by_name ?? (e.recorded_by ? profiles.data?.[e.recorded_by] ?? null : null),
    }));
    const fromOthers: UnifiedRow[] = (others.data ?? []).map((c) => ({
      id: `c-${c.id}`, number: c.transaction_number, date: c.transaction_date, type: c.transaction_type,
      category: CATEGORY_LABELS[c.category] ?? c.category, description: c.description,
      amount: Number(c.amount), payment_method: c.payment_method, payer_payee: c.payer_payee,
      related_reference: c.related_reference, recorded_by: c.recorded_by_name,
    }));
    return [...fromReceipts, ...fromPayments, ...fromOthers].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [receipts.data, payments.data, others.data, profiles.data]);

  const filtered = useMemo(() => {
    let r = rows;
    if (typeFilter !== "all") r = r.filter((x) => x.type === typeFilter);
    const query = q.trim().toLowerCase();
    if (query) {
      r = r.filter((x) =>
        x.number.toLowerCase().includes(query) ||
        (x.description ?? "").toLowerCase().includes(query) ||
        (x.payer_payee ?? "").toLowerCase().includes(query) ||
        x.category.toLowerCase().includes(query));
    }
    return r;
  }, [rows, typeFilter, q]);

  const totalReceipts = rows.filter((r) => r.type === "receipt").reduce((s, r) => s + r.amount, 0);
  const totalPayments = rows.filter((r) => r.type === "payment").reduce((s, r) => s + r.amount, 0);

  const recordPayment = useMutation({
    mutationFn: async (input: {
      customer_id: string | null; sale_id: string | null; amount: number; method: PaymentMethod;
      remarks: string; date: string; customer_name: string; invoice_number: string;
    }) => {
      const { data, error } = await supabase.rpc("record_payment", {
        payload: {
          factory_id: factoryId, customer_id: input.customer_id, sale_id: input.sale_id,
          amount: input.amount, payment_method: input.method, remarks: input.remarks, payment_date: input.date,
        } as any,
      });
      if (error) throw error;
      return { res: data as any, input };
    },
    onSuccess: ({ res, input }) => {
      toast.success(`Receipt ${res.receipt_number}`);
      logAudit({
        action: "payment", entity: "payments_received", entityId: res.payment_id, factoryId,
        newValue: { receipt_number: res.receipt_number, amount: input.amount, method: input.method },
      });
      generateReceiptPdf({
        company: { name: settings.data?.company_name ?? "FMIS", address: settings.data?.address, phone: settings.data?.phone },
        receipt_number: res.receipt_number, payment_date: input.date,
        customer_name: input.customer_name, invoice_number: input.invoice_number || undefined,
        amount: input.amount, payment_method: input.method, remarks: input.remarks,
        currency: settings.data?.currency ?? "NGN",
      });
      invalidateAll();
      setPayOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const review = useMutation({
    mutationFn: async ({ id, doApprove, reason }: { id: string; doApprove: boolean; reason?: string }) => {
      const { error } = await supabase.rpc(doApprove ? "confirm_payment" : "reject_payment", doApprove
        ? { p_id: id }
        : { p_id: id, p_reason: reason ?? "Rejected" });
      if (error) throw error;
    },
    onSuccess: (_r, vars) => { toast.success(vars.doApprove ? "Payment confirmed" : "Payment rejected"); invalidateAll(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const reverse = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc("reverse_payment", { p_id: id, p_reason: reason });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Payment reversed"); invalidateAll(); setReverseTarget(null); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {writePayments && (
        <Dialog open={payOpen} onOpenChange={setPayOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" className="gap-2"><HandCoins className="h-4 w-4" /> Record Payment</Button>
          </DialogTrigger>
          {payOpen && (
            <NewPaymentDialog
              customers={customers.data ?? []}
              sales={sales.data ?? []}
              saving={recordPayment.isPending}
              onSubmit={(v) => recordPayment.mutate(v)}
            />
          )}
        </Dialog>
        )}
        {writeLedger && (
        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="h-4 w-4" /> New Transaction</Button>
          </DialogTrigger>
          {formOpen && factoryId && (
            <TransactionForm factoryId={factoryId} onDone={() => { setFormOpen(false); invalidateAll(); }} />
          )}
        </Dialog>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="rounded-2xl">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Total Receipts</div>
              <div className="mt-2 text-2xl font-semibold text-success">{money(totalReceipts, currency)}</div>
            </div>
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-success/10 text-success"><TrendingUp className="h-5 w-5" /></div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Total Payments</div>
              <div className="mt-2 text-2xl font-semibold text-destructive">{money(totalPayments, currency)}</div>
            </div>
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-destructive/10 text-destructive"><TrendingDown className="h-5 w-5" /></div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Net</div>
              <div className={`mt-2 text-2xl font-semibold ${totalReceipts - totalPayments >= 0 ? "text-success" : "text-destructive"}`}>
                {money(totalReceipts - totalPayments, currency)}
              </div>
            </div>
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary"><Wallet className="h-5 w-5" /></div>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Transactions</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search…" className="pl-8 h-9 w-48" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as typeof typeFilter)}>
              <SelectTrigger className="h-9 w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="receipt">Receipts</SelectItem>
                <SelectItem value="payment">Payments</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Payer/Payee</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Review</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.number}</TableCell>
                  <TableCell>{r.date}</TableCell>
                  <TableCell><Badge variant={r.type === "receipt" ? "secondary" : "destructive"} className="capitalize">{r.type}</Badge></TableCell>
                  <TableCell>{r.category}</TableCell>
                  <TableCell>{r.payer_payee ?? "—"}</TableCell>
                  <TableCell><Badge variant="outline" className="capitalize">{r.payment_method}</Badge></TableCell>
                  <TableCell>
                    {r.paymentId ? <Badge variant={reviewBadge(r.reviewStatus)} className="capitalize">{r.reviewStatus ?? "pending"}</Badge> : "—"}
                  </TableCell>
                  <TableCell className="text-right font-medium">{money(r.amount, currency)}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {r.paymentId && r.reviewStatus === "pending_confirmation" && r.receivedBy !== currentUser.data && (
                        <>
                          {confirmPayments && (
                            <Button variant="ghost" size="icon" title="Confirm" onClick={() => review.mutate({ id: r.paymentId!, doApprove: true })}>
                              <Check className="h-4 w-4 text-success" />
                            </Button>
                          )}
                          {rejectPayments && (
                            <Button variant="ghost" size="icon" title="Reject" onClick={() => review.mutate({ id: r.paymentId!, doApprove: false })}>
                              <X className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </>
                      )}
                      {r.paymentId && r.reviewStatus === "confirmed" && reversePayments && r.receivedBy !== currentUser.data && (
                        <Button variant="ghost" size="icon" title="Reverse" onClick={() => setReverseTarget(r)}>
                          <Undo2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" title="View" onClick={() => setDetailTarget(r)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No transactions match.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!detailTarget} onOpenChange={(v) => !v && setDetailTarget(null)}>
        {detailTarget && (
          <DialogContent>
            <DialogHeader><DialogTitle>{detailTarget.number}</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><span className="text-muted-foreground">Date:</span> {detailTarget.date}</div>
              <div><span className="text-muted-foreground">Type:</span> <Badge variant={detailTarget.type === "receipt" ? "secondary" : "destructive"} className="capitalize">{detailTarget.type}</Badge></div>
              <div><span className="text-muted-foreground">Category:</span> {detailTarget.category}</div>
              <div><span className="text-muted-foreground">Amount:</span> {money(detailTarget.amount, currency)}</div>
              <div><span className="text-muted-foreground">Payment method:</span> {detailTarget.payment_method}</div>
              <div><span className="text-muted-foreground">Payer/Payee:</span> {detailTarget.payer_payee ?? "—"}</div>
              <div><span className="text-muted-foreground">Related reference:</span> {detailTarget.related_reference ?? "—"}</div>
              <div><span className="text-muted-foreground">Recorded by:</span> {detailTarget.recorded_by ?? "—"}</div>
              <div className="col-span-2"><span className="text-muted-foreground">Description:</span> {detailTarget.description ?? "—"}</div>
            </div>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={!!reverseTarget} onOpenChange={(v) => !v && setReverseTarget(null)}>
        {reverseTarget && (
          <ReversePaymentDialog
            row={reverseTarget}
            currency={currency}
            onSubmit={(reason) => reverse.mutate({ id: reverseTarget.paymentId!, reason })}
            saving={reverse.isPending}
          />
        )}
      </Dialog>
    </div>
  );
}

function ReversePaymentDialog({ row, currency, onSubmit, saving }: { row: UnifiedRow; currency: string; onSubmit: (reason: string) => void; saving: boolean }) {
  const [reason, setReason] = useState("");
  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Reverse Payment — {row.number}</DialogTitle></DialogHeader>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          This reverses {money(row.amount, currency)} received from {row.payer_payee ?? "this customer"} — the linked debt/customer balance is restored.
        </p>
        <div><Label>Reason</Label><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      <DialogFooter>
        <Button variant="destructive" disabled={saving || !reason.trim()} onClick={() => onSubmit(reason)}>
          {saving ? "Reversing…" : "Reverse payment"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function NewPaymentDialog({ customers, sales, onSubmit, saving }: {
  customers: Customer[];
  sales: SaleBrief[];
  onSubmit: (v: {
    customer_id: string | null; sale_id: string | null; amount: number; method: PaymentMethod;
    remarks: string; date: string; customer_name: string; invoice_number: string;
  }) => void;
  saving: boolean;
}) {
  const [customerId, setCustomerId] = useState<string>("none");
  const [saleId, setSaleId] = useState<string>("none");
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [remarks, setRemarks] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  const selectedSale = sales.find((s) => s.id === saleId);

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Record Payment</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Invoice (optional)</Label>
          <Select value={saleId} onValueChange={(v) => {
            setSaleId(v);
            const s = sales.find((x) => x.id === v);
            if (s) {
              if (s.customer_id) setCustomerId(s.customer_id);
              setAmount(Number(s.balance));
            }
          }}>
            <SelectTrigger><SelectValue placeholder="Link to an invoice…" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— No invoice —</SelectItem>
              {sales.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.invoice_number} · {s.customer_name ?? "Walk-in"} · bal {money(Number(s.balance))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Customer</Label>
          <Select value={customerId} onValueChange={setCustomerId}>
            <SelectTrigger><SelectValue placeholder="Select customer…" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— None —</SelectItem>
              {customers.map((c) => (<SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div><Label>Amount</Label><Input type="number" min={0.01} step="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></div>
        </div>
        <div>
          <Label>Method</Label>
          <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {(["cash","transfer","pos","card","cheque"] as PaymentMethod[]).map((m) => (
                <SelectItem key={m} value={m} className="capitalize">{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div><Label>Remarks</Label><Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
        <p className="text-xs text-muted-foreground">The receipt prints immediately. A different reviewer will confirm this payment afterward.</p>
      </div>
      <DialogFooter>
        <Button
          disabled={saving || amount <= 0}
          onClick={() => onSubmit({
            customer_id: customerId === "none" ? null : customerId,
            sale_id: saleId === "none" ? null : saleId,
            customer_name: customers.find((c) => c.id === customerId)?.name ?? selectedSale?.customer_name ?? "",
            invoice_number: selectedSale?.invoice_number ?? "",
            amount, method, remarks, date,
          })}
        >
          {saving ? "Saving…" : "Record & Print Receipt"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function TransactionForm({ factoryId, onDone }: { factoryId: string; onDone: () => void }) {
  const [type, setType] = useState<TxType>("receipt");
  const [category, setCategory] = useState("other_income");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [payerPayee, setPayerPayee] = useState("");
  const [reference, setReference] = useState("");
  const [recordedBy, setRecordedBy] = useState("");

  const categoryOptions = type === "receipt"
    ? [["other_income", "Other Income"], ["donation_endowment", "Donations / Endowments"], ["other_inflow", "Other Cash Inflow"]]
    : [["other_outflow", "Other Cash Outflow"]];

  const onTypeChange = (v: TxType) => {
    setType(v);
    setCategory(v === "receipt" ? "other_income" : "other_outflow");
  };

  const save = useMutation({
    mutationFn: async () => {
      if (amount <= 0) throw new Error("Amount must be > 0");
      if (!recordedBy.trim()) throw new Error("Enter who is recording this transaction");
      const { data, error } = await supabase.rpc("create_cash_transaction", {
        payload: {
          factory_id: factoryId, transaction_type: type, category, transaction_date: date,
          description: description || null, amount, payment_method: method,
          payer_payee: payerPayee || null, related_reference: reference || null, recorded_by_name: recordedBy.trim(),
        } as any,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: (data) => {
      toast.success(`Transaction ${data?.transaction_number ?? ""} recorded`);
      logAudit({ action: "create", entity: "cash_transactions", entityId: data?.id, factoryId, newValue: { category, amount, type } });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>New Transaction</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          Sales receipts and expense payments are recorded from the Sales and Expenses pages. Use this for everything else — other income, donations, or miscellaneous cash movement.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Transaction type</Label>
            <Select value={type} onValueChange={(v) => onTypeChange(v as TxType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="receipt">Receipt (cash in)</SelectItem>
                <SelectItem value="payment">Payment (cash out)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {categoryOptions.map(([v, l]) => (<SelectItem key={v} value={v}>{l}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div><Label>Description</Label><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div><Label>Amount</Label><Input type="number" min={0.01} step="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Payment method</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["cash", "transfer", "pos", "card", "cheque", "credit"] as PaymentMethod[]).map((m) => (
                  <SelectItem key={m} value={m} className="capitalize">{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div><Label>Payer / Payee</Label><Input value={payerPayee} onChange={(e) => setPayerPayee(e.target.value)} /></div>
        </div>
        <div><Label>Related invoice / transaction</Label><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" /></div>
        <div><Label>Recorded by</Label><Input value={recordedBy} onChange={(e) => setRecordedBy(e.target.value)} placeholder="Your name" /></div>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending || amount <= 0} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Record Transaction"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
