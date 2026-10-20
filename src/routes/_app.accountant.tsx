import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RequireAccess } from "@/components/layout/require-access";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { usePermissions, type ModuleKey } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { KPI } from "@/lib/dashboard-kit";
import { money } from "@/lib/format";
import { printSaleInvoice } from "@/lib/invoice";
import { generateReceiptPdf } from "@/lib/pdf";
import { AccountsTab, type Rep } from "@/routes/_app.distribution";
import { PostingsTab } from "@/components/accounting/postings-tab";
import { DistributorsTab } from "@/components/accounting/distributors-tab";
import { RetailCashUpTab } from "@/components/retail/outlet-day-close";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BadgeDollarSign,
  CircleDollarSign,
  Download,
  FileBarChart,
  FileText,
  HandCoins,
  Printer,
  Receipt,
  Search,
  Wallet,
  Landmark,
  CheckSquare,
} from "lucide-react";

export const Route = createFileRoute("/_app/accountant")({
  head: () => ({
    meta: [{ title: "Accountant — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
  // ?tab= opens a tab (Finance → Marketer & Retail Accounts links to
  // postings / accounts / distributors); no param means All activity.
  validateSearch: (s: Record<string, unknown>): { tab?: string } => ({
    tab: typeof s.tab === "string" ? s.tab : undefined,
  }),
  component: () => (
    <RequireAccess module="finance">
      <AccountantPage />
    </RequireAccess>
  ),
});

// The accountant's desk: everything they do day to day in one place --
// printing invoices, receiving payments and printing receipts, plus a single
// activity feed of the money transactions (invoices, payments, expenses,
// payroll). Every Warehouse posting (marketers, retail shop, distributors)
// comes here to be assessed and paid (Postings), next to the marketer & retail
// accounts and the distributors' accounts. Recording and approving still happen on the existing pages
// (Payments, Expenses, Payroll, Debts); the quick actions link there rather
// than duplicating those forms.

type SaleRow = {
  id: string;
  invoice_number: string;
  sale_date: string;
  customer_name: string | null;
  grand_total: number;
  amount_paid: number;
  balance: number;
  status: string;
  is_pr: boolean;
};

type PaymentRow = {
  id: string;
  receipt_number: string;
  payment_date: string;
  amount: number;
  payment_method: string;
  remarks: string | null;
  status: string;
  customers: { name: string } | null;
  sales: { invoice_number: string } | null;
};

type ExpenseRow = {
  id: string;
  expense_date: string;
  description: string | null;
  amount: number;
  status: string | null;
  approval_status: string | null;
  expense_categories: { name: string } | null;
};

type PayrollRow = {
  id: string;
  submitted_at: string;
  period_month: number;
  period_year: number;
  net_salary: number;
  status: string;
  employees: { full_name: string } | null;
};

type Activity = {
  key: string;
  date: string;
  kind: "Invoice" | "Payment" | "Expense" | "Payroll";
  reference: string;
  party: string;
  amount: number;
  direction: "in" | "out";
  status: string;
};

const startOfToday = () => new Date().toISOString().slice(0, 10);
const startOfMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};

const statusVariant = (s: string): "default" | "secondary" | "outline" | "destructive" => {
  if (["posted", "confirmed", "approved", "paid"].includes(s)) return "default";
  if (["rejected", "cancelled", "reversed"].includes(s)) return "destructive";
  if (s.startsWith("pending") || s === "submitted") return "secondary";
  return "outline";
};

function AccountantPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const currency = settings.data?.currency ?? "NGN";
  const perms = usePermissions();
  const { can } = perms;
  const [q, setQ] = useState("");
  const { tab = "activity" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const setTab = (v: string) =>
    navigate({
      search: { tab: v === "activity" ? undefined : v },
      replace: true,
      state: (prev) => prev,
    });
  // Marketer & retail accounts read the distribution side (reps, van stock).
  const canRepAccounts = perms.canView("distribution");
  const searchable = ["activity", "invoices", "payments"].includes(tab);

  const reps = useQuery({
    queryKey: ["dist-reps", factoryId],
    enabled: !!factoryId && canRepAccounts,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_reps")
        .select("id,code,full_name,phone,status,employee_id,remarks,kind")
        .eq("factory_id", factoryId!)
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as Rep[];
    },
  });

  useRealtimeInvalidate(
    ["sales", "payments_received", "expenses", "payroll"],
    [["acct-sales"], ["acct-payments"], ["acct-expenses"], ["acct-payroll"]],
  );

  const sales = useQuery({
    queryKey: ["acct-sales", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select(
          "id,invoice_number,sale_date,customer_name,grand_total,amount_paid,balance,status,is_pr",
        )
        .eq("factory_id", factoryId!)
        // Admins can also read soft-deleted sales; they aren't real invoices.
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as SaleRow[];
    },
  });

  const payments = useQuery({
    queryKey: ["acct-payments", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments_received")
        .select(
          "id,receipt_number,payment_date,amount,payment_method,remarks,status,customers(name),sales(invoice_number)",
        )
        .eq("factory_id", factoryId!)
        .order("payment_date", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as PaymentRow[];
    },
  });

  const expenses = useQuery({
    queryKey: ["acct-expenses", factoryId],
    enabled: !!factoryId && can("expenses"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expenses")
        .select(
          "id,expense_date,description,amount,status,approval_status,expense_categories(name)",
        )
        .eq("factory_id", factoryId!)
        .order("expense_date", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as ExpenseRow[];
    },
  });

  const payroll = useQuery({
    queryKey: ["acct-payroll", factoryId],
    enabled: !!factoryId && can("payroll"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll")
        .select("id,submitted_at,period_month,period_year,net_salary,status,employees(full_name)")
        .eq("factory_id", factoryId!)
        .order("submitted_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as PayrollRow[];
    },
  });

  const today = startOfToday();
  const monthStart = startOfMonth();
  const livePayments = (payments.data ?? []).filter(
    (p) => !["rejected", "reversed", "cancelled"].includes(p.status),
  );
  const receivedToday = livePayments
    .filter((p) => p.payment_date.slice(0, 10) === today)
    .reduce((t, p) => t + Number(p.amount), 0);
  const receivedMonth = livePayments
    .filter((p) => p.payment_date.slice(0, 10) >= monthStart)
    .reduce((t, p) => t + Number(p.amount), 0);
  const outstanding = (sales.data ?? [])
    .filter((s) => s.status === "posted" && !s.is_pr)
    .reduce((t, s) => t + Math.max(0, Number(s.balance)), 0);

  const activity = useMemo<Activity[]>(() => {
    const rows: Activity[] = [
      ...(sales.data ?? []).map((s) => ({
        key: `inv-${s.id}`,
        date: s.sale_date,
        kind: "Invoice" as const,
        reference: s.invoice_number,
        party: s.customer_name ?? "Walk-in",
        amount: Number(s.grand_total),
        direction: "in" as const,
        status: s.status,
      })),
      ...(payments.data ?? []).map((p) => ({
        key: `pay-${p.id}`,
        date: p.payment_date,
        kind: "Payment" as const,
        reference: p.receipt_number,
        party: p.customers?.name ?? "—",
        amount: Number(p.amount),
        direction: "in" as const,
        status: p.status,
      })),
      ...(expenses.data ?? []).map((e) => ({
        key: `exp-${e.id}`,
        date: e.expense_date,
        kind: "Expense" as const,
        reference: e.expense_categories?.name ?? "Expense",
        party: e.description ?? "—",
        amount: Number(e.amount),
        direction: "out" as const,
        status: e.status ?? e.approval_status ?? "—",
      })),
      ...(payroll.data ?? []).map((p) => ({
        key: `pr-${p.id}`,
        date: p.submitted_at,
        kind: "Payroll" as const,
        reference: `${String(p.period_month).padStart(2, "0")}/${p.period_year}`,
        party: p.employees?.full_name ?? "—",
        amount: Number(p.net_salary),
        direction: "out" as const,
        status: p.status,
      })),
    ];
    return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [sales.data, payments.data, expenses.data, payroll.data]);

  const query = q.trim().toLowerCase();
  const match = (...fields: (string | null | undefined)[]) =>
    !query || fields.some((f) => (f ?? "").toLowerCase().includes(query));

  const printReceipt = (p: PaymentRow, action: "download" | "print") =>
    generateReceiptPdf(
      {
        company: {
          name: settings.data?.company_name ?? "Elim Table Water",
          address: settings.data?.address,
          phone: settings.data?.phone,
          logo_url: settings.data?.logo_url,
        },
        receipt_number: p.receipt_number,
        payment_date: p.payment_date,
        customer_name: p.customers?.name,
        invoice_number: p.sales?.invoice_number,
        amount: Number(p.amount),
        payment_method: p.payment_method,
        remarks: p.remarks,
        currency,
      },
      action,
    );

  const actions: { label: string; to: string; icon: React.ElementType; module: ModuleKey }[] = [
    { label: "Receive payment", to: "/cash-ledger/ledger", icon: HandCoins, module: "payments" },
    { label: "Debts & receivables", to: "/cash-ledger/debts", icon: Wallet, module: "debts" },
    { label: "Record expense", to: "/expenses", icon: Receipt, module: "expenses" },
    { label: "Payroll", to: "/payroll", icon: BadgeDollarSign, module: "payroll" },
    { label: "Approvals", to: "/approvals", icon: CheckSquare, module: "approvals" },
    { label: "Finance overview", to: "/finance", icon: Landmark, module: "finance" },
    { label: "Financial reports", to: "/reports", icon: FileBarChart, module: "reports" },
  ];

  if (!factoryId) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Accountant</h1>
        <p className="text-sm text-muted-foreground">
          Print invoices, receive payments and print receipts, and follow every money transaction in
          one place.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {actions
          .filter((a) => can(a.module))
          .map((a) => (
            <Button key={a.to} asChild variant="outline" size="sm" className="gap-2">
              <Link to={a.to}>
                <a.icon className="h-4 w-4" /> {a.label}
              </Link>
            </Button>
          ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPI
          icon={HandCoins}
          label="Received Today"
          value={money(receivedToday, currency)}
          tone="success"
        />
        <KPI
          icon={CircleDollarSign}
          label="Received This Month"
          value={money(receivedMonth, currency)}
        />
        <KPI
          icon={Wallet}
          label="Outstanding Invoices"
          value={money(outstanding, currency)}
          hint="Unpaid balance on posted invoices"
          tone={outstanding > 0 ? "warning" : "success"}
        />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList className="flex-wrap">
            <TabsTrigger value="activity">All activity</TabsTrigger>
            <TabsTrigger value="postings">Postings to assess</TabsTrigger>
            <TabsTrigger value="retail-cashup">Retail cash-up</TabsTrigger>
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
            <TabsTrigger value="payments">Payments received</TabsTrigger>
            {canRepAccounts && (
              <TabsTrigger value="accounts">Marketer &amp; retail accounts</TabsTrigger>
            )}
            <TabsTrigger value="distributors">Distributors</TabsTrigger>
          </TabsList>
          <div className={`relative w-full sm:w-72 ${searchable ? "" : "hidden"}`}>
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search number, customer…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>

        <TabsContent value="activity">
          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle>All transactions</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Customer / Details</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activity
                    .filter((a) => match(a.reference, a.party, a.kind))
                    .slice(0, 300)
                    .map((a) => (
                      <TableRow key={a.key}>
                        <TableCell className="whitespace-nowrap text-xs">
                          {new Date(a.date).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{a.kind}</Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{a.reference}</TableCell>
                        <TableCell>{a.party}</TableCell>
                        <TableCell
                          className={`text-right font-medium ${a.direction === "out" ? "text-destructive" : ""}`}
                        >
                          {a.direction === "out" ? "−" : ""}
                          {money(a.amount, currency)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(a.status)} className="capitalize">
                            {a.status.replace(/_/g, " ")}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  {activity.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                        No transactions yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="postings">
          <PostingsTab factoryId={factoryId} currency={currency} />
        </TabsContent>

        {canRepAccounts && (
          <TabsContent value="accounts">
            <AccountsTab factoryId={factoryId} reps={reps.data ?? []} perms={perms} />
          </TabsContent>
        )}

        <TabsContent value="retail-cashup">
          <RetailCashUpTab factoryId={factoryId} currency={currency} />
        </TabsContent>

        <TabsContent value="distributors">
          <DistributorsTab factoryId={factoryId} currency={currency} />
        </TabsContent>

        <TabsContent value="invoices">
          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle>Invoices</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice #</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(sales.data ?? [])
                    .filter((s) => match(s.invoice_number, s.customer_name))
                    .map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-mono text-xs">{s.invoice_number}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {new Date(s.sale_date).toLocaleDateString()}
                        </TableCell>
                        <TableCell>{s.customer_name ?? "Walk-in"}</TableCell>
                        <TableCell className="text-right">
                          {money(s.grand_total, currency)}
                        </TableCell>
                        <TableCell className="text-right">
                          {money(s.amount_paid, currency)}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {money(s.balance, currency)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(s.status)} className="capitalize">
                            {s.status.replace(/_/g, " ")}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Print invoice"
                              onClick={() => printSaleInvoice(s.id, settings.data, "print")}
                            >
                              <Printer className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Download invoice"
                              onClick={() => printSaleInvoice(s.id, settings.data, "download")}
                            >
                              <Download className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  {(sales.data ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                        No invoices yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="payments">
          <Card className="rounded-2xl">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Payments received</CardTitle>
              {can("payments") && (
                <Button asChild size="sm" className="gap-2">
                  <Link to="/cash-ledger/ledger">
                    <HandCoins className="h-4 w-4" /> Receive payment
                  </Link>
                </Button>
              )}
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Receipt #</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(payments.data ?? [])
                    .filter((p) =>
                      match(p.receipt_number, p.customers?.name, p.sales?.invoice_number),
                    )
                    .map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-mono text-xs">{p.receipt_number}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {new Date(p.payment_date).toLocaleDateString()}
                        </TableCell>
                        <TableCell>{p.customers?.name ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {p.sales?.invoice_number ?? "—"}
                        </TableCell>
                        <TableCell className="capitalize">
                          {p.payment_method.replace(/_/g, " ")}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {money(p.amount, currency)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(p.status)} className="capitalize">
                            {p.status.replace(/_/g, " ")}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Print receipt"
                              onClick={() => printReceipt(p, "print")}
                            >
                              <Printer className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Download receipt"
                              onClick={() => printReceipt(p, "download")}
                            >
                              <FileText className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  {(payments.data ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                        No payments yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
