import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { fetchAll } from "@/lib/metrics";
import { TXN_LABEL, type LedgerTxnType } from "@/lib/customer-account";
import type { ReportColumn } from "@/lib/export";

// Customer-account reports for the Reports page. Every figure comes from the
// account ledger (customer_account_transactions) and the summary view built on
// it — the same source the Sales screens, statements and Finance list use — so
// a report can never disagree with what a customer's account shows.

export type CustomerReportKey =
  | "customer_balances"
  | "customer_credit"
  | "customer_debt"
  | "advance_payments"
  | "advance_consumption"
  | "customer_ledger"
  | "customer_adjustments";

export const CUSTOMER_REPORTS: { key: CustomerReportKey; label: string }[] = [
  { key: "customer_balances", label: "Customer Accounts — Advance & Debt Balances" },
  { key: "customer_credit", label: "Customer Accounts — Customers With Advance" },
  { key: "customer_debt", label: "Customer Accounts — Customers With Debt" },
  { key: "advance_payments", label: "Customer Accounts — Advance Payments Received" },
  { key: "advance_consumption", label: "Customer Accounts — Advance Used Against Sales" },
  { key: "customer_ledger", label: "Customer Accounts — Transaction History" },
  { key: "customer_adjustments", label: "Customer Accounts — Adjustments" },
];

// Balances are a position "as of now", so a date range doesn't apply to them.
export const CUSTOMER_SNAPSHOT_REPORTS: CustomerReportKey[] = [
  "customer_balances",
  "customer_credit",
  "customer_debt",
];

export const isCustomerReport = (key: string): key is CustomerReportKey =>
  CUSTOMER_REPORTS.some((r) => r.key === key);

type Result = { columns: ReportColumn[]; rows: Record<string, unknown>[] };

const num = (v: unknown) => Number(v ?? 0);
const money2 = (v: number) => Math.round(v * 100) / 100;
const day = (iso: string | null | undefined) => (iso ? format(new Date(iso), "yyyy-MM-dd") : "");
const total = (label: string, key: string, rows: Record<string, unknown>[], sumKey: string) => ({
  [key]: label,
  [sumKey]: money2(rows.reduce((s, r) => s + num(r[sumKey]), 0)),
});

async function ledgerRows(
  db: any,
  factoryId: string,
  start: string | null,
  end: string | null,
  types?: string[],
): Promise<any[]> {
  return fetchAll<any>((a, b) => {
    let q: any = db
      .from("customer_account_transactions")
      .select("*, customers(name)")
      .eq("factory_id", factoryId)
      .order("seq", { ascending: true })
      .range(a, b);
    if (types) q = q.in("txn_type", types);
    if (start) q = q.gte("created_at", start);
    if (end) q = q.lte("created_at", end);
    return q;
  });
}

export async function fetchCustomerReport(
  key: CustomerReportKey,
  factoryId: string,
  start: string | null,
  end: string | null,
  // Injectable so the report logic can be tested without a live database.
  db: any = supabase,
): Promise<Result> {
  switch (key) {
    case "customer_balances":
    case "customer_credit":
    case "customer_debt": {
      const data = await fetchAll<any>(
        (a, b) =>
          db
            .from("customer_account_summary")
            .select("*")
            .eq("factory_id", factoryId)
            .order("customer_name")
            .range(a, b) as any,
      );
      let rows = data.map((r) => ({
        customer: r.customer_name,
        available_advance: num(r.available_advance),
        outstanding_debt: num(r.outstanding_debt),
        status: r.account_status,
        total_advance_paid: num(r.total_advance_paid),
        advance_used: num(r.advance_used),
        goods_collected: num(r.goods_collected),
        total_payments: num(r.total_payments),
        last_advance: day(r.last_advance_at),
        last_activity: day(r.last_transaction_at),
      }));
      if (key === "customer_credit") {
        rows = rows
          .filter((r) => r.available_advance > 0)
          .sort((a, b) => b.available_advance - a.available_advance);
      } else if (key === "customer_debt") {
        rows = rows
          .filter((r) => r.outstanding_debt > 0)
          .sort((a, b) => b.outstanding_debt - a.outstanding_debt);
      }
      const totalRow = {
        customer: "TOTAL",
        available_advance: money2(rows.reduce((s, r) => s + r.available_advance, 0)),
        outstanding_debt: money2(rows.reduce((s, r) => s + r.outstanding_debt, 0)),
        total_advance_paid: money2(rows.reduce((s, r) => s + r.total_advance_paid, 0)),
        advance_used: money2(rows.reduce((s, r) => s + r.advance_used, 0)),
        goods_collected: money2(rows.reduce((s, r) => s + r.goods_collected, 0)),
        total_payments: money2(rows.reduce((s, r) => s + r.total_payments, 0)),
      };
      return {
        columns: [
          { key: "customer", label: "Customer" },
          { key: "available_advance", label: "Available Advance" },
          { key: "outstanding_debt", label: "Outstanding Debt" },
          { key: "status", label: "Status" },
          { key: "total_advance_paid", label: "Total Advance Paid" },
          { key: "advance_used", label: "Advance Used" },
          { key: "goods_collected", label: "Goods Collected" },
          { key: "total_payments", label: "Total Payments" },
          { key: "last_advance", label: "Last Advance" },
          { key: "last_activity", label: "Last Activity" },
        ],
        rows: rows.length ? [...rows, totalRow] : rows,
      };
    }

    case "advance_payments": {
      const data = await ledgerRows(db, factoryId, start, end, [
        "ADVANCE_PAYMENT",
        "CUSTOMER_PAYMENT",
        "REVERSAL",
      ]);
      const rows = data
        .filter(
          (r) =>
            r.txn_type !== "REVERSAL" ||
            (r.reference_type === "payment_reversal" && num(r.credit_delta) < 0),
        )
        .map((r) => ({
          date: day(r.created_at),
          customer: r.customers?.name ?? "—",
          type: r.txn_type === "REVERSAL" ? "Reversal" : TXN_LABEL[r.txn_type as LedgerTxnType],
          receipt: r.payment_id ? (r.txn_type === "REVERSAL" ? "" : (r.notes ?? "")) : "",
          method: r.payment_method ?? "",
          amount: num(r.credit_delta),
          advance_balance: num(r.credit_after),
          note: r.description ?? "",
        }));
      return {
        columns: [
          { key: "date", label: "Date" },
          { key: "customer", label: "Customer" },
          { key: "type", label: "Type" },
          { key: "receipt", label: "Receipt" },
          { key: "method", label: "Method" },
          { key: "amount", label: "Advance Added" },
          { key: "advance_balance", label: "Advance Balance After" },
          { key: "note", label: "Note" },
        ],
        rows: rows.length ? [...rows, total("TOTAL", "customer", rows, "amount")] : rows,
      };
    }

    case "advance_consumption": {
      const data = await ledgerRows(db, factoryId, start, end, [
        "ADVANCE_APPLIED",
        "ADVANCE_RESTORED",
      ]);
      const rows = data.map((r) => ({
        date: day(r.created_at),
        customer: r.customers?.name ?? "—",
        type: TXN_LABEL[r.txn_type as LedgerTxnType],
        invoice: (r.description ?? "").match(/(?:applied to|reversed sale) (.+)$/)?.[1] ?? "",
        // Applied is positive use; a restore after a reversal is negative use.
        advance_used: money2(-num(r.credit_delta)),
        advance_balance: num(r.credit_after),
      }));
      return {
        columns: [
          { key: "date", label: "Date" },
          { key: "customer", label: "Customer" },
          { key: "type", label: "Type" },
          { key: "invoice", label: "Invoice" },
          { key: "advance_used", label: "Advance Used" },
          { key: "advance_balance", label: "Advance Balance After" },
        ],
        rows: rows.length ? [...rows, total("NET USED", "customer", rows, "advance_used")] : rows,
      };
    }

    case "customer_ledger": {
      const data = await ledgerRows(db, factoryId, start, end);
      const rows = data.map((r) => ({
        date: day(r.created_at),
        customer: r.customers?.name ?? "—",
        type: TXN_LABEL[r.txn_type as LedgerTxnType],
        description: r.description ?? "",
        amount: num(r.amount),
        advance_change: num(r.credit_delta),
        debt_change: num(r.debt_delta),
        advance_balance: num(r.credit_after),
        debt_balance: num(r.debt_after),
      }));
      return {
        columns: [
          { key: "date", label: "Date" },
          { key: "customer", label: "Customer" },
          { key: "type", label: "Type" },
          { key: "description", label: "Description" },
          { key: "amount", label: "Amount" },
          { key: "advance_change", label: "Advance Change" },
          { key: "debt_change", label: "Debt Change" },
          { key: "advance_balance", label: "Advance Balance" },
          { key: "debt_balance", label: "Debt Balance" },
        ],
        rows,
      };
    }

    case "customer_adjustments": {
      const [adjustments, profilesRes] = await Promise.all([
        fetchAll<any>((a, b) => {
          let q: any = db
            .from("customer_account_adjustments")
            .select("*, customers(name)")
            .eq("factory_id", factoryId)
            .order("submitted_at", { ascending: false })
            .range(a, b);
          if (start) q = q.gte("submitted_at", start);
          if (end) q = q.lte("submitted_at", end);
          return q;
        }),
        db.from("profiles").select("id,full_name"),
      ]);
      const names: Record<string, string> = {};
      (profilesRes.data ?? []).forEach((p: any) => (names[p.id] = p.full_name ?? "—"));
      const label: Record<string, string> = {
        credit_up: "Add to advance",
        credit_down: "Reduce advance",
        debt_up: "Add to debt",
        debt_down: "Reduce debt",
        refund: "Refund advance",
      };
      return {
        columns: [
          { key: "date", label: "Submitted" },
          { key: "customer", label: "Customer" },
          { key: "adjustment", label: "Adjustment" },
          { key: "amount", label: "Amount" },
          { key: "reason", label: "Reason" },
          { key: "submitted_by", label: "Submitted By" },
          { key: "status", label: "Status" },
          { key: "reviewed_by", label: "Reviewed By" },
          { key: "reviewed_on", label: "Reviewed" },
          { key: "decision_note", label: "Decision Note" },
        ],
        rows: adjustments.map((r) => ({
          date: day(r.submitted_at),
          customer: r.customers?.name ?? "—",
          adjustment: label[r.effect] ?? r.effect,
          amount: num(r.amount),
          reason: r.reason,
          submitted_by: names[r.submitted_by] ?? "—",
          status: String(r.status).replace(/_/g, " "),
          reviewed_by: r.reviewed_by ? (names[r.reviewed_by] ?? "—") : "",
          reviewed_on: day(r.reviewed_at),
          decision_note: r.review_note ?? "",
        })),
      };
    }
  }
}
