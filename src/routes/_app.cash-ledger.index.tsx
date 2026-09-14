import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from "recharts";
import { money } from "@/lib/format";
import { TrendingUp, TrendingDown, Wallet, Banknote, CreditCard, Landmark, Coins } from "lucide-react";
import { startOfWeek, startOfMonth, startOfYear, format } from "date-fns";

export const Route = createFileRoute("/_app/cash-ledger/")({
  head: () => ({
    meta: [{ title: "Cash Flow Overview — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="cash-flow">
      <CashFlowOverview />
    </RequireAccess>
  ),
});

type CategoryRow = { key: string; label: string; direction: "in" | "out"; amount: number };

const PRESETS: { key: string; label: string; from: () => Date }[] = [
  { key: "week", label: "This week", from: () => startOfWeek(new Date()) },
  { key: "month", label: "This month", from: () => startOfMonth(new Date()) },
  { key: "year", label: "This year", from: () => startOfYear(new Date()) },
];

function CashFlowOverview() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const currency = settings.data?.currency ?? "NGN";

  const [from, setFrom] = useState(() => format(startOfMonth(new Date()), "yyyy-MM-dd"));
  const [to, setTo] = useState(() => format(new Date(), "yyyy-MM-dd"));

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setFrom(format(p.from(), "yyyy-MM-dd"));
    setTo(format(new Date(), "yyyy-MM-dd"));
  };

  const dayStart = `${from}T00:00:00`;
  const dayEnd = `${to}T23:59:59`;

  const salesIncome = useQuery({
    queryKey: ["cf-sales-income", factoryId, from, to],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments_received")
        .select("amount,payment_method")
        .eq("factory_id", factoryId!)
        .gte("payment_date", from)
        .lte("payment_date", to);
      if (error) throw error;
      const byMethod = { cash: 0, pos: 0, transfer: 0, other: 0 };
      let total = 0;
      (data ?? []).forEach((r) => {
        const amt = Number(r.amount);
        total += amt;
        const method = r.payment_method as string;
        if (method === "cash" || method === "pos" || method === "transfer") {
          byMethod[method] += amt;
        } else {
          byMethod.other += amt;
        }
      });
      return { total, ...byMethod };
    },
  });

  const inventoryPurchases = useQuery({
    queryKey: ["cf-inventory-purchases", factoryId, from, to],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_material_movements")
        .select("quantity,unit_cost")
        .eq("factory_id", factoryId!)
        .eq("movement_type", "received")
        .gte("created_at", dayStart)
        .lte("created_at", dayEnd);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.quantity) * Number(r.unit_cost ?? 0), 0);
    },
  });

  const productionCosts = useQuery({
    queryKey: ["cf-production-costs", factoryId, from, to],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production")
        .select("production_cost")
        .eq("factory_id", factoryId!)
        .gte("production_date", from)
        .lte("production_date", to);
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + Number(r.production_cost ?? 0), 0);
    },
  });

  const expenseBuckets = useQuery({
    queryKey: ["cf-expenses", factoryId, from, to],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expenses")
        .select("amount,approval_status,expense_categories(name)")
        .eq("factory_id", factoryId!)
        .eq("approval_status", "approved")
        .gte("expense_date", from)
        .lte("expense_date", to);
      if (error) throw error;
      let operating = 0,
        office = 0,
        other = 0;
      (data ?? []).forEach((r: any) => {
        const name = r.expense_categories?.name;
        const amt = Number(r.amount);
        if (name === "Office Expenses") office += amt;
        else if (name === "Other Expenses" || !name) other += amt;
        else operating += amt;
      });
      return { operating, office, other };
    },
  });

  const cashTransactions = useQuery({
    queryKey: ["cf-cash-transactions", factoryId, from, to],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cash_transactions")
        .select("amount,category")
        .eq("factory_id", factoryId!)
        .gte("transaction_date", from)
        .lte("transaction_date", to);
      if (error) throw error;
      const bucket: Record<string, number> = {
        other_income: 0,
        donation_endowment: 0,
        other_inflow: 0,
        other_outflow: 0,
      };
      (data ?? []).forEach((r) => {
        bucket[r.category] = (bucket[r.category] ?? 0) + Number(r.amount);
      });
      return bucket;
    },
  });

  const loading =
    salesIncome.isLoading ||
    inventoryPurchases.isLoading ||
    productionCosts.isLoading ||
    expenseBuckets.isLoading ||
    cashTransactions.isLoading;

  const categories: CategoryRow[] = useMemo(
    () => [
      {
        key: "sales_income",
        label: "Sales Income",
        direction: "in",
        amount: salesIncome.data?.total ?? 0,
      },
      {
        key: "other_income",
        label: "Other Income",
        direction: "in",
        amount: cashTransactions.data?.other_income ?? 0,
      },
      {
        key: "donations",
        label: "Donations / Endowments",
        direction: "in",
        amount: cashTransactions.data?.donation_endowment ?? 0,
      },
      {
        key: "other_inflows",
        label: "Other Cash Inflows",
        direction: "in",
        amount: cashTransactions.data?.other_inflow ?? 0,
      },
      {
        key: "inventory_purchases",
        label: "Inventory Purchases",
        direction: "out",
        amount: inventoryPurchases.data ?? 0,
      },
      {
        key: "production_costs",
        label: "Production Costs",
        direction: "out",
        amount: productionCosts.data ?? 0,
      },
      {
        key: "operating_expenses",
        label: "Operating Expenses",
        direction: "out",
        amount: expenseBuckets.data?.operating ?? 0,
      },
      {
        key: "office_expenses",
        label: "Office Expenses",
        direction: "out",
        amount: expenseBuckets.data?.office ?? 0,
      },
      {
        key: "other_outflows",
        label: "Other Cash Outflows",
        direction: "out",
        amount: (expenseBuckets.data?.other ?? 0) + (cashTransactions.data?.other_outflow ?? 0),
      },
    ],
    [
      salesIncome.data,
      inventoryPurchases.data,
      productionCosts.data,
      expenseBuckets.data,
      cashTransactions.data,
    ],
  );

  const totalIn = categories.filter((c) => c.direction === "in").reduce((s, c) => s + c.amount, 0);
  const totalOut = categories
    .filter((c) => c.direction === "out")
    .reduce((s, c) => s + c.amount, 0);
  const net = totalIn - totalOut;

  const chartData = categories
    .filter((c) => c.amount > 0)
    .map((c) => ({
      name: c.label,
      amount: c.direction === "in" ? c.amount : -c.amount,
      direction: c.direction,
    }));

  return (
    <div className="space-y-6">
      <Card className="rounded-2xl">
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div>
            <Label>From</Label>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-40"
            />
          </div>
          <div>
            <Label>To</Label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-40"
            />
          </div>
          <div className="flex gap-2">
            {PRESETS.map((p) => (
              <Button key={p.key} size="sm" variant="outline" onClick={() => applyPreset(p)}>
                {p.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="rounded-2xl">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Total Cash In
              </div>
              <div className="mt-2 text-2xl font-semibold text-success">
                {money(totalIn, currency)}
              </div>
            </div>
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-success/10 text-success">
              <TrendingUp className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Total Cash Out
              </div>
              <div className="mt-2 text-2xl font-semibold text-destructive">
                {money(totalOut, currency)}
              </div>
            </div>
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-destructive/10 text-destructive">
              <TrendingDown className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Net Cash Flow
              </div>
              <div
                className={`mt-2 text-2xl font-semibold ${net >= 0 ? "text-success" : "text-destructive"}`}
              >
                {money(net, currency)}
              </div>
            </div>
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
              <Wallet className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="rounded-2xl">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Cash Flow
              </div>
              <div className="mt-2 text-2xl font-semibold text-success">
                {money(salesIncome.data?.cash ?? 0, currency)}
              </div>
            </div>
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-success/10 text-success">
              <Banknote className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                P.O.S Flow
              </div>
              <div className="mt-2 text-2xl font-semibold text-success">
                {money(salesIncome.data?.pos ?? 0, currency)}
              </div>
            </div>
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-success/10 text-success">
              <CreditCard className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Transfer/Bank Flow
              </div>
              <div className="mt-2 text-2xl font-semibold text-success">
                {money(salesIncome.data?.transfer ?? 0, currency)}
              </div>
            </div>
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-success/10 text-success">
              <Landmark className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Total Money Received
              </div>
              <div className="mt-2 text-2xl font-semibold text-primary">
                {money(salesIncome.data?.total ?? 0, currency)}
              </div>
            </div>
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
              <Coins className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Cash flow by category</CardTitle>
        </CardHeader>
        <CardContent className="h-80">
          {chartData.length === 0 ? (
            <p className="text-sm text-muted-foreground">No cash movement in this period.</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  type="number"
                  stroke="var(--color-muted-foreground)"
                  fontSize={12}
                  tickFormatter={(v) => money(Math.abs(v), currency)}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={160}
                  stroke="var(--color-muted-foreground)"
                  fontSize={12}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-card)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 8,
                  }}
                  formatter={(v: number) => money(Math.abs(v), currency)}
                />
                <Bar dataKey="amount" radius={[0, 4, 4, 0]}>
                  {chartData.map((d, i) => (
                    <Cell
                      key={i}
                      fill={
                        d.direction === "in" ? "var(--color-success)" : "var(--color-destructive)"
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Breakdown</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">% of total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((c) => {
                const base = c.direction === "in" ? totalIn : totalOut;
                const pct = base > 0 ? (c.amount / base) * 100 : 0;
                return (
                  <TableRow key={c.key}>
                    <TableCell className="font-medium">{c.label}</TableCell>
                    <TableCell>
                      <Badge variant={c.direction === "in" ? "secondary" : "destructive"}>
                        {c.direction === "in" ? "Inflow" : "Outflow"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{money(c.amount, currency)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {pct.toFixed(1)}%
                    </TableCell>
                  </TableRow>
                );
              })}
              {loading && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
