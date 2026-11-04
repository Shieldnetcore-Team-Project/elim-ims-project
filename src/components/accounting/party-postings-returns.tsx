import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, HandCoins, PackageCheck, Percent, Printer, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { usePermissions } from "@/lib/permissions";
import { Dialog } from "@/components/ui/dialog";
import { SaleAdjustDialog } from "@/components/accounting/sale-adjust-dialog";
import { CustomerPaymentDialog } from "@/components/accounting/customer-payment-dialog";
import { PostingDiscountButton } from "@/components/accounting/posting-discount-dialog";
import { useCanDiscountPostings } from "@/lib/posting-discount";
import { supabase } from "@/integrations/supabase/client";
import { useFactorySettings } from "@/lib/use-factory";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { money, num } from "@/lib/format";
import { printDispatchDayInvoice, printDispatchInvoice } from "@/lib/dispatch-slip";
import { printSaleInvoice } from "@/lib/invoice";
import { localDay } from "@/lib/production-shift";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Everything posted to a marketer / the shop / a distributor and everything
// they returned, all time, newest first (party_postings_and_returns,
// supabase/migrations/20261103110000_party_postings_returns.sql). Shown at
// the top of the window the Accountant opens from a name on All activity
// (user, 2026-11-03): per product how much went out and came back, then each
// posting (with its invoice) and each return with its products.

type Line = {
  kind: "posting" | "return";
  id: string;
  reference: string;
  day: string;
  at: string;
  status: string;
  product_name: string;
  unit: string;
  quantity: number;
  unit_price: number | null;
  line_total: number | null;
  note: string | null;
};
type Group = {
  id: string;
  kind: Line["kind"];
  reference: string;
  day: string;
  at: string;
  status: string;
  note: string | null;
  lines: Line[];
  value: number;
};

const PAGE = 30;
const n = (v: unknown) => Number(v ?? 0);

export function PartyPostingsReturns({
  factoryId,
  repId,
  customerName,
  showValues,
  currency,
  day,
}: {
  // Opened on one day (All activity's day row); the calendar still changes it.
  day?: string;
  factoryId: string;
  // A marketer / the shop by id, or a distributor by name.
  repId?: string;
  customerName?: string;
  showValues: boolean;
  currency?: string;
}) {
  const settings = useFactorySettings(factoryId).data;
  // A distributor's invoice: Accounts gives a discount per product and takes
  // payment here, before printing (user, 2026-11-04).
  const perms = usePermissions();
  const canPay = !repId && (perms.canWrite("payments") || perms.canWrite("debts"));
  // A marketer's / the shop's posting: a discount per product (2026-11-04).
  const canDiscountPosting = useCanDiscountPostings() && !!repId;
  const [discounting, setDiscounting] = useState<{ id: string; invoice_number: string } | null>(
    null,
  );
  const [paying, setPaying] = useState<{
    id: string;
    invoice_number: string;
    customer_id: string;
    balance: number;
  } | null>(null);
  const openPay = async (g: Group) => {
    const { data, error } = await supabase
      .from("sales")
      .select("id,invoice_number,customer_id,balance")
      .eq("id", g.id)
      .maybeSingle();
    if (error || !data) {
      toast.error(error?.message ?? "Invoice not found");
      return;
    }
    const s = data as {
      id: string;
      invoice_number: string;
      customer_id: string | null;
      balance: number;
    };
    if (!s.customer_id) {
      toast.error("This invoice has no customer account to pay into");
      return;
    }
    setPaying({ ...s, customer_id: s.customer_id, balance: Number(s.balance) });
  };
  const [shown, setShown] = useState({ posting: PAGE, return: PAGE });
  // Calendar: empty = all time; a day / range = what is dated then.
  const [from, setFrom] = useState(day ?? "");
  const [to, setTo] = useState("");
  useRealtimeInvalidate(
    ["stock_dispatches", "rep_returns", "sales", "sales_returns"],
    [["party-postings-returns"]],
  );
  const q = useQuery({
    queryKey: ["party-postings-returns", factoryId, repId ?? null, customerName ?? null],
    enabled: !!factoryId && !!(repId || customerName),
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "party_postings_and_returns" as never,
        {
          p_factory: factoryId,
          p_rep: repId ?? null,
          p_customer_name: repId ? null : (customerName ?? null),
        } as never,
      );
      if (error) throw error;
      return (data ?? []) as unknown as Line[];
    },
  });

  const { groups, totals } = useMemo(() => {
    const byId = new Map<string, Group>();
    const totals = new Map<string, { unit: string; posted: number; returned: number }>();
    const end = to && to >= from ? to : from;
    for (const l of q.data ?? []) {
      if (from && (l.day < from || l.day > end)) continue;
      let g = byId.get(l.id);
      if (!g) {
        g = { ...l, lines: [], value: 0 };
        byId.set(l.id, g);
      }
      g.lines.push(l);
      g.value += n(l.line_total);
      // A reversed posting moved nothing in the end.
      if (l.status === "reversed") continue;
      const t = totals.get(l.product_name) ?? { unit: l.unit, posted: 0, returned: 0 };
      if (l.kind === "posting") t.posted += n(l.quantity);
      else t.returned += n(l.quantity);
      totals.set(l.product_name, t);
    }
    return { groups: [...byId.values()], totals };
  }, [q.data, from, to]);
  const postings = groups.filter((g) => g.kind === "posting");
  const returns = groups.filter((g) => g.kind === "return");

  const print = (g: Group, mode: "print" | "download") =>
    repId
      ? printDispatchInvoice({ id: g.id }, settings, mode)
      : printSaleInvoice(g.id, settings, mode);

  // A whole day on one invoice (user, 2026-11-04): every posting that day,
  // lines of the same product and price added together; for a marketer /
  // the shop the day's returns come off as minus lines. Reversed postings
  // are left out.
  const byDay = useMemo(() => {
    const m = new Map<string, { postings: Group[]; returns: Group[] }>();
    for (const g of groups) {
      const d = m.get(g.day) ?? { postings: [], returns: [] };
      if (g.status !== "reversed") (g.kind === "posting" ? d.postings : d.returns).push(g);
      m.set(g.day, d);
    }
    return m;
  }, [groups]);
  const printDay = (day: string, mode: "print" | "download") => {
    const d = byDay.get(day);
    if (!d || d.postings.length === 0) return;
    const ids = d.postings.map((g) => g.id);
    return repId
      ? printDispatchDayInvoice(
          ids,
          settings,
          mode,
          d.returns.map((g) => g.id),
        )
      : printSaleInvoice(ids, settings, mode);
  };
  const dayLabel = (day: string) =>
    new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  const dayHeader = (day: string) => {
    const d = byDay.get(day);
    const count = d?.postings.length ?? 0;
    const back = d?.returns.length ?? 0;
    const value = d?.postings.reduce((t, p) => t + p.value, 0) ?? 0;
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 px-2 py-1 text-xs">
        <span className="font-semibold">{dayLabel(day)}</span>
        <span className="text-muted-foreground">
          {num(count)} posting{count === 1 ? "" : "s"}
          {repId && back > 0 ? ` · ${num(back)} return${back === 1 ? "" : "s"}` : ""}
        </span>
        {showValues && <span className="font-medium">{money(value, currency)}</span>}
        {count > 0 && (
          <span className="ml-auto flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2"
              title="Print one invoice for the whole day"
              onClick={() => void printDay(day, "print")}
            >
              <Printer className="h-3.5 w-3.5" /> Print day
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="Download one invoice for the whole day"
              onClick={() => void printDay(day, "download")}
            >
              <Download className="h-4 w-4" />
            </Button>
          </span>
        )}
      </div>
    );
  };

  const list = (items: Group[], kind: Group["kind"]) => (
    <div className="space-y-2">
      {items.slice(0, shown[kind]).map((g, idx, arr) => (
        <div key={g.id} className="space-y-2">
          {kind === "posting" && (idx === 0 || arr[idx - 1].day !== g.day) && dayHeader(g.day)}
          <div className="rounded-lg border p-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                {new Date(g.at).toLocaleString()}
              </span>
              <span className="font-mono text-xs">{g.reference}</span>
              <Badge
                variant={g.status === "reversed" ? "destructive" : "outline"}
                className="capitalize"
              >
                {g.status.replace(/_/g, " ")}
              </Badge>
              {g.note && <span className="text-xs text-muted-foreground">{g.note}</span>}
              <span className="ml-auto flex items-center gap-1">
                {showValues && <span className="font-medium">{money(g.value, currency)}</span>}
                {kind === "posting" && canDiscountPosting && g.status === "posted" && (
                  <PostingDiscountButton dispatchIds={[g.id]} title={g.reference} size="icon" />
                )}
                {kind === "posting" && canPay && g.status === "posted" && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Discount / surcharge per product"
                      onClick={() => setDiscounting({ id: g.id, invoice_number: g.reference })}
                    >
                      <Percent className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Receive payment on this invoice"
                      onClick={() => void openPay(g)}
                    >
                      <HandCoins className="h-4 w-4" />
                    </Button>
                  </>
                )}
                {kind === "posting" && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Print invoice"
                      onClick={() => print(g, "print")}
                    >
                      <Printer className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Download invoice"
                      onClick={() => print(g, "download")}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
              {g.lines.map((l, i) => (
                <span key={i}>
                  {l.product_name} <b>× {num(n(l.quantity))}</b> {l.unit}
                  {showValues && l.unit_price != null && (
                    <span className="text-muted-foreground">
                      {" "}
                      @ {money(n(l.unit_price), currency)}
                    </span>
                  )}
                </span>
              ))}
            </div>
          </div>
        </div>
      ))}
      {items.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {q.isLoading
            ? "Loading…"
            : kind === "posting"
              ? "Nothing posted yet."
              : "Nothing returned."}
        </p>
      )}
      {items.length > shown[kind] && (
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => setShown((s) => ({ ...s, [kind]: s[kind] + PAGE }))}
        >
          Show {Math.min(PAGE, items.length - shown[kind])} more ({num(items.length - shown[kind])}{" "}
          left)
        </Button>
      )}
    </div>
  );

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">
            All postings {from ? "— on the dates picked" : "— all time"}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              className="h-8 w-40"
              title="From"
              value={from}
              max={localDay()}
              onChange={(e) => setFrom(e.target.value)}
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              className="h-8 w-40"
              title="To (leave empty for one day)"
              value={to}
              min={from || undefined}
              max={localDay()}
              onChange={(e) => setTo(e.target.value)}
            />
            {from && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFrom("");
                  setTo("");
                }}
              >
                All dates
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isError && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
        {totals.size > 0 && (
          <div className="flex flex-wrap gap-2">
            {[...totals].map(([name, t]) => (
              <div key={name} className="rounded-lg border px-2 py-1 text-xs">
                <div className="font-medium">{name}</div>
                <div className="text-muted-foreground">
                  Posted {num(t.posted)} · Returned {num(t.returned)} ·{" "}
                  <span className="font-semibold text-foreground">
                    Net {num(t.posted - t.returned)} {t.unit}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        <Tabs defaultValue="posting">
          <TabsList>
            <TabsTrigger value="posting" className="gap-1">
              <PackageCheck className="h-4 w-4" /> Posted ({num(postings.length)})
            </TabsTrigger>
            <TabsTrigger value="return" className="gap-1">
              <Undo2 className="h-4 w-4" /> Returns ({num(returns.length)})
            </TabsTrigger>
          </TabsList>
          <TabsContent value="posting">{list(postings, "posting")}</TabsContent>
          <TabsContent value="return">{list(returns, "return")}</TabsContent>
        </Tabs>
      </CardContent>
      <Dialog open={!!discounting} onOpenChange={(v) => !v && setDiscounting(null)}>
        {discounting && (
          <SaleAdjustDialog
            sale={discounting}
            currency={currency ?? "NGN"}
            onDone={() => {
              setDiscounting(null);
              void q.refetch();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!paying} onOpenChange={(v) => !v && setPaying(null)}>
        {paying && (
          <CustomerPaymentDialog
            factoryId={factoryId}
            customerId={paying.customer_id}
            customerName={customerName ?? ""}
            owed={paying.balance}
            sale={{ id: paying.id, invoice_number: paying.invoice_number }}
            onDone={() => {
              setPaying(null);
              void q.refetch();
            }}
          />
        )}
      </Dialog>
    </Card>
  );
}
