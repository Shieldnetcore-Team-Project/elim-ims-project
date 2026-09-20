import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { usePermissions, useIsSuperAdmin } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Trash2,
  FileDown,
  Printer,
  Eye,
  Receipt as ReceiptIcon,
  HandCoins,
  History,
  ShoppingCart,
  Check,
  X,
  Ban,
  PiggyBank,
} from "lucide-react";
import { money, num } from "@/lib/format";
import { toast } from "sonner";
import { generateInvoicePdf } from "@/lib/pdf";
import { logAudit } from "@/lib/audit";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { salePaymentStatus, salePosition, useCustomerAccount } from "@/lib/customer-account";
import { AccountLedgerTable, AccountStatusBadge } from "@/components/sales/account-ledger";
import { CustomerAccountDialog } from "@/components/sales/customer-account-dialog";
import { ApprovalHistory } from "@/components/workflow/approval-history";
import { requestDelete } from "@/lib/request-delete";
import { RequestDeleteDialog } from "@/components/shared/request-delete-dialog";
import { QuickAddProductDialog, ADD_NEW_ITEM } from "@/components/shared/quick-add-item";

export const Route = createFileRoute("/_app/sales")({
  head: () => ({ meta: [{ title: "Sales & POS — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="sales">
      <SalesPage />
    </RequireAccess>
  ),
});

type PaymentMethod = "cash" | "transfer" | "pos" | "card" | "cheque" | "credit";

type Product = {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  unit_price: number;
  current_stock: number;
  category_id: string | null;
};
type Category = { id: string; name: string };
type Customer = { id: string; name: string; phone: string | null; address: string | null };
type SaleRow = {
  id: string;
  invoice_number: string;
  sale_date: string;
  customer_id: string | null;
  customer_name: string | null;
  grand_total: number;
  amount_paid: number;
  balance: number;
  credit_applied: number;
  payment_method: string;
  is_pr: boolean;
  status: string;
  created_by: string | null;
  rejected_reason: string | null;
};
type CartItem = {
  product_id: string;
  name: string;
  unit: string;
  quantity: number;
  unit_price: number;
  stock: number;
};

const saleStatusBadge = (s: string): "default" | "secondary" | "outline" | "destructive" =>
  s === "posted" ? "secondary" : s === "rejected" || s === "cancelled" ? "destructive" : "outline";

function SalesPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const qc = useQueryClient();
  // Other users' approvals, payments and advances move a customer's account —
  // keep every open account view current without a manual refresh.
  useRealtimeInvalidate(
    ["customer_account_transactions", "sales", "payments_received"],
    [["sales-list"], ["customer-account"], ["customer-sales-full"], ["customer-payments-full"]],
  );
  const { canWrite, canApprove, canReject, canCancel, canDelete } = usePermissions();
  const write = canWrite("sales");
  const approve = canApprove("sales");
  const reject = canReject("sales");
  const cancel = canCancel("sales");
  const canRequestDelete = canDelete("sales");
  // Mirrors approve_sale()/reject_sale()'s own self-approval exception --
  // an admin (super_admin) can approve/reject a sale even if they're the
  // one who recorded it; every other approver role still can't.
  const isSuperAdmin = useIsSuperAdmin().data ?? false;
  const [posOpen, setPosOpen] = useState(false);
  const [presetCustomerId, setPresetCustomerId] = useState<string | undefined>(undefined);
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [payTarget, setPayTarget] = useState<SaleRow | null>(null);
  const [historyTarget, setHistoryTarget] = useState<{ id: string; name: string } | null>(null);
  const [approveTarget, setApproveTarget] = useState<SaleRow | null>(null);
  const [rejectTarget, setRejectTarget] = useState<SaleRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<SaleRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SaleRow | null>(null);

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const sales = useQuery({
    queryKey: ["sales-list", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select(
          "id,invoice_number,sale_date,customer_id,customer_name,grand_total,amount_paid,balance,credit_applied,payment_method,created_at,is_pr,status,created_by,rejected_reason",
        )
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });

  const openInvoice = async (saleId: string, action: "download" | "print") => {
    const { data, error } = await supabase
      .from("sales")
      .select(
        `
      *, sale_items(quantity,unit_price,line_total,products(name,unit))
    `,
      )
      .eq("id", saleId)
      .single();
    if (error) {
      toast.error(error.message);
      return;
    }
    const s = data as any;
    await generateInvoicePdf(
      {
        company: {
          name: settings.data?.company_name ?? "FMIS",
          address: settings.data?.address,
          phone: settings.data?.phone,
          email: settings.data?.email,
          logo_url: settings.data?.logo_url,
        },
        invoice_number: s.invoice_number,
        sale_date: s.sale_date,
        customer: { name: s.customer_name, phone: s.customer_phone, address: s.customer_address },
        items: (s.sale_items ?? []).map((it: any) => ({
          name: it.products?.name ?? "-",
          quantity: Number(it.quantity),
          unit: it.products?.unit ?? "",
          unit_price: Number(it.unit_price),
          line_total: Number(it.line_total),
        })),
        subtotal: Number(s.subtotal),
        discount: Number(s.discount),
        vat: Number(s.vat),
        grand_total: Number(s.grand_total),
        amount_paid: Number(s.amount_paid),
        balance: Number(s.balance),
        currency: settings.data?.currency ?? "NGN",
        remarks: s.remarks,
        sales_person: s.sales_person,
        is_pr: s.is_pr,
      },
      action,
    );
  };

  const pay = useMutation({
    mutationFn: async (input: {
      sale: SaleRow;
      payments: { amount: number; method: PaymentMethod }[];
      remarks: string;
    }) => {
      const { data, error } = await supabase.rpc("record_payment", {
        payload: {
          factory_id: factoryId,
          customer_id: input.sale.customer_id,
          sale_id: input.sale.id,
          payments: input.payments,
          remarks: input.remarks,
        } as any,
      });
      if (error) throw error;
      return { res: data as any, input };
    },
    onSuccess: ({ res }) => {
      const lines: { receipt_number: string; amount: number; payment_method: string }[] =
        res.payments;
      toast.success(
        lines.length > 1
          ? `${lines.length} receipts recorded`
          : `Receipt ${lines[0].receipt_number}`,
      );
      qc.invalidateQueries({ queryKey: ["sales-list"] });
      qc.invalidateQueries({ queryKey: ["customer-account"] });
      qc.invalidateQueries({ queryKey: ["customer-sales-full"] });
      qc.invalidateQueries({ queryKey: ["customer-payments-full"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      setPayTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const invalidateAfterApproval = () => {
    qc.invalidateQueries({ queryKey: ["sales-list"] });
    qc.invalidateQueries({ queryKey: ["customer-account"] });
    qc.invalidateQueries({ queryKey: ["customer-sales-full"] });
    qc.invalidateQueries({ queryKey: ["customer-payments-full"] });
    qc.invalidateQueries({ queryKey: ["customers"] });
    // approve_sale is what actually decrements stock -- keep the rest of
    // the app's stock-derived views in sync, same as a normal sale used to.
    qc.invalidateQueries({ queryKey: ["finished-goods"] });
    qc.invalidateQueries({ queryKey: ["products-active"] });
    qc.invalidateQueries({ queryKey: ["products-for-production"] });
  };

  const approveSale = useMutation({
    mutationFn: async (input: { sale: SaleRow; comment: string }) => {
      const { error } = await supabase.rpc("approve_sale", {
        p_id: input.sale.id,
        p_comment: input.comment || undefined,
      });
      if (error) throw error;
      return input;
    },
    onSuccess: ({ sale }) => {
      toast.success(`Sale ${sale.invoice_number} approved and posted`);
      logAudit({ action: "approve", entity: "sales", entityId: sale.id, factoryId });
      invalidateAfterApproval();
      setApproveTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejectSale = useMutation({
    mutationFn: async (input: { sale: SaleRow; reason: string }) => {
      const { error } = await supabase.rpc("reject_sale", {
        p_id: input.sale.id,
        p_reason: input.reason,
      });
      if (error) throw error;
      return input;
    },
    onSuccess: ({ sale }) => {
      toast.success(`Sale ${sale.invoice_number} rejected`);
      logAudit({ action: "reject", entity: "sales", entityId: sale.id, factoryId });
      qc.invalidateQueries({ queryKey: ["sales-list"] });
      qc.invalidateQueries({ queryKey: ["customer-account"] });
      qc.invalidateQueries({ queryKey: ["customer-sales-full"] });
      qc.invalidateQueries({ queryKey: ["customer-payments-full"] });
      setRejectTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelSale = useMutation({
    mutationFn: async (sale: SaleRow) => {
      const { error } = await supabase.rpc("cancel_sale", { p_id: sale.id });
      if (error) throw error;
      return sale;
    },
    onSuccess: (sale) => {
      toast.success(`Sale ${sale.invoice_number} cancelled`);
      logAudit({ action: "cancel", entity: "sales", entityId: sale.id, factoryId });
      qc.invalidateQueries({ queryKey: ["sales-list"] });
      qc.invalidateQueries({ queryKey: ["customer-account"] });
      qc.invalidateQueries({ queryKey: ["customer-sales-full"] });
      qc.invalidateQueries({ queryKey: ["customer-payments-full"] });
      setCancelTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteSale = useMutation({
    mutationFn: async ({ sale, reason }: { sale: SaleRow; reason: string }) => {
      await requestDelete("sales", sale.id, reason);
    },
    onSuccess: () => {
      toast.success("Deletion requested — pending admin approval");
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["sales-list"] });
      qc.invalidateQueries({ queryKey: ["customer-account"] });
      qc.invalidateQueries({ queryKey: ["customer-sales-full"] });
      qc.invalidateQueries({ queryKey: ["customer-payments-full"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sales & POS</h1>
          <p className="text-sm text-muted-foreground">
            Create invoices — a manager must approve each sale before it decrements stock and counts
            toward the customer's balance.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {write && (
            <Button variant="outline" className="gap-2" onClick={() => setAdvanceOpen(true)}>
              <PiggyBank className="h-4 w-4" /> Record Advance Payment
            </Button>
          )}
          {write && (
            <Dialog
              open={posOpen}
              onOpenChange={(v) => {
                setPosOpen(v);
                if (!v) setPresetCustomerId(undefined);
              }}
            >
              <DialogTrigger asChild>
                <Button className="gap-2" onClick={() => setPresetCustomerId(undefined)}>
                  <Plus className="h-4 w-4" /> New Sale
                </Button>
              </DialogTrigger>
              {posOpen && factoryId && (
                <PosDialog
                  factoryId={factoryId}
                  presetCustomerId={presetCustomerId}
                  onDone={() => {
                    setPosOpen(false);
                    setPresetCustomerId(undefined);
                    qc.invalidateQueries({ queryKey: ["sales-list"] });
                    qc.invalidateQueries({ queryKey: ["customer-account"] });
                    qc.invalidateQueries({ queryKey: ["customer-sales-full"] });
                    qc.invalidateQueries({ queryKey: ["customer-payments-full"] });
                    // A sale decrements products.current_stock — make sure the
                    // Finished Goods / Store page picks that up even if it's
                    // already mounted elsewhere, instead of relying only on
                    // realtime or a fresh navigation.
                    qc.invalidateQueries({ queryKey: ["finished-goods"] });
                    qc.invalidateQueries({ queryKey: ["products-active"] });
                    qc.invalidateQueries({ queryKey: ["products-for-production"] });
                  }}
                />
              )}
            </Dialog>
          )}
        </div>
      </div>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Recent Sales</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Method</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Payment Status</TableHead>
                <TableHead>Approval</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(sales.data ?? []).map((s: SaleRow) => {
                const status = salePaymentStatus(s);
                const isSelf = s.created_by === currentUser.data && !isSuperAdmin;
                return (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">{s.invoice_number}</TableCell>
                    <TableCell>{s.sale_date}</TableCell>
                    <TableCell>
                      {s.customer_id ? (
                        <button
                          type="button"
                          className="text-left font-medium text-primary hover:underline"
                          title="View this customer's products & transactions"
                          onClick={() =>
                            setHistoryTarget({
                              id: s.customer_id!,
                              name: s.customer_name ?? "Customer",
                            })
                          }
                        >
                          {s.customer_name ?? "Customer"}
                        </button>
                      ) : (
                        (s.customer_name ?? "Walk-in")
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {s.payment_method}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{money(Number(s.grand_total))}</TableCell>
                    <TableCell className="text-right">{money(Number(s.amount_paid))}</TableCell>
                    <TableCell className="text-right">
                      <span className={Number(s.balance) > 0 ? "text-destructive font-medium" : ""}>
                        {money(Number(s.balance))}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={status.variant}
                        className={s.is_pr ? "text-warning" : "capitalize"}
                      >
                        {status.label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={saleStatusBadge(s.status)} className="capitalize">
                        {s.status.replace(/_/g, " ")}
                      </Badge>
                      {s.status === "rejected" && s.rejected_reason && (
                        <div
                          className="mt-1 max-w-[160px] truncate text-xs text-muted-foreground"
                          title={s.rejected_reason}
                        >
                          {s.rejected_reason}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {s.status === "pending_approval" && approve && !isSelf && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Approve & post"
                            onClick={() => setApproveTarget(s)}
                          >
                            <Check className="h-4 w-4 text-success" />
                          </Button>
                        )}
                        {s.status === "pending_approval" && reject && !isSelf && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Reject"
                            onClick={() => setRejectTarget(s)}
                          >
                            <X className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                        {s.status === "pending_approval" && cancel && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Cancel"
                            onClick={() => setCancelTarget(s)}
                          >
                            <Ban className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        )}
                        {s.status === "posted" && Number(s.balance) > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1"
                            onClick={() => setPayTarget(s)}
                          >
                            <HandCoins className="h-4 w-4" /> Receive
                          </Button>
                        )}
                        {write && s.customer_id && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title={`Add products to ${s.customer_name ?? "this customer"}'s account`}
                            onClick={() => {
                              setPresetCustomerId(s.customer_id!);
                              setPosOpen(true);
                            }}
                          >
                            <ShoppingCart className="h-4 w-4" />
                          </Button>
                        )}
                        {s.customer_id && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1"
                            onClick={() =>
                              setHistoryTarget({
                                id: s.customer_id!,
                                name: s.customer_name ?? "Customer",
                              })
                            }
                          >
                            <History className="h-4 w-4" /> History
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1"
                          onClick={() => openInvoice(s.id, "print")}
                        >
                          <Printer className="h-4 w-4" /> Print
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1"
                          onClick={() => openInvoice(s.id, "download")}
                        >
                          <FileDown className="h-4 w-4" /> PDF
                        </Button>
                        {canRequestDelete && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Request deletion"
                            onClick={() => setDeleteTarget(s)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {(sales.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                    No sales yet.
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
            sale={payTarget}
            saving={pay.isPending}
            onSubmit={(payments, remarks) => pay.mutate({ sale: payTarget, payments, remarks })}
          />
        )}
      </Dialog>

      <Dialog open={!!historyTarget} onOpenChange={(v) => !v && setHistoryTarget(null)}>
        {historyTarget && (
          <CustomerAccountDialog customerId={historyTarget.id} customerName={historyTarget.name} />
        )}
      </Dialog>

      <Dialog open={!!approveTarget} onOpenChange={(v) => !v && setApproveTarget(null)}>
        {approveTarget && (
          <ApproveSaleDialog
            sale={approveTarget}
            saving={approveSale.isPending}
            onSubmit={(comment) => approveSale.mutate({ sale: approveTarget, comment })}
          />
        )}
      </Dialog>
      <Dialog open={!!rejectTarget} onOpenChange={(v) => !v && setRejectTarget(null)}>
        {rejectTarget && (
          <RejectSaleDialog
            sale={rejectTarget}
            saving={rejectSale.isPending}
            onSubmit={(reason) => rejectSale.mutate({ sale: rejectTarget, reason })}
          />
        )}
      </Dialog>
      <Dialog open={!!cancelTarget} onOpenChange={(v) => !v && setCancelTarget(null)}>
        {cancelTarget && (
          <CancelSaleDialog
            sale={cancelTarget}
            saving={cancelSale.isPending}
            onConfirm={() => cancelSale.mutate(cancelTarget)}
          />
        )}
      </Dialog>

      <RequestDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        isPending={deleteSale.isPending}
        title={
          deleteTarget
            ? `Request deletion — ${deleteTarget.invoice_number}${
                deleteTarget.status === "posted"
                  ? " (posted — approval reverses its stock and restores any advance it used; the reversal is recorded on the customer account)"
                  : ""
              }`
            : "Request deletion"
        }
        onConfirm={(reason) => deleteTarget && deleteSale.mutate({ sale: deleteTarget, reason })}
      />

      <Dialog open={advanceOpen} onOpenChange={setAdvanceOpen}>
        {advanceOpen && factoryId && (
          <AdvancePaymentDialog
            factoryId={factoryId}
            onDone={() => {
              setAdvanceOpen(false);
              qc.invalidateQueries({ queryKey: ["customers"] });
              qc.invalidateQueries({ queryKey: ["customer-account"] });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

type PaymentLine = { amount: number; method: PaymentMethod };

// Shared by the New Sale checkout and Receive Payment dialogs — one row per
// method so a customer paying part cash, part transfer can be recorded in a
// single transaction instead of forcing everything onto one payment_method.
function PaymentLinesEditor({
  payments,
  onChange,
  methods,
}: {
  payments: PaymentLine[];
  onChange: (payments: PaymentLine[]) => void;
  methods: PaymentMethod[];
}) {
  const update = (i: number, patch: Partial<PaymentLine>) =>
    onChange(payments.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const remove = (i: number) => onChange(payments.filter((_, idx) => idx !== i));
  const add = () => onChange([...payments, { amount: 0, method: "cash" }]);

  return (
    <div className="space-y-2">
      {payments.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <MoneyInput
            value={p.amount}
            onChange={(v) => update(i, { amount: v })}
            className="flex-1"
          />
          <Select value={p.method} onValueChange={(v) => update(i, { method: v as PaymentMethod })}>
            <SelectTrigger className="w-32 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {methods.map((m) => (
                <SelectItem key={m} value={m} className="capitalize">
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {payments.length > 1 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={() => remove(i)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={add}>
        <Plus className="h-3.5 w-3.5" /> Add payment method
      </Button>
    </div>
  );
}

const PAY_DIALOG_METHODS: PaymentMethod[] = ["cash", "transfer", "pos", "card", "cheque"];

function PayDialog({
  sale,
  onSubmit,
  saving,
}: {
  sale: SaleRow;
  onSubmit: (payments: PaymentLine[], remarks: string) => void;
  saving: boolean;
}) {
  const [payments, setPayments] = useState<PaymentLine[]>([
    { amount: Number(sale.balance), method: "cash" },
  ]);
  const [remarks, setRemarks] = useState("");
  const total = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const balance = Number(sale.balance);
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Receive Payment</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div className="rounded-md bg-muted/30 p-3 text-sm">
          <div className="flex justify-between">
            <span>Customer</span>
            <span>{sale.customer_name ?? "Walk-in"}</span>
          </div>
          <div className="flex justify-between">
            <span>Invoice</span>
            <span className="font-mono">{sale.invoice_number}</span>
          </div>
          <div className="flex justify-between">
            <span>Outstanding</span>
            <span className="font-medium">{money(balance)}</span>
          </div>
        </div>
        <div>
          <Label>Payment{payments.length > 1 ? "s" : ""}</Label>
          <PaymentLinesEditor
            payments={payments}
            onChange={setPayments}
            methods={PAY_DIALOG_METHODS}
          />
        </div>
        <div className="flex justify-between text-sm font-medium">
          <span>Total</span>
          <span className={total > balance ? "text-destructive" : ""}>{money(total)}</span>
        </div>
        <div>
          <Label>Remarks</Label>
          <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={saving || total <= 0 || total > balance}
          onClick={() =>
            onSubmit(
              payments.filter((p) => p.amount > 0),
              remarks,
            )
          }
        >
          {saving ? "Saving…" : "Record & Print Receipt"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ApproveSaleDialog({
  sale,
  onSubmit,
  saving,
}: {
  sale: SaleRow;
  onSubmit: (comment: string) => void;
  saving: boolean;
}) {
  const [comment, setComment] = useState("");
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Approve & Post Sale</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {sale.invoice_number} · {sale.customer_name ?? "Walk-in"} ·{" "}
          {money(Number(sale.grand_total))}
        </p>
        <p className="text-sm text-muted-foreground">
          This decrements stock, records any payment taken at the register, and — if there's a
          balance — adds it to the customer's account. It can't be undone from here.
        </p>
        <div>
          <Label>Comment (optional)</Label>
          <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
        <ApprovalHistory module="sales" entityId={sale.id} />
      </div>
      <DialogFooter>
        <Button disabled={saving} onClick={() => onSubmit(comment)}>
          {saving ? "Approving…" : "Approve & Post"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function RejectSaleDialog({
  sale,
  onSubmit,
  saving,
}: {
  sale: SaleRow;
  onSubmit: (reason: string) => void;
  saving: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Reject Sale</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {sale.invoice_number} · {sale.customer_name ?? "Walk-in"} ·{" "}
          {money(Number(sale.grand_total))}
        </p>
        <div>
          <Label>Reason</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <ApprovalHistory module="sales" entityId={sale.id} />
      </div>
      <DialogFooter>
        <Button
          variant="destructive"
          disabled={saving || !reason.trim()}
          onClick={() => onSubmit(reason)}
        >
          {saving ? "Rejecting…" : "Reject"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function CancelSaleDialog({
  sale,
  onConfirm,
  saving,
}: {
  sale: SaleRow;
  onConfirm: () => void;
  saving: boolean;
}) {
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Cancel Sale</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {sale.invoice_number} · {sale.customer_name ?? "Walk-in"} ·{" "}
          {money(Number(sale.grand_total))}
        </p>
        <p className="text-sm text-muted-foreground">
          Nothing has posted to stock or the customer's account yet, so this simply withdraws the
          pending sale.
        </p>
      </div>
      <DialogFooter>
        <Button variant="destructive" disabled={saving} onClick={onConfirm}>
          {saving ? "Cancelling…" : "Cancel Sale"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// Records money a registered customer pays. The server settles the customer's
// oldest debts first and only the excess becomes advance (record_customer_advance
// -> _customer_receive_money), so this dialog shows that split before saving.
function AdvancePaymentDialog({ factoryId, onDone }: { factoryId: string; onDone: () => void }) {
  const customers = useQuery({
    queryKey: ["customers-brief", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("id,name,phone,address")
        .eq("factory_id", factoryId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Customer[];
    },
  });

  const [customerId, setCustomerId] = useState("");
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [remarks, setRemarks] = useState("");
  // One key per opening of this dialog: a double-click or a retry after a
  // dropped connection is recognised by the server and never posts twice.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const account = useCustomerAccount(customerId || undefined);
  const availableAdvance = account.data?.summary.available_advance ?? 0;
  const debt = account.data?.summary.outstanding_debt ?? 0;
  const settlesDebt = Math.min(amount, debt);
  const becomesAdvance = Math.max(amount - debt, 0);

  const submit = useMutation({
    mutationFn: async () => {
      if (!customerId) throw new Error("Select a customer");
      if (amount <= 0) throw new Error("Amount must be greater than 0");
      const { data, error } = await supabase.rpc("record_customer_advance", {
        payload: {
          factory_id: factoryId,
          customer_id: customerId,
          amount,
          payment_method: method,
          reference: reference || null,
          remarks: remarks || null,
          idempotency_key: idempotencyKey,
        } as any,
      });
      if (error) throw error;
      return data as {
        receipt_number: string;
        settled_debt?: number;
        credit_added?: number;
        duplicate?: boolean;
      };
    },
    onSuccess: (data) => {
      const settled = Number(data.settled_debt ?? 0);
      const added = Number(data.credit_added ?? 0);
      const parts = [
        settled > 0 ? `${money(settled)} cleared debt` : null,
        added > 0 ? `${money(added)} added to advance` : null,
      ].filter(Boolean);
      toast.success(
        `${data.duplicate ? "Already recorded" : "Payment recorded"} — receipt ${data.receipt_number}${
          parts.length ? ` (${parts.join(", ")})` : ""
        }`,
      );
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Record Advance Payment</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          For a customer paying ahead of picking up goods. If they owe money, the oldest debts are
          settled first and only the excess becomes advance to draw on in New Sale.
        </p>
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
        {customerId && account.data && (
          <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/30 p-3 text-sm">
            <div>
              <span className="block text-muted-foreground">Available Advance</span>
              <span className={availableAdvance > 0 ? "font-medium text-success" : "font-medium"}>
                {money(availableAdvance)}
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
            <Label>Amount</Label>
            <MoneyInput value={amount} onChange={setAmount} />
          </div>
          <div>
            <Label>Payment method</Label>
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
        </div>
        {customerId && amount > 0 && (
          <div className="space-y-1 rounded-md border p-3 text-sm">
            {debt > 0 && (
              <div className="flex justify-between">
                <span>Clears existing debt</span>
                <span className="text-success">{money(settlesDebt)}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span>Added to advance</span>
              <span className={becomesAdvance > 0 ? "font-medium text-success" : ""}>
                {money(becomesAdvance)}
              </span>
            </div>
            <div className="flex justify-between border-t pt-1 text-xs text-muted-foreground">
              <span>Advance after this payment</span>
              <span>{money(availableAdvance + becomesAdvance)}</span>
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Reference (optional)</Label>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Transfer / POS / cheque no."
            />
          </div>
          <div>
            <Label>Date</Label>
            <Input value={new Date().toLocaleDateString()} disabled />
          </div>
        </div>
        <div>
          <Label>Notes (optional)</Label>
          <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? "Saving…" : "Record Payment"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// Shown inline once an existing (non-Walk-in) customer is picked in the New
// Sale form: the customer's real account position from the ledger — advance,
// debt, status, recent activity — so nothing has to be looked up separately.
function CustomerAccountPanel({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const account = useCustomerAccount(customerId);
  const [historyOpen, setHistoryOpen] = useState(false);

  if (customerId === "walkin") return null;
  if (account.isLoading || !account.data) {
    return <p className="text-xs text-muted-foreground">Loading customer account…</p>;
  }

  const { summary, ledger, pendingSales } = account.data;
  const hasHistory = ledger.length > 0 || pendingSales.length > 0;
  const hadAdvance = summary.total_advance_paid > 0 || summary.opening_credit > 0;

  return (
    <div className="space-y-2 rounded-lg border bg-muted/20 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Customer account
        </span>
        <AccountStatusBadge status={summary.account_status} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className="block text-xs text-muted-foreground">Available Advance</span>
          <span
            className={`text-base font-semibold ${summary.available_advance > 0 ? "text-success" : ""}`}
          >
            {money(summary.available_advance)}
          </span>
        </div>
        <div>
          <span className="block text-xs text-muted-foreground">Outstanding Debt</span>
          <span
            className={`text-base font-semibold ${summary.outstanding_debt > 0 ? "text-destructive" : ""}`}
          >
            {money(summary.outstanding_debt)}
          </span>
        </div>
      </div>

      {summary.outstanding_debt > 0 && (
        <p className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {customerName} still owes {money(summary.outstanding_debt)} from earlier sales. This sale
          does not clear it.
        </p>
      )}
      {summary.available_advance === 0 && hadAdvance && summary.outstanding_debt === 0 && (
        <p className="rounded-md bg-warning/15 px-2 py-1 text-xs text-warning">
          Advance exhausted — this customer has no advance left to draw on.
        </p>
      )}
      {pendingSales.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {pendingSales.length} earlier sale{pendingSales.length === 1 ? " is" : "s are"} still
          awaiting approval and not counted above.
        </p>
      )}

      {hasHistory ? (
        <AccountLedgerTable ledger={ledger} pendingSales={pendingSales} compact limit={5} />
      ) : (
        <p className="text-xs text-muted-foreground">No prior transactions with this customer.</p>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0"
          onClick={() => setHistoryOpen(true)}
        >
          View Account History
        </Button>
      </div>
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        {historyOpen && (
          <CustomerAccountDialog customerId={customerId} customerName={customerName} />
        )}
      </Dialog>
    </div>
  );
}

// Exported so the Store (Finished Goods) page can offer the exact same
// checkout flow -- same create_sale RPC, same stock/customer/debt effects --
// rather than a second, divergent way to record a sale.
export function PosDialog({
  factoryId,
  onDone,
  presetCustomerId,
}: {
  factoryId: string;
  onDone: () => void;
  // Set from the Sales table's per-row "add products to account" icon, so
  // the customer is already selected instead of defaulting to Walk-in.
  presetCustomerId?: string;
}) {
  const settings = useFactorySettings(factoryId);
  const products = useQuery({
    queryKey: ["products-active", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,sku,unit,unit_price,current_stock,category_id")
        .eq("factory_id", factoryId)
        .eq("active", true)
        // Uncategorized products are usually semi-finished/internal items, not
        // sellable SKUs — keep them out of the POS picker.
        .not("category_id", "is", null)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Product[];
    },
  });
  const categories = useQuery({
    queryKey: ["product-categories", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_categories")
        .select("id,name")
        .eq("factory_id", factoryId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Category[];
    },
  });
  const customers = useQuery({
    queryKey: ["customers-brief", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("id,name,phone,address")
        .eq("factory_id", factoryId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Customer[];
    },
  });

  const [cart, setCart] = useState<CartItem[]>([]);
  const [saleDate, setSaleDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [customerId, setCustomerId] = useState<string>(presetCustomerId ?? "walkin");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");

  // customers-brief loads async, so the preset id above may resolve before
  // its name/phone/address are known — fill those in as soon as the list
  // (or a still-loading customer within it) is available.
  useEffect(() => {
    if (!presetCustomerId) return;
    const c = customers.data?.find((x) => x.id === presetCustomerId);
    if (c) {
      setCustomerName(c.name);
      setCustomerPhone(c.phone ?? "");
      setCustomerAddress(c.address ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetCustomerId, customers.data]);
  const [discountInput, setDiscountInput] = useState(0);
  const [discountType, setDiscountType] = useState<"amount" | "percent">("amount");
  const [applyVat, setApplyVat] = useState(true);
  const [isPr, setIsPr] = useState(false);
  const [payments, setPayments] = useState<PaymentLine[]>([{ amount: 0, method: "cash" }]);
  const amountPaid = useMemo(() => payments.reduce((s, p) => s + (p.amount || 0), 0), [payments]);
  // The customer's real account (ledger-backed): advance they can draw on and
  // any debt they already owe. Both feed the live figures below.
  const customerAccount = useCustomerAccount(customerId);
  const availableCredit = customerAccount.data?.summary.available_advance ?? 0;
  const existingDebt = customerAccount.data?.summary.outstanding_debt ?? 0;
  const [salesPerson, setSalesPerson] = useState("");
  const [remarks, setRemarks] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [pickerId, setPickerId] = useState<string>("");
  const [salesRepId, setSalesRepId] = useState<string>("none");

  const currentUserName = useQuery({
    queryKey: ["current-user-full-name"],
    queryFn: async () => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return null;
      const { data } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", userData.user.id)
        .maybeSingle();
      return data?.full_name || userData.user.email || null;
    },
    staleTime: Infinity,
  });
  useEffect(() => {
    if (!salesPerson && currentUserName.data) setSalesPerson(currentUserName.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserName.data]);

  const reps = useQuery({
    queryKey: ["sales-reps-active", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_reps")
        .select("id,full_name")
        .eq("factory_id", factoryId)
        .eq("status", "active")
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string }[];
    },
  });
  const repStock = useQuery({
    queryKey: ["sales-rep-stock", salesRepId],
    enabled: salesRepId !== "none",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rep_stock")
        .select("product_id,quantity")
        .eq("sales_rep_id", salesRepId);
      if (error) throw error;
      return (data ?? []) as { product_id: string; quantity: number }[];
    },
  });
  const repMode = salesRepId !== "none";
  // When a rep is selling, the goods left the store at dispatch time, so the
  // sellable quantity is what's on the rep's van — not products.current_stock.
  const effStock = (p: { id: string; current_stock: number }) =>
    repMode
      ? Number(repStock.data?.find((r) => r.product_id === p.id)?.quantity ?? 0)
      : Number(p.current_stock);

  const vatRate = Number(settings.data?.vat_rate ?? 0);
  const visibleProducts = useMemo(() => {
    const all = products.data ?? [];
    return categoryFilter === "all" ? all : all.filter((p) => p.category_id === categoryFilter);
  }, [products.data, categoryFilter]);

  const totals = useMemo(() => {
    const subtotal = cart.reduce((s, i) => s + i.quantity * i.unit_price, 0);
    // Percentage discount is always taken off the subtotal, not off a
    // previously-discounted amount -- there's only ever one discount here.
    const discount =
      discountType === "percent"
        ? Math.min(subtotal * (Math.max(discountInput, 0) / 100), subtotal)
        : Math.min(Math.max(discountInput, 0), subtotal);
    // PR: stock still goes out (the cart/subtotal above is unaffected), but
    // nothing is billed, paid, or owed -- everything money-related is 0.
    if (isPr) return { subtotal, discount, vat: 0, grand: 0, balance: 0, creditApplied: 0 };
    const vat = applyVat ? Math.max(subtotal - discount, 0) * (vatRate / 100) : 0;
    const grand = Math.max(subtotal - discount + vat, 0);
    // Automatic, not something the cashier sets: whatever the customer's
    // own advance/credit balance can cover of what cash didn't, same
    // formula approve_sale() finalizes with server-side.
    const creditApplied = Math.min(Math.max(grand - amountPaid, 0), availableCredit);
    const balance = Math.max(grand - amountPaid - creditApplied, 0);
    return { subtotal, discount, vat, grand, balance, creditApplied };
  }, [cart, discountInput, discountType, amountPaid, availableCredit, vatRate, applyVat, isPr]);

  const registeredCustomer = customerId !== "walkin";
  // Same arithmetic approve_sale() finalises with, so the figures shown while
  // building the sale are the ones that get posted.
  const position = useMemo(
    () =>
      salePosition({
        grand: totals.grand,
        paid: amountPaid,
        availableAdvance: availableCredit,
        previousDebt: existingDebt,
      }),
    [totals.grand, amountPaid, availableCredit, existingDebt],
  );

  // What actually gets sold -- excludes lines the user has cleared to 0
  // while editing but hasn't removed or refilled yet.
  const sellableCart = useMemo(() => cart.filter((c) => c.quantity > 0), [cart]);

  // Ticking PR clears anything that implies money changed hands, so the form
  // can't show a half-billed, half-free sale.
  useEffect(() => {
    if (isPr) {
      setPayments([{ amount: 0, method: "cash" }]);
      setApplyVat(false);
    }
  }, [isPr]);

  const [addingProduct, setAddingProduct] = useState(false);
  const addProduct = (id: string) => {
    if (id === ADD_NEW_ITEM) {
      setAddingProduct(true);
      return;
    }
    const p = products.data?.find((x) => x.id === id);
    if (!p) return;
    const avail = effStock(p);
    setCart((prev) => {
      const existing = prev.find((c) => c.product_id === id);
      if (existing) {
        if (existing.quantity + 1 > avail) {
          toast.error(`Only ${avail} ${p.unit} ${repMode ? "on the van" : "in stock"}`);
          return prev;
        }
        return prev.map((c) => (c.product_id === id ? { ...c, quantity: c.quantity + 1 } : c));
      }
      if (avail < 1) {
        toast.error(repMode ? "Not on the van" : "Out of stock");
        return prev;
      }
      return [
        ...prev,
        {
          product_id: p.id,
          name: p.name,
          unit: p.unit,
          quantity: 1,
          unit_price: Number(p.unit_price),
          stock: avail,
        },
      ];
    });
    setPickerId("");
  };

  // Doesn't drop lines at quantity 0 -- the quantity box goes through 0
  // while the user clears it to type a new figure, and removing the row
  // out from under them mid-edit would yank the input away. Zero-qty lines
  // are excluded where it actually matters (submit, previews, invoice) via
  // sellableCart below; an explicit trash button removes a row outright.
  const updateQty = (id: string, qty: number) => {
    setCart((prev) =>
      prev.map((c) => {
        if (c.product_id !== id) return c;
        const q = Math.max(0, Math.min(qty, c.stock));
        return { ...c, quantity: q };
      }),
    );
  };
  const updatePrice = (id: string, price: number) => {
    setCart((prev) =>
      prev.map((c) => (c.product_id === id ? { ...c, unit_price: Math.max(0, price) } : c)),
    );
  };

  const submit = useMutation({
    mutationFn: async () => {
      if (sellableCart.length === 0) throw new Error("Cart is empty");
      const finalCustomer = customerId === "walkin" ? null : customerId;
      let displayName = customerName;
      if (finalCustomer) {
        const c = customers.data?.find((x) => x.id === finalCustomer);
        displayName = c?.name ?? displayName;
      }
      const { data, error } = await supabase.rpc("create_sale", {
        payload: {
          factory_id: factoryId,
          sale_date: saleDate,
          customer_id: finalCustomer,
          customer_name: displayName || null,
          customer_phone: customerPhone || null,
          customer_address: customerAddress || null,
          discount: totals.discount,
          vat: totals.vat,
          payments: isPr ? [] : payments.filter((p) => p.amount > 0),
          sales_person: salesPerson || null,
          sales_rep_id: repMode ? salesRepId : null,
          is_pr: isPr,
          remarks: remarks || null,
          items: sellableCart.map((c) => ({
            product_id: c.product_id,
            quantity: c.quantity,
            unit_price: c.unit_price,
          })),
        } as any,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: (res) => {
      toast.success(`${res.invoice_number} submitted — awaiting manager approval`);
      logAudit({
        action: "sale",
        entity: "sales",
        entityId: res.sale_id,
        factoryId,
        newValue: {
          invoice_number: res.invoice_number,
          grand_total: res.grand_total,
          balance: res.balance,
        },
      });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const previewInvoice = async () => {
    if (sellableCart.length === 0) {
      toast.error("Add at least one item to preview");
      return;
    }
    await generateInvoicePdf(
      {
        company: {
          name: settings.data?.company_name ?? "FMIS",
          address: settings.data?.address,
          phone: settings.data?.phone,
          email: settings.data?.email,
          logo_url: settings.data?.logo_url,
        },
        invoice_number: "PREVIEW",
        sale_date: saleDate,
        customer: {
          name: customerName || customers.data?.find((c) => c.id === customerId)?.name,
          phone: customerPhone,
          address: customerAddress,
        },
        items: sellableCart.map((c) => ({
          name: c.name,
          quantity: c.quantity,
          unit: c.unit,
          unit_price: c.unit_price,
          line_total: c.quantity * c.unit_price,
        })),
        subtotal: totals.subtotal,
        discount: totals.discount,
        vat: totals.vat,
        grand_total: totals.grand,
        amount_paid: amountPaid,
        balance: totals.balance,
        currency: settings.data?.currency ?? "NGN",
        remarks,
        sales_person: salesPerson,
        is_pr: isPr,
      },
      "preview",
    );
  };

  return (
    <DialogContent className="flex max-h-[92vh] w-[95vw] max-w-6xl flex-col gap-0 overflow-hidden p-0">
      <DialogHeader className="shrink-0 border-b px-6 py-4">
        <DialogTitle>New Sale</DialogTitle>
      </DialogHeader>
      <div className="grid flex-1 gap-6 overflow-y-auto px-6 py-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-3">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="grid gap-1.5">
              <Label className="text-xs">Add product</Label>
              <Select value={pickerId} onValueChange={addProduct}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a product to add…" />
                </SelectTrigger>
                <SelectContent>
                  {visibleProducts.map((p) => (
                    <SelectItem key={p.id} value={p.id} disabled={effStock(p) <= 0}>
                      {p.name} · {money(Number(p.unit_price))} · {repMode ? "van" : "stock"}{" "}
                      {num(effStock(p))} {p.unit}
                    </SelectItem>
                  ))}
                  {visibleProducts.length === 0 && (
                    <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                      No products in this category.
                    </div>
                  )}
                  <SelectItem value={ADD_NEW_ITEM} className="font-medium text-primary">
                    + Add new product…
                  </SelectItem>
                </SelectContent>
              </Select>
              <QuickAddProductDialog
                open={addingProduct}
                onOpenChange={setAddingProduct}
                factoryId={factoryId}
                onCreated={() => setCategoryFilter("all")}
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">Category</Label>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {(categories.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="max-h-[40vh] overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[220px]">Item</TableHead>
                  <TableHead className="w-28">Qty</TableHead>
                  <TableHead className="w-36">Price</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cart.map((c) => (
                  <TableRow key={c.product_id}>
                    <TableCell>
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground">
                        stock {num(c.stock)} {c.unit}
                      </div>
                    </TableCell>
                    <TableCell>
                      <MoneyInput
                        min={0}
                        max={c.stock}
                        value={c.quantity}
                        onChange={(v) => updateQty(c.product_id, v)}
                        className="h-8"
                      />
                    </TableCell>
                    <TableCell>
                      <MoneyInput
                        value={c.unit_price}
                        onChange={(v) => updatePrice(c.product_id, v)}
                        className="h-8"
                      />
                    </TableCell>
                    <TableCell className="text-right">{money(c.quantity * c.unit_price)}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          setCart((prev) => prev.filter((x) => x.product_id !== c.product_id))
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {cart.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                      No items yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        <div className="min-w-0 space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Sales date</Label>
              <Input type="date" value={saleDate} onChange={(e) => setSaleDate(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Customer</Label>
              <Select
                value={customerId}
                onValueChange={(v) => {
                  setCustomerId(v);
                  if (v === "walkin") {
                    setCustomerName("");
                    setCustomerPhone("");
                    setCustomerAddress("");
                  } else {
                    const c = customers.data?.find((x) => x.id === v);
                    setCustomerName(c?.name ?? "");
                    setCustomerPhone(c?.phone ?? "");
                    setCustomerAddress(c?.address ?? "");
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="walkin">Walk-in</SelectItem>
                  {(customers.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <CustomerAccountPanel
            customerId={customerId}
            customerName={
              (customers.data ?? []).find((c) => c.id === customerId)?.name ?? "This customer"
            }
          />
          {customerId === "walkin" && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Customer name</Label>
                  <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
                </div>
                <div>
                  <Label className="text-xs">Phone</Label>
                  <Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
                </div>
              </div>
              <div>
                <Label className="text-xs">Address</Label>
                <Input
                  value={customerAddress}
                  onChange={(e) => setCustomerAddress(e.target.value)}
                />
              </div>
            </>
          )}
          <div>
            <Label className="text-xs">Discount</Label>
            <div className="flex gap-1.5">
              {discountType === "percent" ? (
                <MoneyInput
                  min={0}
                  max={100}
                  step="0.01"
                  value={discountInput}
                  onChange={setDiscountInput}
                />
              ) : (
                <MoneyInput value={discountInput} onChange={setDiscountInput} />
              )}
              <Select
                value={discountType}
                onValueChange={(v) => setDiscountType(v as "amount" | "percent")}
              >
                <SelectTrigger className="w-16 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="amount">₦</SelectItem>
                  <SelectItem value="percent">%</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={applyVat}
              disabled={isPr}
              onCheckedChange={(v) => setApplyVat(!!v)}
            />
            VAT
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={isPr} onCheckedChange={(v) => setIsPr(!!v)} />
            PR
          </label>
          {!isPr && (
            <div>
              <Label className="text-xs">
                Paid — {payments.length > 1 ? "payments" : "payment"}
              </Label>
              <PaymentLinesEditor
                payments={payments}
                onChange={setPayments}
                methods={PAY_DIALOG_METHODS}
              />
            </div>
          )}
          <div>
            <Label className="text-xs">Sales rep (van stock)</Label>
            <Select
              value={salesRepId}
              onValueChange={(v) => {
                setSalesRepId(v);
                if (cart.length > 0) {
                  setCart([]);
                  toast.info("Cart cleared — stock source changed");
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Direct from store</SelectItem>
                {(reps.data ?? []).map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Sales person</Label>
              <Input value={salesPerson} onChange={(e) => setSalesPerson(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Remarks</Label>
              <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </div>
          </div>

          <div className="rounded-lg border p-3 text-sm space-y-1 bg-muted/30">
            {isPr && (
              <div className="mb-1 rounded-md bg-warning/15 px-2 py-1 text-xs font-medium text-warning">
                PR — complimentary. Stock value below is for record only; nothing is billed.
              </div>
            )}
            <div className="flex justify-between">
              <span>{isPr ? "Value of goods issued" : "Subtotal"}</span>
              <span>{money(totals.subtotal)}</span>
            </div>
            {!isPr && (
              <>
                <div className="flex justify-between">
                  <span>Discount{discountType === "percent" ? ` (${discountInput}%)` : ""}</span>
                  <span>-{money(totals.discount)}</span>
                </div>
                <div className="flex justify-between">
                  <span>VAT {applyVat ? `(${vatRate}%)` : "(not applied)"}</span>
                  <span>{money(totals.vat)}</span>
                </div>
              </>
            )}
            <div className="flex justify-between text-base font-semibold pt-1 border-t">
              <span>Total</span>
              <span>{money(totals.grand)}</span>
            </div>
            <div className="flex justify-between">
              <span>Paid</span>
              <span>{money(amountPaid)}</span>
            </div>
            {registeredCustomer && !isPr ? (
              <div className="mt-1 space-y-1 border-t pt-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Current sale vs customer advance
                </div>
                <div className="flex justify-between">
                  <span>Advance available</span>
                  <span>{money(availableCredit)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Advance applied</span>
                  <span className={position.advanceApplied > 0 ? "text-success" : ""}>
                    {money(position.advanceApplied)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Remaining advance</span>
                  <span>{money(position.remainingAdvance)}</span>
                </div>
                <div className="flex justify-between font-medium">
                  <span>Amount due</span>
                  <span className={position.amountDue > 0 ? "text-destructive" : ""}>
                    {money(position.amountDue)}
                  </span>
                </div>
                {totals.grand > 0 && position.advanceShort && (
                  <p className="rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive">
                    Advance exhausted. Customer owes {money(position.amountDue)}.
                  </p>
                )}
                {totals.grand > 0 && position.advanceExhausted && (
                  <p className="rounded-md bg-warning/15 px-2 py-1 text-xs font-medium text-warning">
                    This sale uses up the customer's advance — nothing is left afterwards.
                  </p>
                )}
                {totals.grand > 0 && position.advanceLow && (
                  <p className="rounded-md bg-warning/15 px-2 py-1 text-xs text-warning">
                    Advance almost exhausted — only {money(position.remainingAdvance)} left after
                    this sale.
                  </p>
                )}
                {totals.grand > 0 && availableCredit === 0 && position.amountDue > 0 && (
                  <p className="text-xs text-muted-foreground">
                    No advance on this account — the amount due becomes a debt unless it is paid
                    now.
                  </p>
                )}
                {existingDebt > 0 && (
                  <div className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
                    Existing debt {money(existingDebt)} is not part of this sale and stays on the
                    account. Total owed after this sale:{" "}
                    <strong>{money(position.debtAfter)}</strong>.
                  </div>
                )}
              </div>
            ) : (
              <>
                {totals.creditApplied > 0 && (
                  <div className="flex justify-between">
                    <span>Credit applied</span>
                    <span>{money(totals.creditApplied)}</span>
                  </div>
                )}
                <div className="flex justify-between font-medium">
                  <span>Balance</span>
                  <span className={totals.balance > 0 ? "text-destructive" : ""}>
                    {money(totals.balance)}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <DialogFooter className="shrink-0 border-t px-6 py-4">
        <Button
          variant="outline"
          disabled={sellableCart.length === 0}
          onClick={previewInvoice}
          className="gap-2"
        >
          <Eye className="h-4 w-4" /> Preview
        </Button>
        <Button
          disabled={submit.isPending || sellableCart.length === 0}
          onClick={() => submit.mutate()}
          className="gap-2"
        >
          <ReceiptIcon className="h-4 w-4" />
          {submit.isPending ? "Processing…" : "Save Sale"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
