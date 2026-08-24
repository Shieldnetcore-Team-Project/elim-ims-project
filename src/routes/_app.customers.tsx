import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, Pencil, Eye } from "lucide-react";
import { money } from "@/lib/format";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/customers")({
  head: () => ({ meta: [{ title: "Customers — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="customers">
      <CustomersPage />
    </RequireAccess>
  ),
});

type Customer = {
  id: string; name: string; phone: string | null; email: string | null;
  address: string | null; outstanding_balance: number; total_purchases: number;
};

function CustomersPage() {
  const { data: factoryId } = useFactoryId();
  const qc = useQueryClient();
  const { canWrite } = usePermissions();
  const write = canWrite("customers");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [viewing, setViewing] = useState<Customer | null>(null);

  const list = useQuery({
    queryKey: ["customers", factoryId, q],
    enabled: !!factoryId,
    queryFn: async () => {
      let query = supabase.from("customers").select("*").eq("factory_id", factoryId!).order("name");
      if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as Customer[];
    },
  });

  const save = useMutation({
    mutationFn: async (form: Partial<Customer>) => {
      if (!factoryId) throw new Error("No factory");
      if (editing) {
        const { error } = await supabase.from("customers").update({
          name: form.name!, phone: form.phone, email: form.email, address: form.address,
        }).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("customers").insert({
          factory_id: factoryId, name: form.name!, phone: form.phone, email: form.email, address: form.address,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editing ? "Customer updated" : "Customer created");
      qc.invalidateQueries({ queryKey: ["customers"] });
      setOpen(false); setEditing(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="text-sm text-muted-foreground">Manage customer profiles and outstanding balances.</p>
        </div>
        {write && (
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditing(null); }}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="h-4 w-4" /> New Customer</Button>
          </DialogTrigger>
          <CustomerDialog
            key={editing?.id ?? "new"}
            editing={editing}
            onSubmit={(f) => save.mutate(f)}
            saving={save.isPending}
          />
        </Dialog>
        )}
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle>All Customers</CardTitle>
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="pl-8 h-9" />
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Email</TableHead>
                <TableHead className="text-right">Total Purchases</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead className="w-16"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>{c.phone ?? "—"}</TableCell>
                  <TableCell>{c.email ?? "—"}</TableCell>
                  <TableCell className="text-right">{money(Number(c.total_purchases))}</TableCell>
                  <TableCell className="text-right">
                    <span className={Number(c.outstanding_balance) > 0 ? "text-destructive font-medium" : ""}>
                      {money(Number(c.outstanding_balance))}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" title="View profile" onClick={() => setViewing(c)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" title="Edit" onClick={() => { setEditing(c); setOpen(true); }}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(list.data ?? []).length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No customers yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)}>
        {viewing && <CustomerProfileDialog customer={viewing} />}
      </Dialog>
    </div>
  );
}

type Invoice = { id: string; invoice_number: string; sale_date: string; grand_total: number; balance: number };
type Payment = { id: string; receipt_number: string; payment_date: string; amount: number; payment_method: string };

function CustomerProfileDialog({ customer }: { customer: Customer }) {
  const invoices = useQuery({
    queryKey: ["customer-invoices", customer.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales").select("id,invoice_number,sale_date,grand_total,balance")
        .eq("customer_id", customer.id).order("sale_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Invoice[];
    },
  });

  const payments = useQuery({
    queryKey: ["customer-payments", customer.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments_received").select("id,receipt_number,payment_date,amount,payment_method")
        .eq("customer_id", customer.id).order("payment_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Payment[];
    },
  });

  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader><DialogTitle>{customer.name}</DialogTitle></DialogHeader>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/30 p-3 text-sm">
          <div><span className="text-muted-foreground">Phone:</span> {customer.phone ?? "—"}</div>
          <div><span className="text-muted-foreground">Email:</span> {customer.email ?? "—"}</div>
          <div className="col-span-2"><span className="text-muted-foreground">Address:</span> {customer.address ?? "—"}</div>
          <div><span className="text-muted-foreground">Total purchases:</span> {money(Number(customer.total_purchases))}</div>
          <div>
            <span className="text-muted-foreground">Outstanding debt:</span>{" "}
            <span className={Number(customer.outstanding_balance) > 0 ? "text-destructive font-medium" : ""}>
              {money(Number(customer.outstanding_balance))}
            </span>
          </div>
        </div>

        <Tabs defaultValue="invoices">
          <TabsList>
            <TabsTrigger value="invoices">Purchase History / Invoices</TabsTrigger>
            <TabsTrigger value="payments">Payment History</TabsTrigger>
          </TabsList>
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
                      {Number(inv.balance) > 0
                        ? <Badge variant="destructive">{money(Number(inv.balance))}</Badge>
                        : <Badge variant="secondary">Paid</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
                {(invoices.data ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-6">No purchases yet.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TabsContent>
          <TabsContent value="payments">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Receipt</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(payments.data ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">{p.receipt_number}</TableCell>
                    <TableCell>{p.payment_date}</TableCell>
                    <TableCell><Badge variant="outline" className="capitalize">{p.payment_method}</Badge></TableCell>
                    <TableCell className="text-right">{money(Number(p.amount))}</TableCell>
                  </TableRow>
                ))}
                {(payments.data ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-6">No payments yet.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TabsContent>
        </Tabs>
      </div>
    </DialogContent>
  );
}

function CustomerDialog({ editing, onSubmit, saving }: {
  editing: Customer | null; onSubmit: (f: Partial<Customer>) => void; saving: boolean;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [phone, setPhone] = useState(editing?.phone ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  const [address, setAddress] = useState(editing?.address ?? "");
  return (
    <DialogContent>
      <DialogHeader><DialogTitle>{editing ? "Edit Customer" : "New Customer"}</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <div><Label>Name *</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Phone</Label><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div><Label>Email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        </div>
        <div><Label>Address</Label><Textarea value={address} onChange={(e) => setAddress(e.target.value)} /></div>
      </div>
      <DialogFooter>
        <Button
          disabled={!name.trim() || saving}
          onClick={() => onSubmit({ name: name.trim(), phone: phone || null, email: email || null, address: address || null })}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
