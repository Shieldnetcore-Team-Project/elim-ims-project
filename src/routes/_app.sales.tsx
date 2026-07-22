import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, FileDown, Receipt as ReceiptIcon } from "lucide-react";
import { money, num } from "@/lib/format";
import { toast } from "sonner";
import { generateInvoicePdf } from "@/lib/pdf";

export const Route = createFileRoute("/_app/sales")({
  head: () => ({ meta: [{ title: "Sales & POS — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: SalesPage,
});

type PaymentMethod = "cash" | "transfer" | "pos" | "card" | "cheque" | "credit";

type Product = { id: string; name: string; sku: string | null; unit: string; unit_price: number; current_stock: number };
type Customer = { id: string; name: string; phone: string | null; address: string | null };
type CartItem = { product_id: string; name: string; unit: string; quantity: number; unit_price: number; stock: number };

function SalesPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const qc = useQueryClient();
  const [posOpen, setPosOpen] = useState(false);

  const sales = useQuery({
    queryKey: ["sales-list", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("id,invoice_number,sale_date,customer_name,grand_total,amount_paid,balance,payment_method,created_at")
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });

  const reprint = async (saleId: string) => {
    const { data, error } = await supabase.from("sales").select(`
      *, sale_items(quantity,unit_price,line_total,products(name,unit))
    `).eq("id", saleId).single();
    if (error) { toast.error(error.message); return; }
    const s = data as any;
    generateInvoicePdf({
      company: {
        name: settings.data?.company_name ?? "FMIS",
        address: settings.data?.address, phone: settings.data?.phone, email: settings.data?.email,
      },
      invoice_number: s.invoice_number, sale_date: s.sale_date,
      customer: { name: s.customer_name, phone: s.customer_phone, address: s.customer_address },
      items: (s.sale_items ?? []).map((it: any) => ({
        name: it.products?.name ?? "-", quantity: Number(it.quantity), unit: it.products?.unit ?? "",
        unit_price: Number(it.unit_price), line_total: Number(it.line_total),
      })),
      subtotal: Number(s.subtotal), discount: Number(s.discount), vat: Number(s.vat),
      grand_total: Number(s.grand_total), amount_paid: Number(s.amount_paid), balance: Number(s.balance),
      currency: settings.data?.currency ?? "NGN",
      remarks: s.remarks, sales_person: s.sales_person,
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sales & POS</h1>
          <p className="text-sm text-muted-foreground">Create invoices, decrement stock, and print receipts.</p>
        </div>
        <Dialog open={posOpen} onOpenChange={setPosOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="h-4 w-4" /> New Sale</Button>
          </DialogTrigger>
          {posOpen && factoryId && (
            <PosDialog
              factoryId={factoryId}
              onDone={() => { setPosOpen(false); qc.invalidateQueries({ queryKey: ["sales-list"] }); }}
            />
          )}
        </Dialog>
      </div>

      <Card className="rounded-2xl">
        <CardHeader><CardTitle>Recent Sales</CardTitle></CardHeader>
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
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(sales.data ?? []).map((s: any) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-xs">{s.invoice_number}</TableCell>
                  <TableCell>{s.sale_date}</TableCell>
                  <TableCell>{s.customer_name ?? "Walk-in"}</TableCell>
                  <TableCell><Badge variant="outline" className="capitalize">{s.payment_method}</Badge></TableCell>
                  <TableCell className="text-right">{money(Number(s.grand_total))}</TableCell>
                  <TableCell className="text-right">{money(Number(s.amount_paid))}</TableCell>
                  <TableCell className="text-right">
                    <span className={Number(s.balance) > 0 ? "text-destructive font-medium" : ""}>
                      {money(Number(s.balance))}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" className="gap-2" onClick={() => reprint(s.id)}>
                      <FileDown className="h-4 w-4" /> PDF
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(sales.data ?? []).length === 0 && (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No sales yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function PosDialog({ factoryId, onDone }: { factoryId: string; onDone: () => void }) {
  const settings = useFactorySettings(factoryId);
  const products = useQuery({
    queryKey: ["products-active", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,sku,unit,unit_price,current_stock")
        .eq("factory_id", factoryId).eq("active", true).order("name");
      if (error) throw error;
      return (data ?? []) as Product[];
    },
  });
  const customers = useQuery({
    queryKey: ["customers-brief", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers").select("id,name,phone,address").eq("factory_id", factoryId).order("name");
      if (error) throw error;
      return (data ?? []) as Customer[];
    },
  });

  const [cart, setCart] = useState<CartItem[]>([]);
  const [customerId, setCustomerId] = useState<string>("walkin");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [discount, setDiscount] = useState(0);
  const [amountPaid, setAmountPaid] = useState(0);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [salesPerson, setSalesPerson] = useState("");
  const [remarks, setRemarks] = useState("");
  const [pickerId, setPickerId] = useState<string>("");

  const vatRate = Number(settings.data?.vat_rate ?? 0);

  const totals = useMemo(() => {
    const subtotal = cart.reduce((s, i) => s + i.quantity * i.unit_price, 0);
    const vat = Math.max((subtotal - discount), 0) * (vatRate / 100);
    const grand = Math.max(subtotal - discount + vat, 0);
    const balance = Math.max(grand - amountPaid, 0);
    return { subtotal, vat, grand, balance };
  }, [cart, discount, amountPaid, vatRate]);

  const addProduct = (id: string) => {
    const p = products.data?.find((x) => x.id === id);
    if (!p) return;
    setCart((prev) => {
      const existing = prev.find((c) => c.product_id === id);
      if (existing) {
        if (existing.quantity + 1 > p.current_stock) { toast.error(`Only ${p.current_stock} ${p.unit} in stock`); return prev; }
        return prev.map((c) => c.product_id === id ? { ...c, quantity: c.quantity + 1 } : c);
      }
      if (p.current_stock < 1) { toast.error("Out of stock"); return prev; }
      return [...prev, { product_id: p.id, name: p.name, unit: p.unit, quantity: 1, unit_price: Number(p.unit_price), stock: Number(p.current_stock) }];
    });
    setPickerId("");
  };

  const updateQty = (id: string, qty: number) => {
    setCart((prev) => prev.map((c) => {
      if (c.product_id !== id) return c;
      const q = Math.max(0, Math.min(qty, c.stock));
      return { ...c, quantity: q };
    }).filter((c) => c.quantity > 0));
  };
  const updatePrice = (id: string, price: number) => {
    setCart((prev) => prev.map((c) => c.product_id === id ? { ...c, unit_price: Math.max(0, price) } : c));
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
          customer_id: finalCustomer,
          customer_name: displayName || null,
          customer_phone: customerPhone || null,
          customer_address: customerAddress || null,
          discount, vat: totals.vat,
          amount_paid: amountPaid,
          payment_method: method,
          sales_person: salesPerson || null,
          remarks: remarks || null,
          items: cart.map((c) => ({ product_id: c.product_id, quantity: c.quantity, unit_price: c.unit_price })),
        } as any,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: (res) => {
      toast.success(`Invoice ${res.invoice_number} created`);
      generateInvoicePdf({
        company: {
          name: settings.data?.company_name ?? "FMIS",
          address: settings.data?.address, phone: settings.data?.phone, email: settings.data?.email,
        },
        invoice_number: res.invoice_number,
        sale_date: new Date().toISOString().slice(0, 10),
        customer: { name: customerName || customers.data?.find((c) => c.id === customerId)?.name, phone: customerPhone, address: customerAddress },
        items: cart.map((c) => ({ name: c.name, quantity: c.quantity, unit: c.unit, unit_price: c.unit_price, line_total: c.quantity * c.unit_price })),
        subtotal: totals.subtotal, discount, vat: totals.vat,
        grand_total: totals.grand, amount_paid: amountPaid, balance: totals.balance,
        currency: settings.data?.currency ?? "NGN",
        remarks, sales_person: salesPerson,
      });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-4xl">
      <DialogHeader><DialogTitle>New Sale</DialogTitle></DialogHeader>
      <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
        <div className="space-y-3">
          <div className="grid gap-2">
            <Label>Add product</Label>
            <Select value={pickerId} onValueChange={addProduct}>
              <SelectTrigger><SelectValue placeholder="Select a product to add…" /></SelectTrigger>
              <SelectContent>
                {(products.data ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id} disabled={p.current_stock <= 0}>
                    {p.name} · {money(Number(p.unit_price))} · stock {num(Number(p.current_stock))} {p.unit}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border overflow-x-auto">
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
                      <div className="text-xs text-muted-foreground">stock {num(c.stock)} {c.unit}</div>
                    </TableCell>
                    <TableCell><Input type="number" min={0} max={c.stock} value={c.quantity} onChange={(e) => updateQty(c.product_id, Number(e.target.value))} className="h-8" /></TableCell>
                    <TableCell><Input type="number" min={0} step="0.01" value={c.unit_price} onChange={(e) => updatePrice(c.product_id, Number(e.target.value))} className="h-8" /></TableCell>
                    <TableCell className="text-right">{money(c.quantity * c.unit_price)}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" onClick={() => setCart((prev) => prev.filter((x) => x.product_id !== c.product_id))}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {cart.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-6">No items yet.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <Label>Customer</Label>
            <Select value={customerId} onValueChange={(v) => {
              setCustomerId(v);
              if (v === "walkin") { setCustomerName(""); setCustomerPhone(""); setCustomerAddress(""); }
              else {
                const c = customers.data?.find((x) => x.id === v);
                setCustomerName(c?.name ?? ""); setCustomerPhone(c?.phone ?? ""); setCustomerAddress(c?.address ?? "");
              }
            }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="walkin">Walk-in</SelectItem>
                {(customers.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {customerId === "walkin" && (
            <>
              <div><Label>Customer name</Label><Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} /></div>
              <div><Label>Phone</Label><Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} /></div>
            </>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div><Label>Discount</Label><Input type="number" min={0} step="0.01" value={discount} onChange={(e) => setDiscount(Number(e.target.value))} /></div>
            <div><Label>Paid</Label><Input type="number" min={0} step="0.01" value={amountPaid} onChange={(e) => setAmountPaid(Number(e.target.value))} /></div>
          </div>
          <div>
            <Label>Payment method</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["cash","transfer","pos","card","cheque","credit"] as PaymentMethod[]).map((m) => (
                  <SelectItem key={m} value={m} className="capitalize">{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div><Label>Sales person</Label><Input value={salesPerson} onChange={(e) => setSalesPerson(e.target.value)} /></div>
          <div><Label>Remarks</Label><Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} /></div>

          <div className="rounded-lg border p-3 text-sm space-y-1 bg-muted/30">
            <div className="flex justify-between"><span>Subtotal</span><span>{money(totals.subtotal)}</span></div>
            <div className="flex justify-between"><span>Discount</span><span>-{money(discount)}</span></div>
            <div className="flex justify-between"><span>VAT ({vatRate}%)</span><span>{money(totals.vat)}</span></div>
            <div className="flex justify-between text-base font-semibold pt-1 border-t"><span>Total</span><span>{money(totals.grand)}</span></div>
            <div className="flex justify-between"><span>Paid</span><span>{money(amountPaid)}</span></div>
            <div className="flex justify-between font-medium"><span>Balance</span><span className={totals.balance > 0 ? "text-destructive" : ""}>{money(totals.balance)}</span></div>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button
          disabled={submit.isPending || cart.length === 0}
          onClick={() => submit.mutate()}
          className="gap-2"
        >
          <ReceiptIcon className="h-4 w-4" />
          {submit.isPending ? "Processing…" : "Complete Sale & Print"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
