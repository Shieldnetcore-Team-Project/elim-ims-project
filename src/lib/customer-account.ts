import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchAll } from "@/lib/metrics";
import { money } from "@/lib/format";

// Customer account = the append-only ledger (customer_account_transactions)
// plus the summary view built on it. These tables/views were added after the
// generated Supabase types, so they're read through an untyped client with
// the row shapes declared here.

export type LedgerTxnType =
  | "OPENING_BALANCE"
  | "ADVANCE_PAYMENT"
  | "SALE"
  | "ADVANCE_APPLIED"
  | "CUSTOMER_PAYMENT"
  | "DEBT_SETTLEMENT"
  | "REFUND"
  | "CREDIT_ADJUSTMENT"
  | "DEBIT_ADJUSTMENT"
  | "REVERSAL"
  | "ADVANCE_RESTORED";

export type LedgerTxn = {
  id: string;
  seq: number;
  txn_type: LedgerTxnType;
  reference_type: string | null;
  reference_id: string | null;
  sale_id: string | null;
  payment_id: string | null;
  debt_id: string | null;
  reverses_id: string | null;
  amount: number;
  goods_value: number;
  cash_paid: number;
  advance_used: number;
  credit_delta: number;
  debt_delta: number;
  credit_after: number;
  debt_after: number;
  payment_method: string | null;
  description: string | null;
  notes: string | null;
  created_at: string;
};

export type AccountSummary = {
  customer_id: string;
  available_advance: number;
  outstanding_debt: number;
  account_status: "CREDIT BALANCE" | "BALANCED" | "OUTSTANDING DEBT" | "CREDIT AND DEBT";
  total_advance_paid: number;
  advance_used: number;
  goods_collected: number;
  opening_credit: number;
  opening_debt: number;
  total_payments: number;
  last_advance_at: string | null;
  last_transaction_at: string | null;
};

export type PendingSale = {
  id: string;
  invoice_number: string;
  grand_total: number;
  amount_paid: number;
  created_at: string;
};

const EMPTY_SUMMARY: AccountSummary = {
  customer_id: "",
  available_advance: 0,
  outstanding_debt: 0,
  account_status: "BALANCED",
  total_advance_paid: 0,
  advance_used: 0,
  goods_collected: 0,
  opening_credit: 0,
  opening_debt: 0,
  total_payments: 0,
  last_advance_at: null,
  last_transaction_at: null,
};

const toNum = (v: unknown) => Number(v ?? 0);

// One fetch serves the New Sale panel, the sale-position calculation and the
// account history dialog (same query key => TanStack Query shares it).
export function useCustomerAccount(customerId: string | undefined) {
  const enabled = !!customerId && customerId !== "walkin";
  return useQuery({
    queryKey: ["customer-account", customerId],
    enabled,
    queryFn: async () => {
      const db = supabase as any;
      const [summaryRes, ledger, pendingRes] = await Promise.all([
        db.from("customer_account_summary").select("*").eq("customer_id", customerId).maybeSingle(),
        fetchAll<LedgerTxn>(
          (a, b) =>
            db
              .from("customer_account_transactions")
              .select("*")
              .eq("customer_id", customerId)
              .order("seq", { ascending: true })
              .range(a, b) as any,
        ),
        // Sales awaiting approval: real, but not on the account until a manager
        // posts them — shown separately so they never look like they vanished.
        db
          .from("sales")
          .select("id,invoice_number,grand_total,amount_paid,created_at")
          .eq("customer_id", customerId)
          .eq("status", "pending_approval")
          .is("deleted_at", null)
          .order("created_at", { ascending: true }),
      ]);
      if (summaryRes.error) throw summaryRes.error;
      if (pendingRes.error) throw pendingRes.error;
      const s = summaryRes.data;
      const summary: AccountSummary = s
        ? {
            ...EMPTY_SUMMARY,
            ...s,
            available_advance: toNum(s.available_advance),
            outstanding_debt: toNum(s.outstanding_debt),
            total_advance_paid: toNum(s.total_advance_paid),
            advance_used: toNum(s.advance_used),
            goods_collected: toNum(s.goods_collected),
            opening_credit: toNum(s.opening_credit),
            opening_debt: toNum(s.opening_debt),
            total_payments: toNum(s.total_payments),
          }
        : EMPTY_SUMMARY;
      const rows = ledger.map((r) => ({
        ...r,
        amount: toNum(r.amount),
        goods_value: toNum(r.goods_value),
        cash_paid: toNum(r.cash_paid),
        advance_used: toNum(r.advance_used),
        credit_delta: toNum(r.credit_delta),
        debt_delta: toNum(r.debt_delta),
        credit_after: toNum(r.credit_after),
        debt_after: toNum(r.debt_after),
      }));
      const pendingSales: PendingSale[] = ((pendingRes.data ?? []) as any[]).map((p) => ({
        ...p,
        grand_total: toNum(p.grand_total),
        amount_paid: toNum(p.amount_paid),
      }));
      return { summary, ledger: rows, pendingSales };
    },
  });
}

// ---------------------------------------------------------------------------
// The position of ONE sale against a customer's account — the same arithmetic
// approve_sale() finalises with server-side, so what the cashier sees while
// building the sale is what gets posted:
//   advance applied = MIN(what cash didn't cover, available advance)
//   amount due      = whatever is still uncovered  -> becomes debt
//   cash over the total is kept as advance
// An existing debt is never hidden or netted: it stays a separate figure.
// ---------------------------------------------------------------------------
export function salePosition(input: {
  grand: number;
  paid: number;
  availableAdvance: number;
  previousDebt: number;
}) {
  // Whole kobo only, so float residue can't turn "exactly used up" into 0.0000001.
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const grand = r2(Math.max(input.grand, 0));
  const paid = r2(Math.max(input.paid, 0));
  const availableAdvance = r2(Math.max(input.availableAdvance, 0));
  const previousDebt = r2(Math.max(input.previousDebt, 0));

  const dueBeforeAdvance = r2(Math.max(grand - paid, 0));
  const advanceApplied = r2(Math.min(dueBeforeAdvance, availableAdvance));
  const amountDue = r2(Math.max(dueBeforeAdvance - advanceApplied, 0));
  const overpaid = r2(Math.max(paid - grand, 0));
  const remainingAdvance = r2(availableAdvance - advanceApplied + overpaid);
  return {
    dueBeforeAdvance,
    advanceApplied,
    amountDue,
    overpaid,
    remainingAdvance,
    debtAfter: r2(previousDebt + amountDue),
    // Advance was used up and still didn't cover the sale.
    advanceShort: availableAdvance > 0 && amountDue > 0,
    // Advance covered the sale exactly and nothing is left.
    advanceExhausted: advanceApplied > 0 && amountDue === 0 && remainingAdvance === 0,
    // Covered, but under a fifth of the starting advance is left.
    advanceLow:
      advanceApplied > 0 &&
      amountDue === 0 &&
      remainingAdvance > 0 &&
      remainingAdvance <= availableAdvance * 0.2,
  };
}

// Mirrors public.sale_payment_status() so lists can label a sale without a
// round trip.
export function salePaymentStatus(s: {
  status: string;
  is_pr?: boolean;
  amount_paid: number;
  credit_applied?: number;
  balance: number;
}): { label: string; variant: "secondary" | "outline" | "destructive" } {
  const paid = Number(s.amount_paid);
  const credit = Number(s.credit_applied ?? 0);
  const balance = Number(s.balance);
  if (s.is_pr) return { label: "PR — no charge", variant: "outline" };
  if (s.status !== "posted") {
    return { label: s.status.replace(/_/g, " "), variant: "outline" };
  }
  if (balance <= 0 && credit > 0 && paid <= 0)
    return { label: "Paid via advance", variant: "secondary" };
  if (balance <= 0) return { label: "Paid", variant: "secondary" };
  if (paid > 0 || credit > 0) return { label: "Partially paid", variant: "outline" };
  return { label: "Unpaid", variant: "destructive" };
}

export const TXN_LABEL: Record<LedgerTxnType, string> = {
  OPENING_BALANCE: "Opening balance",
  ADVANCE_PAYMENT: "Advance payment",
  SALE: "Sale",
  ADVANCE_APPLIED: "Advance applied",
  CUSTOMER_PAYMENT: "Payment held as advance",
  DEBT_SETTLEMENT: "Debt settlement",
  REFUND: "Refund",
  CREDIT_ADJUSTMENT: "Credit adjustment",
  DEBIT_ADJUSTMENT: "Debit adjustment",
  REVERSAL: "Reversal",
  ADVANCE_RESTORED: "Advance restored",
};

export type LedgerLookups = {
  invoiceById?: Map<string, { invoice_number: string }>;
  paymentById?: Map<string, { receipt_number: string }>;
  // sale_id -> "100 Carton, 20 Sachet" style summary
  itemsBySale?: Map<string, string>;
};

export type DisplayRow = {
  key: string;
  date: string;
  reference: string;
  description: string;
  amount: number;
  sign: "+" | "-" | "";
  paid: number | null;
  advanceUsed: number | null;
  creditAfter: number | null;
  debtAfter: number | null;
  pending?: boolean;
};

function referenceOf(r: LedgerTxn, lk: LedgerLookups): string {
  if (r.sale_id && lk.invoiceById?.has(r.sale_id))
    return lk.invoiceById.get(r.sale_id)!.invoice_number;
  if (r.payment_id && lk.paymentById?.has(r.payment_id))
    return lk.paymentById.get(r.payment_id)!.receipt_number;
  if (r.txn_type === "SALE" && r.description) return r.description.replace(/^Sale /, "");
  if (r.payment_id && r.notes) return r.notes;
  return "—";
}

// One statement line per business event: a sale and the advance drawn for it
// (and any overpayment kept as advance) collapse into a single row, the way the
// account is read on paper. Reversals and adjustments stay as their own lines.
export function buildDisplayRows(
  ledger: LedgerTxn[],
  pendingSales: PendingSale[],
  lk: LedgerLookups = {},
): DisplayRow[] {
  const rows: DisplayRow[] = [];
  for (let i = 0; i < ledger.length;) {
    const r = ledger[i];
    if (r.txn_type === "SALE") {
      let last = r;
      let advanceUsed = 0;
      let j = i + 1;
      while (
        j < ledger.length &&
        ledger[j].sale_id === r.sale_id &&
        ledger[j].reference_type === "sale" &&
        (ledger[j].txn_type === "ADVANCE_APPLIED" || ledger[j].txn_type === "ADVANCE_PAYMENT")
      ) {
        if (ledger[j].txn_type === "ADVANCE_APPLIED") advanceUsed += ledger[j].advance_used;
        last = ledger[j];
        j++;
      }
      const items = r.sale_id ? lk.itemsBySale?.get(r.sale_id) : undefined;
      rows.push({
        key: r.id,
        date: r.created_at,
        reference: referenceOf(r, lk),
        description: items ? `Sale — ${items}` : "Sale",
        amount: r.goods_value,
        sign: "",
        paid: r.cash_paid,
        advanceUsed,
        creditAfter: last.credit_after,
        debtAfter: last.debt_after,
      });
      i = j;
      continue;
    }

    let amount = r.amount;
    let sign: DisplayRow["sign"] = "";
    let description = r.description ?? TXN_LABEL[r.txn_type];
    if (
      r.txn_type === "ADVANCE_PAYMENT" ||
      r.txn_type === "CUSTOMER_PAYMENT" ||
      r.txn_type === "ADVANCE_RESTORED"
    ) {
      amount = r.credit_delta;
      sign = "+";
    } else if (r.txn_type === "DEBT_SETTLEMENT") {
      amount = r.cash_paid;
      sign = "+";
    } else if (r.txn_type === "OPENING_BALANCE") {
      const parts: string[] = [];
      if (r.credit_after > 0) parts.push(`advance ${money(r.credit_after)}`);
      if (r.debt_after > 0) parts.push(`debt ${money(r.debt_after)}`);
      description = `Opening balance${parts.length ? ` — ${parts.join(", ")}` : ""}`;
    } else if (r.credit_delta < 0) {
      sign = "-";
    } else if (r.credit_delta > 0) {
      sign = "+";
    }
    rows.push({
      key: r.id,
      date: r.created_at,
      reference: referenceOf(r, lk),
      description,
      amount: Math.abs(amount),
      sign,
      paid: null,
      advanceUsed: null,
      creditAfter: r.credit_after,
      debtAfter: r.debt_after,
    });
    i++;
  }

  pendingSales.forEach((p) =>
    rows.push({
      key: `pending-${p.id}`,
      date: p.created_at,
      reference: p.invoice_number,
      description: "Sale — awaiting approval (not on the account yet)",
      amount: p.grand_total,
      sign: "",
      paid: p.amount_paid,
      advanceUsed: null,
      creditAfter: null,
      debtAfter: null,
      pending: true,
    }),
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Statements: the ledger between two dates, with the balance brought forward
// from just before the period and the totals for it. Pure, so the screen, the
// PDF and the CSV are guaranteed to show the same numbers.
// ---------------------------------------------------------------------------
export type StatementRange = { from?: string; to?: string }; // yyyy-MM-dd, inclusive

export type StatementTotals = {
  advanceReceived: number;
  debtSettled: number;
  goodsCollected: number;
  advanceUsed: number;
  adjustmentsCredit: number;
  adjustmentsDebt: number;
};

export type Statement = {
  range: StatementRange;
  opening: { credit: number; debt: number };
  closing: { credit: number; debt: number };
  totals: StatementTotals;
  rows: DisplayRow[];
  ledger: LedgerTxn[];
};

export function buildStatement(
  ledger: LedgerTxn[],
  range: StatementRange,
  lookups: LedgerLookups = {},
): Statement {
  const at = (r: LedgerTxn) => new Date(r.created_at).getTime();
  const fromMs = range.from ? new Date(`${range.from}T00:00:00`).getTime() : -Infinity;
  const toMs = range.to ? new Date(`${range.to}T23:59:59.999`).getTime() : Infinity;

  const before = ledger.filter((r) => at(r) < fromMs);
  const inRange = ledger.filter((r) => at(r) >= fromMs && at(r) <= toMs);
  const openRow = before[before.length - 1];
  const lastRow = inRange[inRange.length - 1];
  const opening = { credit: openRow?.credit_after ?? 0, debt: openRow?.debt_after ?? 0 };
  const closing = lastRow ? { credit: lastRow.credit_after, debt: lastRow.debt_after } : opening;

  const sum = (f: (r: LedgerTxn) => number) => inRange.reduce((s, r) => s + f(r), 0);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const totals: StatementTotals = {
    advanceReceived: r2(
      sum((r) =>
        (r.txn_type === "ADVANCE_PAYMENT" || r.txn_type === "CUSTOMER_PAYMENT") &&
        r.credit_delta > 0
          ? r.credit_delta
          : 0,
      ),
    ),
    debtSettled: r2(sum((r) => (r.txn_type === "DEBT_SETTLEMENT" ? r.cash_paid : 0))),
    goodsCollected: r2(
      sum((r) =>
        r.txn_type === "SALE"
          ? r.goods_value
          : r.txn_type === "REVERSAL" && r.reference_type === "sale"
            ? -r.goods_value
            : 0,
      ),
    ),
    advanceUsed: r2(
      -sum((r) =>
        r.txn_type === "ADVANCE_APPLIED" || r.txn_type === "ADVANCE_RESTORED" ? r.credit_delta : 0,
      ),
    ),
    adjustmentsCredit: r2(
      sum((r) =>
        r.txn_type === "CREDIT_ADJUSTMENT" ||
        r.txn_type === "DEBIT_ADJUSTMENT" ||
        r.txn_type === "REFUND"
          ? r.credit_delta
          : 0,
      ),
    ),
    adjustmentsDebt: r2(
      sum((r) =>
        r.txn_type === "CREDIT_ADJUSTMENT" ||
        r.txn_type === "DEBIT_ADJUSTMENT" ||
        r.txn_type === "REFUND"
          ? r.debt_delta
          : 0,
      ),
    ),
  };

  return {
    range,
    opening,
    closing,
    totals,
    rows: buildDisplayRows(inRange, [], lookups),
    ledger: inRange,
  };
}

export const STATEMENT_COLUMNS = [
  { key: "date", label: "Date" },
  { key: "reference", label: "Reference" },
  { key: "description", label: "Description" },
  { key: "amount", label: "Amount" },
  { key: "paid", label: "Paid" },
  { key: "advance_used", label: "Advance used" },
  { key: "advance_balance", label: "Advance balance" },
  { key: "debt_balance", label: "Debt balance" },
] as const;

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB");
const plain = (v: number | null) => (v === null ? "" : v.toFixed(2));

// Plain numbers (no currency symbol) so the CSV opens cleanly in a spreadsheet.
export function statementCsvRows(st: Statement): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (st.range.from) {
    out.push({
      date: fmtDate(`${st.range.from}T00:00:00`),
      description: "Balance brought forward",
      advance_balance: plain(st.opening.credit),
      debt_balance: plain(st.opening.debt),
    });
  }
  st.rows.forEach((r) =>
    out.push({
      date: fmtDate(r.date),
      reference: r.reference === "—" ? "" : r.reference,
      description: r.description,
      amount: `${r.sign === "-" ? "-" : ""}${plain(r.amount)}`,
      paid: r.paid && r.paid > 0 ? plain(r.paid) : "",
      advance_used: r.advanceUsed && r.advanceUsed > 0 ? plain(r.advanceUsed) : "",
      advance_balance: plain(r.creditAfter),
      debt_balance: plain(r.debtAfter),
    }),
  );
  out.push({
    description: "Closing balance",
    advance_balance: plain(st.closing.credit),
    debt_balance: plain(st.closing.debt),
  });
  return out;
}

export const periodLabel = (range: StatementRange) =>
  range.from || range.to
    ? `${range.from ? fmtDate(`${range.from}T00:00:00`) : "Start"} to ${
        range.to ? fmtDate(`${range.to}T00:00:00`) : "today"
      }`
    : "All activity to date";
