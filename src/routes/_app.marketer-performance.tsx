import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { money, num } from "@/lib/format";
import { exportCsv } from "@/lib/export";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { toast } from "sonner";
import { Award, Banknote, Download, Package, Pencil, TrendingUp } from "lucide-react";

// Marketer (sales rep) performance and commission. Commission is a fixed
// amount per unit, set per product, captured on each rep sale when it is
// approved, less the commission on units customers returned
// (20260928130000_marketer_commission.sql). Paying it out is done through
// Payroll or Expenses; this page works out what is owed.
export const Route = createFileRoute("/_app/marketer-performance")({
  head: () => ({
    meta: [
      { title: "Performance & Commission — Elim Table Water" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (
    <>
      <SectionTabs section="Warehouse" />
      <RequireAccess module="distribution">
        <PerformancePage />
      </RequireAccess>
    </>
  ),
});

type PerfRow = {
  sales_rep_id: string;
  full_name: string;
  rep_status: string;
  sales_count: number;
  units_sold: number;
  sales_value: number;
  commission_earned: number;
  units_returned: number;
  commission_reversed: number;
  net_commission: number;
  cash_remitted: number;
};

type RateRow = {
  id: string;
  name: string;
  unit: string | null;
  product_commission_rates: { amount_per_unit: number; updated_at: string } | null;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = () => {
  const d = new Date();
  return iso(new Date(d.getFullYear(), d.getMonth(), 1));
};

function PerformancePage() {
  const { data: factoryId } = useFactoryId();
  const { canApprove } = usePermissions();
  const canSetRates = canApprove("distribution");
  const qc = useQueryClient();
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(() => iso(new Date()));
  const [editing, setEditing] = useState<RateRow | null>(null);
  const rangeOk = !!from && !!to && from <= to;

  useRealtimeInvalidate(
    ["sales", "sales_returns", "rep_remittances", "product_commission_rates"],
    [["marketer-performance"], ["commission-rates"]],
  );

  const perf = useQuery({
    queryKey: ["marketer-performance", factoryId, from, to],
    enabled: !!factoryId && rangeOk,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("marketer_performance", {
        p_factory: factoryId!,
        p_from: from,
        p_to: to,
      });
      if (error) throw error;
      return (data ?? []) as PerfRow[];
    },
  });

  const rates = useQuery({
    queryKey: ["commission-rates", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,unit,product_commission_rates(amount_per_unit,updated_at)")
        .eq("factory_id", factoryId!)
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as RateRow[];
    },
  });

  const rows = useMemo(() => perf.data ?? [], [perf.data]);
  const totals = rows.reduce(
    (t, r) => ({
      value: t.value + Number(r.sales_value),
      units: t.units + Number(r.units_sold),
      commission: t.commission + Number(r.net_commission),
      remitted: t.remitted + Number(r.cash_remitted),
    }),
    { value: 0, units: 0, commission: 0, remitted: 0 },
  );
  const top = rows.find((r) => Number(r.sales_value) > 0);
  const unrated = (rates.data ?? []).filter(
    (p) => Number(p.product_commission_rates?.amount_per_unit ?? 0) === 0,
  ).length;

  const exportRows = () =>
    exportCsv(
      `marketer-commission-${from}-to-${to}`,
      [
        { key: "full_name", label: "Marketer" },
        { key: "sales_count", label: "Sales" },
        { key: "units_sold", label: "Units sold" },
        { key: "sales_value", label: "Sales value" },
        { key: "commission_earned", label: "Commission earned" },
        { key: "units_returned", label: "Units returned" },
        { key: "commission_reversed", label: "Commission on returns" },
        { key: "net_commission", label: "Net commission" },
        { key: "cash_remitted", label: "Cash remitted" },
      ],
      rows.map((r) => ({ ...r })),
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Performance &amp; Commission</h1>
          <p className="text-sm text-muted-foreground">
            What each marketer sold in the period and the commission they earned: a fixed amount per
            unit, less units customers returned.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label className="text-xs">From</Label>
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button variant="outline" className="gap-2" disabled={!rows.length} onClick={exportRows}>
            <Download className="h-4 w-4" /> CSV
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi icon={TrendingUp} label="Marketer sales" value={money(totals.value)} />
        <Kpi icon={Package} label="Units sold" value={num(totals.units)} />
        <Kpi icon={Award} label="Commission due" value={money(totals.commission)} />
        <Kpi icon={Banknote} label="Cash remitted" value={money(totals.remitted)} />
      </div>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>By marketer</CardTitle>
          <p className="text-sm text-muted-foreground">
            {top
              ? `Top seller this period: ${top.full_name}.`
              : "No marketer sales in this period."}
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Marketer</TableHead>
                <TableHead className="text-right">Sales</TableHead>
                <TableHead className="text-right">Units sold</TableHead>
                <TableHead className="text-right">Sales value</TableHead>
                <TableHead className="text-right">Commission</TableHead>
                <TableHead className="text-right">Returned</TableHead>
                <TableHead className="text-right">Net commission</TableHead>
                <TableHead className="text-right">Cash remitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                    {!rangeOk
                      ? "Pick a valid date range."
                      : perf.isLoading
                        ? "Loading…"
                        : "No marketers yet. Add them under Distribution → Sales Reps."}
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.sales_rep_id}>
                  <TableCell className="font-medium">
                    {r.full_name}
                    {r.rep_status !== "active" && (
                      <Badge variant="outline" className="ml-2 text-muted-foreground">
                        {r.rep_status}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{r.sales_count}</TableCell>
                  <TableCell className="text-right">{num(Number(r.units_sold))}</TableCell>
                  <TableCell className="text-right">{money(Number(r.sales_value))}</TableCell>
                  <TableCell className="text-right">{money(Number(r.commission_earned))}</TableCell>
                  <TableCell className="text-right">
                    {Number(r.units_returned) > 0 ? (
                      <span className="text-destructive">
                        {num(Number(r.units_returned))} (−{money(Number(r.commission_reversed))})
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    {money(Number(r.net_commission))}
                  </TableCell>
                  <TableCell className="text-right">{money(Number(r.cash_remitted))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Commission rates</CardTitle>
          <p className="text-sm text-muted-foreground">
            Amount a marketer earns per unit sold. A new rate applies to sales approved from now on;
            commission already earned keeps the rate it was earned at.
            {unrated > 0 && ` ${unrated} product(s) have no rate and earn no commission.`}
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Commission per unit</TableHead>
                <TableHead>Last changed</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(rates.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    {rates.isLoading ? "Loading…" : "No products to show."}
                  </TableCell>
                </TableRow>
              )}
              {(rates.data ?? []).map((p) => {
                const rate = p.product_commission_rates;
                return (
                  <TableRow key={p.id}>
                    <TableCell>
                      {p.name}
                      {p.unit && <span className="text-muted-foreground"> · per {p.unit}</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      {rate && Number(rate.amount_per_unit) > 0 ? (
                        money(Number(rate.amount_per_unit))
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {rate ? new Date(rate.updated_at).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell>
                      {canSetRates && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Set commission"
                          onClick={() => setEditing(p)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        {editing && (
          <RateDialog
            product={editing}
            onDone={() => {
              setEditing(null);
              qc.invalidateQueries({ queryKey: ["commission-rates"] });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

function RateDialog({ product, onDone }: { product: RateRow; onDone: () => void }) {
  const [amount, setAmount] = useState(
    String(Number(product.product_commission_rates?.amount_per_unit ?? 0)),
  );
  const [reason, setReason] = useState("");
  const save = useMutation({
    mutationFn: async () => {
      const value = Number(amount);
      if (!Number.isFinite(value) || value < 0) throw new Error("Commission must be 0 or more");
      const { error } = await supabase.rpc("set_product_commission", {
        p_product: product.id,
        p_amount: value,
        p_reason: reason.trim() || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Commission rate saved");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Commission — {product.name}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Amount per {product.unit ?? "unit"}</Label>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div>
          <Label>Reason (optional)</Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <p className="text-xs text-muted-foreground">
          Applies to marketer sales approved from now on. Set 0 to stop paying commission on this
          product.
        </p>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save rate"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function Kpi({ icon: Icon, label, value }: { icon: typeof Award; label: string; value: string }) {
  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row items-center gap-2 pb-2">
        <Icon className="h-4 w-4 text-primary" />
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="text-2xl font-semibold">{value}</CardContent>
    </Card>
  );
}
