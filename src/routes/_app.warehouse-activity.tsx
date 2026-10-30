import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { num } from "@/lib/format";
import { DatePicker } from "@/components/shared/date-picker";
import { PrintCopiesButton } from "@/components/shared/print-copies-button";
import { ReportActions } from "@/components/shared/report-actions";
import {
  type Activity,
  hasSlip,
  KIND,
  printWarehouseActivity,
} from "@/components/warehouse/activity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

export const Route = createFileRoute("/_app/warehouse-activity")({
  head: () => ({
    meta: [
      { title: "Warehouse Activity Log — Elim Table Water" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (
    <>
      <SectionTabs section="Warehouse" />
      <RequireAccess module="finished-goods">
        <WarehouseActivityPage />
      </RequireAccess>
    </>
  ),
});

// Everything that moved through the Warehouse between two days picked on a
// calendar, with who did it (warehouse_activity,
// supabase/migrations/20261030130000_warehouse_activity_by_date.sql):
// releases received from or refused to Production, postings to marketers,
// distributors and the Retail Shop, direct sales and stock corrections.
// Read only; each posting can reprint its slip.

type Row = Activity & { posted_by: string | null };

const lagosToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
const shiftDay = (d: string, days: number) => {
  const t = new Date(`${d}T12:00:00`);
  t.setDate(t.getDate() + days);
  return t.toLocaleDateString("en-CA");
};
const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

function WarehouseActivityPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const today = lagosToday();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [kind, setKind] = useState<"all" | Activity["kind"]>("all");
  const [q, setQ] = useState("");

  useRealtimeInvalidate(
    ["production_releases", "stock_dispatches", "sales", "inventory_movements"],
    [["warehouse-activity-log"]],
  );

  const activity = useQuery({
    queryKey: ["warehouse-activity-log", factoryId, from, to],
    enabled: !!factoryId && !!from && !!to && from <= to,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "warehouse_activity" as never,
        { p_factory: factoryId, p_from: from, p_to: to } as never,
      );
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (activity.data ?? []).filter(
      (a) =>
        (kind === "all" || a.kind === kind) &&
        (!term ||
          [a.reference, a.party, a.items, a.posted_by].some((v) =>
            (v ?? "").toLowerCase().includes(term),
          )),
    );
  }, [activity.data, kind, q]);

  // How many of each kind in the range, for the summary chips.
  const counts = useMemo(() => {
    const m = new Map<Activity["kind"], number>();
    for (const a of activity.data ?? []) m.set(a.kind, (m.get(a.kind) ?? 0) + 1);
    return m;
  }, [activity.data]);

  if (!factoryId) return null;
  const range = from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`;
  const quick = (f: string, t: string) => {
    setFrom(f);
    setTo(t);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity Log</h1>
        <p className="text-sm text-muted-foreground">
          Everything received, posted, sold and corrected in the Warehouse, with who did it. Pick
          the days on the calendar.
        </p>
      </div>

      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">From</div>
            <DatePicker
              value={from}
              max={today}
              onChange={(v) => {
                setFrom(v);
                if (v > to) setTo(v);
              }}
            />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">To</div>
            <DatePicker
              value={to}
              min={from}
              max={today}
              onChange={(v) => {
                setTo(v);
                if (v < from) setFrom(v);
              }}
            />
          </div>
          <div className="flex flex-wrap gap-1">
            <Button variant="outline" size="sm" onClick={() => quick(today, today)}>
              Today
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => quick(shiftDay(today, -1), shiftDay(today, -1))}
            >
              Yesterday
            </Button>
            <Button variant="outline" size="sm" onClick={() => quick(shiftDay(today, -6), today)}>
              Last 7 days
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => quick(`${today.slice(0, 7)}-01`, today)}
            >
              This month
            </Button>
          </div>
          <div className="ml-auto flex flex-wrap items-end gap-2">
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All activity</SelectItem>
                {(Object.keys(KIND) as Activity["kind"][]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND[k].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="w-56 pl-8"
                placeholder="Reference, customer, product, person"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {counts.size > 0 && (
        <div className="flex flex-wrap gap-2">
          {[...counts.entries()].map(([k, n]) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(kind === k ? "all" : k)}
              className="rounded-full"
            >
              <Badge variant={kind === k ? "default" : "outline"}>
                {(KIND[k] ?? { label: k }).label}: {num(n)}
              </Badge>
            </button>
          ))}
        </div>
      )}

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle>Warehouse activity — {range}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {activity.isLoading ? "Loading…" : `${num(rows.length)} entries, newest first.`}
            </p>
          </div>
          <ReportActions
            size="sm"
            title="Warehouse Activity Log"
            fileName={`warehouse-activity-${from}-to-${to}`}
            columns={[
              { key: "when", label: "When" },
              { key: "activity", label: "Activity" },
              { key: "reference", label: "Reference" },
              { key: "party", label: "To / from" },
              { key: "items", label: "Products" },
              { key: "by", label: "Posted by" },
              { key: "status", label: "Status" },
            ]}
            rows={rows.map((a) => ({
              when: new Date(a.at).toLocaleString(),
              activity: (KIND[a.kind] ?? { label: a.kind }).label,
              reference: a.reference,
              party: a.party ?? "",
              items: a.items ?? "",
              by: a.posted_by ?? "",
              status: a.status.replace(/_/g, " "),
            }))}
            subtitle={[
              `Days: ${range}`,
              ...(kind !== "all" ? [`Showing: ${KIND[kind].label}`] : []),
              ...(q.trim() ? [`Search: ${q.trim()}`] : []),
            ]}
          />
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Activity</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>To / from</TableHead>
                <TableHead>Products</TableHead>
                <TableHead>Posted by</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => {
                const k = KIND[a.kind] ?? { label: a.kind, variant: "outline" as const };
                return (
                  <TableRow key={`${a.kind}-${a.reference}-${a.at}`}>
                    <TableCell className="whitespace-nowrap">
                      <div className="font-medium">
                        {new Date(a.at).toLocaleTimeString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(a.at).toLocaleDateString()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={k.variant}>{k.label}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{a.reference}</TableCell>
                    <TableCell className="font-medium">{a.party ?? "—"}</TableCell>
                    <TableCell className="text-xs">{a.items ?? "—"}</TableCell>
                    <TableCell>{a.posted_by ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {a.status.replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {hasSlip(a) && (
                        <PrintCopiesButton
                          onPrint={(copies) =>
                            printWarehouseActivity(a, factoryId, settings.data, copies)
                          }
                        />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                    {activity.isLoading
                      ? "Loading…"
                      : activity.isError
                        ? (activity.error as Error).message
                        : `No Warehouse activity for ${range}.`}
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
