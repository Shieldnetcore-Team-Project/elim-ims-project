import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Search,
  Pencil,
  Eye,
  UserPlus,
  Users,
  Wallet,
  HandCoins,
  AlertTriangle,
  CreditCard,
} from "lucide-react";
import { money } from "@/lib/format";
import { toast } from "sonner";
import { KPI } from "@/lib/dashboard-kit";
import { AccountAdjustmentsCard } from "@/components/customers/account-adjustments";

export const Route = createFileRoute("/_app/customers")({
  head: () => ({ meta: [{ title: "Customers — Elim Table Water" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <>
      <SectionTabs section="Customers" />
      <RequireAccess module="customers">
        <CustomersPage />
      </RequireAccess>
    </>
  ),
});

export type Customer = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  outstanding_balance: number;
  total_purchases: number;
  total_transactions: number;
  registered: boolean;
  credit_limit: number | null;
  credit_days: number;
  sales_rep_id: string | null;
};

function CustomersPage() {
  const { data: factoryId } = useFactoryId();
  const qc = useQueryClient();
  const { canWrite, canApprove } = usePermissions();
  const write = canWrite("customers");
  // Credit limits and payment terms are set via set_customer_credit_terms(),
  // which needs customers:approve -- not the ordinary edit permission.
  const setTerms = canApprove("customers");
  const [termsFor, setTermsFor] = useState<Customer | null>(null);
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

  // Marketers the customer can be assigned to. Only readable with Distribution
  // access; without it the field is hidden and an existing assignment is left
  // as it is.
  const reps = useQuery({
    queryKey: ["customer-form-reps", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_reps")
        .select("id,full_name,status")
        .eq("factory_id", factoryId!)
        .order("full_name");
      if (error) return [];
      return data ?? [];
    },
  });
  const repList = reps.data ?? [];
  const repName = (id: string | null) => repList.find((r) => r.id === id)?.full_name;

  const save = useMutation({
    mutationFn: async (form: Partial<Customer>) => {
      if (!factoryId) throw new Error("No factory");
      if (editing) {
        const { error } = await supabase
          .from("customers")
          .update({
            name: form.name!,
            phone: form.phone,
            email: form.email,
            address: form.address,
            ...(repList.length ? { sales_rep_id: form.sales_rep_id ?? null } : {}),
            // Filling and saving this form is what "registering" a customer
            // means here — applies whether reached via Edit or the Register
            // action on an auto-created walk-in.
            registered: true,
          })
          .eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("customers").insert({
          factory_id: factoryId,
          name: form.name!,
          phone: form.phone,
          email: form.email,
          address: form.address,
          ...(repList.length ? { sales_rep_id: form.sales_rep_id ?? null } : {}),
          registered: true,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editing ? "Customer updated" : "Customer created");
      qc.invalidateQueries({ queryKey: ["customers"] });
      setOpen(false);
      setEditing(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="text-sm text-muted-foreground">
            Manage customer profiles and outstanding balances.
          </p>
        </div>
        {write && (
          <Dialog
            open={open}
            onOpenChange={(v) => {
              setOpen(v);
              if (!v) setEditing(null);
            }}
          >
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" /> New Customer
              </Button>
            </DialogTrigger>
            <CustomerDialog
              key={editing?.id ?? "new"}
              editing={editing}
              reps={repList.filter((r) => r.status === "active" || r.id === editing?.sales_rep_id)}
              onSubmit={(f) => save.mutate(f)}
              saving={save.isPending}
            />
          </Dialog>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KPI icon={Users} label="Total Customers" value={String(list.data?.length ?? 0)} />
        <KPI
          icon={Wallet}
          label="Total Goods Value"
          value={money((list.data ?? []).reduce((s, c) => s + Number(c.total_purchases), 0))}
        />
        <KPI
          icon={HandCoins}
          label="Total Amount Paid"
          value={money(
            (list.data ?? []).reduce(
              (s, c) => s + (Number(c.total_purchases) - Number(c.outstanding_balance)),
              0,
            ),
          )}
          tone="success"
        />
        <KPI
          icon={AlertTriangle}
          label="Total Balance Due"
          value={money((list.data ?? []).reduce((s, c) => s + Number(c.outstanding_balance), 0))}
          tone="destructive"
        />
      </div>

      {factoryId && <AccountAdjustmentsCard factoryId={factoryId} />}

      <Card className="rounded-2xl">
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle>All Customers</CardTitle>
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="pl-8 h-9"
            />
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                {repList.length > 0 && <TableHead>Marketer</TableHead>}
                <TableHead>Transactions</TableHead>
                <TableHead className="text-right">Total Goods</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Credit limit</TableHead>
                <TableHead>Terms</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((c) => {
                const paid = Number(c.total_purchases) - Number(c.outstanding_balance);
                return (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {c.name}
                        {!c.registered && (
                          <Badge variant="outline" className="text-muted-foreground">
                            unregistered
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{c.phone ?? "—"}</TableCell>
                    {repList.length > 0 && (
                      <TableCell>{repName(c.sales_rep_id) ?? "—"}</TableCell>
                    )}
                    <TableCell>
                      <Badge variant="secondary">
                        {c.total_transactions} sale{c.total_transactions === 1 ? "" : "s"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{money(Number(c.total_purchases))}</TableCell>
                    <TableCell className="text-right text-success">{money(paid)}</TableCell>
                    <TableCell className="text-right">
                      <span
                        className={
                          Number(c.outstanding_balance) > 0 ? "text-destructive font-medium" : ""
                        }
                      >
                        {Number(c.outstanding_balance) > 0
                          ? money(Number(c.outstanding_balance))
                          : "—"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      {c.credit_limit == null ? (
                        <span className="text-muted-foreground">No limit</span>
                      ) : (
                        money(Number(c.credit_limit))
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{c.credit_days} days</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {!c.registered && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Complete registration"
                            onClick={() => {
                              setEditing(c);
                              setOpen(true);
                            }}
                          >
                            <UserPlus className="h-4 w-4" />
                          </Button>
                        )}
                        {setTerms && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Credit limit & payment terms"
                            onClick={() => setTermsFor(c)}
                          >
                            <CreditCard className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          title="View profile"
                          onClick={() => setViewing(c)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Edit"
                          onClick={() => {
                            setEditing(c);
                            setOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {(list.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    No customers yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!termsFor} onOpenChange={(v) => !v && setTermsFor(null)}>
        {termsFor && (
          <CreditTermsDialog
            customer={termsFor}
            onDone={() => {
              setTermsFor(null);
              qc.invalidateQueries({ queryKey: ["customers"] });
              qc.invalidateQueries({ queryKey: ["credit-sales"] });
            }}
          />
        )}
      </Dialog>

      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)}>
        {viewing && <CustomerProfileDialog customer={viewing} />}
      </Dialog>
    </div>
  );
}

export type Invoice = {
  id: string;
  invoice_number: string;
  sale_date: string;
  grand_total: number;
  balance: number;
};
export type Payment = {
  id: string;
  receipt_number: string;
  payment_date: string;
  created_at: string;
  amount: number;
  payment_method: string;
};

export function CustomerProfileDialog({ customer }: { customer: Customer }) {
  const invoices = useQuery({
    queryKey: ["customer-invoices", customer.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("id,invoice_number,sale_date,grand_total,balance")
        .eq("customer_id", customer.id)
        .order("sale_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Invoice[];
    },
  });

  const payments = useQuery({
    queryKey: ["customer-payments", customer.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments_received")
        .select("id,receipt_number,payment_date,created_at,amount,payment_method")
        .eq("customer_id", customer.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Payment[];
    },
  });

  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          {customer.name}
          <Badge variant={customer.registered ? "secondary" : "outline"} className="font-normal">
            {customer.registered ? "registered" : "unregistered"}
          </Badge>
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/30 p-3 text-sm">
          <div>
            <span className="text-muted-foreground">Phone:</span> {customer.phone ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Email:</span> {customer.email ?? "—"}
          </div>
          <div className="col-span-2">
            <span className="text-muted-foreground">Address:</span> {customer.address ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Total purchases:</span>{" "}
            {money(Number(customer.total_purchases))}
          </div>
          <div>
            <span className="text-muted-foreground">Outstanding debt:</span>{" "}
            <span
              className={
                Number(customer.outstanding_balance) > 0 ? "text-destructive font-medium" : ""
              }
            >
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

function CustomerDialog({
  editing,
  reps,
  onSubmit,
  saving,
}: {
  editing: Customer | null;
  reps: { id: string; full_name: string }[];
  onSubmit: (f: Partial<Customer>) => void;
  saving: boolean;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [phone, setPhone] = useState(editing?.phone ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  const [address, setAddress] = useState(editing?.address ?? "");
  const [repId, setRepId] = useState(editing?.sales_rep_id ?? "none");
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{editing ? "Edit Customer" : "New Customer"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Name *</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Phone</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div>
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>
        <div>
          <Label>Address</Label>
          <Textarea value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        {reps.length > 0 && (
          <div>
            <Label>Marketer</Label>
            <Select value={repId} onValueChange={setRepId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None (served by the warehouse) —</SelectItem>
                {reps.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              The customer shows on this marketer's account, and they collect the customer's
              payments.
            </p>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button
          disabled={!name.trim() || saving}
          onClick={() =>
            onSubmit({
              name: name.trim(),
              phone: phone || null,
              email: email || null,
              address: address || null,
              sales_rep_id: repId === "none" ? null : repId,
            })
          }
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// Credit limit (blank = no limit, 0 = no credit at all) and payment terms.
// approve_sale() refuses a sale that would take the customer over the limit
// unless an admin approves it; new debts fall due credit_days after the sale.
function CreditTermsDialog({ customer, onDone }: { customer: Customer; onDone: () => void }) {
  const [limit, setLimit] = useState(
    customer.credit_limit == null ? "" : String(Number(customer.credit_limit)),
  );
  const [days, setDays] = useState(String(customer.credit_days ?? 30));
  const [reason, setReason] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const limitValue = limit.trim() === "" ? null : Number(limit);
      if (limitValue != null && (!Number.isFinite(limitValue) || limitValue < 0))
        throw new Error("Credit limit must be 0 or more, or blank for no limit");
      const daysValue = Number(days);
      if (!Number.isInteger(daysValue) || daysValue < 0 || daysValue > 365)
        throw new Error("Payment terms must be a whole number of days from 0 to 365");
      const { error } = await supabase.rpc("set_customer_credit_terms", {
        p_customer: customer.id,
        p_credit_limit: limitValue,
        p_credit_days: daysValue,
        p_reason: reason.trim() || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Credit terms saved");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Credit terms — {customer.name}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Currently owes {money(Number(customer.outstanding_balance))}.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Credit limit</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="No limit"
            />
          </div>
          <div>
            <Label>Payment terms (days)</Label>
            <Input
              type="number"
              min={0}
              max={365}
              step={1}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Leave the limit blank for no limit, or set 0 to allow no credit. A sale that would take
          this customer over the limit can only be approved by an admin.
        </p>
        <div>
          <Label>Reason (optional)</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save terms"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
