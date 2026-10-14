import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { KPI } from "@/lib/dashboard-kit";
import { money, num } from "@/lib/format";
import { PosDialog } from "./_app.sales";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Boxes, PackageOpen, ShoppingCart, Store, TrendingUp } from "lucide-react";

export const Route = createFileRoute("/_app/retail-outlet")({
  head: () => ({
    meta: [{ title: "Retail Outlet — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <>
      <SectionTabs section="Retail" />
      <RequireAccess module="sales">
        <RetailOutletPage />
      </RequireAccess>
    </>
  ),
});

// The company's own shop. Its stock is separate from the Warehouse: products
// arrive on a Warehouse dispatch (adding to what the outlet holds) and leave
// when the outlet sells to walk-in customers. This page shows what it holds
// right now, what came in and went out over a period, and every movement.
// Stock itself only moves through the existing distribution RPCs (dispatch,
// sale, return, reversal) -- the outlet is a sales_reps row with kind='outlet'.

type Outlet = { id: string; full_name: string; status: string };
type StockRow = {
  product_id: string;
  quantity: number;
  products: { name: string; unit: string; unit_price: number } | null;
};
type Movement = {
  id: string;
  created_at: string;
  movement_type: string;
  product_id: string;
  quantity: number;
  quantity_after: number | null;
  reference: string | null;
  reason: string | null;
  products: { name: string; unit: string } | null;
};
type SaleRow = {
  id: string;
  invoice_number: string;
  sale_date: string;
  customer_name: string | null;
  grand_total: number;
  status: string;
};

type Period = "today" | "week" | "month" | "all";
const PERIODS: { value: Period; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

const periodStart = (p: Period): Date | null => {
  const now = new Date();
  if (p === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (p === "week") return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  if (p === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  return null;
};

// rep_stock_movements.movement_type, as the outlet reads it. Quantities are
// stored signed; "in" types add to outlet stock, "out" types take from it.
const MOVEMENT_LABEL: Record<string, string> = {
  dispatch_in: "Received from Warehouse",
  sold: "Sold",
  returned_out: "Returned to Warehouse",
  damaged_out: "Damaged",
  reversal: "Reversed",
  adjustment: "Adjustment",
};

function RetailOutletPage() {
  const { data: factoryId } = useFactoryId();
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canSell = can("sales", "create");
  const [outletId, setOutletId] = useState<string>("");
  const [period, setPeriod] = useState<Period>("today");
  const [posOpen, setPosOpen] = useState(false);

  useRealtimeInvalidate(
    ["rep_stock", "rep_stock_movements", "sales"],
    [["outlet-stock"], ["outlet-movements"], ["outlet-sales"]],
  );

  const outlets = useQuery({
    queryKey: ["outlets", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_reps")
        .select("id,full_name,status")
        .eq("factory_id", factoryId!)
        .eq("kind", "outlet")
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as Outlet[];
    },
  });

  // Default to the first active outlet once the list loads.
  useEffect(() => {
    if (outletId || !outlets.data?.length) return;
    setOutletId((outlets.data.find((o) => o.status === "active") ?? outlets.data[0]).id);
  }, [outlets.data, outletId]);

  const stock = useQuery({
    queryKey: ["outlet-stock", outletId],
    enabled: !!outletId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rep_stock")
        .select("product_id,quantity,products(name,unit,unit_price)")
        .eq("sales_rep_id", outletId);
      if (error) throw error;
      return (data ?? []) as unknown as StockRow[];
    },
  });

  const from = periodStart(period);
  const movements = useQuery({
    queryKey: ["outlet-movements", outletId, period],
    enabled: !!outletId,
    queryFn: async () => {
      let q = supabase
        .from("rep_stock_movements")
        .select(
          "id,created_at,movement_type,product_id,quantity,quantity_after,reference,reason,products(name,unit)",
        )
        .eq("sales_rep_id", outletId)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (from) q = q.gte("created_at", from.toISOString());
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Movement[];
    },
  });

  const sales = useQuery({
    queryKey: ["outlet-sales", outletId, period],
    enabled: !!outletId,
    queryFn: async () => {
      let q = supabase
        .from("sales")
        .select("id,invoice_number,sale_date,customer_name,grand_total,status")
        .eq("sales_rep_id", outletId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(300);
      if (from) q = q.gte("sale_date", from.toISOString().slice(0, 10));
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as SaleRow[];
    },
  });

  // Per product: what came in and went out over the period, and what is on
  // the shelf now (every product the outlet holds or touched in the period).
  const byProduct = useMemo(() => {
    const rows = new Map<
      string,
      {
        name: string;
        unit: string;
        price: number;
        received: number;
        sold: number;
        returned: number;
        remaining: number;
      }
    >();
    const row = (id: string, name: string, unit: string, price = 0) => {
      let r = rows.get(id);
      if (!r) {
        r = { name, unit, price, received: 0, sold: 0, returned: 0, remaining: 0 };
        rows.set(id, r);
      }
      return r;
    };
    for (const s of stock.data ?? []) {
      const r = row(
        s.product_id,
        s.products?.name ?? "—",
        s.products?.unit ?? "",
        Number(s.products?.unit_price ?? 0),
      );
      r.remaining = Number(s.quantity);
    }
    for (const m of movements.data ?? []) {
      const r = row(m.product_id, m.products?.name ?? "—", m.products?.unit ?? "");
      const qty = Math.abs(Number(m.quantity));
      if (m.movement_type === "dispatch_in") r.received += qty;
      else if (m.movement_type === "sold") r.sold += qty;
      else if (m.movement_type === "returned_out" || m.movement_type === "damaged_out")
        r.returned += qty;
      // "reversal" covers two cases, told apart by sign: a reversed dispatch
      // takes stock back out (negative), a deleted sale puts it back (positive).
      else if (m.movement_type === "reversal") {
        if (Number(m.quantity) < 0) r.received -= qty;
        else r.sold -= qty;
      }
    }
    return [...rows.entries()]
      .map(([id, r]) => ({ id, ...r }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [stock.data, movements.data]);

  const unitsOnHand = byProduct.reduce((t, r) => t + r.remaining, 0);
  const stockValue = byProduct.reduce((t, r) => t + r.remaining * r.price, 0);
  const unitsReceived = byProduct.reduce((t, r) => t + r.received, 0);
  const unitsSold = byProduct.reduce((t, r) => t + r.sold, 0);
  const salesValue = (sales.data ?? [])
    .filter((s) => s.status === "posted")
    .reduce((t, s) => t + Number(s.grand_total), 0);

  if (!factoryId) return null;

  if (outlets.isSuccess && outlets.data.length === 0) {
    return (
      <Card className="rounded-2xl border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Store className="h-5 w-5" /> No retail outlet set up
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Add one on the Distribution page (Reps &amp; Outlets → Add Rep / Outlet, type "Retail
          outlet"). The Warehouse then stocks it with a dispatch.
        </CardContent>
      </Card>
    );
  }

  const periodLabel = PERIODS.find((p) => p.value === period)?.label.toLowerCase();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Retail Outlet</h1>
          <p className="text-sm text-muted-foreground">
            The company shop&apos;s own stock: what the Warehouse sent, what was sold to walk-in
            customers, and what is left on the shelf.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(outlets.data ?? []).length > 1 && (
            <Select value={outletId} onValueChange={setOutletId}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Outlet" />
              </SelectTrigger>
              <SelectContent>
                {(outlets.data ?? []).map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canSell && outletId && (
            <Dialog open={posOpen} onOpenChange={setPosOpen}>
              <DialogTrigger asChild>
                <Button className="gap-2">
                  <ShoppingCart className="h-4 w-4" /> New outlet sale
                </Button>
              </DialogTrigger>
              {posOpen && (
                <PosDialog
                  factoryId={factoryId}
                  presetSalesRepId={outletId}
                  onDone={() => {
                    setPosOpen(false);
                    qc.invalidateQueries({ queryKey: ["outlet-stock"] });
                    qc.invalidateQueries({ queryKey: ["outlet-movements"] });
                    qc.invalidateQueries({ queryKey: ["outlet-sales"] });
                    qc.invalidateQueries({ queryKey: ["sales-list"] });
                  }}
                />
              )}
            </Dialog>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPI
          icon={Boxes}
          label="Stock Remaining"
          value={num(unitsOnHand)}
          hint={`Worth ${money(stockValue)} at selling price`}
        />
        <KPI
          icon={PackageOpen}
          label="Received"
          value={num(unitsReceived)}
          hint={`From the Warehouse, ${periodLabel}`}
          tone="success"
        />
        <KPI icon={ShoppingCart} label="Units Sold" value={num(unitsSold)} hint={periodLabel} />
        <KPI
          icon={TrendingUp}
          label="Sales Value"
          value={money(salesValue)}
          hint={`Approved sales, ${periodLabel}`}
          tone="success"
        />
      </div>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Stock by product</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Sold</TableHead>
                <TableHead className="text-right">Returned / damaged</TableHead>
                <TableHead className="text-right">Remaining now</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byProduct.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-right">{num(r.received)}</TableCell>
                  <TableCell className="text-right">{num(r.sold)}</TableCell>
                  <TableCell className="text-right">{num(r.returned)}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {num(r.remaining)} {r.unit}
                    {r.remaining <= 0 && (
                      <Badge variant="destructive" className="ml-2">
                        Out
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{money(r.remaining * r.price)}</TableCell>
                </TableRow>
              ))}
              {byProduct.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    No stock yet. The Warehouse adds stock with a dispatch to this outlet
                    (Distribution → Dispatches).
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Stock activity</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Activity</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Left</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(movements.data ?? []).slice(0, 100).map((m) => {
                  const q = Number(m.quantity);
                  return (
                    <TableRow key={m.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {new Date(m.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          {m.movement_type === "reversal"
                            ? q < 0
                              ? "Dispatch reversed"
                              : "Sale cancelled — back on shelf"
                            : (MOVEMENT_LABEL[m.movement_type] ?? m.movement_type)}
                        </div>
                        {m.reference && (
                          <div className="font-mono text-[11px] text-muted-foreground">
                            {m.reference}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>{m.products?.name ?? "—"}</TableCell>
                      <TableCell
                        className={`text-right font-medium ${q < 0 ? "text-destructive" : "text-success"}`}
                      >
                        {q > 0 ? "+" : ""}
                        {num(q)}
                      </TableCell>
                      <TableCell className="text-right">
                        {m.quantity_after == null ? "—" : num(Number(m.quantity_after))}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {(movements.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                      No activity {periodLabel}.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Outlet sales</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(sales.data ?? []).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">{s.invoice_number}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {new Date(s.sale_date).toLocaleDateString()}
                    </TableCell>
                    <TableCell>{s.customer_name ?? "Walk-in"}</TableCell>
                    <TableCell className="text-right">{money(s.grand_total)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={s.status === "posted" ? "default" : "secondary"}
                        className="capitalize"
                      >
                        {s.status.replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
                {(sales.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                      No sales {periodLabel}.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
