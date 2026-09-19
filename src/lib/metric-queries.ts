import { supabase } from "@/integrations/supabase/client";
import { COUNTED_STATUSES, UNCOUNTED_PAYMENT_STATUS, fetchAll } from "@/lib/metrics";

// Row sources for every money figure on the dashboards. Each one applies the
// same inclusion rules as the page that owns the data (Sales, Cash Ledger,
// Expenses, Payroll), pages through the full result, and filters on the
// business date (sale_date / payment_date / expense_date), not created_at.

export type PaymentRow = {
  id: string;
  receipt_number: string;
  amount: number;
  payment_method: string;
  payment_date: string;
  status: string;
  sale_id: string | null;
  remarks: string | null;
  customers: { name: string } | null;
};

export type CashTxnRow = {
  id: string;
  transaction_number: string;
  transaction_date: string;
  transaction_type: "receipt" | "payment";
  category: string;
  description: string | null;
  amount: number;
  payment_method: string;
  payer_payee: string | null;
};

export type ExpenseRow = {
  id: string;
  expense_date: string;
  amount: number;
  payment_method: string;
  description: string | null;
  vendor: string | null;
  receipt_number: string | null;
  expense_categories: { name: string } | null;
};

export type PayrollPaidRow = {
  id: string;
  net_salary: number;
  payment_method: string | null;
  payment_date: string | null;
  period_month: number;
  period_year: number;
  employees: { full_name: string } | null;
};

// Sales that actually count: posted (approved), not soft-deleted, and not a
// complimentary PR giveaway.
export function postedSalesRows(
  factoryId: string,
  cols: string,
  fromDay: string,
  toDay?: string,
): Promise<any[]> {
  return fetchAll<any>((a, b) => {
    let q: any = supabase
      .from("sales")
      .select(cols)
      .eq("factory_id", factoryId)
      .eq("status", "posted")
      .is("deleted_at", null)
      .eq("is_pr", false)
      .gte("sale_date", fromDay)
      .order("sale_date")
      .order("id")
      .range(a, b);
    if (toDay) q = q.lte("sale_date", toDay);
    return q;
  });
}

// Money received from customers (register payments, debt repayments, advances).
export function paymentRows(factoryId: string, fromDay: string, toDay: string) {
  return fetchAll<PaymentRow>(
    (a, b) =>
      supabase
        .from("payments_received")
        .select(
          "id,receipt_number,amount,payment_method,payment_date,status,sale_id,remarks,customers(name)",
        )
        .eq("factory_id", factoryId)
        .neq("status", UNCOUNTED_PAYMENT_STATUS)
        .gte("payment_date", fromDay)
        .lte("payment_date", toDay)
        .order("payment_date", { ascending: false })
        .order("id")
        .range(a, b) as any,
  );
}

// Receipts and payments that have no home in sales/expenses (donations, other
// income, other outflows).
export function cashTxnRows(factoryId: string, fromDay: string, toDay: string) {
  return fetchAll<CashTxnRow>(
    (a, b) =>
      supabase
        .from("cash_transactions")
        .select(
          "id,transaction_number,transaction_date,transaction_type,category,description,amount,payment_method,payer_payee",
        )
        .eq("factory_id", factoryId)
        .gte("transaction_date", fromDay)
        .lte("transaction_date", toDay)
        .order("transaction_date", { ascending: false })
        .order("id")
        .range(a, b) as any,
  );
}

export function expenseRows(factoryId: string, fromDay: string, toDay: string) {
  return fetchAll<ExpenseRow>(
    (a, b) =>
      supabase
        .from("expenses")
        .select(
          "id,expense_date,amount,payment_method,description,vendor,receipt_number,expense_categories(name)",
        )
        .eq("factory_id", factoryId)
        .in("status", COUNTED_STATUSES)
        .gte("expense_date", fromDay)
        .lte("expense_date", toDay)
        .order("expense_date", { ascending: false })
        .order("id")
        .range(a, b) as any,
  );
}

// Salaries actually paid out in the window (posted runs, by payment date).
export function payrollPaidRows(factoryId: string, fromDay: string, toDay: string) {
  return fetchAll<PayrollPaidRow>(
    (a, b) =>
      supabase
        .from("payroll")
        .select(
          "id,net_salary,payment_method,payment_date,period_month,period_year,employees(full_name)",
        )
        .eq("factory_id", factoryId)
        .eq("status", "posted")
        .gte("payment_date", fromDay)
        .lte("payment_date", toDay)
        .order("payment_date", { ascending: false })
        .order("id")
        .range(a, b) as any,
  );
}
