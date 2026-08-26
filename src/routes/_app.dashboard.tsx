import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { RequireAccess } from "@/components/layout/require-access";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { useMyRoles, type Role } from "@/lib/permissions";
import {
  KPI,
  PageHeader,
  usePendingApprovalsCount,
  usePendingConfirmationsCount,
} from "@/lib/dashboard-kit";
import { FinanceOverview } from "@/components/dashboards/finance-overview";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
} from "recharts";
import { money, num } from "@/lib/format";
import {
  TrendingUp,
  FactoryIcon,
  Receipt,
  AlertTriangle,
  PackageCheck,
  HandCoins,
  Boxes,
  Users,
  ShoppingCart,
  Trophy,
  Activity,
  CheckSquare,
  Inbox,
  ClipboardList,
  Truck,
  PackageMinus,
  Package,
  ScrollText,
} from "lucide-react";
import { format, startOfDay, startOfMonth, subDays } from "date-fns";

export const Route = createFileRoute("/_app/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="dashboard">
      <DashboardRouter />
    </RequireAccess>
  ),
});

// Section 11: the dashboard is not one-size-fits-all. Variant is picked from
// the caller's actual roles (not module access), since several roles can
// view the same module without that module being their primary lens —
// e.g. chairman can view Sales but still wants the admin rollup, not the
// sales-floor view.
type Variant = "admin" | "finance" | "sales" | "inventory" | "production" | "store" | "generic";

function pickVariant(roles: Role[]): Variant {
  if (roles.includes("super_admin") || roles.includes("chairman")) return "admin";
  if (roles.includes("accountant") || roles.includes("payroll_officer")) return "finance";
  if (roles.includes("sales") || roles.includes("cashier")) return "sales";
  if (roles.includes("inventory_officer")) return "inventory";
  if (roles.includes("production")) return "production";
  if (roles.includes("store_officer")) return "store";
  return "generic";
}

function useDashboardVariant(): Variant {
  const roles = useMyRoles();
  return pickVariant(roles.data ?? []);
}

function DashboardRouter() {
  const factory = useFactoryId();
  const factoryId = factory.data;
  const variant = useDashboardVariant();

  if (!factoryId) return null;

  switch (variant) {
    case "admin":
      return <AdminDashboard factoryId={factoryId} />;
    case "finance":
      return <FinanceOverview factoryId={factoryId} />;
    case "sales":
      return <SalesDashboard factoryId={factoryId} />;
    case "inventory":
      return <InventoryDashboard factoryId={factoryId} />;
    case "production":
      return <ProductionDashboard factoryId={factoryId} />;
    case "store":
      return <StoreDashboard factoryId={factoryId} />;
    default:
      return <GenericDashboard factoryId={factoryId} />;
  }
}

// ============================================================================
// ADMIN — super_admin / chairman: everything, factory-wide
// ============================================================================
function AdminDashboard({ factoryId }: { factoryId: string }) {
  const today = startOfDay(new Date()).toISOString();
  const monthStart = startOfMonth(new Date()).toISOString();

  const totalSales = useQuery({
    queryKey: ["total-sales-month", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("grand_total")
        .eq("factory_id", factoryId)
        .gte("created_at", monthStart);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.grand_total ?? 0), 0);
    },
  });
  const salesToday = useQuery({
    queryKey: ["sales-today", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("grand_total")
        .eq("factory_id", factoryId)
        .gte("created_at", today);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.grand_total ?? 0), 0);
    },
  });
  const productionToday = useQuery({
    queryKey: ["production-today", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production")
        .select("quantity_produced")
        .eq("factory_id", factoryId)
        .gte("created_at", today);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.quantity_produced ?? 0), 0);
    },
  });
  const rawStockValue = useQuery({
    queryKey: ["raw-stock", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_materials")
        .select("current_stock,unit_cost")
        .eq("factory_id", factoryId)
        .eq("active", true);
      if (error) throw error;
      return (data ?? []).reduce(
        (s, r) => s + Number(r.current_stock ?? 0) * Number(r.unit_cost ?? 0),
        0,
      );
    },
  });
  const finishedGoods = useQuery({
    queryKey: ["finished-goods-units", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("current_stock")
        .eq("factory_id", factoryId);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.current_stock ?? 0), 0);
    },
  });
  const lowStock = useQuery({
    queryKey: ["low-stock", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_materials")
        .select("id,name,current_stock,reorder_level,unit")
        .eq("factory_id", factoryId)
        .eq("active", true);
      if (error) throw error;
      return (data ?? []).filter((r) => Number(r.current_stock) <= Number(r.reorder_level ?? 0));
    },
  });
  const outstandingPayments = useQuery({
    queryKey: ["outstanding-debts", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("debts")
        .select("outstanding")
        .eq("factory_id", factoryId)
        .neq("status", "paid");
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.outstanding ?? 0), 0);
    },
  });
  const pendingApprovals = usePendingApprovalsCount(factoryId);
  const pendingConfirmations = usePendingConfirmationsCount(factoryId);

  const salesTrend = useQuery({
    queryKey: ["sales-trend", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("sale_date,grand_total")
        .eq("factory_id", factoryId)
        .gte("sale_date", format(subDays(new Date(), 6), "yyyy-MM-dd"))
        .order("sale_date");
      if (error) throw error;
      const bucket: Record<string, number> = {};
      for (let i = 6; i >= 0; i--) bucket[format(subDays(new Date(), i), "MMM d")] = 0;
      (data ?? []).forEach((r) => {
        const key = format(new Date(r.sale_date as string), "MMM d");
        if (key in bucket) bucket[key] += Number(r.grand_total ?? 0);
      });
      return Object.entries(bucket).map(([date, total]) => ({ date, total }));
    },
  });

  const recentActivity = useQuery({
    queryKey: ["recent-activity", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const [sales, production, expenses] = await Promise.all([
        supabase
          .from("sales")
          .select("id,invoice_number,customer_name,grand_total,created_at")
          .eq("factory_id", factoryId)
          .order("created_at", { ascending: false })
          .limit(5),
        supabase
          .from("production")
          .select("id,production_number,quantity_produced,unit,created_at,products(name)")
          .eq("factory_id", factoryId)
          .order("created_at", { ascending: false })
          .limit(5),
        supabase
          .from("expenses")
          .select("id,description,amount,created_at")
          .eq("factory_id", factoryId)
          .order("created_at", { ascending: false })
          .limit(5),
      ]);
      if (sales.error) throw sales.error;
      if (production.error) throw production.error;
      if (expenses.error) throw expenses.error;
      type Item = {
        id: string;
        icon: React.ElementType;
        label: string;
        detail: string;
        at: string;
      };
      const items: Item[] = [
        ...(sales.data ?? []).map((s: any) => ({
          id: `sale-${s.id}`,
          icon: ShoppingCart,
          label: `Sale ${s.invoice_number}`,
          detail: `${s.customer_name ?? "Walk-in"} · ${money(Number(s.grand_total))}`,
          at: s.created_at,
        })),
        ...(production.data ?? []).map((p: any) => ({
          id: `prod-${p.id}`,
          icon: FactoryIcon,
          label: `Produced ${p.products?.name ?? ""}`,
          detail: `${num(Number(p.quantity_produced))} ${p.unit ?? ""}`,
          at: p.created_at,
        })),
        ...(expenses.data ?? []).map((e: any) => ({
          id: `exp-${e.id}`,
          icon: Receipt,
          label: e.description || "Expense",
          detail: money(Number(e.amount)),
          at: e.created_at,
        })),
      ];
      return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 8);
    },
  });

  const systemActivity = useQuery({
    queryKey: ["dashboard-system-activity", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("audit_logs")
        .select("id,action,entity,created_at")
        .eq("factory_id", factoryId)
        .order("created_at", { ascending: false })
        .limit(6);
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        hint="Factory-wide overview — every module, every pending item."
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KPI icon={TrendingUp} label="Total Sales (this month)" value={money(totalSales.data)} />
        <KPI
          icon={ShoppingCart}
          label="Today's Sales"
          value={money(salesToday.data)}
          tone="success"
        />
        <KPI
          icon={FactoryIcon}
          label="Production Today"
          value={num(productionToday.data)}
          tone="success"
        />
        <KPI icon={Boxes} label="Raw Material Stock" value={money(rawStockValue.data)} />
        <KPI icon={Package} label="Finished Goods (units)" value={num(finishedGoods.data)} />
        <KPI
          icon={AlertTriangle}
          label="Low Stock"
          value={String(lowStock.data?.length ?? 0)}
          tone={(lowStock.data?.length ?? 0) > 0 ? "destructive" : "success"}
        />
        <KPI
          icon={CheckSquare}
          label="Pending Approvals"
          value={String(pendingApprovals.data ?? 0)}
          tone={(pendingApprovals.data ?? 0) > 0 ? "warning" : "success"}
          hint="Across every workflow"
        />
        <KPI
          icon={Inbox}
          label="Pending Confirmations"
          value={String(pendingConfirmations.data ?? 0)}
          tone={(pendingConfirmations.data ?? 0) > 0 ? "warning" : "success"}
          hint="Payments awaiting review"
        />
        <KPI
          icon={HandCoins}
          label="Outstanding Payments"
          value={money(outstandingPayments.data)}
          tone="destructive"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="rounded-2xl lg:col-span-2">
          <CardHeader>
            <CardTitle>Sales — last 7 days</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={salesTrend.data ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="date" stroke="var(--color-muted-foreground)" fontSize={12} />
                <YAxis stroke="var(--color-muted-foreground)" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-card)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 8,
                  }}
                  formatter={(v: number) => money(v)}
                />
                <Line
                  type="monotone"
                  dataKey="total"
                  stroke="var(--color-primary)"
                  strokeWidth={2.5}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" /> Low-stock alerts
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(lowStock.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">
                All raw materials are above their reorder level.
              </p>
            ) : (
              <ul className="space-y-2">
                {lowStock.data!.slice(0, 8).map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between rounded-md border p-2 text-sm"
                  >
                    <span className="font-medium">{r.name}</span>
                    <span className="text-muted-foreground">
                      {num(Number(r.current_stock))} / {num(Number(r.reorder_level))} {r.unit}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="rounded-2xl lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4" /> Recent transactions
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(recentActivity.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">No activity yet for this factory.</p>
            ) : (
              <ul className="divide-y">
                {recentActivity.data!.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 py-2.5">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                      <item.icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{item.label}</div>
                      <div className="truncate text-xs text-muted-foreground">{item.detail}</div>
                    </div>
                    <div className="shrink-0 text-xs text-muted-foreground">
                      {format(new Date(item.at), "MMM d, HH:mm")}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScrollText className="h-4 w-4" /> System activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(systemActivity.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing logged yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {systemActivity.data!.map((a: any) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between rounded-md border p-2"
                  >
                    <span className="capitalize">{String(a.action).replace(/_/g, " ")}</span>
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(a.created_at), "MMM d, HH:mm")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Link
              to="/audit-logs"
              className="mt-3 block text-center text-xs text-primary hover:underline"
            >
              View full audit log →
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ============================================================================
// SALES — sales / cashier
// ============================================================================
function SalesDashboard({ factoryId }: { factoryId: string }) {
  const today = startOfDay(new Date()).toISOString();

  const salesToday = useQuery({
    queryKey: ["sd-sales-today", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("id,grand_total,balance")
        .eq("factory_id", factoryId)
        .gte("created_at", today);
      if (error) throw error;
      return data ?? [];
    },
  });
  const availableProducts = useQuery({
    queryKey: ["sd-available-products", factoryId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("factory_id", factoryId)
        .eq("active", true)
        .gt("current_stock", 0);
      if (error) throw error;
      return count ?? 0;
    },
  });
  const outstandingBalances = useQuery({
    queryKey: ["sd-outstanding-balances", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("outstanding_balance")
        .eq("factory_id", factoryId);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.outstanding_balance ?? 0), 0);
    },
  });
  const recentSales = useQuery({
    queryKey: ["sd-recent-sales", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("id,invoice_number,customer_name,grand_total,balance,created_at")
        .eq("factory_id", factoryId)
        .order("created_at", { ascending: false })
        .limit(8);
      if (error) throw error;
      return data ?? [];
    },
  });

  const total = (salesToday.data ?? []).reduce((s, r) => s + Number(r.grand_total ?? 0), 0);
  const orders = (salesToday.data ?? []).length;
  const pending = (salesToday.data ?? []).filter((r) => Number(r.balance) > 0).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales Dashboard"
        hint="Today's floor — orders, stock on hand, and what customers still owe."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <KPI icon={TrendingUp} label="Today's Sales" value={money(total)} />
        <KPI icon={ShoppingCart} label="Orders" value={String(orders)} tone="success" />
        <KPI
          icon={Package}
          label="Available Products"
          value={String(availableProducts.data ?? 0)}
        />
        <KPI
          icon={AlertTriangle}
          label="Pending Orders"
          value={String(pending)}
          hint="Not yet fully paid"
          tone={pending > 0 ? "warning" : "success"}
        />
        <KPI
          icon={HandCoins}
          label="Outstanding Customer Balances"
          value={money(outstandingBalances.data)}
          tone="destructive"
        />
      </div>
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Recent sales</CardTitle>
        </CardHeader>
        <CardContent>
          {(recentSales.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No sales recorded yet.</p>
          ) : (
            <ul className="divide-y">
              {recentSales.data!.map((s: any) => (
                <li key={s.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div>
                    <div className="font-medium">{s.invoice_number}</div>
                    <div className="text-xs text-muted-foreground">
                      {s.customer_name ?? "Walk-in"} ·{" "}
                      {format(new Date(s.created_at), "MMM d, HH:mm")}
                    </div>
                  </div>
                  <div className="text-right">
                    <div>{money(Number(s.grand_total))}</div>
                    {Number(s.balance) > 0 && (
                      <Badge variant="destructive" className="mt-0.5">
                        {money(Number(s.balance))} due
                      </Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================================
// INVENTORY — inventory_officer (raw materials)
// ============================================================================
function InventoryDashboard({ factoryId }: { factoryId: string }) {
  const materials = useQuery({
    queryKey: ["id-materials", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_materials")
        .select("id,name,unit,current_stock,reorder_level")
        .eq("factory_id", factoryId)
        .eq("active", true);
      if (error) throw error;
      return data ?? [];
    },
  });
  const pendingPurchaseRequests = useQuery({
    queryKey: ["id-pending-requests", factoryId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("production_requests")
        .select("id", { count: "exact", head: true })
        .eq("factory_id", factoryId)
        .eq("approval_status", "pending");
      if (error) throw error;
      return count ?? 0;
    },
  });
  const materialsIssued = useQuery({
    queryKey: ["id-materials-issued", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_material_movements")
        .select("id,quantity")
        .eq("factory_id", factoryId)
        .eq("movement_type", "issued")
        .gte("created_at", subDays(new Date(), 6).toISOString());
      if (error) throw error;
      return data ?? [];
    },
  });

  const low = (materials.data ?? []).filter(
    (m) => Number(m.current_stock) <= Number(m.reorder_level ?? 0),
  );
  const critical = (materials.data ?? []).filter(
    (m) => Number(m.current_stock) <= Number(m.reorder_level ?? 0) * 0.5,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory Dashboard"
        hint="Raw material stock health and what's moving in and out."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <KPI icon={Boxes} label="Raw Materials" value={String((materials.data ?? []).length)} />
        <KPI
          icon={AlertTriangle}
          label="Low Stock"
          value={String(low.length)}
          tone={low.length > 0 ? "warning" : "success"}
        />
        <KPI
          icon={AlertTriangle}
          label="Critical Stock"
          value={String(critical.length)}
          hint="At or below half of reorder level"
          tone={critical.length > 0 ? "destructive" : "success"}
        />
        <KPI
          icon={ClipboardList}
          label="Pending Purchase Requests"
          value={String(pendingPurchaseRequests.data ?? 0)}
          tone={(pendingPurchaseRequests.data ?? 0) > 0 ? "warning" : "success"}
        />
        <KPI
          icon={PackageMinus}
          label="Materials Issued (7d)"
          value={num(
            (materialsIssued.data ?? []).reduce((s, r) => s + Math.abs(Number(r.quantity)), 0),
          )}
        />
      </div>
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" /> Critical &amp; low stock
          </CardTitle>
        </CardHeader>
        <CardContent>
          {low.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Every material is above its reorder level.
            </p>
          ) : (
            <ul className="space-y-2">
              {low.slice(0, 12).map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between rounded-md border p-2 text-sm"
                >
                  <span className="font-medium">{m.name}</span>
                  <span
                    className={
                      critical.includes(m)
                        ? "text-destructive font-medium"
                        : "text-muted-foreground"
                    }
                  >
                    {num(Number(m.current_stock))} / {num(Number(m.reorder_level))} {m.unit}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================================
// PRODUCTION — production
// ============================================================================
function ProductionDashboard({ factoryId }: { factoryId: string }) {
  const today = startOfDay(new Date()).toISOString();
  const weekAgo = subDays(new Date(), 6).toISOString();

  const runsToday = useQuery({
    queryKey: ["pd-runs-today", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production")
        .select("id,quantity_produced,batch_number,products(name)")
        .eq("factory_id", factoryId)
        .gte("created_at", today);
      if (error) throw error;
      return data ?? [];
    },
  });
  const materialsAwaitingIssue = useQuery({
    queryKey: ["pd-awaiting-issue", factoryId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("production_requests")
        .select("id", { count: "exact", head: true })
        .eq("factory_id", factoryId)
        .eq("approval_status", "approved")
        .eq("materials_issued", false);
      if (error) throw error;
      return count ?? 0;
    },
  });
  const readyToRun = useQuery({
    queryKey: ["pd-ready-to-run", factoryId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("production_requests")
        .select("id", { count: "exact", head: true })
        .eq("factory_id", factoryId)
        .eq("production_status", "materials_issued");
      if (error) throw error;
      return count ?? 0;
    },
  });
  const batchesThisWeek = useQuery({
    queryKey: ["pd-batches-week", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production")
        .select("batch_number")
        .eq("factory_id", factoryId)
        .gte("created_at", weekAgo);
      if (error) throw error;
      return new Set((data ?? []).map((r) => r.batch_number).filter(Boolean)).size;
    },
  });
  const recentRuns = useQuery({
    queryKey: ["pd-recent-runs", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production")
        .select("id,production_number,quantity_produced,unit,created_at,products(name)")
        .eq("factory_id", factoryId)
        .order("created_at", { ascending: false })
        .limit(8);
      if (error) throw error;
      return data ?? [];
    },
  });

  const producedToday = (runsToday.data ?? []).reduce(
    (s, r) => s + Number(r.quantity_produced ?? 0),
    0,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Production Dashboard"
        hint="What's queued, what's running, and what shipped today."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <KPI
          icon={FactoryIcon}
          label="Production Today"
          value={num(producedToday)}
          tone="success"
        />
        <KPI
          icon={ClipboardList}
          label="Ready To Run"
          value={String(readyToRun.data ?? 0)}
          hint="Requests with materials already issued"
        />
        <KPI
          icon={PackageMinus}
          label="Materials Awaiting Issue"
          value={String(materialsAwaitingIssue.data ?? 0)}
          tone={(materialsAwaitingIssue.data ?? 0) > 0 ? "warning" : "success"}
        />
        <KPI icon={Boxes} label="Batches This Week" value={String(batchesThisWeek.data ?? 0)} />
        <KPI
          icon={CheckSquare}
          label="Completed Runs Today"
          value={String((runsToday.data ?? []).length)}
          tone="success"
        />
      </div>
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Recent production runs</CardTitle>
        </CardHeader>
        <CardContent>
          {(recentRuns.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No production runs yet.</p>
          ) : (
            <ul className="divide-y">
              {recentRuns.data!.map((r: any) => (
                <li key={r.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div>
                    <div className="font-medium">{r.products?.name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.production_number} · {format(new Date(r.created_at), "MMM d, HH:mm")}
                    </div>
                  </div>
                  <div>
                    {num(Number(r.quantity_produced))} {r.unit}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================================
// STORE — store_officer (finished goods)
// ============================================================================
function StoreDashboard({ factoryId }: { factoryId: string }) {
  const today = startOfDay(new Date()).toISOString();

  const products = useQuery({
    queryKey: ["sto-products", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,current_stock,reorder_level")
        .eq("factory_id", factoryId)
        .eq("active", true);
      if (error) throw error;
      return data ?? [];
    },
  });
  const producedToday = useQuery({
    queryKey: ["sto-produced-today", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production")
        .select("quantity_produced")
        .eq("factory_id", factoryId)
        .gte("created_at", today);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.quantity_produced ?? 0), 0);
    },
  });
  const recentIssues = useQuery({
    queryKey: ["sto-recent-issues", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("inventory_movements")
        .select("id,movement_type,quantity,created_at,products(name,unit)")
        .eq("factory_id", factoryId)
        .in("movement_type", ["issued", "sold", "transferred"])
        .order("created_at", { ascending: false })
        .limit(8);
      if (error) throw error;
      return data ?? [];
    },
  });
  const pendingDispatch = useQuery({
    queryKey: ["sto-pending-dispatch", factoryId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("deliveries")
        .select("id", { count: "exact", head: true })
        .eq("factory_id", factoryId)
        .not("status", "in", "(delivered,cancelled)");
      if (error) throw error;
      return count ?? 0;
    },
  });

  const totalUnits = (products.data ?? []).reduce((s, r) => s + Number(r.current_stock ?? 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Store Dashboard"
        hint="Finished-goods stock, what just arrived, and what's waiting to go out."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <KPI
          icon={Package}
          label="Finished Goods (SKUs)"
          value={String((products.data ?? []).length)}
        />
        <KPI icon={Boxes} label="Available Stock (units)" value={num(totalUnits)} tone="success" />
        <KPI
          icon={FactoryIcon}
          label="Produced Today"
          value={num(producedToday.data)}
          hint="Just arrived from Production"
        />
        <KPI
          icon={Truck}
          label="Pending Dispatch"
          value={String(pendingDispatch.data ?? 0)}
          tone={(pendingDispatch.data ?? 0) > 0 ? "warning" : "success"}
        />
      </div>
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Recent issues</CardTitle>
        </CardHeader>
        <CardContent>
          {(recentIssues.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No recent stock movements.</p>
          ) : (
            <ul className="divide-y">
              {recentIssues.data!.map((m: any) => (
                <li key={m.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div>
                    <div className="font-medium">{m.products?.name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground capitalize">
                      {m.movement_type} · {format(new Date(m.created_at), "MMM d, HH:mm")}
                    </div>
                  </div>
                  <div>
                    {num(Math.abs(Number(m.quantity)))} {m.products?.unit ?? ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================================
// FINANCE — accountant / payroll_officer
// ============================================================================
// ============================================================================
// GENERIC — any role without a dedicated variant (costing_officer, logistics, hr)
// ============================================================================
function GenericDashboard({ factoryId }: { factoryId: string }) {
  void factoryId;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        hint="Use the sidebar to jump into the modules you have access to."
      />
      <Card className="rounded-2xl border-dashed">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          <Users className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
          No dedicated dashboard is defined for your role yet — your access is unchanged, this is
          just the landing view.
        </CardContent>
      </Card>
    </div>
  );
}
