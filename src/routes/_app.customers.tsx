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
import { MoneyInput } from "@/components/ui/money-input";
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
  Trash2,
  RotateCcw,
} from "lucide-react";
import { money } from "@/lib/format";
import { toast } from "sonner";
import { KPI } from "@/lib/dashboard-kit";
import { AccountAdjustmentsCard } from "@/components/customers/account-adjustments";
import { ReportActions } from "@/components/shared/report-actions";

export const Route = createFileRoute("/_app/customers")({
  head: () => ({
    meta: [{ title: "Customers — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
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
  // Set when the customer was removed (stopped buying) but has history to keep.
  removed_at?: string | null;
  removed_reason?: string | null;
};

function CustomersPage() {
  const { data: factoryId } = useFactoryId();
  const qc = useQueryClient();
  const { can, canWrite, canApprove, canSeeMoney } = usePermissions();
  const canRemove = can("customers", "delete");
  const [showRemoved, setShowRemoved] = useState(false);
  const [removing, setRemoving] = useState<Customer | null>(null);
  const write = canWrite("customers");
  // Credit limits and payment terms are set via set_customer_credit_terms(),
  // which needs customers:approve -- not the ordinary edit permission.
  const setTerms = canApprove("customers") && canSeeMoney;
  const [termsFor, setTermsFor] = useState<Customer | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [viewing, setViewing] = useState<Customer | null>(null);

  const list = useQuery({
    queryKey: ["customers", factoryId, q, showRemoved],
    enabled: !!factoryId,
    queryFn: async () => {
      // Removed customers (stopped buying) are kept for their history and
      // listed only on request.
      let query = supabase.from("customers").select("*").eq("factory_id", factoryId!).order("name");
      query = showRemoved ? query.not("removed_at", "is", null) : query.is("removed_at", null);
      const term = q.trim().replace(/[,()]/g, " ");
      if (term) query = query.or(`name.ilike.%${term}%,phone.ilike.%${term}%`);
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
        // Customers belong to field reps; the retail outlet has none.
        .eq("kind", "rep")
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
            {canSeeMoney
              ? "Manage customer profiles and outstanding balances."
              : "Manage customer profiles."}
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
        {canSeeMoney && (
          <>
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
              value={money(
                (list.data ?? []).reduce((s, c) => s + Number(c.outstanding_balance), 0),
              )}
              tone="destructive"
            />
          </>
        )}
      </div>

      {factoryId && canSeeMoney && <AccountAdjustmentsCard factoryId={factoryId} />}

      <Card className="rounded-2xl">
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle>{showRemoved ? "Removed customers" : "All Customers"}</CardTitle>
          <ReportActions
            size="sm"
            title={showRemoved ? "Removed customers" : "Customers"}
            fileName={showRemoved ? "customers-removed" : "customers"}
            columns={[
              { key: "name", label: "Name" },
              { key: "phone", label: "Phone" },
              ...(repList.length > 0 ? [{ key: "marketer", label: "Marketer" }] : []),
              { key: "sales", label: "Transactions" },
              { key: "goods", label: "Total Goods" },
              ...(canSeeMoney
                ? [
                    { key: "paid", label: "Paid" },
                    { key: "balance", label: "Balance" },
                    { key: "limit", label: "Credit limit" },
                    { key: "terms", label: "Terms" },
                  ]
                : []),
            ]}
            rows={(list.data ?? []).map((c) => ({
              name: c.name,
              phone: c.phone ?? "",
              marketer: repName(c.sales_rep_id) ?? "",
              sales: c.total_transactions,
              goods: money(Number(c.total_purchases)),
              paid: money(Number(c.total_purchases) - Number(c.outstanding_balance)),
              balance: money(Number(c.outstanding_balance)),
              limit: c.credit_limit == null ? "No limit" : money(Number(c.credit_limit)),
              terms: `${c.credit_days} days`,
            }))}
            subtitle={q.trim() ? [`Search: ${q.trim()}`] : []}
          />
          <div className="flex w-full max-w-md items-center gap-2">
            <Button
              size="sm"
              variant={showRemoved ? "default" : "outline"}
              className="shrink-0"
              onClick={() => setShowRemoved((v) => !v)}
            >
              {showRemoved ? "Back to customers" : "Show removed"}
            </Button>
            <div className="relative w-full">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name or phone…"
                className="pl-8 h-9"
              />
            </div>
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
                {canSeeMoney && (
                  <>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead className="text-right">Credit limit</TableHead>
                    <TableHead>Terms</TableHead>
                  </>
                )}
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
                        {c.removed_at ? (
                          <Badge
                            variant="outline"
                            className="text-muted-foreground"
                            title={c.removed_reason ?? undefined}
                          >
                            removed {new Date(c.removed_at).toLocaleDateString()}
                          </Badge>
                        ) : (
                          !c.registered && (
                            <Badge variant="outline" className="text-muted-foreground">
                              unregistered
                            </Badge>
                          )
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{c.phone ?? "—"}</TableCell>
                    {repList.length > 0 && <TableCell>{repName(c.sales_rep_id) ?? "—"}</TableCell>}
                    <TableCell>
                      <Badge variant="secondary">
                        {c.total_transactions} sale{c.total_transactions === 1 ? "" : "s"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{money(Number(c.total_purchases))}</TableCell>
                    {canSeeMoney && (
                      <>
                        <TableCell className="text-right text-success">{money(paid)}</TableCell>
                        <TableCell className="text-right">
                          <span
                            className={
                              Number(c.outstanding_balance) > 0
                                ? "text-destructive font-medium"
                                : ""
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
                      </>
                    )}
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {!c.registered && !c.removed_at && (
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
                        {canRemove && !c.removed_at && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Remove customer"
                            onClick={() => setRemoving(c)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                        {(canRemove || write) && c.removed_at && <RestoreButton customer={c} />}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {(list.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    {showRemoved
                      ? "No removed customers."
                      : q
                        ? "No customers match."
                        : "No customers yet."}
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

      <Dialog open={!!removing} onOpenChange={(v) => !v && setRemoving(null)}>
        {removing && <RemoveCustomerDialog customer={removing} onDone={() => setRemoving(null)} />}
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
  const { canSeeMoney } = usePermissions();
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
    enabled: canSeeMoney,
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
          {canSeeMoney && (
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
          )}
        </div>

        <Tabs defaultValue="invoices">
          <TabsList>
            <TabsTrigger value="invoices">Purchase History / Invoices</TabsTrigger>
            {canSeeMoney && <TabsTrigger value="payments">Payment History</TabsTrigger>}
          </TabsList>
          <TabsContent value="invoices">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  {canSeeMoney && <TableHead className="text-right">Balance</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(invoices.data ?? []).map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-mono text-xs">{inv.invoice_number}</TableCell>
                    <TableCell>{inv.sale_date}</TableCell>
                    <TableCell className="text-right">{money(Number(inv.grand_total))}</TableCell>
                    {canSeeMoney && (
                      <TableCell className="text-right">
                        {Number(inv.balance) > 0 ? (
                          <Badge variant="destructive">{money(Number(inv.balance))}</Badge>
                        ) : (
                          <Badge variant="secondary">Paid</Badge>
                        )}
                      </TableCell>
                    )}
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
            <MoneyInput
              value={limit.trim() === "" ? null : Number(limit)}
              onChange={(v) => setLimit(String(v))}
              onEmpty={() => setLimit("")}
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

// remove_customer / restore_customer are newer than the generated types.
const rpc = supabase.rpc as unknown as (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: Error | null }>;

// Remove a customer who no longer buys. One with no history is deleted; one
// with invoices or payments is taken off the lists and pickers but kept, so
// their statements still work. Refused while they owe money, hold an advance
// or containers, or have a sale waiting for approval.
function RemoveCustomerDialog({ customer, onDone }: { customer: Customer; onDone: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const remove = useMutation({
    mutationFn: async () => {
      const { data, error } = await rpc.call(supabase, "remove_customer", {
        p_customer: customer.id,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      return data as { result: "deleted" | "removed" };
    },
    onSuccess: (res) => {
      toast.success(
        res.result === "deleted"
          ? `${customer.name} deleted`
          : `${customer.name} removed. Their invoices and payments are kept under "Show removed".`,
      );
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["acct-distributors"] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Remove {customer.name}?</DialogTitle>
      </DialogHeader>
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          If {customer.name} has never bought or paid anything, they are deleted. Otherwise they
          come off the customer and distributor lists, but their invoices, payments and statements
          are kept, and they can be restored later.
        </p>
        <p className="text-muted-foreground">
          A customer who still owes money, has an advance, holds containers or has a sale waiting
          for approval can&apos;t be removed until that is settled.
        </p>
        <div>
          <Label>Reason *</Label>
          <Textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. No longer buys from us"
          />
        </div>
      </div>
      <DialogFooter>
        <Button
          variant="destructive"
          disabled={reason.trim().length < 3 || remove.isPending}
          onClick={() => remove.mutate()}
        >
          Remove customer
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function RestoreButton({ customer }: { customer: Customer }) {
  const qc = useQueryClient();
  const restore = useMutation({
    mutationFn: async () => {
      const { error } = await rpc.call(supabase, "restore_customer", { p_customer: customer.id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${customer.name} restored`);
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["acct-distributors"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Button
      variant="ghost"
      size="icon"
      title="Restore customer"
      disabled={restore.isPending}
      onClick={() => restore.mutate()}
    >
      <RotateCcw className="h-4 w-4" />
    </Button>
  );
}
