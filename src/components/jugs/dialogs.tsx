import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
import { useQuery } from "@tanstack/react-query";
import { CountInput, fmtDateTime } from "@/components/preform/shared";
import { db, rpc, useUserNames } from "@/components/preform/api";
import { formatDay } from "@/lib/jug-accountability";
import { localDay } from "@/lib/production-shift";
import { LastSuppliedPanel, useLastSupplied } from "@/components/warehouse/last-supplied";
import { useMyProductMatcher } from "@/lib/product-rules";
import { money, num } from "@/lib/format";
import { usePermissions } from "@/lib/permissions";
import {
  ROLE_LABEL,
  SOURCE_LABEL,
  dayEnd,
  dayStart,
  useJugAction,
  useJugMovements,
  useJugReturns,
  useProductLinks,
  type JugRole,
  type Named,
  type ReportRow,
} from "./api";
import { EarlierReturnsNote, ReturnDateField } from "@/components/shared/return-date";
import { jugTypeLabel } from "@/lib/jug-type-label";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

// Old Jug, then New Jug, then any other jug type.
const jugTypeRank = (name: string) => {
  const n = name.trim().toLowerCase();
  return n === "old jug" ? 0 : n === "new jug" ? 1 : 2;
};

// ----------------------------------------------------------- record return
// What the marketer says they brought back. Nothing moves until the
// QC counts it (Quality Control -> Old & New Jugs; 20261101100000).
export function RecordReturnDialog({
  factoryId,
  marketers,
  types,
  initialRepId,
  initialCustomerId,
  initialTypeId,
  shop = false,
  onClose,
}: {
  factoryId: string;
  marketers: Named[];
  types: { id: string; name: string }[];
  // The Retail Shop (factory shop) returns on its own, apart from marketers
  // and distributors (user, 2026-11-10).
  shop?: boolean;
  initialRepId?: string;
  // A Distributor/Office Delivery customer to start with (Warehouse party window).
  initialCustomerId?: string;
  initialTypeId?: string;
  onClose: () => void;
}) {
  // "rep:<id>" for a marketer / the shop, "customer:<id>" for a
  // Distributor/Office Delivery customer (user, 2026-11-02).
  const shops = marketers.filter((m) => m.kind === "outlet");
  const people = marketers.filter((m) => m.kind !== "outlet");
  const [holder, setHolder] = useState(
    initialRepId
      ? `rep:${initialRepId}`
      : initialCustomerId
        ? `customer:${initialCustomerId}`
        : shop && shops.length === 1
          ? `rep:${shops[0].id}`
          : "",
  );
  const [holderKind, holderId] = holder.split(":") as ["rep" | "customer" | "", string];
  const distributors = useQuery({
    queryKey: ["jug", "distributors", factoryId],
    queryFn: async () => {
      const { data, error } = await db
        .from("customers")
        .select("id,name,phone")
        .eq("factory_id", factoryId)
        .eq("registered", true)
        .is("sales_rep_id", null)
        .is("removed_at", null)
        .order("name");
      if (error) return [];
      return (data ?? []) as { id: string; name: string; phone: string | null }[];
    },
  });
  // Old Jug / New Jug (20261023190000) first; the person returning picks one.
  const [typeId, setTypeId] = useState(initialTypeId ?? "");
  const jugTypes = [...types].sort(
    (a, b) => jugTypeRank(a.name) - jugTypeRank(b.name) || a.name.localeCompare(b.name),
  );
  const [qty, setQty] = useState<number | null>(null);
  // More jug types and quantities in one go (user, 2026-11-02): the first
  // line is typeId / qty above, these are the added ones.
  const [more, setMore] = useState<{ typeId: string; qty: number | null }[]>([]);
  const lines = [{ typeId, qty }, ...more];
  const linesReady = lines.every((l) => l.typeId && l.qty && l.qty > 0);
  const totalJugs = lines.reduce((t, l) => t + (l.qty ?? 0), 0);
  const [notes, setNotes] = useState("");
  // The day they came back -- today, or an earlier day (user, 2026-11-02).
  const [returnDate, setReturnDate] = useState(localDay());
  // One key per dialog: a double click records one return (one per line).
  const [clientRef] = useState(() => crypto.randomUUID());
  const save = useJugAction(
    async () => {
      const refs: string[] = [];
      for (const [i, l] of lines.entries()) {
        const r = await rpc<{ reference: string }>("record_jug_return", {
          payload: {
            client_ref: i === 0 ? clientRef : `${clientRef}-${i}`,
            sales_rep_id: holderKind === "rep" ? holderId : undefined,
            customer_id: holderKind === "customer" ? holderId : undefined,
            container_type_id: l.typeId,
            quantity: l.qty,
            notes,
            return_date: returnDate,
          },
        });
        refs.push(r.reference);
      }
      return { reference: refs.join(", ") };
    },
    (r) =>
      `${(r as { reference: string }).reference} recorded — hand the jugs to QC, who count and confirm them`,
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {shop ? "Retail Shop — empty Dispenser Jugs" : "Return empty Dispenser Jugs"}
          </DialogTitle>
          <DialogDescription>
            {shop
              ? "Empty jugs the factory shop hands back. QC counts them and posts them to the PM."
              : "What the marketer or distributor says they brought back. QC counts them and posts them to the PM."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="From">
            <Select value={holder} onValueChange={setHolder}>
              <SelectTrigger>
                <SelectValue
                  placeholder={shop ? "Retail Shop" : "Marketer or Distributor/Office Delivery"}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{shop ? "Retail Shop" : "Marketers"}</SelectLabel>
                  {(shop ? shops : people).map((m) => (
                    <SelectItem key={m.id} value={`rep:${m.id}`}>
                      {m.code ? `${m.code} · ` : ""}
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
                {!shop && (distributors.data ?? []).length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Distributor/Office Delivery</SelectLabel>
                    {(distributors.data ?? []).map((c) => (
                      <SelectItem key={c.id} value={`customer:${c.id}`}>
                        {c.name}
                        {c.phone ? ` · ${c.phone}` : ""}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </Field>
          {holderId && (
            <LastSuppliedPanel
              kind={holderKind === "customer" ? "customer" : "marketer"}
              id={holderId}
            />
          )}
          <Field label="Jug type">
            <Select value={typeId} onValueChange={setTypeId}>
              <SelectTrigger>
                <SelectValue placeholder="Old or New Dispenser Jug?" />
              </SelectTrigger>
              <SelectContent>
                {jugTypes.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {jugTypeLabel(t.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Date returned">
            <Input
              type="date"
              value={returnDate}
              max={localDay()}
              onChange={(e) => e.target.value && setReturnDate(e.target.value)}
            />
          </Field>
          <Field label="Empty Dispenser Jugs returned">
            <CountInput value={qty} onChange={setQty} placeholder="0" />
          </Field>
          {more.map((l, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field label="Jug type">
                  <Select
                    value={l.typeId}
                    onValueChange={(v) =>
                      setMore((m) => m.map((x, j) => (j === i ? { ...x, typeId: v } : x)))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Old or New Dispenser Jug?" />
                    </SelectTrigger>
                    <SelectContent>
                      {jugTypes.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {jugTypeLabel(t.name)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <div className="w-28">
                <Field label="Jugs">
                  <CountInput
                    value={l.qty}
                    onChange={(v) =>
                      setMore((m) => m.map((x, j) => (j === i ? { ...x, qty: v } : x)))
                    }
                    placeholder="0"
                  />
                </Field>
              </div>
              <Button
                variant="ghost"
                size="icon"
                title="Remove"
                onClick={() => setMore((m) => m.filter((_, j) => j !== i))}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit gap-1"
            onClick={() => setMore((m) => [...m, { typeId: "", qty: null }])}
          >
            <Plus className="h-4 w-4" /> Add another jug type
          </Button>
          <Field label="Notes (optional)">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!holderId || !linesReady || save.isPending}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Record return{totalJugs > 0 ? ` (${num(totalJugs)})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------- receive unsold dispensers
// Filled dispenser jugs a marketer brings back unsold. Posted through the
// existing marketer return (create_rep_return): off the marketer's stock,
// back into Warehouse finished goods, the marketer credited, and the jugs
// moved marketer -> Warehouse on the container ledger (counted as Received).
export function ReceiveUnsoldDialog({
  factoryId,
  marketers: allMarketers,
  onClose,
  presetRepId,
  presetCustomerId,
}: {
  factoryId: string;
  marketers: (Named & { kind?: string })[];
  onClose: () => void;
  // Opened from a marketer's / a distributor's window (2026-11-04).
  presetRepId?: string;
  presetCustomerId?: string;
}) {
  // Marketers only: the Retail Shop no longer returns (20261104130000).
  const marketers = allMarketers.filter((m) => m.kind !== "outlet");
  // One list: every marketer and every Distributor/Office Delivery customer
  // (user, 2026-11-04).
  const distributors = useQuery({
    queryKey: ["jug", "customers", factoryId, true],
    queryFn: async () => {
      const { data, error } = await db
        .from("customers")
        .select("id,name,phone,registered,sales_rep_id")
        .eq("factory_id", factoryId)
        .is("removed_at", null)
        .order("name");
      if (error) throw error;
      return (
        (data ?? []) as {
          id: string;
          name: string;
          registered: boolean;
          sales_rep_id: string | null;
        }[]
      ).filter((c) => c.registered && !c.sales_rep_id);
    },
  });
  const [party, setParty] = useState(
    presetCustomerId ? `cust:${presetCustomerId}` : presetRepId ? `rep:${presetRepId}` : "",
  );
  const [kind, id] = party ? (party.split(":") as ["rep" | "cust", string]) : ["rep", ""];
  const picker = (
    <Field label="From">
      <Select value={party} onValueChange={setParty}>
        <SelectTrigger>
          <SelectValue placeholder="Choose a marketer or distributor" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Marketers</SelectLabel>
            {marketers.map((m) => (
              <SelectItem key={m.id} value={`rep:${m.id}`}>
                {m.code ? `${m.code} · ` : ""}
                {m.name}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectGroup>
            <SelectLabel>Distributors</SelectLabel>
            {(distributors.data ?? []).map((c) => (
              <SelectItem key={c.id} value={`cust:${c.id}`}>
                {c.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
  return kind === "cust" ? (
    <CustomerUnsoldDialog
      key={party}
      factoryId={factoryId}
      onClose={onClose}
      toggle={picker}
      presetCustomerId={id}
      distributorsOnly
      hidePicker
    />
  ) : (
    <MarketerUnsoldDialog
      key={party}
      factoryId={factoryId}
      marketers={marketers}
      onClose={onClose}
      toggle={picker}
      presetRepId={id || undefined}
      hidePicker
    />
  );
}

function MarketerUnsoldDialog({
  factoryId,
  marketers,
  onClose,
  toggle,
  presetRepId,
  hidePicker = false,
}: {
  factoryId: string;
  marketers: Named[];
  onClose: () => void;
  toggle: React.ReactNode;
  presetRepId?: string;
  // The From list above already picked the marketer.
  hidePicker?: boolean;
}) {
  const [repId, setRepId] = useState(presetRepId ?? "");
  const [qty, setQty] = useState<Record<string, number | null>>({});
  const [notes, setNotes] = useState("");
  const links = useProductLinks(factoryId);
  // Filled dispenser products only; an "Empty jug" product is not a dispenser.
  // ...and only those this Warehouse officer handles (20261101140000).
  const mine = useMyProductMatcher();
  const dispenserIds = useMemo(() => {
    const names = Object.fromEntries((links.data?.products ?? []).map((p) => [p.id, p.name]));
    return new Set(
      (links.data?.links ?? [])
        .filter((l) => l.jug_role !== "empty" && mine(names[l.product_id] ?? ""))
        .map((l) => l.product_id),
    );
  }, [links.data, mine]);
  const productName = useMemo(
    () => Object.fromEntries((links.data?.products ?? []).map((p) => [p.id, p.name])),
    [links.data],
  );
  const stock = useQuery({
    queryKey: ["jug", "rep-stock", repId],
    enabled: !!repId,
    queryFn: async () => {
      const { data, error } = await db
        .from("rep_stock")
        .select("product_id,quantity")
        .eq("sales_rep_id", repId)
        .gt("quantity", 0);
      if (error) throw error;
      return ((data ?? []) as { product_id: string; quantity: number }[]).map((r) => ({
        product_id: r.product_id,
        quantity: Number(r.quantity),
      }));
    },
  });
  const held = (stock.data ?? []).filter((s) => dispenserIds.has(s.product_id));
  // Yesterday's unsold keyed in today go on yesterday (2026-11-03).
  const [unsoldDate, setUnsoldDate] = useState(localDay());
  const items = held
    .map((s) => ({ product_id: s.product_id, quantity_returned: qty[s.product_id] ?? 0 }))
    .filter((i) => i.quantity_returned > 0);
  const over = held.some((s) => (qty[s.product_id] ?? 0) > s.quantity);
  const total = items.reduce((s, i) => s + i.quantity_returned, 0);

  const save = useJugAction(
    () =>
      rpc<{ return_number: string }>("create_rep_return", {
        payload: {
          factory_id: factoryId,
          sales_rep_id: repId,
          return_date: unsoldDate,
          notes: notes || undefined,
          items,
        },
      }),
    (r) =>
      `${(r as { return_number: string }).return_number}: ${num(total)} unsold dispenser(s) received into the Warehouse`,
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Receive unsold dispensers</DialogTitle>
          <DialogDescription>
            Filled dispenser jugs a marketer brings back unsold. They come off the marketer&apos;s
            stock, go back into Warehouse finished goods, and the jugs count as Received.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {toggle}
          {!hidePicker && (
            <Field label="Marketer">
              <Select
                value={repId}
                onValueChange={(v) => {
                  setRepId(v);
                  setQty({});
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose" />
                </SelectTrigger>
                <SelectContent>
                  {marketers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.code ? `${m.code} · ` : ""}
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {repId && <LastSuppliedPanel kind="marketer" id={repId} />}
          {repId && <ReturnDateField value={unsoldDate} onChange={setUnsoldDate} />}
          {repId && (
            <EarlierReturnsNote
              holderId={repId}
              date={unsoldDate}
              only={(id) => dispenserIds.has(id)}
            />
          )}
          {repId && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Holding</TableHead>
                  <TableHead className="w-28 text-right">Returned</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {held.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                      {stock.isLoading || links.isLoading
                        ? "Loading…"
                        : "This marketer holds no dispenser stock."}
                    </TableCell>
                  </TableRow>
                )}
                {held.map((s) => {
                  const v = qty[s.product_id] ?? null;
                  return (
                    <TableRow key={s.product_id}>
                      <TableCell>{productName[s.product_id] ?? "—"}</TableCell>
                      <TableCell className="text-right">{num(s.quantity)}</TableCell>
                      <TableCell className="text-right">
                        <CountInput
                          className="ml-auto w-24 text-right"
                          value={v}
                          onChange={(x) => setQty((q) => ({ ...q, [s.product_id]: x }))}
                          placeholder="0"
                        />
                        {(v ?? 0) > s.quantity && (
                          <div className="text-[11px] text-destructive">More than held</div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <Field label="Notes (optional)">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!repId || items.length === 0 || over || save.isPending}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Receive {total > 0 ? num(total) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Unsold dispensers back from any customer -- distributor, a marketer's
// customer, retail / walk-in (warehouse_receive_customer_return, 20261102270000): back into
// the Warehouse, what they owe comes down first, the rest is their credit.
// Goods bought from a marketer's van or the shop go back through that
// marketer's account, so the marketer is credited too.
// Also Warehouse → Returns (2026-11-02): allProducts takes back any product,
// distributorsOnly lists Distributor/Office Delivery customers only (a
// marketer's customers come back through the marketer).
export function CustomerUnsoldDialog({
  factoryId,
  onClose,
  toggle,
  allProducts = false,
  distributorsOnly = false,
  onDone,
  presetCustomerId,
  hidePicker = false,
}: {
  factoryId: string;
  onClose: () => void;
  toggle?: React.ReactNode;
  // The From list above already picked the customer.
  hidePicker?: boolean;
  allProducts?: boolean;
  distributorsOnly?: boolean;
  onDone?: () => void;
  // Start on this customer (Warehouse party window).
  presetCustomerId?: string;
}) {
  const [search, setSearch] = useState("");
  const [customerId, setCustomerId] = useState(presetCustomerId ?? "");
  const [qty, setQty] = useState<Record<string, number | null>>({});
  const [reason, setReason] = useState("");
  const [returnDate, setReturnDate] = useState(localDay());
  // Products typed in by hand (Distributor/Office Delivery, 2026-11-02): any
  // finished product and quantity, also goods not bought in this system.
  const [manual, setManual] = useState<{ product_id: string; quantity: number }[]>([]);
  const [addProduct, setAddProduct] = useState("");
  const [addQty, setAddQty] = useState<number | null>(null);
  const mine = useMyProductMatcher();
  const products = useQuery({
    queryKey: ["jug", "return-products", factoryId],
    enabled: allProducts,
    queryFn: async () => {
      const { data, error } = await db
        .from("products")
        .select("id,name,unit")
        .eq("factory_id", factoryId)
        .eq("product_type", "finished")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string; unit: string }[];
    },
  });
  const productList = (products.data ?? []).filter((p) => mine(p.name));
  const productOf = (id: string) => (products.data ?? []).find((p) => p.id === id);
  const customers = useQuery({
    queryKey: ["jug", "customers", factoryId, distributorsOnly],
    queryFn: async () => {
      const { data, error } = await db
        .from("customers")
        .select("id,name,phone,registered,sales_rep_id")
        .eq("factory_id", factoryId)
        .is("removed_at", null)
        .order("name");
      if (error) throw error;
      const rows = (data ?? []) as {
        id: string;
        name: string;
        phone: string | null;
        registered: boolean;
        sales_rep_id: string | null;
      }[];
      return distributorsOnly ? rows.filter((c) => c.registered && !c.sales_rep_id) : rows;
    },
  });
  const k = search.trim().toLowerCase();
  const shown = (customers.data ?? []).filter(
    (c) => !k || c.name.toLowerCase().includes(k) || (c.phone ?? "").includes(k),
  );
  const returnable = useQuery({
    queryKey: ["jug", "customer-returnable", customerId, allProducts],
    enabled: !!customerId,
    retry: false,
    queryFn: async () =>
      (
        await rpc<
          {
            product_id: string;
            name: string;
            unit: string;
            bought: number;
            returnable: number;
          }[]
        >("warehouse_customer_returnable", { p_customer: customerId, p_all: allProducts })
      ).map((r) => ({ ...r, bought: Number(r.bought), returnable: Number(r.returnable) })),
  });
  // Returns go in per supply day, dated that day (user, 2026-11-10): the day
  // picked shows what went out that day, and only that, less anything already
  // returned for the same day, can come back -- not the accumulated total.
  const [mode, setMode] = useState<"day" | "all">("day");
  const daySupply = useLastSupplied(
    "customer",
    customerId && mode === "day" ? customerId : null,
    returnDate,
  );
  // Open on the customer's last supply day; the officer moves back from there.
  const lastSupply = useLastSupplied("customer", customerId || null);
  const [dayFor, setDayFor] = useState("");
  useEffect(() => {
    if (!customerId || dayFor === customerId || lastSupply.isLoading) return;
    setDayFor(customerId);
    if (mode === "day" && lastSupply.data?.date) setReturnDate(lastSupply.data.date);
  }, [customerId, dayFor, mode, lastSupply.isLoading, lastSupply.data]);
  const dayReturned = useQuery({
    queryKey: ["jug", "customer-day-returned", customerId, returnDate],
    enabled: !!customerId && mode === "day",
    queryFn: async () => {
      const { data, error } = await db
        .from("sales_returns")
        .select("product_id,quantity_returned,status")
        .eq("customer_id", customerId)
        .eq("return_date", returnDate);
      if (error) throw error;
      const t: Record<string, number> = {};
      for (const r of (data ?? []) as {
        product_id: string;
        quantity_returned: number;
        status: string;
      }[])
        if (r.status !== "cancelled")
          t[r.product_id] = (t[r.product_id] ?? 0) + Number(r.quantity_returned);
      return t;
    },
  });
  const suppliedOnDay = (daySupply.data?.lines ?? []).reduce<Record<string, number>>((t, l) => {
    t[l.product_id] = (t[l.product_id] ?? 0) + l.qty;
    return t;
  }, {});
  // "All at once" (user, 2026-11-10) keeps the accumulated way: everything the
  // customer can still return, on any date returned.
  const held =
    mode === "all"
      ? (returnable.data ?? [])
          .filter((r) => r.returnable > 0)
          .map((r) => ({ ...r, supplied: 0, already: 0 }))
      : (returnable.data ?? [])
          .map((r) => {
            const supplied = suppliedOnDay[r.product_id] ?? 0;
            const already = dayReturned.data?.[r.product_id] ?? 0;
            return {
              ...r,
              supplied,
              already,
              returnable: Math.max(0, Math.min(r.returnable, supplied - already)),
            };
          })
          .filter((r) => r.supplied > 0);
  const dayLoading = mode === "day" && (daySupply.isLoading || dayReturned.isLoading);
  const switchMode = (m: "day" | "all") => {
    if (m === mode) return;
    setMode(m);
    setQty({});
    setReturnDate(m === "day" && lastSupply.data?.date ? lastSupply.data.date : localDay());
  };
  // Listed quantities plus the hand-typed lines, one line per product.
  const items = Object.entries(
    [
      ...held.map((r) => ({ product_id: r.product_id, quantity: qty[r.product_id] ?? 0 })),
      ...manual,
    ].reduce<Record<string, number>>((t, i) => {
      t[i.product_id] = (t[i.product_id] ?? 0) + i.quantity;
      return t;
    }, {}),
  )
    .map(([product_id, quantity]) => ({ product_id, quantity }))
    .filter((i) => i.quantity > 0);
  const over = held.some((r) => (qty[r.product_id] ?? 0) > r.returnable);
  const total = items.reduce((s, i) => s + i.quantity, 0);
  const name = (customers.data ?? []).find((c) => c.id === customerId)?.name ?? "the customer";

  const save = useJugAction(
    () =>
      rpc<{ return_number: string }>("warehouse_receive_customer_return", {
        payload: {
          customer_id: customerId,
          return_date: returnDate,
          reason: reason || undefined,
          all_products: allProducts || undefined,
          items,
        },
      }),
    (r) =>
      `${(r as { return_number: string }).return_number}: ${num(total)} ${allProducts ? "item(s)" : "unsold dispenser(s)"} from ${name} received into the Warehouse`,
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {allProducts ? "Return from Distributor/Office Delivery" : "Receive unsold dispensers"}
          </DialogTitle>
          {!allProducts && (
            <DialogDescription>
              Filled dispenser jugs any customer brings back unsold -- a distributor, a marketer's
              customer or a retail customer. They go back into Warehouse finished goods, the jugs
              count as Received, and the customer's account is credited.
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="grid gap-3">
          {toggle}
          {!hidePicker && (
            <Field label="Customer">
              <Input
                placeholder="Search name or phone…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Select
                value={customerId}
                onValueChange={(v) => {
                  setCustomerId(v);
                  setQty({});
                  setManual([]);
                }}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder={customers.isLoading ? "Loading…" : "Choose"} />
                </SelectTrigger>
                <SelectContent>
                  {shown.slice(0, 200).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {c.phone ? ` · ${c.phone}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {customerId && (
            <div className="grid grid-cols-2 gap-1 rounded-lg border p-1">
              {(
                [
                  ["day", "Per supply day"],
                  ["all", "All at once"],
                ] as const
              ).map(([m, label]) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant={mode === m ? "default" : "ghost"}
                  onClick={() => switchMode(m)}
                >
                  {label}
                </Button>
              ))}
            </div>
          )}
          {customerId && (
            <Field
              label={mode === "day" ? "Supply day (the return is dated this day)" : "Date returned"}
            >
              <Input
                type="date"
                value={returnDate}
                max={localDay()}
                onChange={(e) => {
                  if (!e.target.value) return;
                  setReturnDate(e.target.value);
                  if (mode === "day") setQty({});
                }}
              />
            </Field>
          )}
          {customerId && (
            <LastSuppliedPanel
              kind="customer"
              id={customerId}
              day={mode === "day" ? returnDate : undefined}
            />
          )}
          {customerId && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Can return</TableHead>
                  <TableHead className="w-28 text-right">Returned</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {held.length === 0 && manual.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                      {returnable.isLoading || dayLoading
                        ? "Loading…"
                        : returnable.isError
                          ? (returnable.error as Error).message
                          : mode === "all"
                            ? allProducts
                              ? "Nothing listed from this system -- add the products below."
                              : "This customer has no dispensers to return."
                            : allProducts
                              ? "Nothing supplied on this day -- pick another day, or add the products below."
                              : "No dispensers supplied to this customer on this day."}
                    </TableCell>
                  </TableRow>
                )}
                {held.map((r) => {
                  const v = qty[r.product_id] ?? null;
                  return (
                    <TableRow key={r.product_id}>
                      <TableCell>
                        {r.name}
                        <div className="text-[11px] text-muted-foreground">
                          {mode === "all" ? (
                            `bought ${num(r.bought)} ${r.unit}`
                          ) : (
                            <>
                              supplied {num(r.supplied)} {r.unit} that day
                              {r.already > 0 && ` · ${num(r.already)} already returned`}
                            </>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{num(r.returnable)}</TableCell>
                      <TableCell className="text-right">
                        <CountInput
                          className="ml-auto w-24 text-right"
                          value={v}
                          onChange={(x) => setQty((q) => ({ ...q, [r.product_id]: x }))}
                          placeholder="0"
                        />
                        {(v ?? 0) > r.returnable && (
                          <div className="text-[11px] text-destructive">
                            {mode === "all" ? "More than bought" : "More than supplied that day"}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {manual.map((m, i) => {
                  const p = productOf(m.product_id);
                  return (
                    <TableRow key={`manual-${i}`}>
                      <TableCell>
                        {p?.name ?? "—"}
                        <div className="text-[11px] text-muted-foreground">added by hand</div>
                      </TableCell>
                      <TableCell className="text-right">—</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {num(m.quantity)} {p?.unit ?? ""}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title="Remove"
                            onClick={() => setManual((l) => l.filter((_, j) => j !== i))}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {customerId && allProducts && (
            <Field label="Add a product">
              <div className="flex flex-wrap gap-2">
                <Select value={addProduct} onValueChange={setAddProduct}>
                  <SelectTrigger className="min-w-0 flex-1">
                    <SelectValue placeholder={products.isLoading ? "Loading…" : "Product"} />
                  </SelectTrigger>
                  <SelectContent>
                    {productList.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                        {p.unit ? ` (${p.unit})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <CountInput
                  className="w-24 text-right"
                  value={addQty}
                  onChange={setAddQty}
                  placeholder="Qty"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="gap-1"
                  disabled={!addProduct || !addQty || addQty <= 0}
                  onClick={() => {
                    setManual((l) => [...l, { product_id: addProduct, quantity: addQty! }]);
                    setAddProduct("");
                    setAddQty(null);
                  }}
                >
                  <Plus className="h-4 w-4" /> Add
                </Button>
              </div>
            </Field>
          )}
          <Field label="Reason (optional)">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!customerId || items.length === 0 || over || save.isPending}
            onClick={() =>
              save.mutate(undefined, {
                onSuccess: () => {
                  onDone?.();
                  onClose();
                },
              })
            }
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Receive {total > 0 ? num(total) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------------- adjustment
// Approved corrections on the existing container ledger
// (record_container_movement): an opening balance for jugs a marketer held
// before tracking began, or jugs written off as lost. Both need a reason.
export function AdjustDialog({
  factoryId,
  marketers,
  types,
  canWriteOff,
  onClose,
}: {
  factoryId: string;
  marketers: Named[];
  types: { id: string; name: string }[];
  canWriteOff: boolean;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<"issue" | "lost">("issue");
  const [repId, setRepId] = useState("");
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const [qty, setQty] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [reference, setReference] = useState("");
  const save = useJugAction(
    () =>
      rpc("record_container_movement", {
        payload: {
          factory_id: factoryId,
          container_type_id: typeId,
          kind,
          holder_type: "sales_rep",
          holder_id: repId,
          quantity: qty,
          notes,
          reference,
        },
      }),
    kind === "issue" ? "Opening balance recorded" : "Jugs written off",
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Jug adjustment</DialogTitle>
          <DialogDescription>
            Corrections are new ledger entries — nothing is edited or deleted.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field
            label="Type"
            hint={
              kind === "issue"
                ? "Jugs the marketer already held before tracking began (their opening balance). Shown as Loaded on today's report."
                : "Jugs the marketer cannot account for. They stop being outstanding."
            }
          >
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="issue">Opening balance / jugs issued</SelectItem>
                {canWriteOff && <SelectItem value="lost">Write off as lost</SelectItem>}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Marketer / outlet">
            <Select value={repId} onValueChange={setRepId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                {marketers.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.code ? `${m.code} · ` : ""}
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Jug type">
            <Select value={typeId} onValueChange={setTypeId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                {types.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {jugTypeLabel(t.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Jugs">
            <CountInput value={qty} onChange={setQty} placeholder="0" />
          </Field>
          <Field label="Supporting reference">
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="e.g. count sheet no."
            />
          </Field>
          <Field label="Reason">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={kind === "lost" ? "destructive" : "default"}
            disabled={!repId || !typeId || !qty || notes.trim().length < 5 || save.isPending}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {kind === "issue" ? "Record opening balance" : "Write off"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------ new jugs in
// New jugs bought in, counted into the Store (receive_new_jugs; the Store
// since 20261104120000): a "Bought in" ledger move from outside. The Store
// then sends them to QC or issues them to Production.
export function ReceiveNewJugsDialog({
  factoryId,
  types,
  onClose,
}: {
  factoryId: string;
  types: { id: string; name: string }[];
  onClose: () => void;
}) {
  const sorted = useMemo(
    () => [...types].sort((a, b) => jugTypeRank(a.name) - jugTypeRank(b.name)),
    [types],
  );
  const [typeId, setTypeId] = useState(
    () => sorted.find((t) => t.name.trim().toLowerCase() === "new jug")?.id ?? sorted[0]?.id ?? "",
  );
  const [qty, setQty] = useState<number | null>(null);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const save = useJugAction(
    () =>
      rpc("receive_new_jugs", {
        p_factory: factoryId,
        p_container_type: typeId,
        p_quantity: qty,
        p_reference: reference,
        p_notes: notes,
      }),
    `${num(qty ?? 0)} jugs received into the Store`,
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Receive new jugs</DialogTitle>
          <DialogDescription>
            Count the new jugs delivered. They go into the Store, which sends them to QC or issues
            them to Production.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Jug type">
            <Select value={typeId} onValueChange={setTypeId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                {sorted.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {jugTypeLabel(t.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Jugs received">
            <CountInput value={qty} onChange={setQty} placeholder="0" />
          </Field>
          <Field label="Delivery note / invoice no.">
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="e.g. DN-0457"
            />
          </Field>
          <Field label="Note" hint="Optional — supplier, condition on arrival.">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!typeId || !qty || !reference.trim() || save.isPending}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Receive {qty ? num(qty) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------ day detail
// Every transaction behind one row of the report.
export function RowDetailDialog({
  factoryId,
  row,
  productNames,
  onClose,
}: {
  factoryId: string;
  row: ReportRow;
  productNames: Record<string, string>;
  onClose: () => void;
}) {
  const movements = useJugMovements(factoryId, row.report_date, row.report_date, row.sales_rep_id);
  // Money is Accounts' only (2026-11-02).
  const showMoney = usePermissions().canSeeMoney;
  const returns = useJugReturns(factoryId, row.report_date, row.report_date);
  const lines = (movements.data ?? []).filter((m) => m.container_type_id === row.container_type_id);
  const claims = (returns.data ?? []).filter(
    (r) =>
      r.sales_rep_id === row.sales_rep_id &&
      r.container_type_id === row.container_type_id &&
      new Date(r.recorded_at) >= new Date(dayStart(row.report_date)) &&
      new Date(r.recorded_at) <= new Date(dayEnd(row.report_date)),
  );
  const names = useUserNames([
    ...lines.map((l) => l.created_by),
    ...claims.map((c) => c.recorded_by),
  ]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {row.rep_name} · {row.container_name} · {formatDay(row.report_date)}
          </DialogTitle>
          <DialogDescription>
            Opening {num(row.opening)} + Loaded {num(row.loaded)} = {num(row.total)}; −
            Dispenser/Jug Water {num(row.jug_water_sold)} − Empties sold {num(row.empties_sold)} =
            Expected {num(row.expected_empties)}; − Received {num(row.received)} − Written off{" "}
            {num(row.written_off)} = Outstanding {num(row.outstanding)}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <div className="mb-1 text-sm font-medium">Ledger movements</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Jugs</TableHead>
                  <TableHead>By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-4 text-center text-muted-foreground">
                      {movements.isLoading ? "Loading…" : "No jug movements this day."}
                    </TableCell>
                  </TableRow>
                )}
                {lines.map((l) => {
                  const toRep = l.to_type === "sales_rep" && l.to_id === row.sales_rep_id;
                  return (
                    <TableRow key={l.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {fmtDateTime(l.created_at)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {SOURCE_LABEL[l.source] ?? l.source}
                      </TableCell>
                      <TableCell className="text-xs">
                        {l.product_id ? (productNames[l.product_id] ?? "—") : "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{l.reference ?? "—"}</TableCell>
                      <TableCell
                        className={`text-right font-medium ${toRep ? "text-primary" : "text-destructive"}`}
                      >
                        {toRep ? "+" : "−"}
                        {num(l.quantity)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {names.data?.[l.created_by ?? ""] ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {row.refills_sold > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Also {num(row.refills_sold)} refills sold — swaps, so no jug left the marketer.
              </p>
            )}
            {showMoney && row.empties_value > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Empty jugs sold for {money(row.empties_value)}.
              </p>
            )}
          </div>
          <div>
            <div className="mb-1 text-sm font-medium">Empty-jug returns</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Recorded</TableHead>
                  <TableHead className="text-right">Returned</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {claims.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-4 text-center text-muted-foreground">
                      No returns recorded.
                    </TableCell>
                  </TableRow>
                )}
                {claims.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-xs">{c.reference}</TableCell>
                    <TableCell className="text-xs">
                      {fmtDateTime(c.recorded_at)}
                      <div className="text-muted-foreground">
                        {names.data?.[c.recorded_by] ?? ""}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{num(c.quantity_claimed)}</TableCell>
                    <TableCell className="text-right">
                      {c.quantity_received == null ? "—" : num(c.quantity_received)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          c.status === "verified"
                            ? "default"
                            : c.status === "pending"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {c.status === "pending" ? "Awaiting count" : c.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ setup
// Jug types and which products carry them, with the role that decides what
// a sale does to the jug. Managers only (distribution approve).
export function JugSetupPanel({
  factoryId,
  types,
}: {
  factoryId: string;
  types: { id: string; name: string; active: boolean }[];
}) {
  const data = useProductLinks(factoryId);
  const [newType, setNewType] = useState("");
  const addType = useJugAction(
    (name: string) =>
      rpc("save_container_type", {
        p_factory: factoryId,
        p_id: null,
        p_name: name,
        p_active: true,
      }),
    "Jug type added",
  );
  const setRole = useJugAction(
    (a: { product: string; type: string; qty: number; role: JugRole | null }) =>
      rpc("set_product_jug_role", {
        p_product: a.product,
        p_container_type: a.type,
        p_quantity: a.qty,
        p_role: a.role,
      }),
    "Saved",
  );
  const linkFor = useMemo(() => {
    const m = new Map<string, { type: string; qty: number; role: JugRole | null }>();
    for (const l of data.data?.links ?? [])
      if (types.some((t) => t.id === l.container_type_id))
        m.set(l.product_id, {
          type: l.container_type_id,
          qty: l.quantity_per_unit,
          role: l.jug_role,
        });
    return m;
  }, [data.data, types]);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Jug types</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {types.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
            >
              {t.name}
              {!t.active && <Badge variant="outline">Inactive</Badge>}
            </div>
          ))}
          <div className="flex gap-2">
            <Input
              placeholder="e.g. 19L Dispenser Jug"
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
            />
            <Button
              disabled={!newType.trim() || addType.isPending}
              onClick={() => addType.mutate(newType.trim(), { onSuccess: () => setNewType("") })}
            >
              Add
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card className="rounded-2xl lg:col-span-2">
        <CardHeader>
          <CardTitle>Products that carry a jug</CardTitle>
          <p className="text-sm text-muted-foreground">
            Refill: the customer swaps an empty, so the marketer still owes the jug. Dispenser/Jug
            Water: the customer keeps it. Empty jug: sold as an empty, its price is the Empties
            Cost.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Jug type</TableHead>
                <TableHead>Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data.data?.products ?? [])
                .filter((p) => p.active)
                .map((p) => {
                  const l = linkFor.get(p.id);
                  return (
                    <TableRow key={p.id}>
                      <TableCell>{p.name}</TableCell>
                      <TableCell>
                        <Select
                          value={l?.type ?? "none"}
                          disabled={setRole.isPending}
                          onValueChange={(v) =>
                            v === "none"
                              ? l &&
                                setRole.mutate({ product: p.id, type: l.type, qty: 0, role: null })
                              : setRole.mutate({
                                  product: p.id,
                                  type: v,
                                  qty: 1,
                                  role: l?.role ?? "refill",
                                })
                          }
                        >
                          <SelectTrigger className="w-44">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No jug</SelectItem>
                            {types.map((t) => (
                              <SelectItem key={t.id} value={t.id}>
                                {t.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        {l ? (
                          <Select
                            value={l.role ?? "with_water"}
                            disabled={setRole.isPending}
                            onValueChange={(v) =>
                              setRole.mutate({
                                product: p.id,
                                type: l.type,
                                qty: l.qty,
                                role: v as JugRole,
                              })
                            }
                          >
                            <SelectTrigger className="w-72">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(Object.keys(ROLE_LABEL) as JugRole[]).map((r) => (
                                <SelectItem key={r} value={r}>
                                  {ROLE_LABEL[r]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
