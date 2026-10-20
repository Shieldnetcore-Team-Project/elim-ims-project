import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { money, num } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { CheckCircle2, ClipboardCheck, Loader2, MessageSquareWarning, Send } from "lucide-react";

// End-of-day reconciliation between the retail outlet and Accounts (see
// supabase/migrations/20261020100000_retail_day_reconciliation.sql).
//   RetailDayClose     Retail Outlet page: count the shelf and the cash,
//                      submit the day to Accounts.
//   RetailCashUpTab    Accountant page: every outlet day, live figures, and
//                      confirm (records the remittance) or query back.
// The RPCs are newer than the generated Supabase types, hence the untyped client.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tables/RPCs newer than the generated types
const db = supabase as any;

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

const n = (v: unknown) => Number(v ?? 0);

const lagosToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });

const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

type ProductFig = {
  product_id: string;
  name: string;
  unit: string;
  unit_price: number;
  opening: number;
  received: number;
  sold: number;
  returned: number;
  damaged: number;
  corrections: number;
  closing: number;
  sold_value: number;
};

type DayFigures = {
  date: string;
  products: ProductFig[];
  stock: {
    opening: number;
    received: number;
    sold: number;
    returned: number;
    damaged: number;
    corrections: number;
    closing: number;
    closing_value: number;
  };
  money: {
    sales_count: number;
    sales_value: number;
    advance_applied: number;
    cash_expected: number;
    other_expected: number;
    credit_sales: number;
    by_method: Record<string, number>;
  };
  unremitted_before: number;
  remitted_on_day: number;
  pending_sales: number;
};

type CountLine = {
  product_id: string;
  name: string;
  unit: string;
  system: number;
  counted: number;
};

export type Recon = {
  id: string;
  factory_id: string;
  sales_rep_id: string;
  close_date: string;
  status: "submitted" | "queried" | "confirmed";
  figures: DayFigures;
  counted_stock: CountLine[];
  declared_cash: number;
  declared_other: number;
  retail_notes: string | null;
  submitted_at: string;
  received_cash: number | null;
  received_other: number | null;
  accounts_notes: string | null;
  reviewed_at: string | null;
};

type DayResponse = {
  outlet: { id: string; name: string };
  live: DayFigures;
  reconciliation: Recon | null;
};

const STATUS: Record<
  Recon["status"],
  { label: string; variant: "default" | "secondary" | "destructive" }
> = {
  submitted: { label: "Awaiting Accounts", variant: "secondary" },
  queried: { label: "Queried by Accounts", variant: "destructive" },
  confirmed: { label: "Confirmed", variant: "default" },
};

function cleanFigures(f: DayFigures): DayFigures {
  return {
    ...f,
    products: (f.products ?? []).map((p) => ({
      ...p,
      unit_price: n(p.unit_price),
      opening: n(p.opening),
      received: n(p.received),
      sold: n(p.sold),
      returned: n(p.returned),
      damaged: n(p.damaged),
      corrections: n(p.corrections),
      closing: n(p.closing),
      sold_value: n(p.sold_value),
    })),
    money: {
      ...f.money,
      sales_count: n(f.money?.sales_count),
      sales_value: n(f.money?.sales_value),
      advance_applied: n(f.money?.advance_applied),
      cash_expected: n(f.money?.cash_expected),
      other_expected: n(f.money?.other_expected),
      credit_sales: n(f.money?.credit_sales),
    },
    unremitted_before: n(f.unremitted_before),
    remitted_on_day: n(f.remitted_on_day),
    pending_sales: n(f.pending_sales),
  };
}

function cleanRecon(r: Recon | null): Recon | null {
  if (!r) return null;
  return {
    ...r,
    figures: cleanFigures(r.figures),
    counted_stock: (r.counted_stock ?? []).map((c) => ({
      ...c,
      system: n(c.system),
      counted: n(c.counted),
    })),
    declared_cash: n(r.declared_cash),
    declared_other: n(r.declared_other),
    received_cash: r.received_cash == null ? null : n(r.received_cash),
    received_other: r.received_other == null ? null : n(r.received_other),
  };
}

function useOutletDay(outletId: string, date: string) {
  return useQuery({
    queryKey: ["outlet-day", outletId, date],
    enabled: !!outletId && !!date,
    queryFn: async () => {
      const r = await rpc<DayResponse>("outlet_day_figures", { p_outlet: outletId, p_date: date });
      return { ...r, live: cleanFigures(r.live), reconciliation: cleanRecon(r.reconciliation) };
    },
  });
}

function useLiveDay() {
  useRealtimeInvalidate(
    ["outlet_day_reconciliations", "sales", "rep_stock_movements", "rep_remittances"],
    [["outlet-day"], ["outlet-recons"]],
  );
}

const diffClass = (d: number) =>
  Math.abs(d) < 0.0005 ? "text-muted-foreground" : d < 0 ? "text-destructive" : "text-warning";

const signed = (d: number, fmt: (v: number) => string) =>
  Math.abs(d) < 0.0005 ? "—" : `${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}`;

// --------------------------------------------------------------- shared UI ---

function StockTable({
  figures,
  counts,
  onCount,
  counted,
}: {
  figures: DayFigures;
  // editable count (retail filling in)
  counts?: Record<string, number | undefined>;
  onCount?: (productId: string, v: number | undefined) => void;
  // submitted count (read-only)
  counted?: CountLine[];
}) {
  const showCount = !!counts || !!counted;
  const countOf = (id: string) =>
    counts ? counts[id] : counted?.find((c) => c.product_id === id)?.counted;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead className="text-right">Opening</TableHead>
            <TableHead className="text-right">From Warehouse</TableHead>
            <TableHead className="text-right">Sold</TableHead>
            <TableHead className="text-right">Returned / damaged</TableHead>
            <TableHead className="text-right">System remaining</TableHead>
            {showCount && <TableHead className="text-right">Counted on shelf</TableHead>}
            {showCount && <TableHead className="text-right">Difference</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {figures.products.map((p) => {
            const c = countOf(p.product_id);
            const d = c == null ? null : c - p.closing;
            return (
              <TableRow key={p.product_id}>
                <TableCell className="font-medium">
                  {p.name}
                  {p.corrections !== 0 && (
                    <div className="text-[11px] text-muted-foreground">
                      Corrections {signed(p.corrections, num)}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">{num(p.opening)}</TableCell>
                <TableCell className="text-right">{num(p.received)}</TableCell>
                <TableCell className="text-right">{num(p.sold)}</TableCell>
                <TableCell className="text-right">{num(p.returned + p.damaged)}</TableCell>
                <TableCell className="text-right font-semibold">
                  {num(p.closing)} {p.unit}
                </TableCell>
                {showCount && (
                  <TableCell className="text-right">
                    {counts && onCount ? (
                      <Input
                        type="number"
                        min={0}
                        inputMode="decimal"
                        className="ml-auto h-8 w-24 text-right"
                        value={c ?? ""}
                        onChange={(e) =>
                          onCount(
                            p.product_id,
                            e.target.value === "" ? undefined : Number(e.target.value),
                          )
                        }
                      />
                    ) : c == null ? (
                      "—"
                    ) : (
                      num(c)
                    )}
                  </TableCell>
                )}
                {showCount && (
                  <TableCell className={`text-right font-medium ${d == null ? "" : diffClass(d)}`}>
                    {d == null ? "—" : signed(d, num)}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
          {figures.products.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={showCount ? 8 : 6}
                className="py-6 text-center text-muted-foreground"
              >
                No stock at the outlet on this day.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${tone ?? ""}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function MoneyFigures({ figures, currency }: { figures: DayFigures; currency?: string }) {
  const m = figures.money;
  const fmt = (v: number) => money(v, currency);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Figure label="Sales" value={fmt(m.sales_value)} hint={`${num(m.sales_count)} invoice(s)`} />
      <Figure label="Cash expected" value={fmt(m.cash_expected)} hint="Cash taken at the till" />
      <Figure
        label="Transfer / POS expected"
        value={fmt(m.other_expected)}
        hint="Non-cash taken at the till"
      />
      <Figure
        label="On credit"
        value={fmt(m.credit_sales)}
        hint={
          m.advance_applied > 0
            ? `Plus ${fmt(m.advance_applied)} from customer advances`
            : "Owed by customers"
        }
      />
      {Math.abs(figures.unremitted_before) > 0.005 && (
        <div className="col-span-2 text-xs text-warning md:col-span-4">
          Before this day the outlet was already holding {fmt(figures.unremitted_before)} not handed
          to Accounts.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------- Retail Outlet page ---

export function RetailDayClose({ outletId, currency }: { outletId: string; currency?: string }) {
  useLiveDay();
  const qc = useQueryClient();
  const { can } = usePermissions();
  // submit_outlet_day checks sales 'write' = create, edit or delete.
  const canSubmit = can("sales", "create") || can("sales", "edit") || can("sales", "delete");
  const [date, setDate] = useState(lagosToday());
  const day = useOutletDay(outletId, date);
  const rec = day.data?.reconciliation ?? null;
  const editable = canSubmit && (!rec || rec.status === "queried");

  const [counts, setCounts] = useState<Record<string, number | undefined>>({});
  const [cash, setCash] = useState(0);
  const [other, setOther] = useState(0);
  const [notes, setNotes] = useState("");

  // Start the form again for each day; a queried day starts from what was sent.
  useEffect(() => {
    setCounts(
      Object.fromEntries(
        (rec?.status === "queried" ? rec.counted_stock : []).map((c) => [c.product_id, c.counted]),
      ),
    );
    setCash(rec?.status === "queried" ? rec.declared_cash : 0);
    setOther(rec?.status === "queried" ? rec.declared_other : 0);
    setNotes(rec?.status === "queried" ? (rec.retail_notes ?? "") : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outletId, date, rec?.id, rec?.status]);

  const live = day.data?.live;
  const shown = rec && rec.status !== "queried" ? rec.figures : live;
  const missing = (live?.products ?? []).filter((p) => counts[p.product_id] == null);
  const stockOff = (live?.products ?? []).some(
    (p) =>
      counts[p.product_id] != null && Math.abs((counts[p.product_id] ?? 0) - p.closing) > 0.0005,
  );
  const cashOff =
    !!live &&
    (Math.abs(cash - live.money.cash_expected) > 0.005 ||
      Math.abs(other - live.money.other_expected) > 0.005);

  const submit = useMutation({
    mutationFn: () =>
      rpc("submit_outlet_day", {
        p_outlet: outletId,
        p_date: date,
        p_declared_cash: cash,
        p_declared_other: other,
        p_counts: Object.entries(counts)
          .filter(([, v]) => v != null)
          .map(([product_id, counted]) => ({ product_id, counted })),
        p_notes: notes || null,
      }),
    onSuccess: () => {
      toast.success(`${fmtDay(date)} sent to Accounts`);
      qc.invalidateQueries({ queryKey: ["outlet-day"] });
      qc.invalidateQueries({ queryKey: ["outlet-recons"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <ClipboardCheck className="h-5 w-5" /> Close the day with Accounts
        </CardTitle>
        <div className="flex items-center gap-2">
          {rec && <Badge variant={STATUS[rec.status].variant}>{STATUS[rec.status].label}</Badge>}
          <Input
            type="date"
            className="w-40"
            value={date}
            max={lagosToday()}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {day.isLoading || !shown ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {rec?.status === "queried" && rec.accounts_notes && (
              <div className="flex gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <MessageSquareWarning className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div>
                  <div className="font-medium">Accounts sent this day back</div>
                  <div className="text-muted-foreground">{rec.accounts_notes}</div>
                </div>
              </div>
            )}
            {live && live.pending_sales > 0 && editable && (
              <div className="rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm">
                {live.pending_sales} sale(s) on this day are still awaiting approval. Approve or
                cancel them before closing the day.
              </div>
            )}

            <MoneyFigures figures={shown} currency={currency} />

            <StockTable
              figures={shown}
              counts={editable ? counts : undefined}
              onCount={editable ? (id, v) => setCounts((c) => ({ ...c, [id]: v })) : undefined}
              counted={editable ? undefined : rec?.counted_stock}
            />

            {editable ? (
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>Cash in hand</Label>
                  <MoneyInput value={cash} onChange={setCash} />
                  {live && (
                    <p className="text-[11px] text-muted-foreground">
                      Expected {money(live.money.cash_expected, currency)}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>Transfer / POS received</Label>
                  <MoneyInput value={other} onChange={setOther} />
                  {live && (
                    <p className="text-[11px] text-muted-foreground">
                      Expected {money(live.money.other_expected, currency)}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>
                    Notes{" "}
                    {(stockOff || cashOff) && (
                      <span className="text-destructive">(required: count differs)</span>
                    )}
                  </Label>
                  <Textarea
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Explain any shortage or surplus"
                  />
                </div>
                <div className="flex items-center justify-end gap-3 md:col-span-3">
                  {missing.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      Count every product to submit ({missing.length} left)
                    </span>
                  )}
                  <Button
                    className="gap-2"
                    disabled={
                      submit.isPending ||
                      missing.length > 0 ||
                      ((stockOff || cashOff) && !notes.trim()) ||
                      (live?.pending_sales ?? 0) > 0
                    }
                    onClick={() => submit.mutate()}
                  >
                    {submit.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                    {rec?.status === "queried" ? "Resubmit to Accounts" : "Submit to Accounts"}
                  </Button>
                </div>
              </div>
            ) : rec ? (
              <SubmittedSummary rec={rec} currency={currency} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Not submitted yet. Only staff who can record sales can submit the day.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SubmittedSummary({ rec, currency }: { rec: Recon; currency?: string }) {
  const fmt = (v: number) => money(v, currency);
  const m = rec.figures.money;
  const rows: { label: string; expected: number; declared: number; received: number | null }[] = [
    {
      label: "Cash",
      expected: m.cash_expected,
      declared: rec.declared_cash,
      received: rec.received_cash,
    },
    {
      label: "Transfer / POS",
      expected: m.other_expected,
      declared: rec.declared_other,
      received: rec.received_other,
    },
  ];
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Money</TableHead>
              <TableHead className="text-right">Expected (system)</TableHead>
              <TableHead className="text-right">Declared by retail</TableHead>
              <TableHead className="text-right">Received by Accounts</TableHead>
              <TableHead className="text-right">Short / over</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const final = r.received ?? r.declared;
              const d = final - r.expected;
              return (
                <TableRow key={r.label}>
                  <TableCell className="font-medium">{r.label}</TableCell>
                  <TableCell className="text-right">{fmt(r.expected)}</TableCell>
                  <TableCell className="text-right">{fmt(r.declared)}</TableCell>
                  <TableCell className="text-right">
                    {r.received == null ? "—" : fmt(r.received)}
                  </TableCell>
                  <TableCell className={`text-right font-medium ${diffClass(d)}`}>
                    {signed(d, fmt)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="grid gap-2 text-sm md:grid-cols-2">
        <div>
          <span className="text-muted-foreground">Retail note: </span>
          {rec.retail_notes ?? "—"}
          <div className="text-[11px] text-muted-foreground">
            Submitted {new Date(rec.submitted_at).toLocaleString()}
          </div>
        </div>
        {rec.reviewed_at && (
          <div>
            <span className="text-muted-foreground">Accounts note: </span>
            {rec.accounts_notes ?? "—"}
            <div className="text-[11px] text-muted-foreground">
              {rec.status === "confirmed" ? "Confirmed" : "Queried"}{" "}
              {new Date(rec.reviewed_at).toLocaleString()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------- Accountant page ---

type Outlet = { id: string; full_name: string; status: string };

export function RetailCashUpTab({ factoryId, currency }: { factoryId: string; currency?: string }) {
  useLiveDay();
  const [outletId, setOutletId] = useState("");
  const [openDate, setOpenDate] = useState(lagosToday());
  const [dialog, setDialog] = useState<{ outletId: string; date: string } | null>(null);
  const fmt = (v: number) => money(v, currency);

  const outlets = useQuery({
    queryKey: ["outlets", factoryId],
    queryFn: async () => {
      const { data, error } = await db
        .from("sales_reps")
        .select("id,full_name,status")
        .eq("factory_id", factoryId)
        .eq("kind", "outlet")
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as Outlet[];
    },
  });

  useEffect(() => {
    if (outletId || !outlets.data?.length) return;
    setOutletId((outlets.data.find((o) => o.status === "active") ?? outlets.data[0]).id);
  }, [outlets.data, outletId]);

  const recons = useQuery({
    queryKey: ["outlet-recons", factoryId],
    queryFn: async () => {
      const { data, error } = await db
        .from("outlet_day_reconciliations")
        .select("*")
        .eq("factory_id", factoryId)
        .order("close_date", { ascending: false })
        .limit(120);
      if (error) throw error;
      return ((data ?? []) as Recon[]).map((r) => cleanRecon(r)!);
    },
  });

  const outletName = (id: string) => outlets.data?.find((o) => o.id === id)?.full_name ?? "Outlet";
  const rows = useMemo(() => {
    const order = { submitted: 0, queried: 1, confirmed: 2 } as const;
    return [...(recons.data ?? [])].sort(
      (a, b) => order[a.status] - order[b.status] || b.close_date.localeCompare(a.close_date),
    );
  }, [recons.data]);
  const waiting = rows.filter((r) => r.status === "submitted").length;

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle>Retail cash-up</CardTitle>
            <p className="text-sm text-muted-foreground">
              What the Warehouse posted to the shop, what it sold, what is left, and the money
              handed over.{" "}
              {waiting > 0 && (
                <span className="font-medium text-foreground">
                  {waiting} day(s) waiting for you.
                </span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(outlets.data ?? []).length > 1 && (
              <Select value={outletId} onValueChange={setOutletId}>
                <SelectTrigger className="w-44">
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
            <Input
              type="date"
              className="w-40"
              value={openDate}
              max={lagosToday()}
              onChange={(e) => e.target.value && setOpenDate(e.target.value)}
            />
            <Button
              variant="outline"
              disabled={!outletId}
              onClick={() => setDialog({ outletId, date: openDate })}
            >
              View day
            </Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead>Outlet</TableHead>
                <TableHead className="text-right">Sales</TableHead>
                <TableHead className="text-right">Cash + transfer expected</TableHead>
                <TableHead className="text-right">Declared</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Stock diff.</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const expected = r.figures.money.cash_expected + r.figures.money.other_expected;
                const declared = r.declared_cash + r.declared_other;
                const received =
                  r.received_cash == null ? null : r.received_cash + (r.received_other ?? 0);
                const stockDiff = r.counted_stock.reduce((t, c) => t + (c.counted - c.system), 0);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">{fmtDay(r.close_date)}</TableCell>
                    <TableCell>{outletName(r.sales_rep_id)}</TableCell>
                    <TableCell className="text-right">{fmt(r.figures.money.sales_value)}</TableCell>
                    <TableCell className="text-right">{fmt(expected)}</TableCell>
                    <TableCell className={`text-right ${diffClass(declared - expected)}`}>
                      {fmt(declared)}
                    </TableCell>
                    <TableCell className="text-right">
                      {received == null ? "—" : fmt(received)}
                    </TableCell>
                    <TableCell className={`text-right ${diffClass(stockDiff)}`}>
                      {signed(stockDiff, num)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant={r.status === "submitted" ? "default" : "outline"}
                        onClick={() => setDialog({ outletId: r.sales_rep_id, date: r.close_date })}
                      >
                        {r.status === "submitted" ? "Review" : "Open"}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                    No day has been submitted by the retail outlet yet. Use “View day” to see a
                    day’s live figures.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {dialog && (
        <AccountsDayDialog
          outletId={dialog.outletId}
          date={dialog.date}
          currency={currency}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function AccountsDayDialog({
  outletId,
  date,
  currency,
  onClose,
}: {
  outletId: string;
  date: string;
  currency?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const isAccounts =
    can("finance", "view") &&
    (can("payments", "create") || can("finance", "post") || can("distribution", "post"));
  const day = useOutletDay(outletId, date);
  const rec = day.data?.reconciliation ?? null;
  const reviewing = isAccounts && rec?.status === "submitted";

  const [cash, setCash] = useState(0);
  const [other, setOther] = useState(0);
  const [notes, setNotes] = useState("");
  useEffect(() => {
    if (!rec) return;
    setCash(rec.declared_cash);
    setOther(rec.declared_other);
  }, [rec?.id, rec?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const done = (msg: string) => {
    toast.success(msg);
    qc.invalidateQueries({ queryKey: ["outlet-day"] });
    qc.invalidateQueries({ queryKey: ["outlet-recons"] });
    onClose();
  };
  const confirm = useMutation({
    mutationFn: () =>
      rpc("confirm_outlet_day", {
        p_id: rec!.id,
        p_received_cash: cash,
        p_received_other: other,
        p_notes: notes || null,
      }),
    onSuccess: () => done(`${fmtDay(date)} confirmed — remittance recorded`),
    onError: (e: Error) => toast.error(e.message),
  });
  const query = useMutation({
    mutationFn: () => rpc("query_outlet_day", { p_id: rec!.id, p_notes: notes }),
    onSuccess: () => done(`${fmtDay(date)} sent back to retail`),
    onError: (e: Error) => toast.error(e.message),
  });

  const live = day.data?.live;
  const shown = rec && rec.status !== "queried" ? rec.figures : live;
  const m = rec?.figures.money;
  const differs =
    !!rec &&
    !!m &&
    (Math.abs(cash - rec.declared_cash) > 0.005 ||
      Math.abs(other - rec.declared_other) > 0.005 ||
      Math.abs(cash - m.cash_expected) > 0.005 ||
      Math.abs(other - m.other_expected) > 0.005);
  const busy = confirm.isPending || query.isPending;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[95vw] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {day.data?.outlet.name ?? "Retail outlet"} — {fmtDay(date)}
            {rec ? (
              <Badge variant={STATUS[rec.status].variant}>{STATUS[rec.status].label}</Badge>
            ) : (
              <Badge variant="outline">Not submitted — live figures</Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {day.isLoading || !shown ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <MoneyFigures figures={shown} currency={currency} />
            <StockTable
              figures={shown}
              counted={rec && rec.status !== "queried" ? rec.counted_stock : undefined}
            />
            {rec && rec.status !== "queried" && <SubmittedSummary rec={rec} currency={currency} />}
            {rec?.status === "queried" && (
              <p className="text-sm text-muted-foreground">
                Sent back to retail: “{rec.accounts_notes}”. Waiting for them to resubmit.
              </p>
            )}

            {reviewing && (
              <div className="grid gap-4 rounded-xl border p-4 md:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>Cash received</Label>
                  <MoneyInput value={cash} onChange={setCash} />
                </div>
                <div className="space-y-1.5">
                  <Label>Transfer / POS received</Label>
                  <MoneyInput value={other} onChange={setOther} />
                </div>
                <div className="space-y-1.5">
                  <Label>
                    Note{" "}
                    {differs && (
                      <span className="text-destructive">(required: amounts differ)</span>
                    )}
                  </Label>
                  <Textarea
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Shortage, surplus, or what retail should check"
                  />
                </div>
                <p className="text-xs text-muted-foreground md:col-span-3">
                  Confirming records what you received as the outlet’s remittance for {fmtDay(date)}{" "}
                  and closes the day. Querying sends it back to retail with your note.
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {reviewing && (
            <>
              <Button
                variant="destructive"
                className="gap-2"
                disabled={busy || !notes.trim()}
                onClick={() => query.mutate()}
              >
                <MessageSquareWarning className="h-4 w-4" /> Query back to retail
              </Button>
              <Button
                className="gap-2"
                disabled={busy || (differs && !notes.trim())}
                onClick={() => confirm.mutate()}
              >
                {confirm.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Confirm &amp; record remittance
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
