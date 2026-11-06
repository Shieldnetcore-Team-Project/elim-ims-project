import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { RemittanceCommission } from "@/components/accounting/remittance-commission";
import { SectionTabs } from "@/components/layout/section-tabs";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
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
import { money, num } from "@/lib/format";
import { exportCsv } from "@/lib/export";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { Award, Banknote, Download, Package, TrendingUp } from "lucide-react";

// Marketer performance and monthly target-based commission.
export const Route = createFileRoute("/_app/marketer-performance")({
  head: () => ({
    meta: [
      { title: "Performance & Commission — Elim Table Water" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (
    <>
      <SectionTabs section="Marketer & Retail Accounts" />
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
};

type RemittanceActivity = {
  id: string;
  sales_rep_id: string;
  marketer: string;
  remittance_number: string;
  remittance_date: string;
  created_at: string;
  amount: number;
  payment_method: string;
  remarks: string | null;
};

type TierCommissionRow = {
  month: string;
  sales_rep_id: string;
  marketer: string;
  tier: "A" | "B" | null;
  target: number;
  posted: number;
  returned: number;
  net_posted: number;
  remitted: number;
  eligible_value: number;
  achievement: number | null;
  commission: number;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = () => {
  const d = new Date();
  return iso(new Date(d.getFullYear(), d.getMonth(), 1));
};

function PerformancePage() {
  const { data: factoryId } = useFactoryId();
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(() => iso(new Date()));
  const rangeDays = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  const rangeOk = !!from && !!to && from <= to && rangeDays <= 366;
  const rangeError =
    !from || !to || from > to
      ? "Pick a valid date range."
      : rangeDays > 366
        ? "Select a date range of no more than one year."
        : "";

  useRealtimeInvalidate(
    ["sales", "sales_returns", "rep_remittances", "stock_dispatches", "rep_returns", "sales_reps"],
    [["marketer-performance"], ["marketer-tier-commission"], ["marketer-remittance-activity"]],
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

  const tierCommission = useQuery({
    queryKey: ["marketer-tier-commission", factoryId, from, to],
    enabled: !!factoryId && rangeOk,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("marketer_monthly_tier_commission", {
        p_factory: factoryId!,
        p_from: from,
        p_to: to,
      });
      if (error) throw error;
      return (data ?? []) as TierCommissionRow[];
    },
  });
  const remittanceActivity = useQuery({
    queryKey: ["marketer-remittance-activity", factoryId, from, to],
    enabled: !!factoryId && rangeOk,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("marketer_remittance_activity", {
        p_factory: factoryId!,
        p_from: from,
        p_to: to,
      });
      if (error) throw error;
      return (data ?? []) as RemittanceActivity[];
    },
  });

  const rows = useMemo(() => perf.data ?? [], [perf.data]);
  const tierRows = useMemo(() => tierCommission.data ?? [], [tierCommission.data]);
  const remittances = useMemo(() => remittanceActivity.data ?? [], [remittanceActivity.data]);
  const remittedByRep = useMemo(() => {
    const totals = new Map<string, number>();
    for (const remittance of remittances) {
      totals.set(
        remittance.sales_rep_id,
        (totals.get(remittance.sales_rep_id) ?? 0) + Number(remittance.amount),
      );
    }
    return totals;
  }, [remittances]);
  const tierByRep = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of tierRows) {
      totals.set(r.sales_rep_id, (totals.get(r.sales_rep_id) ?? 0) + Number(r.commission));
    }
    return totals;
  }, [tierRows]);
  const totals = rows.reduce(
    (t, r) => ({
      value: t.value + Number(r.sales_value),
      units: t.units + Number(r.units_sold),
      legacyCommission: t.legacyCommission + Number(r.net_commission),
    }),
    { value: 0, units: 0, legacyCommission: 0 },
  );
  const totalRemitted = remittances.reduce(
    (total, remittance) => total + Number(remittance.amount),
    0,
  );
  const top = rows.find((r) => Number(r.sales_value) > 0);
  const tierCommissionTotal = tierRows.reduce((total, r) => total + Number(r.commission), 0);

  const exportRows = () =>
    exportCsv(
      `marketer-commission-${from}-to-${to}`,
      [
        { key: "full_name", label: "Marketer" },
        { key: "sales_count", label: "Sales" },
        { key: "units_sold", label: "Units sold" },
        { key: "sales_value", label: "Sales value" },
        { key: "legacy_commission", label: "Legacy per-unit commission" },
        { key: "tier_commission", label: "Monthly tier commission" },
        { key: "cash_remitted", label: "Cash remitted" },
      ],
      rows.map((r) => ({
        ...r,
        legacy_commission: Number(r.net_commission),
        tier_commission: tierByRep.get(r.sales_rep_id) ?? 0,
        cash_remitted: remittedByRep.get(r.sales_rep_id) ?? 0,
      })),
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Performance &amp; Commission</h1>
          <p className="text-sm text-muted-foreground">
            Monthly target commissions are paid in full when the assigned target is remitted, capped
            at posted value after returns. Daily remittance commission is shown separately.
            Remittance figures and receipts below are pulled from each marketer&apos;s account
            ledger. Previously earned per-unit commission remains listed as a historical balance.
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
          <Button
            variant="outline"
            className="gap-2"
            disabled={!rangeOk || !rows.length}
            onClick={exportRows}
          >
            <Download className="h-4 w-4" /> CSV
          </Button>
        </div>
      </div>
      {rangeError && <p className="text-sm text-destructive">{rangeError}</p>}

      {/* Commission on remittances, by achievement band (2026-11-04). */}
      {factoryId && rangeOk && <RemittanceCommission factoryId={factoryId} from={from} to={to} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi icon={TrendingUp} label="Marketer sales" value={money(totals.value)} />
        <Kpi icon={Package} label="Units sold" value={num(totals.units)} />
        <Kpi icon={Award} label="Legacy per-unit balance" value={money(totals.legacyCommission)} />
        <Kpi icon={Award} label="Monthly tier commission" value={money(tierCommissionTotal)} />
        <Kpi icon={Banknote} label="Cash remitted" value={money(totalRemitted)} />
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
                <TableHead className="text-right">Legacy per-unit balance</TableHead>
                <TableHead className="text-right">Monthly tier commission</TableHead>
                <TableHead className="text-right">Cash remitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                    {!rangeOk
                      ? rangeError
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
                  <TableCell className="text-right">{money(Number(r.net_commission))}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {money(tierByRep.get(r.sales_rep_id) ?? 0)}
                  </TableCell>
                  <TableCell className="text-right">
                    {money(remittedByRep.get(r.sales_rep_id) ?? 0)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Remittance activity</CardTitle>
          <p className="text-sm text-muted-foreground">
            Individual cash remittances recorded in marketers&apos; accounts for the selected date
            range. Total: {money(totalRemitted)}.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Marketer</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Payment method</TableHead>
                <TableHead>Remarks</TableHead>
                <TableHead className="text-right">Amount remitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {remittances.map((remittance) => (
                <TableRow key={remittance.id}>
                  <TableCell className="whitespace-nowrap">
                    {new Date(`${remittance.remittance_date}T00:00:00`).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="font-medium">{remittance.marketer}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {remittance.remittance_number}
                  </TableCell>
                  <TableCell className="capitalize">
                    {remittance.payment_method.replace(/_/g, " ")}
                  </TableCell>
                  <TableCell>{remittance.remarks || "—"}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {money(Number(remittance.amount))}
                  </TableCell>
                </TableRow>
              ))}
              {remittances.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    {rangeError ||
                      (remittanceActivity.isLoading
                        ? "Loading account remittances…"
                        : remittanceActivity.isError
                          ? (remittanceActivity.error as Error).message
                          : "No remittances in this date range.")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Monthly tier commission</CardTitle>
          <p className="text-sm text-muted-foreground">
            Each calendar month touched by the selected date range is evaluated in full. Eligible
            value is remittances capped at posted value after returns; the full commission is paid
            once Status A reaches ₦22,000,000 or Status B reaches ₦11,000,000.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead>Marketer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Target</TableHead>
                <TableHead className="text-right">Net posted</TableHead>
                <TableHead className="text-right">Remitted</TableHead>
                <TableHead className="text-right">Progress</TableHead>
                <TableHead className="text-right">Commission</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tierRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                    {rangeError ||
                      (tierCommission.isLoading
                        ? "Loading…"
                        : tierCommission.isError
                          ? (tierCommission.error as Error).message
                          : "No marketers to show.")}
                  </TableCell>
                </TableRow>
              )}
              {tierRows.map((r) => (
                <TableRow key={`${r.month}-${r.sales_rep_id}`}>
                  <TableCell>
                    {new Date(`${r.month}T00:00:00`).toLocaleDateString(undefined, {
                      month: "long",
                      year: "numeric",
                    })}
                  </TableCell>
                  <TableCell className="font-medium">{r.marketer}</TableCell>
                  <TableCell>
                    {r.tier ? <Badge variant="outline">Status {r.tier}</Badge> : "Unassigned"}
                  </TableCell>
                  <TableCell className="text-right">
                    {r.target ? money(Number(r.target)) : "—"}
                  </TableCell>
                  <TableCell className="text-right">{money(Number(r.net_posted))}</TableCell>
                  <TableCell className="text-right">{money(Number(r.remitted))}</TableCell>
                  <TableCell className="text-right">
                    {r.achievement == null ? "—" : `${Number(r.achievement).toFixed(2)}%`}
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    {money(Number(r.commission))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
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
