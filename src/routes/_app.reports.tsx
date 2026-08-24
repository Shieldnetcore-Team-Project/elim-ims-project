import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FileDown, FileSpreadsheet, Printer, FileText } from "lucide-react";
import { generateReportPdf } from "@/lib/pdf";
import { exportCsv, exportExcel, type ReportColumn } from "@/lib/export";
import { logAudit } from "@/lib/audit";
import { startOfDay, startOfWeek, startOfMonth, startOfYear, format } from "date-fns";

export const Route = createFileRoute("/_app/reports")({
  head: () => ({ meta: [{ title: "Reports — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="reports">
      <ReportsPage />
    </RequireAccess>
  ),
});

type ReportKey =
  | "sales" | "production" | "inventory" | "raw_materials" | "purchase_orders" | "expenses" | "payroll"
  | "debts" | "payments" | "customers" | "employees" | "suppliers" | "damage" | "sales_returns";

const REPORTS: { key: ReportKey; label: string }[] = [
  { key: "sales", label: "Sales" },
  { key: "production", label: "Production" },
  { key: "inventory", label: "Inventory (Finished Goods Movements)" },
  { key: "raw_materials", label: "Raw Materials Movements" },
  { key: "purchase_orders", label: "Purchase Orders" },
  { key: "damage", label: "Damage Records" },
  { key: "sales_returns", label: "Sales Returns" },
  { key: "expenses", label: "Expenses" },
  { key: "payroll", label: "Payroll" },
  { key: "debts", label: "Debts" },
  { key: "payments", label: "Payments Received" },
  { key: "customers", label: "Customers" },
  { key: "employees", label: "Employees" },
  { key: "suppliers", label: "Suppliers" },
];

type RangeKey = "daily" | "weekly" | "monthly" | "yearly" | "custom" | "all";
const RANGES: { key: RangeKey; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "yearly", label: "Yearly" },
  { key: "custom", label: "Custom Date" },
];

function rangeBounds(key: RangeKey, from: string, to: string): { start: string | null; end: string | null } {
  const now = new Date();
  if (key === "daily") return { start: startOfDay(now).toISOString(), end: null };
  if (key === "weekly") return { start: startOfWeek(now).toISOString(), end: null };
  if (key === "monthly") return { start: startOfMonth(now).toISOString(), end: null };
  if (key === "yearly") return { start: startOfYear(now).toISOString(), end: null };
  if (key === "custom") return { start: from ? new Date(from).toISOString() : null, end: to ? new Date(to + "T23:59:59").toISOString() : null };
  return { start: null, end: null };
}

async function fetchReport(
  key: ReportKey, factoryId: string, dateField: string, start: string | null, end: string | null,
): Promise<{ columns: ReportColumn[]; rows: Record<string, unknown>[] }> {
  const applyRange = <T,>(q: T): T => {
    let query = q as any;
    if (start) query = query.gte(dateField, start);
    if (end) query = query.lte(dateField, end);
    return query;
  };

  switch (key) {
    case "sales": {
      const { data, error } = await applyRange(
        supabase.from("sales").select("invoice_number,sale_date,customer_name,grand_total,amount_paid,balance,payment_method,sales_person")
          .eq("factory_id", factoryId).order("sale_date", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "invoice_number", label: "Invoice" }, { key: "sale_date", label: "Date" },
          { key: "customer_name", label: "Customer" }, { key: "grand_total", label: "Total" },
          { key: "amount_paid", label: "Paid" }, { key: "balance", label: "Balance" },
          { key: "payment_method", label: "Method" }, { key: "sales_person", label: "Sales Person" },
        ],
        rows: data ?? [],
      };
    }
    case "production": {
      const { data, error } = await applyRange(
        supabase.from("production").select("production_number,production_date,created_at,quantity_produced,unit,production_cost,supervisor,batch_number,department,production_scope,status,products(name),production_types(name)")
          .eq("factory_id", factoryId).order("production_date", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "production_number", label: "Reference" }, { key: "production_type", label: "Production Type" },
          { key: "product", label: "Product" }, { key: "quantity_produced", label: "Qty" }, { key: "unit", label: "Unit" },
          { key: "production_scope", label: "Scope" }, { key: "production_date", label: "Production Date" },
          { key: "supervisor", label: "Production Manager" }, { key: "created_at", label: "Created" },
          { key: "status", label: "Status" }, { key: "batch_number", label: "Batch/Ref" }, { key: "production_cost", label: "Cost" },
        ],
        rows: (data ?? []).map((r: any) => ({
          ...r, product: r.products?.name ?? "—", production_type: r.production_types?.name ?? "—",
          created_at: new Date(r.created_at).toLocaleString(),
          status: String(r.status ?? "").replace(/_/g, " "),
        })),
      };
    }
    case "inventory": {
      const { data, error } = await applyRange(
        supabase.from("inventory_movements").select("created_at,movement_type,quantity,reference,reason,products(name)")
          .eq("factory_id", factoryId).order("created_at", { ascending: false }).limit(500),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "created_at", label: "Date" }, { key: "product", label: "Product" },
          { key: "movement_type", label: "Type" }, { key: "quantity", label: "Qty" },
          { key: "reference", label: "Reference" }, { key: "reason", label: "Reason" },
        ],
        rows: (data ?? []).map((r: any) => ({ ...r, product: r.products?.name ?? "—", created_at: new Date(r.created_at).toLocaleString() })),
      };
    }
    case "raw_materials": {
      const { data, error } = await applyRange(
        supabase.from("raw_material_movements").select("created_at,movement_type,quantity,unit_cost,reference,reason,raw_materials(name,unit)")
          .eq("factory_id", factoryId).order("created_at", { ascending: false }).limit(500),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "created_at", label: "Date" }, { key: "material", label: "Material" },
          { key: "movement_type", label: "Type" }, { key: "quantity", label: "Qty" },
          { key: "unit_cost", label: "Unit Cost" }, { key: "reference", label: "Reference" }, { key: "reason", label: "Reason" },
        ],
        rows: (data ?? []).map((r: any) => ({ ...r, material: r.raw_materials?.name ?? "—", created_at: new Date(r.created_at).toLocaleString() })),
      };
    }
    case "purchase_orders": {
      const { data, error } = await applyRange(
        supabase.from("purchase_orders").select("po_number,issued_at,quantity_ordered,quantity_received,unit,unit_cost,status,expected_delivery_date,raw_materials(name),suppliers(name)")
          .eq("factory_id", factoryId).order("issued_at", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "po_number", label: "PO Number" }, { key: "issued_at", label: "Issued" },
          { key: "material", label: "Material" }, { key: "supplier", label: "Supplier" },
          { key: "quantity_ordered", label: "Ordered" }, { key: "quantity_received", label: "Received" },
          { key: "unit", label: "Unit" }, { key: "unit_cost", label: "Unit Cost" },
          { key: "status", label: "Status" }, { key: "expected_delivery_date", label: "Expected Delivery" },
        ],
        rows: (data ?? []).map((r: any) => ({
          ...r, material: r.raw_materials?.name ?? "—", supplier: r.suppliers?.name ?? "—",
          issued_at: new Date(r.issued_at).toLocaleDateString(),
        })),
      };
    }
    case "damage": {
      const { data, error } = await applyRange(
        supabase.from("damage_records").select("reference_number,source_type,source_reference,quantity,unit,reason,status,created_at,products(name),raw_materials(name)")
          .eq("factory_id", factoryId).order("created_at", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "reference_number", label: "Reference" }, { key: "created_at", label: "Date" },
          { key: "source_type", label: "Source" }, { key: "source_reference", label: "Source Ref" },
          { key: "item", label: "Item" }, { key: "quantity", label: "Qty" }, { key: "unit", label: "Unit" },
          { key: "reason", label: "Reason" }, { key: "status", label: "Status" },
        ],
        rows: (data ?? []).map((r: any) => ({
          ...r, item: r.products?.name ?? r.raw_materials?.name ?? "—",
          created_at: new Date(r.created_at).toLocaleString(),
        })),
      };
    }
    case "sales_returns": {
      const { data, error } = await applyRange(
        supabase.from("sales_returns").select("return_number,received_at,quantity_returned,unit,accepted_quantity,damaged_quantity,rejected_quantity,status,reason,products(name),customers(name),sales(invoice_number)")
          .eq("factory_id", factoryId).order("received_at", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "return_number", label: "Return #" }, { key: "received_at", label: "Date" },
          { key: "product", label: "Product" }, { key: "customer", label: "Customer" }, { key: "invoice", label: "Invoice" },
          { key: "quantity_returned", label: "Returned" }, { key: "accepted_quantity", label: "Accepted" },
          { key: "damaged_quantity", label: "Damaged" }, { key: "rejected_quantity", label: "Rejected" },
          { key: "status", label: "Status" }, { key: "reason", label: "Reason" },
        ],
        rows: (data ?? []).map((r: any) => ({
          ...r, product: r.products?.name ?? "—", customer: r.customers?.name ?? "—", invoice: r.sales?.invoice_number ?? "—",
          received_at: new Date(r.received_at).toLocaleDateString(),
        })),
      };
    }
    case "expenses": {
      const { data, error } = await applyRange(
        supabase.from("expenses").select("expense_date,description,vendor,payment_method,amount,approved_by,expense_categories(name)")
          .eq("factory_id", factoryId).order("expense_date", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "expense_date", label: "Date" }, { key: "category", label: "Category" },
          { key: "description", label: "Description" }, { key: "vendor", label: "Vendor" },
          { key: "payment_method", label: "Method" }, { key: "amount", label: "Amount" }, { key: "approved_by", label: "Approved By" },
        ],
        rows: (data ?? []).map((r: any) => ({ ...r, category: r.expense_categories?.name ?? "—" })),
      };
    }
    case "payroll": {
      const { data, error } = await applyRange(
        supabase.from("payroll").select("period_month,period_year,gross_salary,net_salary,status,payment_date,employees(full_name,department)")
          .eq("factory_id", factoryId).order("created_at", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "employee", label: "Employee" }, { key: "department", label: "Department" },
          { key: "period", label: "Period" }, { key: "gross_salary", label: "Gross" },
          { key: "net_salary", label: "Net" }, { key: "status", label: "Status" }, { key: "payment_date", label: "Payment Date" },
        ],
        rows: (data ?? []).map((r: any) => ({
          ...r, employee: r.employees?.full_name ?? "—", department: r.employees?.department ?? "—",
          period: `${r.period_month}/${r.period_year}`,
        })),
      };
    }
    case "debts": {
      const { data, error } = await applyRange(
        supabase.from("debts").select("created_at,total_amount,amount_paid,outstanding,status,customers(name),sales(invoice_number)")
          .eq("factory_id", factoryId).order("created_at", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "created_at", label: "Date" }, { key: "customer", label: "Customer" }, { key: "invoice", label: "Invoice" },
          { key: "total_amount", label: "Total" }, { key: "amount_paid", label: "Paid" },
          { key: "outstanding", label: "Outstanding" }, { key: "status", label: "Status" },
        ],
        rows: (data ?? []).map((r: any) => ({
          ...r, customer: r.customers?.name ?? "—", invoice: r.sales?.invoice_number ?? "—",
          created_at: new Date(r.created_at).toLocaleDateString(),
        })),
      };
    }
    case "payments": {
      const { data, error } = await applyRange(
        supabase.from("payments_received").select("receipt_number,payment_date,amount,payment_method,customers(name),sales(invoice_number)")
          .eq("factory_id", factoryId).order("payment_date", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "receipt_number", label: "Receipt" }, { key: "payment_date", label: "Date" },
          { key: "customer", label: "Customer" }, { key: "invoice", label: "Invoice" },
          { key: "payment_method", label: "Method" }, { key: "amount", label: "Amount" },
        ],
        rows: (data ?? []).map((r: any) => ({ ...r, customer: r.customers?.name ?? "—", invoice: r.sales?.invoice_number ?? "—" })),
      };
    }
    case "customers": {
      const { data, error } = await applyRange(
        supabase.from("customers").select("name,phone,email,total_purchases,outstanding_balance")
          .eq("factory_id", factoryId).order("total_purchases", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "name", label: "Name" }, { key: "phone", label: "Phone" }, { key: "email", label: "Email" },
          { key: "total_purchases", label: "Total Purchases" }, { key: "outstanding_balance", label: "Outstanding" },
        ],
        rows: data ?? [],
      };
    }
    case "employees": {
      const { data, error } = await applyRange(
        supabase.from("employees").select("employee_code,full_name,department,position,basic_salary,status")
          .eq("factory_id", factoryId).order("full_name"),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "employee_code", label: "ID" }, { key: "full_name", label: "Name" }, { key: "department", label: "Department" },
          { key: "position", label: "Position" }, { key: "basic_salary", label: "Basic Salary" }, { key: "status", label: "Status" },
        ],
        rows: data ?? [],
      };
    }
    case "suppliers": {
      const { data, error } = await applyRange(
        supabase.from("suppliers").select("name,phone,materials_supplied,outstanding_balance")
          .eq("factory_id", factoryId).order("name"),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "name", label: "Name" }, { key: "phone", label: "Phone" },
          { key: "materials_supplied", label: "Materials Supplied" }, { key: "outstanding_balance", label: "Outstanding" },
        ],
        rows: data ?? [],
      };
    }
  }
}

const DATE_FIELDS: Record<ReportKey, string> = {
  sales: "sale_date", production: "production_date", inventory: "created_at", raw_materials: "created_at",
  purchase_orders: "issued_at", damage: "created_at", sales_returns: "received_at",
  expenses: "expense_date", payroll: "created_at", debts: "created_at", payments: "payment_date",
  customers: "created_at", employees: "created_at", suppliers: "created_at",
};

function ReportsPage() {
  const { data: factoryId } = useFactoryId();
  const [reportKey, setReportKey] = useState<ReportKey>("sales");
  const [range, setRange] = useState<RangeKey>("monthly");
  const [customFrom, setCustomFrom] = useState(format(new Date(), "yyyy-MM-01"));
  const [customTo, setCustomTo] = useState(format(new Date(), "yyyy-MM-dd"));

  const bounds = useMemo(() => rangeBounds(range, customFrom, customTo), [range, customFrom, customTo]);

  const report = useQuery({
    queryKey: ["report", reportKey, factoryId, bounds.start, bounds.end],
    enabled: !!factoryId,
    queryFn: () => fetchReport(reportKey, factoryId!, DATE_FIELDS[reportKey], bounds.start, bounds.end),
  });

  const reportLabel = REPORTS.find((r) => r.key === reportKey)?.label ?? "Report";
  const columns = report.data?.columns ?? [];
  const rows = report.data?.rows ?? [];

  const doExport = (type: "csv" | "excel" | "pdf" | "print") => {
    if (columns.length === 0) return;
    const name = `${reportLabel}-${format(new Date(), "yyyy-MM-dd")}`;
    if (type === "csv") exportCsv(name, columns, rows);
    else if (type === "excel") exportExcel(name, columns, rows);
    else if (type === "pdf") generateReportPdf(reportLabel, columns, rows, "download");
    else generateReportPdf(reportLabel, columns, rows, "print");
    logAudit({ action: type === "print" ? "print" : "export", entity: "report", factoryId, newValue: { report: reportLabel, format: type, rows: rows.length } });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">Cross-module reports with Excel, PDF, and CSV export.</p>
      </div>

      <Card className="rounded-2xl">
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div>
            <Label className="mb-1 block text-xs">Report</Label>
            <Select value={reportKey} onValueChange={(v) => setReportKey(v as ReportKey)}>
              <SelectTrigger className="w-[260px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {REPORTS.map((r) => (<SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1 block text-xs">Range</Label>
            <Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RANGES.map((r) => (<SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          {range === "custom" && (
            <>
              <div><Label className="mb-1 block text-xs">From</Label><Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} /></div>
              <div><Label className="mb-1 block text-xs">To</Label><Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} /></div>
            </>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="gap-2" onClick={() => doExport("csv")}><FileDown className="h-4 w-4" /> CSV</Button>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => doExport("excel")}><FileSpreadsheet className="h-4 w-4" /> Excel</Button>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => doExport("pdf")}><FileText className="h-4 w-4" /> PDF</Button>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => doExport("print")}><Printer className="h-4 w-4" /> Print</Button>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader><CardTitle>{reportLabel} ({rows.length})</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => (<TableHead key={c.key}>{c.label}</TableHead>))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i}>
                  {columns.map((c) => (<TableCell key={c.key}>{String(r[c.key] ?? "—")}</TableCell>))}
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow><TableCell colSpan={columns.length || 1} className="text-center text-muted-foreground py-8">No data for this range.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
