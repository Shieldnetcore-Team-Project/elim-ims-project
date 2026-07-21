import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useActiveFactoryCode } from "@/lib/factory-store";
import { getFactoryIdByCode } from "@/lib/factories";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar,
} from "recharts";
import { money, num } from "@/lib/format";
import {
  TrendingUp, FactoryIcon, Receipt, AlertTriangle, PackageCheck, HandCoins,
  Boxes, Wallet, Users,
} from "lucide-react";
import { format, startOfDay, subDays } from "date-fns";

export const Route = createFileRoute("/_app/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: Dashboard,
});

function useFactoryId() {
  const code = useActiveFactoryCode();
  return useQuery({
    queryKey: ["factory-id", code],
    queryFn: () => getFactoryIdByCode(code),
    staleTime: Infinity,
  });
}

function KPI({ icon: Icon, label, value, hint, tone = "primary" }: {
  icon: React.ElementType; label: string; value: string; hint?: string;
  tone?: "primary" | "success" | "warning" | "destructive";
}) {
  const toneClasses = {
    primary: "bg-primary/10 text-primary",
    success: "bg-success/10 text-success",
    warning: "bg-warning/15 text-warning",
    destructive: "bg-destructive/10 text-destructive",
  }[tone];
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
            <div className="mt-2 text-2xl font-semibold">{value}</div>
            {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
          </div>
          <div className={`grid h-10 w-10 place-items-center rounded-xl ${toneClasses}`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Dashboard() {
  const factory = useFactoryId();
  const factoryId = factory.data;

  const today = startOfDay(new Date()).toISOString();
  const weekAgo = startOfDay(subDays(new Date(), 6)).toISOString();

  const salesToday = useQuery({
    queryKey: ["sales-today", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales").select("grand_total")
        .eq("factory_id", factoryId!).gte("created_at", today);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.grand_total ?? 0), 0);
    },
  });

  const productionToday = useQuery({
    queryKey: ["production-today", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production").select("quantity_produced")
        .eq("factory_id", factoryId!).gte("created_at", today);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.quantity_produced ?? 0), 0);
    },
  });

  const expensesToday = useQuery({
    queryKey: ["expenses-today", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expenses").select("amount")
        .eq("factory_id", factoryId!).gte("created_at", today);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
    },
  });

  const outstandingDebts = useQuery({
    queryKey: ["outstanding-debts", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("debts").select("outstanding")
        .eq("factory_id", factoryId!).neq("status", "paid");
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.outstanding ?? 0), 0);
    },
  });

  const rawStockValue = useQuery({
    queryKey: ["raw-stock", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_materials").select("current_stock,unit_cost")
        .eq("factory_id", factoryId!);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.current_stock ?? 0) * Number(r.unit_cost ?? 0), 0);
    },
  });

  const finishedGoods = useQuery({
    queryKey: ["finished-goods", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products").select("current_stock")
        .eq("factory_id", factoryId!);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.current_stock ?? 0), 0);
    },
  });

  const payrollDue = useQuery({
    queryKey: ["payroll-due", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll").select("net_salary,status")
        .eq("factory_id", factoryId!).eq("status", "pending");
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.net_salary ?? 0), 0);
    },
  });

  const lowStock = useQuery({
    queryKey: ["low-stock", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_materials").select("id,name,current_stock,reorder_level,unit")
        .eq("factory_id", factoryId!);
      if (error) throw error;
      return (data ?? []).filter((r) => Number(r.current_stock) <= Number(r.reorder_level ?? 0));
    },
  });

  const salesTrend = useQuery({
    queryKey: ["sales-trend", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales").select("sale_date,grand_total")
        .eq("factory_id", factoryId!).gte("sale_date", format(subDays(new Date(), 6), "yyyy-MM-dd"))
        .order("sale_date");
      if (error) throw error;
      const bucket: Record<string, number> = {};
      for (let i = 6; i >= 0; i--) {
        const d = format(subDays(new Date(), i), "MMM d");
        bucket[d] = 0;
      }
      (data ?? []).forEach((r) => {
        const key = format(new Date(r.sale_date as string), "MMM d");
        if (key in bucket) bucket[key] += Number(r.grand_total ?? 0);
      });
      return Object.entries(bucket).map(([date, total]) => ({ date, total }));
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Live overview for the currently selected factory.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KPI icon={TrendingUp} label="Today's Sales" value={money(salesToday.data)} />
        <KPI icon={FactoryIcon} label="Today's Production" value={num(productionToday.data)} tone="success" />
        <KPI icon={Receipt} label="Today's Expenses" value={money(expensesToday.data)} tone="warning" />
        <KPI icon={HandCoins} label="Outstanding Debts" value={money(outstandingDebts.data)} tone="destructive" />
        <KPI icon={Boxes} label="Raw Material Stock Value" value={money(rawStockValue.data)} />
        <KPI icon={PackageCheck} label="Finished Goods (units)" value={num(finishedGoods.data)} tone="success" />
        <KPI icon={Wallet} label="Payroll Due" value={money(payrollDue.data)} tone="warning" />
        <KPI icon={AlertTriangle} label="Low-Stock Items" value={String(lowStock.data?.length ?? 0)}
             tone={(lowStock.data?.length ?? 0) > 0 ? "destructive" : "success"} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="rounded-2xl lg:col-span-2">
          <CardHeader><CardTitle>Sales — last 7 days</CardTitle></CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={salesTrend.data ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="date" stroke="var(--color-muted-foreground)" fontSize={12} />
                <YAxis stroke="var(--color-muted-foreground)" fontSize={12} />
                <Tooltip
                  contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 8 }}
                  formatter={(v: number) => money(v)}
                />
                <Line type="monotone" dataKey="total" stroke="var(--color-primary)" strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader><CardTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-warning" /> Low-stock alerts</CardTitle></CardHeader>
          <CardContent>
            {(lowStock.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">All raw materials are above their reorder level.</p>
            ) : (
              <ul className="space-y-2">
                {lowStock.data!.slice(0, 8).map((r) => (
                  <li key={r.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
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

      <Card className="rounded-2xl">
        <CardHeader><CardTitle className="flex items-center gap-2"><Users className="h-4 w-4" /> Quick actions</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "New Sale", href: "/sales" },
            { label: "Add Production", href: "/production" },
            { label: "Receive Payment", href: "/payments" },
            { label: "Record Expense", href: "/expenses" },
          ].map((a) => (
            <a
              key={a.href}
              href={a.href}
              className="rounded-xl border p-4 text-center text-sm font-medium transition-colors hover:bg-white hover:text-primary hover:shadow"
            >
              {a.label}
            </a>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
