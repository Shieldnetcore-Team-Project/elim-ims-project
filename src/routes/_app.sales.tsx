import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
} from "lucide-react";
import { money, num } from "@/lib/format";
import { toast } from "sonner";
import { generateInvoicePdf, generateReceiptPdf } from "@/lib/pdf";
import { logAudit } from "@/lib/audit";

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
  payment_method: string;
};
type CartItem = {
  product_id: string;
  name: string;
  unit: string;
  quantity: number;
  unit_price: number;
  stock: number;
};

const paymentStatus = (
  paid: number,
  balance: number,
): { label: string; variant: "secondary" | "outline" | "destructive" } => {
  if (balance <= 0) return { label: "Paid", variant: "secondary" };
  if (paid > 0) return { label: "Partial", variant: "outline" };
  return { label: "Unpaid", variant: "destructive" };
};

function SalesPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const qc = useQueryClient();
  const { canWrite } = usePermissions();
  const write = canWrite("sales");
  const [posOpen, setPosOpen] = useState(false);
  const [payTarget, setPayTarget] = useState<SaleRow | null>(null);
  const [historyTarget, setHistoryTarget] = useState<{ id: string; name: string } | null>(null);

  const sales = useQuery({
    queryKey: ["sales-list", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select(
          "id,invoice_number,sale_date,customer_id,customer_name,grand_total,amount_paid,balance,payment_method,created_at",
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
      },
      action,
    );
  };

  const pay = useMutation({
    mutationFn: async (input: {
      sale: SaleRow;
      amount: number;
      method: PaymentMethod;
      remarks: string;
    }) => {
      const { data, error } = await supabase.rpc("record_payment", {
        payload: {
          factory_id: factoryId,
          customer_id: input.sale.customer_id,
          sale_id: input.sale.id,
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
        customer_name: input.sale.customer_name ?? undefined,
        invoice_number: input.sale.invoice_number,
        amount: input.amount,
        payment_method: input.method,
        remarks: input.remarks,
        currency: settings.data?.currency ?? "NGN",
      });
      qc.invalidateQueries({ queryKey: ["sales-list"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      setPayTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sales & POS</h1>
          <p className="text-sm text-muted-foreground">
            Create invoices, decrement stock, and print receipts.
          </p>
        </div>
        {write && (
          <Dialog open={posOpen} onOpenChange={setPosOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" /> New Sale
              </Button>
            </DialogTrigger>
            {posOpen && factoryId && (
              <PosDialog
                factoryId={factoryId}
                onDone={() => {
                  setPosOpen(false);
                  qc.invalidateQueries({ queryKey: ["sales-list"] });
                }}
              />
            )}
          </Dialog>
        )}
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
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(sales.data ?? []).map((s: SaleRow) => {
                const status = paymentStatus(Number(s.amount_paid), Number(s.balance));
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
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {Number(s.balance) > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1"
                            onClick={() => setPayTarget(s)}
                          >
                            <HandCoins className="h-4 w-4" /> Receive
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
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {(sales.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
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
            onSubmit={(amount, method, remarks) =>
              pay.mutate({ sale: payTarget, amount, method, remarks })
            }
          />
        )}
      </Dialog>

      <Dialog open={!!historyTarget} onOpenChange={(v) => !v && setHistoryTarget(null)}>
        {historyTarget && (
          <CustomerHistoryDialog customerId={historyTarget.id} customerName={historyTarget.name} />
        )}
      </Dialog>
    </div>
  );
}

function PayDialog({
  sale,
  onSubmit,
  saving,
}: {
  sale: SaleRow;
  onSubmit: (amount: number, method: PaymentMethod, remarks: string) => void;
  saving: boolean;
}) {
  const [amount, setAmount] = useState(Number(sale.balance));
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
            <span>{sale.customer_name ?? "Walk-in"}</span>
          </div>
          <div className="flex justify-between">
            <span>Invoice</span>
            <span className="font-mono">{sale.invoice_number}</span>
          </div>
          <div className="flex justify-between">
            <span>Outstanding</span>
            <span className="font-medium">{money(Number(sale.balance))}</span>
          </div>
        </div>
        <div>
          <Label>Amount</Label>
          <Input
            type="number"
            min={0.01}
            step="0.01"
            max={Number(sale.balance)}
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
          disabled={saving || amount <= 0 || amount > Number(sale.balance)}
          onClick={() => onSubmit(amount, method, remarks)}
        >
          {saving ? "Saving…" : "Record & Print Receipt"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

type CustomerSaleRow = {
  id: string;
  invoice_number: string;
  sale_date: string;
  grand_total: number;
  amount_paid: number;
  balance: number;
};
type CustomerItemRow = {
  sale_id: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  products: { name: string; unit: string } | null;
};
type CustomerPaymentRow = {
  id: string;
  receipt_number: string;
  payment_date: string;
  created_at: string;
  amount: number;
  payment_method: string;
};

function CustomerHistoryDialog({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const invoices = useQuery({
    queryKey: ["customer-sales-full", customerId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("id,invoice_number,sale_date,grand_total,amount_paid,balance")
        .eq("customer_id", customerId)
        .order("sale_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CustomerSaleRow[];
    },
  });

  const saleIds = (invoices.data ?? []).map((s) => s.id);
  const items = useQuery({
    queryKey: ["customer-items-full", customerId, saleIds.join(",")],
    enabled: saleIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sale_items")
        .select("sale_id,quantity,unit_price,line_total,products(name,unit)")
        .in("sale_id", saleIds);
      if (error) throw error;
      return (data ?? []) as unknown as CustomerItemRow[];
    },
  });

  const payments = useQuery({
    queryKey: ["customer-payments-full", customerId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments_received")
        .select("id,receipt_number,payment_date,created_at,amount,payment_method")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as CustomerPaymentRow[];
    },
  });

  const invoiceById = new Map((invoices.data ?? []).map((s) => [s.id, s]));
  const totals = (invoices.data ?? []).reduce(
    (acc, s) => ({
      total: acc.total + Number(s.grand_total),
      paid: acc.paid + Number(s.amount_paid),
      balance: acc.balance + Number(s.balance),
    }),
    { total: 0, paid: 0, balance: 0 },
  );

  return (
    <DialogContent className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>{customerName} — Products & Transactions</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3 rounded-md bg-muted/30 p-3 text-sm">
          <div>
            <span className="text-muted-foreground block">Total purchased</span>
            <span className="font-medium">{money(totals.total)}</span>
          </div>
          <div>
            <span className="text-muted-foreground block">Total paid</span>
            <span className="font-medium">{money(totals.paid)}</span>
          </div>
          <div>
            <span className="text-muted-foreground block">Outstanding</span>
            <span className={totals.balance > 0 ? "font-medium text-destructive" : "font-medium"}>
              {money(totals.balance)}
            </span>
          </div>
        </div>

        <Tabs defaultValue="products">
          <TabsList>
            <TabsTrigger value="products">Products Purchased</TabsTrigger>
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
            <TabsTrigger value="payments">Payment History</TabsTrigger>
          </TabsList>
          <TabsContent value="products">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit Price</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(items.data ?? []).map((it, idx) => {
                  const inv = invoiceById.get(it.sale_id);
                  return (
                    <TableRow key={`${it.sale_id}-${idx}`}>
                      <TableCell className="font-mono text-xs">
                        {inv?.invoice_number ?? "—"}
                      </TableCell>
                      <TableCell>{inv?.sale_date ?? "—"}</TableCell>
                      <TableCell>
                        {it.products?.name ?? "—"}
                        {it.products?.unit ? ` (${it.products.unit})` : ""}
                      </TableCell>
                      <TableCell className="text-right">{num(Number(it.quantity))}</TableCell>
                      <TableCell className="text-right">{money(Number(it.unit_price))}</TableCell>
                      <TableCell className="text-right">{money(Number(it.line_total))}</TableCell>
                    </TableRow>
                  );
                })}
                {(items.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                      No products purchased yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TabsContent>
          <TabsContent value="invoices">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(invoices.data ?? []).map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-mono text-xs">{inv.invoice_number}</TableCell>
                    <TableCell>{inv.sale_date}</TableCell>
                    <TableCell className="text-right">{money(Number(inv.grand_total))}</TableCell>
                    <TableCell className="text-right">
                      {Number(inv.balance) > 0 ? (
                        <Badge variant="destructive">{money(Number(inv.balance))}</Badge>
                      ) : (
                        <Badge variant="secondary">Paid</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {(invoices.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                      No purchases yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TabsContent>
          <TabsContent value="payments">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Receipt</TableHead>
                  <TableHead>Date & Time</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(payments.data ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">{p.receipt_number}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {new Date(p.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {p.payment_method}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{money(Number(p.amount))}</TableCell>
                  </TableRow>
                ))}
                {(payments.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                      No payments yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TabsContent>
        </Tabs>
      </div>
    </DialogContent>
  );
}

// Exported so the Store (Finished Goods) page can offer the exact same
// checkout flow -- same create_sale RPC, same stock/customer/debt effects --
// rather than a second, divergent way to record a sale.
export function PosDialog({ factoryId, onDone }: { factoryId: string; onDone: () => void }) {
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
  const [customerId, setCustomerId] = useState<string>("walkin");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [discount, setDiscount] = useState(0);
  const [applyVat, setApplyVat] = useState(true);
  const [amountPaid, setAmountPaid] = useState(0);
  const [method, setMethod] = useState<PaymentMethod>("cash");
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
    const vat = applyVat ? Math.max(subtotal - discount, 0) * (vatRate / 100) : 0;
    const grand = Math.max(subtotal - discount + vat, 0);
    const balance = Math.max(grand - amountPaid, 0);
    return { subtotal, vat, grand, balance };
  }, [cart, discount, amountPaid, vatRate, applyVat]);

  const addProduct = (id: string) => {
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

  const updateQty = (id: string, qty: number) => {
    setCart((prev) =>
      prev
        .map((c) => {
          if (c.product_id !== id) return c;
          const q = Math.max(0, Math.min(qty, c.stock));
          return { ...c, quantity: q };
        })
        .filter((c) => c.quantity > 0),
    );
  };
  const updatePrice = (id: string, price: number) => {
    setCart((prev) =>
      prev.map((c) => (c.product_id === id ? { ...c, unit_price: Math.max(0, price) } : c)),
    );
  };

  const submit = useMutation({
    mutationFn: async () => {
      if (cart.length === 0) throw new Error("Cart is empty");
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
          discount,
          vat: totals.vat,
          amount_paid: amountPaid,
          payment_method: method,
          sales_person: salesPerson || null,
          sales_rep_id: repMode ? salesRepId : null,
          remarks: remarks || null,
          items: cart.map((c) => ({
            product_id: c.product_id,
            quantity: c.quantity,
            unit_price: c.unit_price,
          })),
        } as any,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: async (res) => {
      toast.success(`Invoice ${res.invoice_number} created`);
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
      await generateInvoicePdf({
        company: {
          name: settings.data?.company_name ?? "FMIS",
          address: settings.data?.address,
          phone: settings.data?.phone,
          email: settings.data?.email,
          logo_url: settings.data?.logo_url,
        },
        invoice_number: res.invoice_number,
        sale_date: saleDate,
        customer: {
          name: customerName || customers.data?.find((c) => c.id === customerId)?.name,
          phone: customerPhone,
          address: customerAddress,
        },
        items: cart.map((c) => ({
          name: c.name,
          quantity: c.quantity,
          unit: c.unit,
          unit_price: c.unit_price,
          line_total: c.quantity * c.unit_price,
        })),
        subtotal: totals.subtotal,
        discount,
        vat: totals.vat,
        grand_total: totals.grand,
        amount_paid: amountPaid,
        balance: totals.balance,
        currency: settings.data?.currency ?? "NGN",
        remarks,
        sales_person: salesPerson,
      });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const previewInvoice = async () => {
    if (cart.length === 0) {
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
        items: cart.map((c) => ({
          name: c.name,
          quantity: c.quantity,
          unit: c.unit,
          unit_price: c.unit_price,
          line_total: c.quantity * c.unit_price,
        })),
        subtotal: totals.subtotal,
        discount,
        vat: totals.vat,
        grand_total: totals.grand,
        amount_paid: amountPaid,
        balance: totals.balance,
        currency: settings.data?.currency ?? "NGN",
        remarks,
        sales_person: salesPerson,
      },
      "preview",
    );
  };

  return (
    <DialogContent className="flex max-h-[92vh] w-[95vw] max-w-4xl flex-col gap-0 overflow-hidden p-0">
      <DialogHeader className="shrink-0 border-b px-6 py-4">
        <DialogTitle>New Sale</DialogTitle>
      </DialogHeader>
      <div className="grid flex-1 gap-4 overflow-y-auto px-6 py-4 md:grid-cols-[2fr_1fr]">
        <div className="space-y-3">
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
                </SelectContent>
              </Select>
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
                  <TableHead>Item</TableHead>
                  <TableHead className="w-24">Qty</TableHead>
                  <TableHead className="w-32">Price</TableHead>
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
                      <Input
                        type="number"
                        min={0}
                        max={c.stock}
                        value={c.quantity}
                        onChange={(e) => updateQty(c.product_id, Number(e.target.value))}
                        className="h-8"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={c.unit_price}
                        onChange={(e) => updatePrice(c.product_id, Number(e.target.value))}
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

        <div className="space-y-2.5">
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
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Discount</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={discount}
                onChange={(e) => setDiscount(Number(e.target.value))}
              />
            </div>
            <div>
              <Label className="text-xs">Paid</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={amountPaid}
                onChange={(e) => setAmountPaid(Number(e.target.value))}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={applyVat} onCheckedChange={(v) => setApplyVat(!!v)} />
            Apply VAT ({vatRate}%) to this sale
          </label>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Payment method</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["cash", "transfer", "pos", "card", "cheque", "credit"] as PaymentMethod[]).map(
                    (m) => (
                      <SelectItem key={m} value={m} className="capitalize">
                        {m}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
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
            <div className="flex justify-between">
              <span>Subtotal</span>
              <span>{money(totals.subtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span>Discount</span>
              <span>-{money(discount)}</span>
            </div>
            <div className="flex justify-between">
              <span>VAT {applyVat ? `(${vatRate}%)` : "(not applied)"}</span>
              <span>{money(totals.vat)}</span>
            </div>
            <div className="flex justify-between text-base font-semibold pt-1 border-t">
              <span>Total</span>
              <span>{money(totals.grand)}</span>
            </div>
            <div className="flex justify-between">
              <span>Paid</span>
              <span>{money(amountPaid)}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>Balance</span>
              <span className={totals.balance > 0 ? "text-destructive" : ""}>
                {money(totals.balance)}
              </span>
            </div>
          </div>
        </div>
      </div>

      <DialogFooter className="shrink-0 border-t px-6 py-4">
        <Button
          variant="outline"
          disabled={cart.length === 0}
          onClick={previewInvoice}
          className="gap-2"
        >
          <Eye className="h-4 w-4" /> Preview
        </Button>
        <Button
          disabled={submit.isPending || cart.length === 0}
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
