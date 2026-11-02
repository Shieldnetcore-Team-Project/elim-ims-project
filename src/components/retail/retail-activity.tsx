import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { printShopSaleSlips } from "@/lib/invoice";
import { printDispatchSlip } from "@/lib/dispatch-slip";
import { money } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Printer, Search } from "lucide-react";
import { RetailWarehousePostings } from "./warehouse-postings";

// Retail › All activity (user, 2026-11-02): everything at the Retail Shop --
// postings from the Warehouse, sales, customer returns, later payments,
// returns to the Warehouse and cash handed in -- through retail_activity().
// The shop's activity is here, not on the Accountant's All activity.
// Postings from Warehouse sit under it, full width (2026-11-02).

type Row = {
  kind: string;
  at: string | null;
  reference: string;
  party: string | null;
  details: string | null;
  amount: number | null;
  paid: number | null;
  balance: number | null;
  method: string | null;
  status: string | null;
  sale_id: string | null;
  dispatch_id: string | null;
};

const KINDS = ["All", "Sale", "Posting", "Customer return", "Payment", "Return", "Cash remitted"];
const KIND_LABEL: Record<string, string> = {
  Sale: "Sale",
  Posting: "Posting in",
  "Customer return": "Customer return",
  Payment: "Payment received",
  Return: "Returned to Warehouse",
  "Cash remitted": "Cash handed in",
};

type Range = "day" | "week" | "month" | "custom";
const shift = (d: string, days: number) => {
  const x = new Date(`${d}T12:00:00`);
  x.setDate(x.getDate() + days);
  return x.toISOString().slice(0, 10);
};

export function RetailActivity({ outletId, date }: { outletId: string; date: string }) {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const [range, setRange] = useState<Range>("day");
  const [kind, setKind] = useState("All");
  const [q, setQ] = useState("");
  // Any dates the user picks (2026-11-02): From / To on the card.
  const [pickFrom, setPickFrom] = useState(date);
  const [pickTo, setPickTo] = useState(date);
  const to = range === "custom" ? pickTo : date;
  const from =
    range === "custom"
      ? pickFrom
      : range === "day"
        ? date
        : range === "week"
          ? shift(date, -6)
          : `${date.slice(0, 7)}-01`;

  useRealtimeInvalidate(
    [
      "sales",
      "stock_dispatches",
      "sales_returns",
      "payments_received",
      "rep_returns",
      "rep_remittances",
    ],
    [["retail-activity"]],
  );

  const rows = useQuery({
    queryKey: ["retail-activity", outletId, from, to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "retail_activity" as never,
        { p_outlet: outletId, p_from: from, p_to: to } as never,
      );
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (rows.data ?? []).filter(
      (r) =>
        (kind === "All" || r.kind === kind) &&
        (!k ||
          [r.reference, r.party, r.details, r.kind].some((f) =>
            (f ?? "").toLowerCase().includes(k),
          )),
    );
  }, [rows.data, kind, q]);
  const sales = (rows.data ?? []).filter((r) => r.kind === "Sale" && r.status !== "PR");
  const sold = sales.reduce((t, r) => t + Number(r.amount ?? 0), 0);
  const paid = sales.reduce((t, r) => t + Number(r.paid ?? 0), 0);

  return (
    <div className="space-y-6">
      <Card className="rounded-2xl">
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>All activity</CardTitle>
            <div className="flex flex-wrap items-center gap-1">
              {(
                [
                  ["day", "This day"],
                  ["week", "Last 7 days"],
                  ["month", "This month"],
                ] as [Range, string][]
              ).map(([k, l]) => (
                <Button
                  key={k}
                  size="sm"
                  variant={range === k ? "default" : "outline"}
                  onClick={() => setRange(k)}
                >
                  {l}
                </Button>
              ))}
              <span className="ml-2 text-sm text-muted-foreground">From</span>
              <Input
                type="date"
                className="h-9 w-40"
                value={from}
                max={to}
                onChange={(e) => {
                  if (!e.target.value) return;
                  setPickFrom(e.target.value);
                  setPickTo(to);
                  setRange("custom");
                }}
              />
              <span className="text-sm text-muted-foreground">To</span>
              <Input
                type="date"
                className="h-9 w-40"
                value={to}
                min={from}
                onChange={(e) => {
                  if (!e.target.value) return;
                  setPickTo(e.target.value);
                  setPickFrom(e.target.value < from ? e.target.value : from);
                  setRange("custom");
                }}
              />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {new Date(from).toLocaleDateString()}
            {from !== to ? ` – ${new Date(to).toLocaleDateString()}` : ""} · {sales.length} sale
            {sales.length === 1 ? "" : "s"} · sold {money(sold)} · paid at sale {money(paid)}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1">
              {KINDS.map((k) => (
                <Button
                  key={k}
                  size="sm"
                  variant={kind === k ? "default" : "outline"}
                  onClick={() => setKind(k)}
                >
                  {k === "All" ? "All" : KIND_LABEL[k]}
                </Button>
              ))}
            </div>
            <div className="relative ml-auto w-full sm:w-64">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Search number, customer, product…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Customer / Details</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => (
                <TableRow key={`${r.kind}-${r.reference}`}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {r.at ? new Date(r.at).toLocaleString() : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{KIND_LABEL[r.kind] ?? r.kind}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                  <TableCell>
                    <div className="font-medium">{r.party ?? "—"}</div>
                    {r.details && <div className="text-xs text-muted-foreground">{r.details}</div>}
                    {r.kind === "Sale" && r.status !== "PR" && (
                      <div className="text-xs text-muted-foreground">
                        Paid {money(Number(r.paid ?? 0))}
                        {Number(r.balance ?? 0) > 0 && (
                          <span className="text-destructive">
                            {" "}
                            · owes {money(Number(r.balance))}
                          </span>
                        )}
                        {r.method ? ` · ${r.method.replace(/_/g, " ")}` : ""}
                      </div>
                    )}
                    {(r.kind === "Payment" || r.kind === "Cash remitted") && r.method && (
                      <div className="text-xs text-muted-foreground">
                        {r.method.replace(/_/g, " ")}
                      </div>
                    )}
                  </TableCell>
                  <TableCell
                    className={`text-right font-medium ${
                      r.kind === "Customer return" || r.kind === "Return" ? "text-destructive" : ""
                    }`}
                  >
                    {r.kind === "Customer return" || r.kind === "Return" ? "−" : ""}
                    {money(Number(r.amount ?? 0))}
                  </TableCell>
                  <TableCell>
                    {r.status && (
                      <Badge variant="secondary" className="capitalize">
                        {r.status.replace(/_/g, " ")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.kind === "Sale" && r.sale_id && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Print receipt"
                        onClick={() => printShopSaleSlips(r.sale_id!, settings.data)}
                      >
                        <Printer className="h-4 w-4" />
                      </Button>
                    )}
                    {r.kind === "Posting" && r.dispatch_id && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Print posting slip"
                        onClick={() =>
                          printDispatchSlip({ id: r.dispatch_id! }, settings.data, "print")
                        }
                      >
                        <Printer className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {shown.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    {rows.isLoading
                      ? "Loading…"
                      : rows.isError
                        ? (rows.error as Error).message
                        : "Nothing at the shop in this period."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <RetailWarehousePostings outletId={outletId} from={from} to={to} />
    </div>
  );
}
