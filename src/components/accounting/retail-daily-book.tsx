import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Printer, Store } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useFactorySettings } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { money, num } from "@/lib/format";
import { printDispatchDayInvoice } from "@/lib/dispatch-slip";
import { printSaleInvoice } from "@/lib/invoice";
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Accountant > Retail daily (user, 2026-11-03): the Retail Shop day by day --
// everything the Warehouse posted to it (dispensers, bottles, sachets), what
// it sent back, and everything it sold -- with one posting invoice and one
// sales invoice to print per day (retail_daily_book,
// supabase/migrations/20261103140000_retail_daily_book.sql).

type Line = {
  day: string;
  kind: "posting" | "return" | "sale";
  id: string;
  reference: string;
  at: string;
  product_name: string;
  unit: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  is_pr: boolean;
};
type ProductRow = {
  name: string;
  unit: string;
  posted: number;
  returned: number;
  sold: number;
  postedValue: number;
  soldValue: number;
};
type Day = {
  day: string;
  products: ProductRow[];
  postingIds: string[];
  returnIds: string[];
  saleIds: string[];
  prSales: number;
};

const lagosToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const n = (v: unknown) => Number(v ?? 0);

export function RetailDailyBook({ factoryId, currency }: { factoryId: string; currency?: string }) {
  const settings = useFactorySettings(factoryId).data;
  const showValues = usePermissions().canSeeMoney;
  const [outletId, setOutletId] = useState("");
  // One day at a time, today first; the calendar picks another (2026-11-03).
  const [day, setDay] = useState(lagosToday());
  const fmt = (v: number) => money(v, currency);

  useRealtimeInvalidate(["stock_dispatches", "rep_returns", "sales"], [["retail-daily-book"]]);

  const outlets = useQuery({
    queryKey: ["outlets", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_reps")
        .select("id,full_name,status")
        .eq("factory_id", factoryId)
        .eq("kind", "outlet")
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string; status: string }[];
    },
  });
  useEffect(() => {
    if (outletId || !outlets.data?.length) return;
    setOutletId((outlets.data.find((o) => o.status === "active") ?? outlets.data[0]).id);
  }, [outlets.data, outletId]);
  const shopName = outlets.data?.find((o) => o.id === outletId)?.full_name ?? "Retail Shop";

  const book = useQuery({
    queryKey: ["retail-daily-book", outletId, day],
    enabled: !!outletId && !!day,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "retail_daily_book" as never,
        { p_outlet: outletId, p_from: day, p_to: day } as never,
      );
      if (error) throw error;
      return (data ?? []) as unknown as Line[];
    },
  });

  const days = useMemo<Day[]>(() => {
    const byDay = new Map<
      string,
      Day & { byProduct: Map<string, ProductRow>; prIds: Set<string> }
    >();
    for (const l of book.data ?? []) {
      let d = byDay.get(l.day);
      if (!d) {
        d = {
          day: l.day,
          products: [],
          postingIds: [],
          returnIds: [],
          saleIds: [],
          prSales: 0,
          byProduct: new Map(),
          prIds: new Set(),
        };
        byDay.set(l.day, d);
      }
      const ids =
        l.kind === "posting" ? d.postingIds : l.kind === "return" ? d.returnIds : d.saleIds;
      // PR (free) sales are not on the sales invoice; counted apart.
      if (l.kind === "sale" && l.is_pr) d.prIds.add(l.id);
      else if (!ids.includes(l.id)) ids.push(l.id);
      let p = d.byProduct.get(l.product_name);
      if (!p) {
        p = {
          name: l.product_name,
          unit: l.unit,
          posted: 0,
          returned: 0,
          sold: 0,
          postedValue: 0,
          soldValue: 0,
        };
        d.byProduct.set(l.product_name, p);
      }
      if (l.kind === "posting") {
        p.posted += n(l.quantity);
        p.postedValue += n(l.line_total);
      } else if (l.kind === "return") p.returned += n(l.quantity);
      else {
        p.sold += n(l.quantity);
        p.soldValue += n(l.line_total);
      }
    }
    return [...byDay.values()]
      .map((d) => ({
        day: d.day,
        products: [...d.byProduct.values()].sort((a, b) => a.name.localeCompare(b.name)),
        postingIds: d.postingIds,
        returnIds: d.returnIds,
        saleIds: d.saleIds,
        prSales: d.prIds.size,
      }))
      .sort((a, b) => b.day.localeCompare(a.day));
  }, [book.data]);

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Store className="h-5 w-5" /> {shopName}
            </CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(outlets.data ?? []).length > 1 && (
              <Select value={outletId} onValueChange={setOutletId}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Shop" />
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
            <Input
              type="date"
              className="w-40"
              title="Day"
              value={day}
              max={lagosToday()}
              onChange={(e) => e.target.value && setDay(e.target.value)}
            />
          </div>
        </CardHeader>
        {(book.isError || (book.isSuccess && days.length === 0) || book.isLoading) && (
          <CardContent>
            <p className="py-4 text-center text-sm text-muted-foreground">
              {book.isError
                ? `Couldn't load: ${(book.error as Error).message}`
                : book.isLoading
                  ? "Loading…"
                  : "Nothing posted to or sold by the shop on this day."}
            </p>
          </CardContent>
        )}
      </Card>

      {days.map((d) => {
        const total = (k: keyof ProductRow) => d.products.reduce((t, p) => t + n(p[k]), 0);
        return (
          <Card key={d.day} className="rounded-2xl">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
              <div>
                <CardTitle className="text-base">{fmtDay(d.day)}</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {d.postingIds.length} posting(s) · {d.returnIds.length} return(s) ·{" "}
                  {d.saleIds.length} sale(s)
                  {d.prSales > 0 && ` · ${d.prSales} PR`}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1"
                  disabled={d.postingIds.length === 0}
                  title="Everything posted to the shop this day on one invoice (returns as minus lines)"
                  onClick={() =>
                    void printDispatchDayInvoice(d.postingIds, settings, "print", d.returnIds)
                  }
                >
                  <Printer className="h-4 w-4" /> Print posting invoice
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1"
                  disabled={d.saleIds.length === 0}
                  title="All the shop's sales this day on one combined invoice"
                  onClick={() => void printSaleInvoice(d.saleIds, settings, "print")}
                >
                  <Printer className="h-4 w-4" /> Print sales invoice
                </Button>
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Posted to shop</TableHead>
                    <TableHead className="text-right">Sent back</TableHead>
                    <TableHead className="text-right">Sold</TableHead>
                    {showValues && <TableHead className="text-right">Posted value</TableHead>}
                    {showValues && <TableHead className="text-right">Sales value</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.products.map((p) => (
                    <TableRow key={p.name}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell className="text-right">
                        {p.posted ? `${num(p.posted)} ${p.unit}` : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {p.returned ? num(p.returned) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {p.sold ? `${num(p.sold)} ${p.unit}` : "—"}
                      </TableCell>
                      {showValues && (
                        <TableCell className="text-right">
                          {p.postedValue ? fmt(p.postedValue) : "—"}
                        </TableCell>
                      )}
                      {showValues && (
                        <TableCell className="text-right">
                          {p.soldValue ? fmt(p.soldValue) : "—"}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell className="font-semibold">Total</TableCell>
                    <TableCell className="text-right font-semibold">
                      {num(total("posted"))}
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {num(total("returned"))}
                    </TableCell>
                    <TableCell className="text-right font-semibold">{num(total("sold"))}</TableCell>
                    {showValues && (
                      <TableCell className="text-right font-semibold">
                        {fmt(total("postedValue"))}
                      </TableCell>
                    )}
                    {showValues && (
                      <TableCell className="text-right font-semibold">
                        {fmt(total("soldValue"))}
                      </TableCell>
                    )}
                  </TableRow>
                </TableFooter>
              </Table>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
