import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Printer, Save } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { useFactorySettings } from "@/lib/use-factory";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { money, num } from "@/lib/format";
import { generateReportPdf } from "@/lib/pdf";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Commission on what each marketer remits (user, 2026-11-04;
// marketer_daily_commission, 20261104250000): per marketer per day,
// achievement = remitted / target x 100, target = posted less returned; the
// band pays its floor (50-59.99% -> 50% ... 100%+ -> 100%, below 50% none);
// commission = remitted x the marketer's rate % x band %.

type Row = {
  day: string;
  sales_rep_id: string;
  marketer: string;
  code: string | null;
  rate: number;
  posted: number;
  returned: number;
  target: number;
  remitted: number;
  achievement: number | null;
  band: number;
  full_commission: number;
  commission: number;
};
type Rep = { id: string; full_name: string; code: string | null; commission_rate: number };

const n = (v: unknown) => Number(v ?? 0);

export function RemittanceCommission({
  factoryId,
  from,
  to,
}: {
  factoryId: string;
  from: string;
  to: string;
}) {
  const qc = useQueryClient();
  const perms = usePermissions();
  const canSetRates =
    perms.canWrite("payments") || perms.canWrite("debts") || perms.canApprove("distribution");
  const settings = useFactorySettings(factoryId);
  useRealtimeInvalidate(
    ["stock_dispatches", "rep_returns", "rep_remittances", "sales_reps"],
    [["remittance-commission"], ["commission-reps"]],
  );

  const rows = useQuery({
    queryKey: ["remittance-commission", factoryId, from, to],
    enabled: !!factoryId && !!from && !!to && from <= to,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "marketer_daily_commission" as never,
        { p_factory: factoryId, p_from: from, p_to: to } as never,
      );
      if (error) throw error;
      return ((data ?? []) as unknown as Row[]).map((r) => ({
        ...r,
        rate: n(r.rate),
        posted: n(r.posted),
        returned: n(r.returned),
        target: n(r.target),
        remitted: n(r.remitted),
        achievement: r.achievement == null ? null : n(r.achievement),
        band: n(r.band),
        full_commission: n(r.full_commission),
        commission: n(r.commission),
      }));
    },
  });
  const reps = useQuery({
    queryKey: ["commission-reps", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_reps")
        .select("id,full_name,code,commission_rate" as never)
        .eq("factory_id", factoryId)
        .eq("kind", "rep")
        .eq("status", "active")
        .order("full_name");
      if (error) throw error;
      return ((data ?? []) as unknown as Rep[]).map((r) => ({
        ...r,
        commission_rate: n(r.commission_rate),
      }));
    },
  });
  const [rates, setRates] = useState<Record<string, string>>({});
  const saveRate = useMutation({
    mutationFn: async (rep: Rep) => {
      const v = Number(rates[rep.id]);
      if (!(v >= 0 && v <= 100)) throw new Error("Enter a rate from 0 to 100%");
      const { error } = await supabase.rpc(
        "set_marketer_commission_rate" as never,
        { p_rep: rep.id, p_rate: v } as never,
      );
      if (error) throw error;
      return { rep, v };
    },
    onSuccess: ({ rep, v }) => {
      toast.success(`${rep.full_name}: commission rate ${v}%`);
      setRates((s) => {
        const next = { ...s };
        delete next[rep.id];
        return next;
      });
      void qc.invalidateQueries({ queryKey: ["commission-reps"] });
      void qc.invalidateQueries({ queryKey: ["remittance-commission"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const list = rows.data ?? [];
  const sum = (k: keyof Row) => list.reduce((t, r) => t + n(r[k]), 0);
  const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(2)}%`);
  const who = (r: Row) => (r.code ? `${r.marketer} (${r.code})` : r.marketer);

  const print = () =>
    generateReportPdf(
      `Marketer Commission on Remittances ${from === to ? from : `${from} to ${to}`}`,
      [
        { key: "day", label: "Date" },
        { key: "who", label: "Marketer" },
        { key: "rate", label: "Rate" },
        { key: "target", label: "Target" },
        { key: "remitted", label: "Remitted" },
        { key: "ach", label: "Achieved" },
        { key: "band", label: "Band" },
        { key: "commission", label: "Commission" },
      ],
      [
        ...list.map((r) => ({
          day: r.day,
          who: who(r),
          rate: `${r.rate}%`,
          target: money(r.target),
          remitted: money(r.remitted),
          ach: pct(r.achievement),
          band: `${r.band}%`,
          commission: money(r.commission),
        })),
        {
          day: "Total",
          who: "",
          rate: "",
          target: money(sum("target")),
          remitted: money(sum("remitted")),
          ach: "",
          band: "",
          commission: money(sum("commission")),
        },
      ],
      "print",
      { name: settings.data?.company_name, logo_url: settings.data?.logo_url },
      [
        "Achieved = remitted / target (posted less returned) x 100, per marketer per day.",
        "50-59.99% pays 50% of the commission ... 90-99.99% pays 90%, 100% or more pays 100%; below 50% none.",
      ],
    );

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle>Commission on remittances</CardTitle>
          <p className="text-sm text-muted-foreground">
            Per marketer per day: achieved = remitted ÷ target (posted less returned) × 100.
            50–59.99% pays 50% of the commission, 60–69.99% pays 60% … 100% or more pays 100%; below
            50% pays nothing. Commission = remitted × the marketer&apos;s rate × band.
          </p>
        </div>
        <Button
          variant="outline"
          className="gap-2"
          disabled={!list.length}
          onClick={() => void print()}
        >
          <Printer className="h-4 w-4" /> Print
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Each marketer's rate. */}
        <div className="flex flex-wrap gap-2">
          {(reps.data ?? []).map((r) => {
            const edited = rates[r.id] !== undefined;
            return (
              <div key={r.id} className="flex items-center gap-1 rounded-lg border px-2 py-1">
                <span className="text-sm font-medium">
                  {r.code ? `${r.full_name} (${r.code})` : r.full_name}
                </span>
                {canSetRates ? (
                  <>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step="0.1"
                      className="h-8 w-20 text-right"
                      value={edited ? rates[r.id] : String(r.commission_rate)}
                      onChange={(e) => setRates((s) => ({ ...s, [r.id]: e.target.value }))}
                    />
                    <span className="text-sm">%</span>
                    {edited && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        title="Save rate"
                        disabled={saveRate.isPending}
                        onClick={() => saveRate.mutate(r)}
                      >
                        <Save className="h-4 w-4" />
                      </Button>
                    )}
                  </>
                ) : (
                  <span className="text-sm">{r.commission_rate}%</span>
                )}
              </div>
            );
          })}
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Marketer</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Posted</TableHead>
                <TableHead className="text-right">Returned</TableHead>
                <TableHead className="text-right">Target</TableHead>
                <TableHead className="text-right">Remitted</TableHead>
                <TableHead className="text-right">Achieved</TableHead>
                <TableHead className="text-right">Band</TableHead>
                <TableHead className="text-right">Commission</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => (
                <TableRow key={`${r.day}-${r.sales_rep_id}`}>
                  <TableCell className="whitespace-nowrap">{r.day}</TableCell>
                  <TableCell className="font-medium">{who(r)}</TableCell>
                  <TableCell className="text-right">{r.rate}%</TableCell>
                  <TableCell className="text-right">{money(r.posted)}</TableCell>
                  <TableCell className="text-right">{money(r.returned)}</TableCell>
                  <TableCell className="text-right">{money(r.target)}</TableCell>
                  <TableCell className="text-right">{money(r.remitted)}</TableCell>
                  <TableCell className="text-right">{pct(r.achievement)}</TableCell>
                  <TableCell className="text-right">{num(r.band)}%</TableCell>
                  <TableCell className="text-right font-semibold">{money(r.commission)}</TableCell>
                </TableRow>
              ))}
              {list.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="py-6 text-center text-muted-foreground">
                    {rows.isLoading
                      ? "Loading…"
                      : rows.isError
                        ? (rows.error as Error).message
                        : "Nothing posted or remitted in this period."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            {list.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={3} className="font-semibold">
                    Total
                  </TableCell>
                  <TableCell className="text-right font-semibold">{money(sum("posted"))}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {money(sum("returned"))}
                  </TableCell>
                  <TableCell className="text-right font-semibold">{money(sum("target"))}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {money(sum("remitted"))}
                  </TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell className="text-right font-semibold">
                    {money(sum("commission"))}
                  </TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
