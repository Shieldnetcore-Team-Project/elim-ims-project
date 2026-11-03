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
import {
  AccountsTab,
  RemittancesTab,
  RepDetailsDialog,
  RepsTab,
  type Rep,
} from "@/routes/_app.distribution";
import { printDispatchInvoice } from "@/lib/dispatch-slip";
import { CustomersPage } from "@/routes/_app.customers";
import { PostingsTab } from "@/components/accounting/postings-tab";
import { DistributorsTab } from "@/components/accounting/distributors-tab";
import { RetailCashUpTab } from "@/components/retail/outlet-day-close";
import { DispenserReports } from "@/components/retail/dispenser-reports";
import { RetailDailyBook } from "@/components/accounting/retail-daily-book";
import { CustomerActivityDialog } from "@/components/accounting/customer-activity-dialog";
import { Dialog } from "@/components/ui/dialog";
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
  created_at?: string | null;
  customer_name: string | null;
  grand_total: number;
  amount_paid: number;
  balance: number;
  status: string;
  is_pr: boolean;
  // The marketer or the Retail Shop whose stock it was sold from, if any.
  sales_rep_id: string | null;
  // Whose account the sale is on: the marketer who sold it, else the
  // customer's marketer at the time (stamped by the database).
  account_rep_id: string | null;
  sale_items: { quantity: number; products: { name: string; unit: string } | null }[] | null;
};

// One customer's invoices for one day. Marketers and distributors take
// supplies many times a day, so the accountant sees -- and prints -- them as
// a single invoice (printSaleInvoice merges the lines). Walk-ins are never
// merged with each other, nor are PR or differently-statused invoices.
type InvoiceGroup = {
  key: string;
  date: string;
  // When the group's latest invoice was keyed in (sorting newest first).
  at?: string | null;
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
  repId?: string | null;
  // Opened from a party's row on All activity: the whole history.
  allHistory?: boolean;
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
        repId: s.account_rep_id ?? s.sales_rep_id,
      };
      groups.set(key, g);
    }
    if (s.created_at && (!g.at || s.created_at > g.at)) g.at = s.created_at;
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
  created_at?: string | null;
  amount: number;
  payment_method: string;
  remarks: string | null;
  status: string;
  customers: { name: string } | null;
  sales: { invoice_number: string; customer_name: string | null } | null;
  // The marketer's account the payment counts on, if any.
  account_rep_id: string | null;
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

type PartyType = "marketer" | "customer" | "retail" | "internal";
const PARTY_FILTERS: { key: PartyType | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "marketer", label: "Marketers" },
  // Customers under a marketer are on the marketer's row (2026-11-02).
  { key: "customer", label: "Distributor/Office Delivery" },
  // Only the Warehouse's postings to the shop show here (2026-11-03).
  { key: "retail", label: "Retail Shop postings" },
  { key: "internal", label: "Expenses & payroll" },
];

// Warehouse postings to marketers and the Retail Shop (accounting_postings).
type PostingRow = {
  kind: string;
  posting_kind: string;
  posting_id: string;
  reference: string;
  at: string;
  party_id: string;
  party: string;
  items: string | null;
  value: number;
  status: string;
};
type ReturnRow = {
  id: string;
  return_number: string;
  return_date: string;
  received_at: string | null;
  status: string;
  sales_rep_id: string;
  sales_reps: { full_name: string; kind: string } | null;
  rep_return_items: { quantity_returned: number; unit_price: number }[];
  items?: string;
};
type RemittanceRow = {
  id: string;
  remittance_number: string;
  remittance_date: string;
  created_at: string | null;
  amount: number;
  payment_method: string | null;
  sales_rep_id: string;
  sales_reps: { full_name: string; kind: string } | null;
};

type Activity = {
  key: string;
  date: string;
  // The exact time, where the row has one: rows are sorted by it, newest
  // first (a day-only date counts as that day's start).
  at?: string | null;
  kind: "Invoice" | "Payment" | "Expense" | "Payroll" | "Posting" | "Return" | "Cash remitted";
  // Whose activity it is, for the filter: a marketer, a customer or
  // distributor, the Retail Shop, or the factory's own spending.
  party_type: PartyType;
  // A marketer or the shop: the row opens their whole account.
  repId?: string;
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
  // A party's row stands for all their activity (2026-11-02): how many
  // transactions it gathers; the rest of the row is the latest one.
  count?: number;
  // The newest posting / sale invoice among them: their Print buttons stay on
  // the row whatever came after (a payment, a return...) -- 2026-11-03.
  lastPostingId?: string;
  lastInvoice?: InvoiceGroup;
  // What the eye opens on a customer's row: every invoice they have here,
  // from their whole history (print buttons keep the latest invoice).
  viewGroup?: InvoiceGroup;
  amount: number;
  direction: "in" | "out";
  status: string;
};

// One row per marketer and per customer (user, 2026-11-02): the latest
// activity stands for them, with how many there are; the eye opens all of
// it. Walk-ins, expenses and payroll stay one row each. `list` is newest
// first, so the first row met for a party is their latest.
function groupByParty(list: Activity[]): Activity[] {
  const out: Activity[] = [];
  const at = new Map<string, number>();
  for (const a0 of list) {
    // The list is newest first, so the first of each is the newest.
    const a: Activity = {
      ...a0,
      lastPostingId: a0.kind === "Posting" ? a0.key.slice("post-".length) : undefined,
      lastInvoice: a0.kind === "Invoice" && a0.group && a0.group.ids.length ? a0.group : undefined,
    };
    const key = a.repId
      ? `rep:${a.repId}`
      : a.party_type === "customer" && a.group && !a.group.walkIn && a.party !== "—"
        ? `customer:${a.party.trim().toLowerCase()}`
        : null;
    if (!key) {
      out.push(a);
      continue;
    }
    const i = at.get(key);
    if (i === undefined) {
      at.set(key, out.length);
      out.push({
        ...a,
        count: 1,
        viewGroup: a.group ? { ...a.group, ids: [...a.group.ids], allHistory: true } : undefined,
      });
      continue;
    }
    const row = out[i];
    row.count = (row.count ?? 1) + 1;
    row.lastPostingId ??= a.lastPostingId;
    row.lastInvoice ??= a.lastInvoice;
    if (row.viewGroup && a.group)
      row.viewGroup = { ...row.viewGroup, ids: [...row.viewGroup.ids, ...a.group.ids] };
    else if (!row.viewGroup && a.group)
      row.viewGroup = { ...a.group, ids: [...a.group.ids], allHistory: true };
  }
  return out;
}

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
  // All activity: whose rows to show, and the marketer / shop account open.
  const [party, setParty] = useState<PartyType | "all">("all");
  const [repViewing, setRepViewing] = useState<string | null>(null);
  // Monthly accumulated sales PDF: "YYYY-MM", this month by default.
  const [month, setMonth] = useState(() => startOfToday().slice(0, 7));
  // Invoices tab calendar: empty = the latest 200; a day / range loads every
  // invoice dated then, so earlier invoices can be printed again (2026-11-03).
  // All activity calendar (2026-11-03): empty = the latest of everything; a
  // day / range = everything dated then (datedActivity below).
  const [actFrom, setActFrom] = useState("");
  const [actTo, setActTo] = useState("");
  const [invFrom, setInvFrom] = useState("");
  const [invTo, setInvTo] = useState("");
  const { tab: tabParam = "activity" } = Route.useSearch();
  // Retail cash-up lives in Retail daily now (2026-11-03); old links land there.
  const tab = tabParam === "retail-cashup" ? "retail-daily" : tabParam;
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
    [
      "sales",
      "payments_received",
      "expenses",
      "payroll",
      "stock_dispatches",
      "rep_returns",
      "rep_remittances",
    ],
    [
      ["acct-sales"],
      ["acct-payments"],
      ["acct-expenses"],
      ["acct-payroll"],
      ["acct-activity-postings"],
      ["acct-activity-returns"],
      ["acct-activity-remittances"],
    ],
  );

  // The latest 200 invoices, or every invoice dated from..to.
  const loadSales = async (range?: { from: string; to: string }) => {
    let q = supabase
      .from("sales")
      .select(
        "id,invoice_number,sale_date,created_at,customer_name,grand_total,amount_paid,balance,status,is_pr,sales_rep_id,account_rep_id,sale_items(quantity,products(name,unit))",
      )
      .eq("factory_id", factoryId!)
      // Admins can also read soft-deleted sales; they aren't real invoices.
      .is("deleted_at", null);
    q = range
      ? q.gte("sale_date", range.from).lte("sale_date", range.to)
      : q.order("created_at", { ascending: false }).limit(200);
    const { data, error } = await (range ? q.order("created_at", { ascending: false }) : q);
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
  };
  const sales = useQuery({
    queryKey: ["acct-sales", factoryId],
    enabled: !!factoryId,
    queryFn: () => loadSales(),
  });
  const invRange = useMemo(
    () => (invFrom ? { from: invFrom, to: invTo && invTo >= invFrom ? invTo : invFrom } : null),
    [invFrom, invTo],
  );
  const datedSales = useQuery({
    queryKey: ["acct-sales", factoryId, "dated", invRange?.from, invRange?.to],
    enabled: !!factoryId && !!invRange,
    queryFn: () => loadSales(invRange!),
  });

  const payments = useQuery({
    queryKey: ["acct-payments", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments_received")
        .select(
          "id,receipt_number,payment_date,created_at,amount,payment_method,remarks,status,account_rep_id,customers(name),sales(invoice_number,customer_name)",
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

  // Marketers' and the Retail Shop's side of the feed (2026-11-02): what the
  // Warehouse posted to them, what they brought back, and cash they handed in.
  const postings = useQuery({
    queryKey: ["acct-activity-postings", factoryId],
    enabled: !!factoryId && canRepAccounts,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "accounting_postings" as never,
        { p_factory: factoryId, p_limit: 300 } as never,
      );
      if (error) throw error;
      // Distributor postings are invoices, already on the feed.
      return ((data ?? []) as unknown as PostingRow[]).filter((p) => p.posting_kind === "dispatch");
    },
  });
  const returns = useQuery({
    queryKey: ["acct-activity-returns", factoryId],
    enabled: !!factoryId && canRepAccounts,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rep_returns")
        .select(
          "id,return_number,return_date,received_at,status,sales_rep_id,sales_reps(full_name,kind),rep_return_items(quantity_returned,unit_price)",
        )
        .eq("factory_id", factoryId!)
        .neq("status", "cancelled")
        .order("received_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      const rows = (data ?? []) as unknown as ReturnRow[];
      // Product names through rep_posting_lines(): accountants can't read
      // products directly.
      const lines = await Promise.all(
        rows.map((r) =>
          supabase
            .rpc("rep_posting_lines" as never, { p_kind: "return", p_id: r.id } as never)
            .then(({ data: l }) =>
              ((l ?? []) as unknown as { product_name: string; unit: string; quantity: number }[])
                .map((x) => `${x.product_name} × ${Number(x.quantity).toLocaleString()} ${x.unit}`)
                .join(" · "),
            ),
        ),
      );
      return rows.map((r, i) => ({ ...r, items: lines[i] }));
    },
  });
  const remittances = useQuery({
    queryKey: ["acct-activity-remittances", factoryId],
    enabled: !!factoryId && canRepAccounts,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rep_remittances")
        .select(
          "id,remittance_number,remittance_date,created_at,amount,payment_method,sales_rep_id,sales_reps(full_name,kind)",
        )
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as RemittanceRow[];
    },
  });

  const actRange = useMemo(
    () => (actFrom ? { from: actFrom, to: actTo && actTo >= actFrom ? actTo : actFrom } : null),
    [actFrom, actTo],
  );
  // Everything on the feed for the picked days, all of it (the live queries
  // above keep only the latest). Only the All activity list reads this.
  const datedActivity = useQuery({
    queryKey: ["acct-activity-dated", factoryId, actRange?.from, actRange?.to],
    enabled: !!factoryId && !!actRange,
    queryFn: async () => {
      const r = actRange!;
      // Timestamps by Lagos day.
      const dayStart = `${r.from}T00:00:00+01:00`;
      const dayEnd = `${r.to}T23:59:59.999+01:00`;
      const none = { data: [] as unknown[], error: null };
      const [salesRows, pays, exps, prl, posts, rets, rems] = await Promise.all([
        loadSales(r),
        supabase
          .from("payments_received")
          .select(
            "id,receipt_number,payment_date,created_at,amount,payment_method,remarks,status,account_rep_id,customers(name),sales(invoice_number,customer_name)",
          )
          .eq("factory_id", factoryId!)
          .gte("payment_date", r.from)
          .lte("payment_date", r.to)
          .order("payment_date", { ascending: false }),
        can("expenses")
          ? supabase
              .from("expenses")
              .select(
                "id,expense_date,description,amount,status,approval_status,expense_categories(name)",
              )
              .eq("factory_id", factoryId!)
              .gte("expense_date", r.from)
              .lte("expense_date", r.to)
              .order("expense_date", { ascending: false })
          : Promise.resolve(none),
        can("payroll")
          ? supabase
              .from("payroll")
              .select(
                "id,submitted_at,period_month,period_year,net_salary,status,employees(full_name)",
              )
              .eq("factory_id", factoryId!)
              .gte("submitted_at", dayStart)
              .lte("submitted_at", dayEnd)
              .order("submitted_at", { ascending: false })
          : Promise.resolve(none),
        canRepAccounts
          ? supabase.rpc(
              "accounting_postings_between" as never,
              { p_factory: factoryId, p_from: r.from, p_to: r.to } as never,
            )
          : Promise.resolve(none),
        canRepAccounts
          ? supabase
              .from("rep_returns")
              .select(
                "id,return_number,return_date,received_at,status,sales_rep_id,sales_reps(full_name,kind),rep_return_items(quantity_returned,unit_price)",
              )
              .eq("factory_id", factoryId!)
              .neq("status", "cancelled")
              .gte("return_date", r.from)
              .lte("return_date", r.to)
              .order("received_at", { ascending: false })
          : Promise.resolve(none),
        canRepAccounts
          ? supabase
              .from("rep_remittances")
              .select(
                "id,remittance_number,remittance_date,created_at,amount,payment_method,sales_rep_id,sales_reps(full_name,kind)",
              )
              .eq("factory_id", factoryId!)
              .gte("remittance_date", r.from)
              .lte("remittance_date", r.to)
              .order("created_at", { ascending: false })
          : Promise.resolve(none),
      ]);
      for (const x of [pays, exps, prl, posts, rets, rems]) if (x.error) throw x.error;
      const retRows = (rets.data ?? []) as unknown as ReturnRow[];
      // Product names through rep_posting_lines(): accountants can't read
      // products directly.
      const retLines = await Promise.all(
        retRows.map((x) =>
          supabase
            .rpc("rep_posting_lines" as never, { p_kind: "return", p_id: x.id } as never)
            .then(({ data: l }) =>
              ((l ?? []) as unknown as { product_name: string; unit: string; quantity: number }[])
                .map((y) => `${y.product_name} × ${Number(y.quantity).toLocaleString()} ${y.unit}`)
                .join(" · "),
            ),
        ),
      );
      return {
        invoiceGroups: groupInvoices(salesRows),
        payments: (pays.data ?? []) as unknown as PaymentRow[],
        expenses: (exps.data ?? []) as unknown as ExpenseRow[],
        payroll: (prl.data ?? []) as unknown as PayrollRow[],
        postings: ((posts.data ?? []) as unknown as PostingRow[]).filter(
          (p) => p.posting_kind === "dispatch",
        ),
        returns: retRows.map((x, i) => ({ ...x, items: retLines[i] })),
        remittances: (rems.data ?? []) as unknown as RemittanceRow[],
      };
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
  // The Invoices tab: the calendar's day / range when one is picked.
  const invoiceRows = useMemo(
    () => (invRange ? groupInvoices(datedSales.data ?? []) : invoiceGroups),
    [invRange, datedSales.data, invoiceGroups],
  );

  const activity = useMemo<Activity[]>(() => {
    // A picked day / range reads every record dated then; otherwise the latest.
    const src = actRange
      ? (datedActivity.data ?? {
          invoiceGroups: [],
          payments: [],
          expenses: [],
          payroll: [],
          postings: [],
          returns: [],
          remittances: [],
        })
      : {
          invoiceGroups,
          payments: payments.data ?? [],
          expenses: expenses.data ?? [],
          payroll: payroll.data ?? [],
          postings: postings.data ?? [],
          returns: returns.data ?? [],
          remittances: remittances.data ?? [],
        };
    // One row per customer per day: their payments that day join their
    // invoice row (by the invoice paid, else by name), so the customer shows
    // once and the eye opens everything. Payments with no invoice that day
    // are still merged per customer per day.
    const day = (d: string) => d.slice(0, 10);
    const nameOf = (p: PaymentRow) =>
      (p.customers?.name ?? p.sales?.customer_name ?? "").trim().toLowerCase();
    const byNumber = new Map<string, InvoiceGroup>();
    const byName = new Map<string, InvoiceGroup>();
    for (const g of src.invoiceGroups) {
      for (const n of g.numbers) byNumber.set(n, g);
      if (!g.walkIn) byName.set(`${day(g.date)}|${g.customer.toLowerCase()}`, g);
    }
    const paidTo = new Map<string, PaymentRow[]>();
    const loose = new Map<string, PaymentRow[]>();
    for (const p of src.payments) {
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
      ...src.invoiceGroups.map((g) => {
        const ps = paidTo.get(g.key) ?? [];
        // A sale on a marketer's account (their van sale, or their customer's)
        // is the marketer's activity: it goes on the marketer's row (user,
        // 2026-11-02 -- STROI MINI MART is under Courage).
        const owner = (reps.data ?? []).find((r) => r.id === g.repId);
        const mkt = owner?.kind === "rep" ? owner : null;
        return {
          key: `inv-${g.key}`,
          date: g.date,
          at: g.at,
          kind: "Invoice" as const,
          reference: g.numbers.length > 1 ? `${g.numbers.length} invoices` : g.numbers[0],
          party_type: (owner?.kind === "outlet"
            ? "retail"
            : mkt
              ? "marketer"
              : "customer") as PartyType,
          repId: mkt?.id,
          party: mkt ? mkt.full_name : g.customer,
          details: mkt ? `${g.customer}: ${g.products}` : g.products,
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
        // A payment on a marketer's account goes on the marketer's row too.
        const owner = (reps.data ?? []).find((r) => r.id === p.account_rep_id);
        const mkt = owner?.kind === "rep" ? owner : null;
        return {
          key: `pay-${k}`,
          date: p.payment_date,
          at: ps.reduce<string | null>(
            (m, x) => (x.created_at && (!m || x.created_at > m) ? x.created_at : m),
            null,
          ),
          kind: "Payment" as const,
          party_type: (owner?.kind === "outlet"
            ? "retail"
            : mkt
              ? "marketer"
              : "customer") as PartyType,
          repId: mkt?.id,
          details: mkt && name ? `From ${name}` : undefined,
          reference: ps.length > 1 ? `${ps.length} receipts` : p.receipt_number,
          party: mkt ? mkt.full_name : (name ?? "—"),
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
      ...src.expenses.map((e) => ({
        key: `exp-${e.id}`,
        date: e.expense_date,
        kind: "Expense" as const,
        party_type: "internal" as PartyType,
        reference: e.expense_categories?.name ?? "Expense",
        party: e.description ?? "—",
        amount: Number(e.amount),
        direction: "out" as const,
        status: e.status ?? e.approval_status ?? "—",
      })),
      ...src.payroll.map((p) => ({
        key: `pr-${p.id}`,
        date: p.submitted_at,
        kind: "Payroll" as const,
        party_type: "internal" as PartyType,
        reference: `${String(p.period_month).padStart(2, "0")}/${p.period_year}`,
        party: p.employees?.full_name ?? "—",
        amount: Number(p.net_salary),
        direction: "out" as const,
        status: p.status,
      })),
      ...src.postings.map((p) => ({
        key: `post-${p.posting_id}`,
        date: p.at,
        kind: "Posting" as const,
        party_type: (p.kind === "retail" ? "retail" : "marketer") as PartyType,
        // One row per marketer / the shop; its name opens every posting.
        repId: p.party_id,
        reference: p.reference,
        party: p.party,
        details: p.items ?? undefined,
        amount: Number(p.value),
        direction: "in" as const,
        status: p.status,
      })),
      ...src.returns.map((r) => ({
        key: `ret-${r.id}`,
        date: r.received_at ?? r.return_date,
        kind: "Return" as const,
        party_type: (r.sales_reps?.kind === "outlet" ? "retail" : "marketer") as PartyType,
        repId: r.sales_rep_id,
        reference: r.return_number,
        party: r.sales_reps?.full_name ?? "—",
        details: r.items || undefined,
        // Goods back: credited to their account.
        amount: r.rep_return_items.reduce(
          (t, i) => t + Number(i.quantity_returned) * Number(i.unit_price),
          0,
        ),
        direction: "out" as const,
        status: r.status,
      })),
      ...src.remittances.map((m) => ({
        key: `rem-${m.id}`,
        date: m.created_at ?? m.remittance_date,
        kind: "Cash remitted" as const,
        party_type: (m.sales_reps?.kind === "outlet" ? "retail" : "marketer") as PartyType,
        repId: m.sales_rep_id,
        reference: m.remittance_number,
        party: m.sales_reps?.full_name ?? "—",
        details: m.payment_method ? `Paid by ${m.payment_method.replace(/_/g, " ")}` : undefined,
        amount: Number(m.amount),
        direction: "in" as const,
        status: "received",
      })),
    ];
    // Newest first by the actual time (2026-11-03), not the text of the date.
    const time = (a: Activity) => new Date(a.at ?? a.date).getTime() || 0;
    return rows.sort((a, b) => time(b) - time(a));
  }, [
    actRange,
    datedActivity.data,
    invoiceGroups,
    payments.data,
    expenses.data,
    payroll.data,
    postings.data,
    returns.data,
    remittances.data,
    reps.data,
  ]);

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
            <TabsTrigger value="retail-daily">Retail daily</TabsTrigger>
            <TabsTrigger value="dispensers">Dispenser sales</TabsTrigger>
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
            <TabsTrigger value="payments">Payments received</TabsTrigger>
            {canRepAccounts && (
              <TabsTrigger value="accounts">Marketer &amp; retail accounts</TabsTrigger>
            )}
            {canRepAccounts && <TabsTrigger value="reps">Reps &amp; outlets</TabsTrigger>}
            {canRepAccounts && perms.canSeeMoney && (
              <TabsTrigger value="remittances">Cash remitted</TabsTrigger>
            )}
            <TabsTrigger value="distributors">Distributor/Office Delivery</TabsTrigger>
            {can("customers") && <TabsTrigger value="customers">Customers</TabsTrigger>}
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
            <CardHeader className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>All transactions</CardTitle>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="date"
                    className="w-40"
                    title="From"
                    value={actFrom}
                    max={startOfToday()}
                    onChange={(e) => setActFrom(e.target.value)}
                  />
                  <span className="text-sm text-muted-foreground">to</span>
                  <Input
                    type="date"
                    className="w-40"
                    title="To (leave empty for one day)"
                    value={actTo}
                    min={actFrom || undefined}
                    max={startOfToday()}
                    onChange={(e) => setActTo(e.target.value)}
                  />
                  {actFrom ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setActFrom("");
                        setActTo("");
                      }}
                    >
                      Latest
                    </Button>
                  ) : null}
                </div>
              </div>
              {actRange && (
                <p className="text-xs text-muted-foreground">
                  {datedActivity.isLoading
                    ? "Loading everything on these dates…"
                    : datedActivity.isError
                      ? `Couldn't load these dates: ${(datedActivity.error as Error).message}`
                      : actRange.from === actRange.to
                        ? `Everything on ${new Date(`${actRange.from}T00:00:00`).toLocaleDateString()}.`
                        : `Everything from ${new Date(`${actRange.from}T00:00:00`).toLocaleDateString()} to ${new Date(`${actRange.to}T00:00:00`).toLocaleDateString()}.`}
                </p>
              )}
              <div className="flex flex-wrap gap-1">
                {PARTY_FILTERS.map((p) => (
                  <Button
                    key={p.key}
                    size="sm"
                    variant={party === p.key ? "default" : "outline"}
                    onClick={() => setParty(p.key)}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Click a name to open their account: what was posted to them, what they owe, and
                payments, remittances and everything else on it.
              </p>
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
                  {groupByParty(
                    activity
                      // The Retail Shop's activity is on Retail › All activity (2026-11-02),
                      // except the Warehouse's postings to it, kept here so their
                      // invoices can be printed (2026-11-03).
                      .filter((a) => a.party_type !== "retail" || a.kind === "Posting")
                      .filter((a) => party === "all" || a.party_type === party)
                      .filter((a) => match(a.reference, a.party, a.kind, a.details)),
                  )
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
                          {a.repId || a.viewGroup || a.group ? (
                            <button
                              type="button"
                              className="text-left font-medium text-primary hover:underline"
                              onClick={() =>
                                a.repId
                                  ? setRepViewing(a.repId)
                                  : setViewing((a.viewGroup ?? a.group)!)
                              }
                            >
                              {a.party}
                            </button>
                          ) : (
                            <div>{a.party}</div>
                          )}
                          {(a.count ?? 1) > 1 && (
                            <div className="text-xs font-medium text-muted-foreground">
                              Latest of {a.count} activities — click to see them all
                            </div>
                          )}
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
                            {a.repId && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title={`Open ${a.party}'s account`}
                                onClick={() => setRepViewing(a.repId!)}
                              >
                                <Eye className="h-4 w-4" />
                              </Button>
                            )}
                            {/* The posting on the A4 invoice, as a distributor's sale. */}
                            {/* Always the newest posting's, and as often as needed. */}
                            {a.lastPostingId && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title="Print invoice (latest posting)"
                                  onClick={() =>
                                    printDispatchInvoice(
                                      { id: a.lastPostingId! },
                                      settings.data,
                                      "print",
                                    )
                                  }
                                >
                                  <Printer className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title="Download invoice (latest posting)"
                                  onClick={() =>
                                    printDispatchInvoice(
                                      { id: a.lastPostingId! },
                                      settings.data,
                                      "download",
                                    )
                                  }
                                >
                                  <Download className="h-4 w-4" />
                                </Button>
                              </>
                            )}
                            {a.group && (
                              <>
                                {/* A marketer's row opens the marketer's account (above). */}
                                {!a.repId && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    title="View all of this customer's activity"
                                    onClick={() => setViewing((a.viewGroup ?? a.group)!)}
                                  >
                                    <Eye className="h-4 w-4" />
                                  </Button>
                                )}
                              </>
                            )}
                            {/* The newest invoice's, whatever came after it. */}
                            {a.lastInvoice && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title={
                                    a.lastInvoice.ids.length > 1
                                      ? "Print combined invoice"
                                      : "Print invoice"
                                  }
                                  onClick={() =>
                                    printSaleInvoice(a.lastInvoice!.ids, settings.data, "print")
                                  }
                                >
                                  <Printer className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title={
                                    a.lastInvoice.ids.length > 1
                                      ? "Download combined invoice"
                                      : "Download invoice"
                                  }
                                  onClick={() =>
                                    printSaleInvoice(a.lastInvoice!.ids, settings.data, "download")
                                  }
                                >
                                  <Download className="h-4 w-4" />
                                </Button>
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

        {/* Moved from the Distribution page (2026-11-02). */}
        {canRepAccounts && (
          <TabsContent value="reps">
            <RepsTab factoryId={factoryId} reps={reps.data ?? []} perms={perms} />
          </TabsContent>
        )}
        {canRepAccounts && perms.canSeeMoney && (
          <TabsContent value="remittances">
            <RemittancesTab
              factoryId={factoryId}
              reps={(reps.data ?? []).filter((r) => r.status === "active")}
              perms={perms}
            />
          </TabsContent>
        )}

        {/* The shop in one place (2026-11-03): its cash-up, then day by day what was
            posted, sent back and sold, with invoices. */}
        <TabsContent value="retail-daily" className="space-y-4">
          <RetailCashUpTab factoryId={factoryId} currency={currency} />
          <RetailDailyBook factoryId={factoryId} currency={currency} />
        </TabsContent>

        <TabsContent value="dispensers">
          <DispenserReports factoryId={factoryId} currency={currency} />
        </TabsContent>

        <TabsContent value="distributors">
          <DistributorsTab factoryId={factoryId} currency={currency} />
        </TabsContent>

        {/* Moved from the Warehouse (2026-11-02). */}
        {can("customers") && (
          <TabsContent value="customers">
            <CustomersPage />
          </TabsContent>
        )}

        <TabsContent value="invoices">
          <Card className="rounded-2xl">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle>Invoices</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">Invoices dated</span>
                <Input
                  type="date"
                  className="w-40"
                  title="From"
                  value={invFrom}
                  max={startOfToday()}
                  onChange={(e) => setInvFrom(e.target.value)}
                />
                <span className="text-sm text-muted-foreground">to</span>
                <Input
                  type="date"
                  className="w-40"
                  title="To (leave empty for one day)"
                  value={invTo}
                  min={invFrom || undefined}
                  max={startOfToday()}
                  onChange={(e) => setInvTo(e.target.value)}
                />
                {invFrom && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setInvFrom("");
                      setInvTo("");
                    }}
                  >
                    Latest
                  </Button>
                )}
              </div>
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
                  {invoiceRows
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
                  {invoiceRows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-sm text-muted-foreground">
                        {invRange
                          ? datedSales.isLoading
                            ? "Loading…"
                            : "No invoices on these dates."
                          : "No invoices yet."}
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

      {repViewing && (reps.data ?? []).some((r) => r.id === repViewing) && (
        <Dialog open onOpenChange={(v) => !v && setRepViewing(null)}>
          <RepDetailsDialog
            factoryId={factoryId}
            rep={(reps.data ?? []).find((r) => r.id === repViewing)!}
          />
        </Dialog>
      )}
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
          initialRange={viewing.allHistory ? "all" : "day"}
        />
      )}
    </div>
  );
}
