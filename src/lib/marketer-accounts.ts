import { useQuery } from "@tanstack/react-query";
import {
  endOfMonth,
  endOfWeek,
  format,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths,
  subWeeks,
} from "date-fns";
import { supabase } from "@/integrations/supabase/client";

// Marketer profile / customer account data. Every figure comes from the RPCs
// in supabase/migrations/20261017150000_marketer_customer_accountability.sql,
// which read the actual sales, payments, debts, stock movements and
// remittances (and enforce who may see them). Those functions were added
// after the generated Supabase types, so they're called through an untyped
// client with the shapes declared here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tables/RPCs newer than the generated types
const db = supabase as any;

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

const n = (v: unknown) => Number(v ?? 0);

// ---------------------------------------------------------------- periods ---

export type PeriodKey =
  | "today"
  | "yesterday"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month"
  | "custom"
  | "all";

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this_week", label: "Current week" },
  { key: "last_week", label: "Previous week" },
  { key: "this_month", label: "Current month" },
  { key: "last_month", label: "Previous month" },
  { key: "custom", label: "Custom range" },
  { key: "all", label: "All recorded history" },
];

const ymd = (d: Date) => format(d, "yyyy-MM-dd");
export const todayYmd = () => ymd(new Date());

// Weeks start on Monday. "all" has no start date; it runs to today.
export function periodRange(
  key: PeriodKey,
  custom?: { from: string; to: string },
): { from: string | null; to: string | null } {
  const now = new Date();
  switch (key) {
    case "today":
      return { from: ymd(now), to: ymd(now) };
    case "yesterday": {
      const y = subDays(now, 1);
      return { from: ymd(y), to: ymd(y) };
    }
    case "this_week":
      return { from: ymd(startOfWeek(now, { weekStartsOn: 1 })), to: ymd(now) };
    case "last_week": {
      const w = subWeeks(now, 1);
      return {
        from: ymd(startOfWeek(w, { weekStartsOn: 1 })),
        to: ymd(endOfWeek(w, { weekStartsOn: 1 })),
      };
    }
    case "this_month":
      return { from: ymd(startOfMonth(now)), to: ymd(now) };
    case "last_month": {
      const m = subMonths(now, 1);
      return { from: ymd(startOfMonth(m)), to: ymd(endOfMonth(m)) };
    }
    case "custom":
      return { from: custom?.from || null, to: custom?.to || null };
    case "all":
      return { from: null, to: null };
  }
}

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString("en-GB") : "—";

export function periodLabel(range: { from: string | null; to: string | null }) {
  if (!range.from && !range.to) return "All recorded history";
  if (!range.from) return `Up to ${fmtDate(range.to)}`;
  if (range.from === range.to) return fmtDate(range.from);
  return `${fmtDate(range.from)} to ${fmtDate(range.to ?? todayYmd())}`;
}

// ------------------------------------------------------------------ types ---

export type MarketerRow = {
  id: string;
  code: string | null;
  full_name: string;
  phone: string | null;
  territory: string | null;
  status: string;
  kind: "rep" | "outlet";
  created_at: string;
  customers: number;
  sales_value: number;
  collected: number;
  outstanding: number;
  remitted: number;
  unremitted: number;
  stock_units: number;
  last_sale: string | null;
};

export type ProductFigures = {
  product_id: string;
  name: string;
  unit: string;
  opening: number;
  issued: number;
  available: number;
  sold: number;
  returned: number;
  damaged: number;
  corrections: number;
  closing: number;
  issued_value: number;
  returned_value: number;
  qty_invoiced: number;
  value_invoiced: number;
  qty_van: number;
  value_van: number;
};

export type Figures = {
  from: string | null;
  to: string | null;
  products: ProductFigures[];
  stock: {
    opening: number;
    issued: number;
    available: number;
    sold: number;
    returned: number;
    damaged: number;
    corrections: number;
    closing: number;
    issued_value: number;
    returned_value: number;
  };
  sales: {
    count: number;
    customers: number;
    value: number;
    van_value: number;
    direct_value: number;
    paid_at_sale: number;
    advance_applied: number;
    credit_sales: number;
    credit_invoices: number;
  };
  collections: {
    total: number;
    count: number;
    cash: number;
    other: number;
    at_sale: number;
    on_debts: number;
    held_by_marketer: number;
    brought_in_by_marketer: number;
    received_by_factory: number;
    pending_verification: number;
    pending_count: number;
    by_method: Record<string, number>;
  };
  remittances: { total: number; count: number; cash: number; other: number };
  held_cumulative: number;
  remitted_cumulative: number;
  unremitted: number;
  debt: {
    outstanding: number;
    open_debts: number;
    customers_owing: number;
    overdue: number;
    written_off: number;
    from_period: number;
  };
};

export type MarketerStatement = {
  marketer: {
    id: string;
    code: string | null;
    name: string;
    phone: string | null;
    territory: string | null;
    status: string;
    kind: string;
    registered: string;
  };
  period: Figures;
  cumulative: Figures;
  debtors: { customer: string; phone: string | null; invoices: number; outstanding: number }[];
  reconciliation: {
    pending_payments: { receipt: string; date: string; amount: number }[];
    pending_sales: { invoice: string; date: string; amount: number }[];
    overdue_debts: { invoice: string | null; customer: string; due: string; outstanding: number }[];
    stock_drift: { product: string; trail: number; on_record: number }[];
  };
  first_activity: string | null;
  generated_at: string;
};

export type CustomerReportRow = {
  customer_id: string | null;
  name: string;
  phone: string | null;
  address: string | null;
  status: "active" | "dormant";
  registered: boolean;
  assigned: boolean;
  registered_at: string | null;
  invoices: number;
  total_purchases: number;
  total_paid: number;
  written_off: number;
  outstanding: number;
  unpaid_invoices: number;
  overdue: number;
  last_purchase: string | null;
  account_debt: number;
  advance: number;
  open_followups: number;
  credit_limit: number | null;
};

export type InvoiceItem = {
  product: string;
  unit: string;
  quantity: number;
  unit_price: number;
  line_total: number;
};

export type MarketerInvoice = {
  sale_id: string;
  invoice_number: string;
  sale_date: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  grand_total: number;
  paid_at_sale: number;
  paid_later: number;
  advance_applied: number;
  written_off: number;
  outstanding: number;
  payment_method: string;
  van_sale: boolean;
  due_date: string | null;
  status: "paid" | "part_paid" | "unpaid" | "overdue" | "written_off";
  items: InvoiceItem[];
};

export type Allocation = { invoice: string | null; amount: number };

export type MarketerPayment = {
  payment_id: string;
  receipt_number: string;
  payment_date: string;
  customer_id: string | null;
  customer_name: string;
  amount: number;
  payment_method: string;
  at_point_of_sale: boolean;
  collected_by_marketer: boolean;
  held_by_marketer: boolean;
  review_status: string;
  status: string;
  remarks: string | null;
  allocations: Allocation[];
};

export type Remittance = {
  id: string;
  remittance_number: string;
  remittance_date: string;
  amount: number;
  payment_method: string;
  remarks: string | null;
  created_at: string;
};

export type DayRow = {
  day: string;
  opening_qty: number;
  issued_qty: number;
  available_qty: number;
  sold_qty: number;
  returned_qty: number;
  damaged_qty: number;
  corrections_qty: number;
  closing_qty: number;
  sales_count: number | null;
  sales_value: number | null;
  cash_collected: number | null;
  other_collected: number | null;
  credit_sales: number | null;
  debt_collections: number | null;
  held_by_marketer: number | null;
  remitted: number | null;
  unremitted: number | null;
  debt_outstanding: number | null;
  pending_verification: number | null;
  closed: boolean;
  variances: string[];
};

export type MonthRow = {
  month: string;
  sales_count: number;
  units: number;
  sales_value: number;
  credit_sales: number;
  collected: number;
  cash: number;
  other: number;
  remitted: number;
};

export type DayClose = {
  id: string;
  close_date: string;
  notes: string | null;
  closed_at: string;
  figures: Record<string, unknown>;
};

export type StatementLine = {
  seq: number;
  date: string;
  type: string;
  reference: string | null;
  invoice: string | null;
  invoice_date: string | null;
  receipt: string | null;
  payment_date: string | null;
  description: string | null;
  notes: string | null;
  goods: number;
  paid: number;
  advance_used: number;
  debt_delta: number;
  credit_delta: number;
  debt_after: number;
  credit_after: number;
  method: string | null;
  items: InvoiceItem[] | null;
};

export type StatementInvoice = {
  sale_id: string;
  invoice_number: string;
  sale_date: string;
  in_period: boolean;
  marketer: string | null;
  van_sale: boolean;
  grand_total: number;
  advance_applied: number;
  written_off: number;
  outstanding: number;
  paid: number;
  due_date: string | null;
  paid_at: string | null;
  items: InvoiceItem[];
  payments: {
    receipt: string | null;
    date: string;
    method: string | null;
    amount: number;
    kind: "at sale" | "allocated" | "advance";
  }[];
};

export type StatementPayment = {
  payment_id: string;
  receipt: string;
  date: string;
  amount: number;
  method: string;
  status: string;
  review_status: string;
  remarks: string | null;
  at_point_of_sale: boolean;
  collected_by: string | null;
  allocations: Allocation[];
};

export type CustomerStatement = {
  customer: {
    id: string;
    name: string;
    phone: string | null;
    address: string | null;
    email: string | null;
    status: "active" | "dormant";
    notes: string | null;
    registered: boolean;
    registered_at: string;
    credit_limit: number | null;
    credit_days: number | null;
    outstanding_balance: number;
    advance: number;
  };
  marketer: { id: string; name: string; code: string | null } | null;
  from: string | null;
  to: string | null;
  opening: { debt: number; advance: number };
  closing: { debt: number; advance: number };
  lines: StatementLine[];
  invoices: StatementInvoice[];
  payments: StatementPayment[];
  returns: {
    return_number: string;
    date: string;
    product: string;
    unit: string;
    quantity: number;
    accepted: number | null;
    status: string;
    reason: string | null;
    invoice: string | null;
  }[];
  marketer_history: {
    from: string | null;
    to: string | null;
    reason: string | null;
    changed_at: string;
  }[];
  first_purchase: string | null;
  generated_at: string;
};

export type Followup = {
  id: string;
  note: string;
  follow_up_date: string | null;
  status: "open" | "done" | "note";
  created_at: string;
  done_at: string | null;
  done_note: string | null;
};

// ---------------------------------------------------------------- numbers ---
// Postgres numerics arrive as strings; normalise once here.

function numFigures(f: Figures): Figures {
  const obj = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "object" ? v : n(v)]));
  return {
    ...f,
    products: (f.products ?? []).map(
      (p) =>
        ({ ...obj(p), name: p.name, unit: p.unit, product_id: p.product_id }) as ProductFigures,
    ),
    stock: obj(f.stock) as Figures["stock"],
    sales: obj(f.sales) as Figures["sales"],
    collections: {
      ...(obj(f.collections) as Figures["collections"]),
      by_method: Object.fromEntries(
        Object.entries(f.collections?.by_method ?? {}).map(([k, v]) => [k, n(v)]),
      ),
    },
    remittances: obj(f.remittances) as Figures["remittances"],
    held_cumulative: n(f.held_cumulative),
    remitted_cumulative: n(f.remitted_cumulative),
    unremitted: n(f.unremitted),
    debt: obj(f.debt) as Figures["debt"],
  };
}

const numRow = <T extends Record<string, unknown>>(r: T, keep: string[] = []): T =>
  Object.fromEntries(
    Object.entries(r).map(([k, v]) => [
      k,
      keep.includes(k) || v === null || typeof v !== "string" || !/^-?\d+(\.\d+)?$/.test(v)
        ? v
        : Number(v),
    ]),
  ) as T;

// Fields that look numeric but must stay text.
const TEXT_KEYS = [
  "phone",
  "customer_phone",
  "code",
  "invoice_number",
  "receipt_number",
  "receipt",
];

// ------------------------------------------------------------------ hooks ---

export function useMarketerDirectory(factoryId: string | undefined) {
  return useQuery({
    queryKey: ["mkt-directory", factoryId],
    enabled: !!factoryId,
    queryFn: async () =>
      (await rpc<MarketerRow[]>("marketer_directory", { p_factory: factoryId })).map((r) =>
        numRow(r, TEXT_KEYS),
      ),
  });
}

export function useMarketerStatement(
  repId: string,
  from: string | null,
  to: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ["mkt-statement", repId, from, to],
    enabled,
    queryFn: async () => {
      const s = await rpc<MarketerStatement>("marketer_statement", {
        p_rep: repId,
        p_from: from,
        p_to: to,
      });
      return {
        ...s,
        period: numFigures(s.period),
        cumulative: numFigures(s.cumulative),
        debtors: s.debtors.map((d) => ({
          ...d,
          invoices: n(d.invoices),
          outstanding: n(d.outstanding),
        })),
      };
    },
  });
}

export function useMarketerCustomers(repId: string) {
  return useQuery({
    queryKey: ["mkt-customers", repId],
    queryFn: async () =>
      (await rpc<CustomerReportRow[]>("marketer_customer_report", { p_rep: repId })).map((r) =>
        numRow(r, TEXT_KEYS),
      ),
  });
}

export function useMarketerInvoices(
  repId: string,
  from: string | null,
  to: string | null,
  owingOnly = false,
) {
  return useQuery({
    queryKey: ["mkt-invoices", repId, from, to, owingOnly],
    queryFn: async () =>
      (
        await rpc<MarketerInvoice[]>("marketer_invoices", {
          p_rep: repId,
          p_from: from,
          p_to: to,
          p_owing_only: owingOnly,
        })
      ).map((r) => ({
        ...numRow(r, TEXT_KEYS),
        items: (r.items ?? []).map((i) => numRow(i)),
      })),
  });
}

export function useMarketerPayments(repId: string, from: string | null, to: string | null) {
  return useQuery({
    queryKey: ["mkt-payments", repId, from, to],
    queryFn: async () =>
      (
        await rpc<MarketerPayment[]>("marketer_payments", { p_rep: repId, p_from: from, p_to: to })
      ).map((r) => ({
        ...numRow(r, TEXT_KEYS),
        allocations: (r.allocations ?? []).map((a) => ({ ...a, amount: n(a.amount) })),
      })),
  });
}

export function useMarketerRemittances(repId: string, from: string | null, to: string | null) {
  return useQuery({
    queryKey: ["mkt-remittances", repId, from, to],
    queryFn: async () =>
      (
        await rpc<Remittance[]>("marketer_remittances", { p_rep: repId, p_from: from, p_to: to })
      ).map((r) => numRow(r, TEXT_KEYS)),
  });
}

export function useMarketerDays(repId: string, from: string, to: string) {
  return useQuery({
    queryKey: ["mkt-days", repId, from, to],
    enabled: !!from && !!to && from <= to,
    queryFn: async () =>
      (
        await rpc<DayRow[]>("marketer_daily_accountability", {
          p_rep: repId,
          p_from: from,
          p_to: to,
        })
      ).map((r) => ({ ...numRow(r), variances: r.variances ?? [] })),
  });
}

export function useMarketerStock(repId: string, from: string | null, to: string | null) {
  return useQuery({
    queryKey: ["mkt-stock", repId, from, to],
    queryFn: async () => {
      const r = await rpc<{ products: ProductFigures[]; stock: Figures["stock"] }>(
        "marketer_stock_accountability",
        { p_rep: repId, p_from: from, p_to: to },
      );
      return {
        products: (r.products ?? []).map((p) => numRow(p)),
        stock: numRow(r.stock),
      };
    },
  });
}

export function useMarketerMonths(repId: string, months = 12) {
  return useQuery({
    queryKey: ["mkt-months", repId, months],
    queryFn: async () =>
      (
        await rpc<MonthRow[]>("marketer_monthly_performance", { p_rep: repId, p_months: months })
      ).map((r) => numRow(r)),
  });
}

export function useDayCloses(repId: string) {
  return useQuery({
    queryKey: ["mkt-day-closes", repId],
    queryFn: async () => {
      const { data, error } = await db
        .from("marketer_day_closes")
        .select("id,close_date,notes,closed_at,figures")
        .eq("sales_rep_id", repId)
        .order("close_date", { ascending: false })
        .limit(60);
      if (error) throw error;
      return (data ?? []) as DayClose[];
    },
  });
}

export function useCustomerStatement(customerId: string, from: string | null, to: string | null) {
  return useQuery({
    queryKey: ["cust-statement", customerId, from, to],
    queryFn: async () => {
      const s = await rpc<CustomerStatement>("customer_statement", {
        p_customer: customerId,
        p_from: from,
        p_to: to,
      });
      return {
        ...s,
        customer: numRow(s.customer, TEXT_KEYS),
        opening: { debt: n(s.opening.debt), advance: n(s.opening.advance) },
        closing: { debt: n(s.closing.debt), advance: n(s.closing.advance) },
        lines: s.lines.map((l) => ({
          ...numRow(l, ["reference", "invoice", "receipt"]),
          items: l.items ? l.items.map((i) => numRow(i)) : null,
        })),
        invoices: s.invoices.map((i) => ({
          ...numRow(i, TEXT_KEYS),
          items: i.items.map((x) => numRow(x)),
          payments: i.payments.map((p) => ({ ...p, amount: n(p.amount) })),
        })),
        payments: s.payments.map((p) => ({
          ...numRow(p, TEXT_KEYS),
          allocations: (p.allocations ?? []).map((a) => ({ ...a, amount: n(a.amount) })),
        })),
        returns: s.returns.map((r) => numRow(r, ["return_number", "invoice"])),
      } as CustomerStatement;
    },
  });
}

export function useCustomerFollowups(customerId: string) {
  return useQuery({
    queryKey: ["cust-followups", customerId],
    queryFn: async () => {
      const { data, error } = await db
        .from("customer_followups")
        .select("id,note,follow_up_date,status,created_at,done_at,done_note")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Followup[];
    },
  });
}

export const marketerRpc = {
  registerCustomer: (payload: Record<string, unknown>) =>
    rpc<{ customer_id: string; adopted_walk_in: boolean }>("register_marketer_customer", {
      payload,
    }),
  updateCustomer: (customerId: string, payload: Record<string, unknown>) =>
    rpc("update_marketer_customer", { p_customer: customerId, payload }),
  reassign: (customerId: string, repId: string | null, reason: string) =>
    rpc("reassign_customer_marketer", { p_customer: customerId, p_rep: repId, p_reason: reason }),
  updateProfile: (repId: string, payload: Record<string, unknown>) =>
    rpc("update_marketer_profile", { p_rep: repId, payload }),
  addFollowup: (customerId: string, note: string, date: string | null) =>
    rpc("add_customer_followup", { p_customer: customerId, p_note: note, p_follow_up_date: date }),
  completeFollowup: (id: string, note: string | null) =>
    rpc("complete_customer_followup", { p_id: id, p_note: note }),
  removeMarketer: (repId: string, reason: string, mergeInto: string | null) =>
    rpc("remove_marketer", { p_rep: repId, p_reason: reason, p_merge_into: mergeInto }),
  closeDay: (repId: string, day: string, notes: string | null) =>
    rpc("close_marketer_day", { p_rep: repId, p_date: day, p_notes: notes }),
};

// Query keys a recorded payment / sale / remittance makes stale.
export const MARKETER_KEYS = [
  "mkt-directory",
  "mkt-statement",
  "mkt-customers",
  "mkt-invoices",
  "mkt-payments",
  "mkt-remittances",
  "mkt-days",
  "mkt-stock",
  "mkt-months",
  "mkt-day-closes",
  "cust-statement",
  "cust-followups",
];

export const INVOICE_STATUS: Record<
  MarketerInvoice["status"],
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  paid: { label: "Paid", variant: "secondary" },
  part_paid: { label: "Part paid", variant: "outline" },
  unpaid: { label: "Unpaid", variant: "destructive" },
  overdue: { label: "Overdue", variant: "destructive" },
  written_off: { label: "Written off", variant: "outline" },
};

export const itemsSummary = (items: InvoiceItem[]) =>
  items.map((i) => `${i.product} × ${Number(i.quantity).toLocaleString()}`).join(", ");

// How a ledger line reads on a statement. A sale charges its value and
// credits the cash paid with it; the advance drawn for it is its own line.
// Everything else moves the debt by debt_delta.
export const lineCharged = (l: StatementLine) =>
  l.type === "SALE" ? l.goods : Math.max(l.debt_delta, 0);
export const lineCredited = (l: StatementLine) =>
  l.type === "SALE"
    ? l.paid
    : l.type === "ADVANCE_APPLIED"
      ? l.advance_used
      : Math.max(-l.debt_delta, 0);
