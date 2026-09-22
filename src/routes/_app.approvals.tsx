import { createFileRoute, Link } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions, useIsSuperAdmin } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { money } from "@/lib/format";
import {
  Receipt,
  HandCoins,
  Wallet,
  PackageMinus,
  ShieldCheck,
  ArrowRight,
  PackagePlus,
  Factory,
  Calculator,
  ClipboardList,
  ShoppingCart,
} from "lucide-react";

export const Route = createFileRoute("/_app/approvals")({
  head: () => ({ meta: [{ title: "Approvals — Elim Table Water" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="approvals">
      <ApprovalsPage />
    </RequireAccess>
  ),
});

function useCurrentUser() {
  return useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });
}

function QueueCard({
  icon: Icon,
  title,
  to,
  rows,
  empty,
}: {
  icon: React.ElementType;
  title: string;
  to: string;
  rows: { key: string; cells: React.ReactNode[] }[];
  empty: string;
}) {
  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Icon className="h-4 w-4" /> {title} <Badge variant="secondary">{rows.length}</Badge>
        </CardTitle>
        <Button asChild variant="ghost" size="sm" className="gap-1">
          <Link to={to}>
            Review <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <Table>
            <TableBody>
              {rows.slice(0, 6).map((r) => (
                <TableRow key={r.key}>
                  {r.cells.map((c, i) => (
                    <TableCell key={i}>{c}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {rows.length > 6 && (
          <p className="mt-2 text-xs text-muted-foreground">
            +{rows.length - 6} more — open the full page to review.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ApprovalsPage() {
  const { canApprove, canConfirm } = usePermissions();
  const currentUser = useCurrentUser();
  const uid = currentUser.data;
  // approve_sale()/reject_sale() exempt an admin (super_admin) from the
  // self-approval block that every other approver role is still under, so
  // this queue mirrors that instead of hiding an admin's own sale from them.
  const isSuperAdmin = useIsSuperAdmin().data ?? false;

  const sales = useQuery({
    queryKey: ["approvals-sales"],
    enabled: canApprove("sales"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("id,invoice_number,customer_name,grand_total,sale_date,created_by")
        .eq("status", "pending_approval")
        .order("sale_date", { ascending: false })
        .limit(50);
      if (error) throw error;
      return isSuperAdmin ? (data ?? []) : (data ?? []).filter((s) => s.created_by !== uid);
    },
  });

  const expenses = useQuery({
    queryKey: ["approvals-expenses"],
    enabled: canApprove("expenses"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expenses")
        .select("id,description,amount,expense_date,submitted_by")
        .eq("approval_status", "pending")
        .order("expense_date", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []).filter((e) => e.submitted_by !== uid);
    },
  });

  const debts = useQuery({
    queryKey: ["approvals-debts"],
    enabled: canApprove("debts"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("debts")
        .select("id,outstanding,writeoff_requested_by,writeoff_reason,customers(name)")
        .eq("writeoff_status", "requested")
        .limit(50);
      if (error) throw error;
      return (data ?? []).filter((d: any) => d.writeoff_requested_by !== uid) as any[];
    },
  });

  const customerAdjustments = useQuery({
    queryKey: ["approvals-customer-adjustments"],
    enabled: canApprove("customers"),
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("customer_account_adjustments")
        .select("id,effect,amount,submitted_by,customers(name)")
        .eq("status", "pending_approval")
        .limit(50);
      if (error) throw error;
      return ((data ?? []) as any[]).filter((d) => d.submitted_by !== uid);
    },
  });

  const payments = useQuery({
    queryKey: ["approvals-payments"],
    enabled: canApprove("payments"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments_received")
        .select("id,receipt_number,amount,payment_date,received_by,customers(name)")
        .eq("review_status", "pending")
        .order("payment_date", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []).filter((p: any) => p.received_by !== uid) as any[];
    },
  });

  const payroll = useQuery({
    queryKey: ["approvals-payroll"],
    enabled: canApprove("payroll"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll")
        .select("id,net_salary,period_month,period_year,submitted_by,employees(full_name)")
        .eq("status", "pending_approval")
        .limit(50);
      if (error) throw error;
      return (data ?? []).filter((p: any) => p.submitted_by !== uid) as any[];
    },
  });

  const stockRaw = useQuery({
    queryKey: ["approvals-stock-raw"],
    enabled: canApprove("raw-materials"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_adjustment_requests")
        .select("id,reference_number,quantity_delta,reason,submitted_by,raw_materials(name,unit)")
        .eq("entity_type", "raw_material")
        .eq("status", "pending_approval")
        .limit(50);
      if (error) throw error;
      return (data ?? []).filter((r: any) => r.submitted_by !== uid) as any[];
    },
  });

  const stockFinished = useQuery({
    queryKey: ["approvals-stock-finished"],
    enabled: canApprove("finished-goods"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_adjustment_requests")
        .select("id,reference_number,quantity_delta,reason,submitted_by,products(name,unit)")
        .eq("entity_type", "finished_good")
        .eq("status", "pending_approval")
        .limit(50);
      if (error) throw error;
      return (data ?? []).filter((r: any) => r.submitted_by !== uid) as any[];
    },
  });

  const roleGrants = useQuery({
    queryKey: ["approvals-roles"],
    enabled: canApprove("users"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("role_grant_requests")
        .select("id,role,action,requested_by,target_user_id")
        .eq("review_status", "pending")
        .limit(50);
      if (error) throw error;
      return (data ?? []).filter((r: any) => r.requested_by !== uid) as any[];
    },
  });

  const goodsReceipts = useQuery({
    queryKey: ["approvals-goods-receipts"],
    enabled: canConfirm("goods-receiving"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("goods_receipts")
        .select("id,receipt_number,quantity,unit,submitted_by,raw_materials(name)")
        .eq("status", "pending_confirmation")
        .order("submitted_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []).filter((r: any) => r.submitted_by !== uid) as any[];
    },
  });

  const productionBatches = useQuery({
    queryKey: ["approvals-production-batches"],
    enabled: canConfirm("production"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production")
        .select("id,batch_number,quantity_produced,unit,created_by,products(name)")
        .eq("status", "pending_confirmation")
        .order("production_date", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []).filter((r: any) => r.created_by !== uid) as any[];
    },
  });

  const costingSheets = useQuery({
    queryKey: ["approvals-costing"],
    enabled: canApprove("costing"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("costing_sheets")
        .select("id,sheet_number,unit_cost,created_by,products(name)")
        .eq("status", "pending_approval")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []).filter((r: any) => r.created_by !== uid) as any[];
    },
  });

  const productionRequests = useQuery({
    queryKey: ["approvals-production-requests"],
    enabled: canApprove("production-requests"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production_requests")
        .select("id,request_number,quantity_requested,unit,requested_by,products(name)")
        .eq("approval_status", "pending")
        .eq("request_type", "production_material")
        .order("request_date", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []).filter((r: any) => r.requested_by !== uid) as any[];
    },
  });

  const purchaseRequests = useQuery({
    queryKey: ["approvals-purchase-requests"],
    enabled: canApprove("production-requests"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production_requests")
        .select("id,request_number,quantity_requested,unit,requested_by,raw_materials(name)")
        .eq("approval_status", "pending")
        .eq("request_type", "purchase")
        .order("request_date", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []).filter((r: any) => r.requested_by !== uid) as any[];
    },
  });

  const staffDeductions = useQuery({
    queryKey: ["approvals-staff-deductions"],
    enabled: canApprove("payroll"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_deductions")
        .select("id,kind,label,amount,submitted_by,employees(full_name)")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []).filter((r: any) => r.submitted_by !== uid) as any[];
    },
  });

  const staffLoans = useQuery({
    queryKey: ["approvals-staff-loans"],
    enabled: canApprove("payroll"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_loans")
        .select("id,loan_number,principal,submitted_by,employees(full_name)")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []).filter((r: any) => r.submitted_by !== uid) as any[];
    },
  });

  const nothingToApprove =
    !canApprove("sales") &&
    !canApprove("expenses") &&
    !canApprove("debts") &&
    !canApprove("payments") &&
    !canApprove("payroll") &&
    !canApprove("raw-materials") &&
    !canApprove("finished-goods") &&
    !canApprove("users") &&
    !canConfirm("goods-receiving") &&
    !canConfirm("production") &&
    !canApprove("costing") &&
    !canApprove("production-requests");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          Everything waiting on your review, across every module — you can't approve your own
          submissions.
        </p>
      </div>

      {nothingToApprove ? (
        <Card className="rounded-2xl border-dashed">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            You don't hold an approver role for any module yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {canApprove("sales") && (
            <QueueCard
              icon={ShoppingCart}
              title="Sales"
              to="/sales"
              empty="No sales awaiting approval."
              rows={(sales.data ?? []).map((s) => ({
                key: s.id,
                cells: [
                  s.invoice_number,
                  s.customer_name ?? "Walk-in",
                  money(Number(s.grand_total)),
                ],
              }))}
            />
          )}
          {canApprove("expenses") && (
            <QueueCard
              icon={Receipt}
              title="Expenses"
              to="/expenses"
              empty="No expenses awaiting approval."
              rows={(expenses.data ?? []).map((e: any) => ({
                key: e.id,
                cells: [e.description ?? "—", money(Number(e.amount)), e.expense_date],
              }))}
            />
          )}
          {canApprove("debts") && (
            <QueueCard
              icon={Wallet}
              title="Debt Write-offs"
              to="/cash-ledger/debts"
              empty="No write-off requests pending."
              rows={(debts.data ?? []).map((d: any) => ({
                key: d.id,
                cells: [
                  d.customers?.name ?? "—",
                  money(Number(d.outstanding)),
                  d.writeoff_reason ?? "—",
                ],
              }))}
            />
          )}
          {canApprove("payments") && (
            <QueueCard
              icon={HandCoins}
              title="Payment Confirmations"
              to="/cash-ledger/ledger"
              empty="No payments awaiting confirmation."
              rows={(payments.data ?? []).map((p: any) => ({
                key: p.id,
                cells: [p.receipt_number, p.customers?.name ?? "—", money(Number(p.amount))],
              }))}
            />
          )}
          {canApprove("payroll") && (
            <QueueCard
              icon={Wallet}
              title="Payroll"
              to="/payroll"
              empty="No payroll runs awaiting approval."
              rows={(payroll.data ?? []).map((p: any) => ({
                key: p.id,
                cells: [
                  p.employees?.full_name ?? "—",
                  `${p.period_month}/${p.period_year}`,
                  money(Number(p.net_salary)),
                ],
              }))}
            />
          )}
          {(canApprove("raw-materials") || canApprove("finished-goods")) && (
            <QueueCard
              icon={PackageMinus}
              title="Stock Write-offs"
              to="/raw-materials"
              empty="No stock write-off requests pending."
              rows={[
                ...(stockRaw.data ?? []).map((r: any) => ({
                  key: r.id,
                  cells: [
                    r.reference_number,
                    r.raw_materials?.name ?? "—",
                    `${r.quantity_delta} ${r.raw_materials?.unit ?? ""}`,
                    r.reason ?? "—",
                  ],
                })),
                ...(stockFinished.data ?? []).map((r: any) => ({
                  key: r.id,
                  cells: [
                    r.reference_number,
                    r.products?.name ?? "—",
                    `${r.quantity_delta} ${r.products?.unit ?? ""}`,
                    r.reason ?? "—",
                  ],
                })),
              ]}
            />
          )}
          {canApprove("users") && (
            <QueueCard
              icon={ShieldCheck}
              title="Role Changes"
              to="/users"
              empty="No role changes pending."
              rows={(roleGrants.data ?? []).map((r: any) => ({
                key: r.id,
                cells: [<span className="capitalize">{r.action}</span>, r.role],
              }))}
            />
          )}
          {canApprove("production-requests") && (
            <QueueCard
              icon={ClipboardList}
              title="Production Requests"
              to="/production-requests"
              empty="No requests awaiting approval."
              rows={(productionRequests.data ?? []).map((r: any) => ({
                key: r.id,
                cells: [
                  r.request_number,
                  r.products?.name ?? "—",
                  `${r.quantity_requested} ${r.unit ?? ""}`,
                ],
              }))}
            />
          )}
          {canApprove("production-requests") && (
            <QueueCard
              icon={ClipboardList}
              title="Purchase Requests"
              to="/procurement"
              empty="No purchase requests awaiting approval."
              rows={(purchaseRequests.data ?? []).map((r: any) => ({
                key: r.id,
                cells: [
                  r.request_number,
                  r.raw_materials?.name ?? "—",
                  `${r.quantity_requested} ${r.unit ?? ""}`,
                ],
              }))}
            />
          )}
          {canApprove("customers") && (
            <QueueCard
              icon={HandCoins}
              title="Customer Account Adjustments"
              to="/customers"
              empty="No customer account adjustments awaiting approval."
              rows={(customerAdjustments.data ?? []).map((r: any) => ({
                key: r.id,
                cells: [
                  r.customers?.name ?? "—",
                  <span className="capitalize">{String(r.effect).replace(/_/g, " ")}</span>,
                  money(Number(r.amount)),
                ],
              }))}
            />
          )}
          {canApprove("payroll") && (
            <QueueCard
              icon={HandCoins}
              title="Staff Loans & Deductions"
              to="/employees"
              empty="No staff loans, fines, or contributions awaiting approval."
              rows={[
                ...(staffLoans.data ?? []).map((r: any) => ({
                  key: r.id,
                  cells: [
                    r.employees?.full_name ?? "—",
                    "Loan",
                    r.loan_number,
                    money(Number(r.principal)),
                  ],
                })),
                ...(staffDeductions.data ?? []).map((r: any) => ({
                  key: r.id,
                  cells: [
                    r.employees?.full_name ?? "—",
                    <span className="capitalize">{r.kind}</span>,
                    r.label,
                    money(Number(r.amount)),
                  ],
                })),
              ]}
            />
          )}
          {canConfirm("goods-receiving") && (
            <QueueCard
              icon={PackagePlus}
              title="Goods Receiving"
              to="/raw-materials"
              empty="No goods receipts awaiting confirmation."
              rows={(goodsReceipts.data ?? []).map((r: any) => ({
                key: r.id,
                cells: [
                  r.receipt_number,
                  r.raw_materials?.name ?? "—",
                  `${r.quantity} ${r.unit ?? ""}`,
                ],
              }))}
            />
          )}
          {canConfirm("production") && (
            <QueueCard
              icon={Factory}
              title="Production Batches"
              to="/finished-goods"
              empty="No production batches awaiting confirmation."
              rows={(productionBatches.data ?? []).map((r: any) => ({
                key: r.id,
                cells: [
                  r.batch_number ?? "—",
                  r.products?.name ?? "—",
                  `${r.quantity_produced} ${r.unit ?? ""}`,
                ],
              }))}
            />
          )}
          {canApprove("costing") && (
            <QueueCard
              icon={Calculator}
              title="Costing Sheets"
              to="/costing"
              empty="No costing sheets awaiting approval."
              rows={(costingSheets.data ?? []).map((r: any) => ({
                key: r.id,
                cells: [r.sheet_number, r.products?.name ?? "—", money(Number(r.unit_cost))],
              }))}
            />
          )}
        </div>
      )}
    </div>
  );
}
