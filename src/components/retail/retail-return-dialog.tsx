import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { money, num } from "@/lib/format";
import { fetchSaleLines } from "@/lib/invoice";
import { localDay } from "@/lib/production-shift";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { Loader2, Search } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- record_retail_return is newer than the generated types
const db = supabase as any;

type ShopSale = {
  id: string;
  invoice_number: string;
  sale_date: string;
  customer_id: string | null;
  customer_name: string | null;
  grand_total: number;
  amount_paid: number;
  balance: number;
};

type Line = { product_id: string; name: string; unit: string; sold: number; value: number };

const METHODS = ["cash", "transfer", "pos", "card", "cheque"] as const;

// Retail → Sales Returns → "Customer return": a customer who bought from the
// Retail Shop brings goods back. Pick the sale, enter what came back per
// product (up to what is left on the sale); it goes straight back into the
// shop's stock (record_retail_return -- no inspection or approval). The
// goods' value comes off what the customer still owes on the sale first;
// money already paid is kept as their credit (customers with an account) or
// handed back, which the Retail cash-up takes off the day's money.
export function RetailReturnDialog({
  factoryId,
  onDone,
}: {
  factoryId: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [sale, setSale] = useState<ShopSale | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [settle, setSettle] = useState<"credit" | "refund">("credit");
  const [method, setMethod] = useState<(typeof METHODS)[number]>("cash");
  const [date, setDate] = useState(localDay());
  const [reason, setReason] = useState("");

  const sales = useQuery({
    queryKey: ["retail-return-sales", factoryId],
    queryFn: async () => {
      const { data: outlets, error: oErr } = await supabase
        .from("sales_reps")
        .select("id")
        .eq("factory_id", factoryId)
        .eq("kind", "outlet");
      if (oErr) throw oErr;
      const ids = (outlets ?? []).map((o) => o.id);
      if (ids.length === 0) return [] as ShopSale[];
      const { data, error } = await supabase
        .from("sales")
        .select(
          "id,invoice_number,sale_date,customer_id,customer_name,grand_total,amount_paid,balance",
        )
        .eq("factory_id", factoryId)
        .in("sales_rep_id", ids)
        .eq("status", "posted")
        .eq("is_pr", false)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as ShopSale[];
    },
  });

  // The sale's products: what was sold, its value after discounts, less what
  // already came back on it.
  const lines = useQuery({
    queryKey: ["retail-return-lines", sale?.id],
    enabled: !!sale,
    queryFn: async () => {
      const map = await fetchSaleLines([sale!.id]);
      if (!map) throw new Error("Could not load the sale's products");
      const { data: back, error } = await supabase
        .from("sales_returns")
        .select("product_id,quantity_returned,status")
        .eq("sale_id", sale!.id)
        .neq("status", "cancelled");
      if (error) throw error;
      // sale_items gives each line's product; sale_invoice_lines its name
      // (products itself may not be readable here). Grouped by product.
      const { data: items, error: iErr } = await supabase
        .from("sale_items")
        .select("id,product_id,quantity,line_total")
        .eq("sale_id", sale!.id);
      if (iErr) throw iErr;
      const named = new Map((map.get(sale!.id) ?? []).map((l) => [l.item_id, l]));
      const byProduct = new Map<string, Line>();
      for (const it of items ?? []) {
        const info = named.get(it.id);
        const cur = byProduct.get(it.product_id) ?? {
          product_id: it.product_id,
          name: info?.name ?? "Product",
          unit: info?.unit ?? "",
          sold: 0,
          value: 0,
        };
        cur.sold += Number(it.quantity);
        cur.value += Number(it.line_total);
        byProduct.set(it.product_id, cur);
      }
      const returned = new Map<string, number>();
      for (const r of back ?? [])
        returned.set(r.product_id, (returned.get(r.product_id) ?? 0) + Number(r.quantity_returned));
      return [...byProduct.values()].map((l) => ({
        ...l,
        left: l.sold - (returned.get(l.product_id) ?? 0),
      }));
    },
  });

  const query = q.trim().toLowerCase();
  const shown = (sales.data ?? []).filter(
    (s) =>
      !query ||
      s.invoice_number.toLowerCase().includes(query) ||
      (s.customer_name ?? "").toLowerCase().includes(query),
  );
  const rows = useMemo(() => lines.data ?? [], [lines.data]);
  const value = useMemo(
    () =>
      rows.reduce(
        (t, l) =>
          t +
          (l.sold > 0 ? Math.round(((qty[l.product_id] ?? 0) * l.value * 100) / l.sold) / 100 : 0),
        0,
      ),
    [rows, qty],
  );
  const reduce = sale ? Math.min(value, Math.max(Number(sale.balance), 0)) : 0;
  const paidPart = value - reduce;
  const tooMany = rows.some((l) => (qty[l.product_id] ?? 0) > l.left);
  const nothing = value <= 0;
  const walkIn = !sale?.customer_id;
  const effectiveSettle = walkIn ? "refund" : settle;

  const save = useMutation({
    mutationFn: async () => {
      if (!sale) throw new Error("Pick the sale");
      const { data, error } = await db.rpc("record_retail_return", {
        payload: {
          sale_id: sale.id,
          settle: effectiveSettle,
          refund_method: method,
          return_date: date,
          reason: reason.trim() || null,
          items: rows
            .filter((l) => (qty[l.product_id] ?? 0) > 0)
            .map((l) => ({ product_id: l.product_id, quantity: qty[l.product_id] })),
        },
      });
      if (error) throw error;
      return data as {
        return_number: string;
        value: number;
        refund: number;
        credit_added: number;
      };
    },
    onSuccess: (res) => {
      toast.success(
        `${res.return_number}: ${money(Number(res.value))} back into the shop's stock` +
          (Number(res.refund) > 0 ? ` — ${money(Number(res.refund))} refunded` : "") +
          (Number(res.credit_added) > 0
            ? ` — ${money(Number(res.credit_added))} kept as credit`
            : ""),
      );
      for (const key of [
        "sales-returns-list",
        "stock-movement-summary",
        "sales-list",
        "retail-return-sales",
        "retail-return-lines",
        "outlet-stock",
        "outlet-day",
        "customer-account",
        "acct-sales",
      ])
        qc.invalidateQueries({ queryKey: [key] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Customer return — Retail Shop</DialogTitle>
      </DialogHeader>
      {!sale ? (
        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">Pick the shop sale the goods came from.</p>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search invoice or customer…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
            />
          </div>
          <div className="max-h-80 overflow-y-auto rounded-md border">
            {shown.map((s) => (
              <button
                key={s.id}
                type="button"
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                onClick={() => {
                  setSale(s);
                  setQty({});
                  setSettle(s.customer_id ? "credit" : "refund");
                }}
              >
                <span>
                  <span className="font-mono text-xs">{s.invoice_number}</span>{" "}
                  <span className="font-medium">{s.customer_name || "Walk-in"}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(s.sale_date).toLocaleDateString()} · {money(Number(s.grand_total))}
                </span>
              </button>
            ))}
            {shown.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">
                {sales.isLoading ? "Loading…" : "No shop sale matches."}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
            <span>
              <span className="font-mono text-xs">{sale.invoice_number}</span> ·{" "}
              <span className="font-medium">{sale.customer_name || "Walk-in"}</span> ·{" "}
              {new Date(sale.sale_date).toLocaleDateString()}
            </span>
            <span>
              Total {money(Number(sale.grand_total))} · paid {money(Number(sale.amount_paid))} ·
              owes {money(Number(sale.balance))}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setSale(null)}>
              Change sale
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Sold</TableHead>
                <TableHead className="text-right">Can come back</TableHead>
                <TableHead className="w-32">Returned</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((l) => {
                const n = qty[l.product_id] ?? 0;
                return (
                  <TableRow key={l.product_id}>
                    <TableCell>{l.name}</TableCell>
                    <TableCell className="text-right">
                      {num(l.sold)} {l.unit}
                    </TableCell>
                    <TableCell className="text-right">{num(l.left)}</TableCell>
                    <TableCell>
                      <MoneyInput
                        value={n}
                        disabled={l.left <= 0}
                        onChange={(v) => setQty((cur) => ({ ...cur, [l.product_id]: v }))}
                      />
                      {n > l.left && (
                        <p className="mt-1 text-xs text-destructive">Only {num(l.left)} left</p>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {money(l.sold > 0 ? (n * l.value) / l.sold : 0)}
                    </TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    {lines.isLoading
                      ? "Loading…"
                      : lines.error
                        ? (lines.error as Error).message
                        : "No products."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {paidPart > 0 && (
            <div className="grid gap-2 rounded-lg border p-3 text-sm">
              <p>{money(paidPart)} of this was already paid. What happens to it?</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={effectiveSettle === "credit" ? "default" : "outline"}
                  disabled={walkIn}
                  title={walkIn ? "A walk-in has no account to keep credit on" : undefined}
                  onClick={() => setSettle("credit")}
                >
                  Keep as customer&apos;s credit
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={effectiveSettle === "refund" ? "default" : "outline"}
                  onClick={() => setSettle("refund")}
                >
                  Refund to customer
                </Button>
                {effectiveSettle === "refund" && (
                  <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {METHODS.map((m) => (
                        <SelectItem key={m} value={m} className="capitalize">
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              {effectiveSettle === "refund" && (
                <p className="text-xs text-muted-foreground">
                  The refund comes off the money the shop hands over on the day (Retail cash-up).
                </p>
              )}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Return date</Label>
              <Input
                type="date"
                value={date}
                max={localDay()}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div>
              <Label>Reason (optional)</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg border p-3 text-sm">
            <span className="text-muted-foreground">Value of goods returned</span>
            <span className="text-right font-medium">{money(value)}</span>
            <span className="text-muted-foreground">Off what they owe</span>
            <span className="text-right">{money(reduce)}</span>
            {paidPart > 0 && (
              <>
                <span className="text-muted-foreground">
                  {effectiveSettle === "credit" ? "Kept as credit" : `Refunded (${method})`}
                </span>
                <span className="text-right">{money(paidPart)}</span>
              </>
            )}
          </div>
        </div>
      )}
      <DialogFooter>
        <Button
          disabled={!sale || save.isPending || nothing || tooMany}
          onClick={() => save.mutate()}
        >
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Record return
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
