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
import { fetchSaleLines, printSaleInvoice } from "@/lib/invoice";
import { printMonthlySales } from "@/lib/monthly-sales-pdf";
import { generateReceiptPdf } from "@/lib/pdf";
import { AccountsTab, type Rep } from "@/routes/_app.distribution";
import { PostingsTab } from "@/components/accounting/postings-tab";
import { DistributorsTab } from "@/components/accounting/distributors-tab";
import { RetailCashUpTab } from "@/components/retail/outlet-day-close";
import { CustomerActivityDialog } from "@/components/accounting/customer-activity-dialog";
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
  Eye,
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
  sale_items: { quantity: number; products: { name: string; unit: string } | null }[] | null;
};

// One customer's invoices for one day. Marketers and distributors take
// supplies many times a day, so the accountant sees -- and prints -- them as
// a single invoice (printSaleInvoice merges the lines). Walk-ins are never
// merged with each other, nor are PR or differently-statused invoices.
type InvoiceGroup = {
  key: string;
  date: string;
  customer: string;
  walkIn: boolean;
  ids: string[];
  numbers: string[];
  products: string;
  total: number;
  paid: number;
  balance: number;
  status: string;
  is_pr: boolean;
};

function groupInvoices(sales: SaleRow[]): InvoiceGroup[] {
  const groups = new Map<string, InvoiceGroup & { qty: Map<string, number> }>();
  for (const s of sales) {
    const name = s.customer_name?.trim();
    const key = [
      s.sale_date.slice(0, 10),
      name ? name.toLowerCase() : `walk-in-${s.id}`,
      s.status,
      s.is_pr,
    ].join("|");
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        date: s.sale_date,
        customer: name || "Walk-in",
        walkIn: !name,
        ids: [],
        numbers: [],
        products: "",
        total: 0,
        paid: 0,
        balance: 0,
        status: s.status,
        is_pr: s.is_pr,
        qty: new Map(),
      };
      groups.set(key, g);
    }
    g.ids.push(s.id);
    g.numbers.push(s.invoice_number);
    g.total += Number(s.grand_total);
    g.paid += Number(s.amount_paid);
    g.balance += Number(s.balance);
    for (const it of s.sale_items ?? []) {
      const label = [it.products?.name ?? "Item", it.products?.unit].filter(Boolean).join("|");
      g.qty.set(label, (g.qty.get(label) ?? 0) + Number(it.quantity));
    }
  }
  return [...groups.values()].map(({ qty, ...g }) => ({
    ...g,
    products: [...qty]
      .map(([label, n]) => {
        const [name, unit] = label.split("|");
        return `${name} × ${n.toLocaleString()}${unit ? ` ${unit}` : ""}`;
      })
      .join(" · "),
  }));
}

type PaymentRow = {
  id: string;
  receipt_number: string;
  payment_date: string;
  amount: number;
  payment_method: string;
  remarks: string | null;
  status: string;
  customers: { name: string } | null;
  sales: { invoice_number: string; customer_name: string | null } | null;
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
  // Invoices: the products supplied.
  details?: string;
  // The row's actions: invoices view/print, payments print a receipt.
  group?: InvoiceGroup;
  payment?: PaymentRow;
  // Payments merged into the row (the customer's receipts that day).
  paid?: number;
  receipts?: number;
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
  const [viewing, setViewing] = useState<InvoiceGroup | null>(null);
  // Monthly accumulated sales PDF: "YYYY-MM", this month by default.
  const [month, setMonth] = useState(() => startOfToday().slice(0, 7));
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
          "id,invoice_number,sale_date,customer_name,grand_total,amount_paid,balance,status,is_pr,sale_items(quantity,products(name,unit))",
        )
        .eq("factory_id", factoryId!)
        // Admins can also read soft-deleted sales; they aren't real invoices.
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      const rows = (data ?? []) as unknown as SaleRow[];
      // Product names through sale_invoice_lines(): an accountant without
      // finished-goods rights can't read products directly.
      const lines = await fetchSaleLines(rows.map((s) => s.id));
      return rows.map((s) => {
        const own = lines?.get(s.id);
        return own
          ? {
              ...s,
              sale_items: own.map((l) => ({
                quantity: l.quantity,
                products: { name: l.name, unit: l.unit },
              })),
            }
          : s;
      });
    },
  });

  const payments = useQuery({
    queryKey: ["acct-payments", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments_received")
        .select(
          "id,receipt_number,payment_date,amount,payment_method,remarks,status,customers(name),sales(invoice_number,customer_name)",
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

  const invoiceGroups = useMemo(() => groupInvoices(sales.data ?? []), [sales.data]);

  const activity = useMemo<Activity[]>(() => {
    // One row per customer per day: their payments that day join their
    // invoice row (by the invoice paid, else by name), so the customer shows
    // once and the eye opens everything. Payments with no invoice that day
    // are still merged per customer per day.
    const day = (d: string) => d.slice(0, 10);
    const nameOf = (p: PaymentRow) =>
      (p.customers?.name ?? p.sales?.customer_name ?? "").trim().toLowerCase();
    const byNumber = new Map<string, InvoiceGroup>();
    const byName = new Map<string, InvoiceGroup>();
    for (const g of invoiceGroups) {
      for (const n of g.numbers) byNumber.set(n, g);
      if (!g.walkIn) byName.set(`${day(g.date)}|${g.customer.toLowerCase()}`, g);
    }
    const paidTo = new Map<string, PaymentRow[]>();
    const loose = new Map<string, PaymentRow[]>();
    for (const p of payments.data ?? []) {
      const live = !["rejected", "reversed", "cancelled"].includes(p.status);
      const g =
        (live && p.sales?.invoice_number && byNumber.get(p.sales.invoice_number)) ||
        (live && nameOf(p) && byName.get(`${day(p.payment_date)}|${nameOf(p)}`)) ||
        null;
      if (g && day(g.date) === day(p.payment_date)) {
        paidTo.set(g.key, [...(paidTo.get(g.key) ?? []), p]);
        continue;
      }
      const k = nameOf(p) && live ? `${day(p.payment_date)}|${nameOf(p)}` : `id|${p.id}`;
      loose.set(k, [...(loose.get(k) ?? []), p]);
    }
    const sum = (ps: PaymentRow[]) => ps.reduce((t, p) => t + Number(p.amount), 0);
    const rows: Activity[] = [
      ...invoiceGroups.map((g) => {
        const ps = paidTo.get(g.key) ?? [];
        return {
          key: `inv-${g.key}`,
          date: g.date,
          kind: "Invoice" as const,
          reference: g.numbers.length > 1 ? `${g.numbers.length} invoices` : g.numbers[0],
          party: g.customer,
          details: g.products,
          group: g,
          paid: ps.length ? sum(ps) : undefined,
          receipts: ps.length || undefined,
          amount: g.total,
          direction: "in" as const,
          status: g.status,
        };
      }),
      ...[...loose.entries()].map(([k, ps]) => {
        const p = ps[0];
        const name = p.customers?.name ?? p.sales?.customer_name ?? null;
        return {
          key: `pay-${k}`,
          date: p.payment_date,
          kind: "Payment" as const,
          reference: ps.length > 1 ? `${ps.length} receipts` : p.receipt_number,
          party: name ?? "—",
          amount: sum(ps),
          direction: "in" as const,
          status: p.status,
          payment: ps.length === 1 ? p : undefined,
          // The eye opens the customer's activity (by name).
          group: name
            ? {
                key: `pay-${k}`,
                date: p.payment_date,
                customer: name,
                walkIn: false,
                ids: [],
                numbers: [],
                products: "",
                total: 0,
                paid: 0,
                balance: 0,
                status: p.status,
                is_pr: false,
              }
            : undefined,
        };
      }),
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
  }, [invoiceGroups, payments.data, expenses.data, payroll.data]);

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
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activity
                    .filter((a) => match(a.reference, a.party, a.kind, a.details))
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
                        <TableCell>
                          <div>{a.party}</div>
                          {a.details && (
                            <div className="text-xs text-muted-foreground">{a.details}</div>
                          )}
                          {a.paid !== undefined && a.group && (
                            <div className="text-xs text-success">
                              Paid {money(a.paid, currency)} ({a.receipts}{" "}
                              {a.receipts === 1 ? "receipt" : "receipts"}) · Balance{" "}
                              {money(a.group.balance, currency)}
                            </div>
                          )}
                        </TableCell>
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
                        <TableCell>
                          {/* Same actions as the Invoices / Payments received tabs. */}
                          <div className="flex justify-end gap-1">
                            {a.group && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title="View customer's activity"
                                  onClick={() => setViewing(a.group!)}
                                >
                                  <Eye className="h-4 w-4" />
                                </Button>
                                {a.group.ids.length > 0 && (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      title={
                                        a.group.ids.length > 1
                                          ? "Print combined invoice"
                                          : "Print invoice"
                                      }
                                      onClick={() =>
                                        printSaleInvoice(a.group!.ids, settings.data, "print")
                                      }
                                    >
                                      <Printer className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      title={
                                        a.group.ids.length > 1
                                          ? "Download combined invoice"
                                          : "Download invoice"
                                      }
                                      onClick={() =>
                                        printSaleInvoice(a.group!.ids, settings.data, "download")
                                      }
                                    >
                                      <Download className="h-4 w-4" />
                                    </Button>
                                  </>
                                )}
                              </>
                            )}
                            {a.payment && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title="Print receipt"
                                  onClick={() => printReceipt(a.payment!, "print")}
                                >
                                  <Printer className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title="Download receipt"
                                  onClick={() => printReceipt(a.payment!, "download")}
                                >
                                  <FileText className="h-4 w-4" />
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  {activity.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
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
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle>Invoices</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">Monthly sales</span>
                <Input
                  type="month"
                  className="w-40"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  disabled={!month}
                  onClick={() => printMonthlySales(factoryId, month, settings.data, "print")}
                >
                  <Printer className="h-4 w-4" /> Print
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  disabled={!month}
                  onClick={() => printMonthlySales(factoryId, month, settings.data, "download")}
                >
                  <Download className="h-4 w-4" /> PDF
                </Button>
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice #</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Products</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoiceGroups
                    .filter((g) => match(...g.numbers, g.customer, g.products))
                    .map((g) => (
                      <TableRow key={g.key}>
                        <TableCell className="font-mono text-xs">
                          {g.numbers.length > 1 ? (
                            <span title={g.numbers.join("\n")}>{g.numbers.length} invoices</span>
                          ) : (
                            g.numbers[0]
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {new Date(g.date).toLocaleDateString()}
                        </TableCell>
                        <TableCell>{g.customer}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {g.products || "—"}
                        </TableCell>
                        <TableCell className="text-right">{money(g.total, currency)}</TableCell>
                        <TableCell className="text-right">{money(g.paid, currency)}</TableCell>
                        <TableCell className="text-right font-medium">
                          {money(g.balance, currency)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(g.status)} className="capitalize">
                            {g.status.replace(/_/g, " ")}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              title="View customer's activity"
                              onClick={() => setViewing(g)}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={g.ids.length > 1 ? "Print combined invoice" : "Print invoice"}
                              onClick={() => printSaleInvoice(g.ids, settings.data, "print")}
                            >
                              <Printer className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={
                                g.ids.length > 1 ? "Download combined invoice" : "Download invoice"
                              }
                              onClick={() => printSaleInvoice(g.ids, settings.data, "download")}
                            >
                              <Download className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  {(sales.data ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-sm text-muted-foreground">
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
            <CardHeader className="flex flex-row items-center flex-wrap justify-between gap-2">
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

      {viewing && (
        <CustomerActivityDialog
          open
          onOpenChange={(v) => !v && setViewing(null)}
          factoryId={factoryId}
          customer={viewing.walkIn ? null : viewing.customer}
          date={viewing.date}
          saleIds={viewing.ids}
          currency={currency}
          settings={settings.data}
        />
      )}
    </div>
  );
}
