import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Send } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { money, num } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { Textarea } from "@/components/ui/textarea";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// The shop's end of day in one press (close_shop_day,
// supabase/migrations/20261103150000_shop_end_of_day.sql; user 2026-11-03):
// the unsold go back to the Warehouse (it sees them on its next posting to
// the shop), damaged products come off the shop, and the day's money goes to
// Accounts, who count the goods and confirm on Accountant > Retail daily.

type DayProduct = { product_id: string; name: string; unit: string; closing: number };
type DayResponse = {
  live: {
    products: DayProduct[];
    money: {
      sales_value: number;
      cash_expected: number;
      other_expected: number;
      sales_count: number;
    };
    pending_sales: number;
  };
  reconciliation: { status: "submitted" | "queried" | "confirmed" } | null;
};

const lagosToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
const n = (v: unknown) => Number(v ?? 0);

export function EndOfDayDialog({
  outletId,
  outletName,
  currency,
  onDone,
}: {
  outletId: string;
  outletName: string;
  currency?: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [date, setDate] = useState(lagosToday());
  const [unsold, setUnsold] = useState<Record<string, number>>({});
  const [damaged, setDamaged] = useState<Record<string, number>>({});
  const [cash, setCash] = useState(0);
  const [other, setOther] = useState(0);
  const [notes, setNotes] = useState("");
  const fmt = (v: number) => money(v, currency);

  const day = useQuery({
    queryKey: ["outlet-day", outletId, date],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "outlet_day_figures" as never,
        { p_outlet: outletId, p_date: date } as never,
      );
      if (error) throw error;
      return data as unknown as DayResponse;
    },
  });
  // A past day: its unsold stayed at the shop overnight and have since been
  // sold or sent back, so only what the shop still holds now can go back.
  const isPast = date < lagosToday();
  const now = useQuery({
    queryKey: ["outlet-day", outletId, lagosToday()],
    enabled: isPast,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "outlet_day_figures" as never,
        { p_outlet: outletId, p_date: lagosToday() } as never,
      );
      if (error) throw error;
      return data as unknown as DayResponse;
    },
  });
  const nowHeld = (id: string) =>
    n(now.data?.live.products.find((p) => p.product_id === id)?.closing);
  const live = day.data?.live;
  const held = (live?.products ?? []).filter((p) => n(p.closing) > 0);
  const canReturn = (p: DayProduct) =>
    isPast ? Math.min(n(p.closing), nowHeld(p.product_id)) : n(p.closing);
  const tooMany = (p: DayProduct) =>
    (unsold[p.product_id] ?? 0) + (damaged[p.product_id] ?? 0) > canReturn(p);
  const closed = day.data?.reconciliation && day.data.reconciliation.status !== "queried";

  // A new day starts from: everything unsold goes back, the money as taken.
  useEffect(() => {
    if (!live) return;
    setUnsold(Object.fromEntries(held.map((p) => [p.product_id, isPast ? 0 : n(p.closing)])));
    setDamaged({});
    setCash(n(live.money.cash_expected));
    setOther(n(live.money.other_expected));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, isPast]);

  const left = (p: DayProduct) =>
    n(p.closing) - (unsold[p.product_id] ?? 0) - (damaged[p.product_id] ?? 0);
  const over = held.some(tooMany);
  const moneyOff =
    !!live &&
    (Math.abs(cash - n(live.money.cash_expected)) > 0.005 ||
      Math.abs(other - n(live.money.other_expected)) > 0.005);

  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc(
        "close_shop_day" as never,
        {
          payload: {
            outlet_id: outletId,
            close_date: date,
            declared_cash: cash,
            declared_other: other,
            notes: notes || null,
            items: held.map((p) => ({
              product_id: p.product_id,
              unsold: unsold[p.product_id] ?? 0,
              damaged: damaged[p.product_id] ?? 0,
            })),
          },
        } as never,
      );
      if (error) throw error;
      return data as unknown as { return_number: string | null };
    },
    onSuccess: (r) => {
      toast.success(
        r.return_number
          ? `Day posted to Accounts — unsold back to the Warehouse (${r.return_number})`
          : "Day posted to Accounts",
      );
      for (const key of [
        "outlet-day",
        "outlet-recons",
        "outlet-stock",
        "outlet-movements",
        "retail-activity",
        "retail-summary",
        "dispatch-open-returns",
        "dist-returns",
        "retail-daily-book",
      ])
        qc.invalidateQueries({ queryKey: [key] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const qtyInput = (value: number | undefined, set: (v: number) => void) => (
    <Input
      type="number"
      min={0}
      className="ml-auto h-8 w-20 text-right"
      value={value ?? 0}
      onChange={(e) => set(Math.max(0, Number(e.target.value) || 0))}
    />
  );

  return (
    <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Post Balance — {outletName}</DialogTitle>
        <DialogDescription>
          Unsold products go back to the Warehouse, damaged ones come off the shop, and the
          day&apos;s money goes to Accounts.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label>Day</Label>
          <Input
            type="date"
            className="w-44"
            value={date}
            max={lagosToday()}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
        </div>
        {live && (
          <div className="text-sm text-muted-foreground">
            {num(n(live.money.sales_count))} sale(s) · {fmt(n(live.money.sales_value))}
          </div>
        )}
      </div>

      {day.isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : day.isError ? (
        <p className="text-sm text-destructive">{(day.error as Error).message}</p>
      ) : closed ? (
        <p className="rounded-md border p-3 text-sm">
          This day is already with Accounts ({day.data?.reconciliation?.status}). Pick another day.
        </p>
      ) : live && live.pending_sales > 0 ? (
        <p className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
          {live.pending_sales} sale(s) on this day are still awaiting approval. Approve or cancel
          them first.
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">At the shop</TableHead>
                {isPast && <TableHead className="text-right">There now</TableHead>}
                <TableHead className="text-right">Unsold → Warehouse</TableHead>
                <TableHead className="text-right">Damaged</TableHead>
                <TableHead className="text-right">Left at shop</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {held.map((p) => (
                <TableRow key={p.product_id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="text-right">
                    {num(n(p.closing))} {p.unit}
                  </TableCell>
                  {isPast && (
                    <TableCell className="text-right">{num(nowHeld(p.product_id))}</TableCell>
                  )}
                  <TableCell className="text-right">
                    {qtyInput(unsold[p.product_id], (v) =>
                      setUnsold((m) => ({ ...m, [p.product_id]: v })),
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {qtyInput(damaged[p.product_id], (v) =>
                      setDamaged((m) => ({ ...m, [p.product_id]: v })),
                    )}
                  </TableCell>
                  <TableCell
                    className={`text-right font-medium ${tooMany(p) ? "text-destructive" : ""}`}
                  >
                    {num(left(p))}
                  </TableCell>
                </TableRow>
              ))}
              {held.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={isPast ? 6 : 5}
                    className="py-4 text-center text-muted-foreground"
                  >
                    Nothing left at the shop.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {isPast && held.length > 0 && (
            <p className="text-xs text-muted-foreground">
              A past day: what was left that evening stayed at the shop. Return only what is still
              there now (&quot;There now&quot;); otherwise leave 0 and just post the money.
            </p>
          )}

          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <Label>Cash handed over</Label>
              <MoneyInput value={cash} onChange={setCash} />
              {live && (
                <p className="text-[11px] text-muted-foreground">
                  Taken: {fmt(n(live.money.cash_expected))}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Transfer / POS</Label>
              <MoneyInput value={other} onChange={setOther} />
              {live && (
                <p className="text-[11px] text-muted-foreground">
                  Taken: {fmt(n(live.money.other_expected))}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label>
                Note{" "}
                {moneyOff && <span className="text-destructive">(required: money differs)</span>}
              </Label>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
        </>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          className="gap-2"
          disabled={
            !live ||
            (isPast && now.isLoading) ||
            !!closed ||
            (live?.pending_sales ?? 0) > 0 ||
            over ||
            (moneyOff && !notes.trim()) ||
            save.isPending
          }
          onClick={() => save.mutate()}
        >
          {save.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          Post to Accounts
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
