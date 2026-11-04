import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { HandCoins, Loader2, Undo2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { localDay } from "@/lib/production-shift";
import { num } from "@/lib/format";
import { type Activity, KIND, scopeToMyProducts } from "@/components/warehouse/activity";
import { useMyProductMatcher } from "@/lib/product-rules";
import { CancelPostingButton, useCanCancelPosting } from "@/components/warehouse/cancel-posting";
import { CustomerUnsoldDialog, ReceiveUnsoldDialog } from "@/components/jugs/dialogs";
import { LastSuppliedPanel } from "@/components/warehouse/last-supplied";
import { ReturnDateField } from "@/components/shared/return-date";
import { useDayReturns } from "@/lib/day-returns";
import { DayReturnsPanel } from "@/components/warehouse/correct-return-dialog";
import { useJugTypes, useMarketers } from "@/components/jugs/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
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

// A marketer's, the shop's or a Distributor/Office Delivery customer's
// window on the Warehouse (user, 2026-11-02): what they hold, everything
// that moved with them, and the Warehouse's actions on their account --
// return products, return empty jugs. Goods only: money is Accounts'.
export type Party = {
  type: "marketer" | "retail" | "distributor";
  id: string;
  name: string;
};

export function WarehousePartyDialog({
  factoryId,
  party,
  onClose,
}: {
  factoryId: string;
  party: Party;
  onClose: () => void;
}) {
  const perms = usePermissions();
  const holder = party.type !== "distributor";
  // The Retail Shop no longer returns unsold products (user, 2026-11-04).
  const canReturn = holder
    ? party.type === "marketer" && perms.can("distribution", "submit")
    : perms.can("sales-returns", "submit") || perms.can("distribution", "submit");
  // "Record sold Dispenser + Water" replaces "Return empty Dispenser Jugs"
  // (user, 2026-11-04): a distributor's customers kept the jugs -- billed at
  // the empty-jug price (record_sold_dispenser_jugs). Marketers' empties
  // still come back through Warehouse -> Dispenser & jugs -> Returns.
  const canSoldRight = !holder && perms.can("sales", "create");
  const [act, setAct] = useState<"products" | "jugs" | "unsold" | null>(null);
  // Receive unsold dispensers from any marketer or distributor (2026-11-04).
  const canUnsold =
    party.type !== "retail" &&
    (perms.can("distribution", "submit") || perms.can("sales-returns", "submit"));
  const marketers = useMarketers(factoryId);
  // Only the products this Warehouse officer handles (2026-11-02).
  const mine = useMyProductMatcher();
  const canCancel = useCanCancelPosting();
  const types = useJugTypes(factoryId);

  const history = useQuery({
    queryKey: ["warehouse-party", party.id],
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "warehouse_transactions" as never,
        { p_factory: factoryId, p_limit: 1000, p_party: party.id } as never,
      );
      if (error) throw error;
      return (data ?? []) as unknown as Activity[];
    },
  });
  // What they hold: a marketer's / the shop's stock, or what a customer
  // bought that can still come back.
  const holding = useQuery({
    queryKey: ["warehouse-party-holding", party.id],
    retry: false,
    queryFn: async () => {
      if (holder) {
        const { data, error } = await supabase.rpc(
          "rep_van_stock" as never,
          { p_rep: party.id } as never,
        );
        if (error) throw error;
        return ((data ?? []) as unknown as { name: string; unit: string; quantity: number }[]).map(
          (r) => ({ name: r.name, unit: r.unit, quantity: Number(r.quantity) }),
        );
      }
      const { data, error } = await supabase.rpc(
        "warehouse_customer_returnable" as never,
        { p_customer: party.id, p_all: true } as never,
      );
      if (error)
        throw /could not find the function/i.test(error.message)
          ? new Error(
              "The Warehouse return update is not in the database yet -- run supabase/migrations/20261102270000_warehouse_customer_returns.sql in the SQL Editor.",
            )
          : error;
      return ((data ?? []) as unknown as { name: string; unit: string; returnable: number }[])
        .map((r) => ({ name: r.name, unit: r.unit, quantity: Number(r.returnable) }))
        .filter((r) => r.quantity > 0);
    },
  });

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[92vh] w-[96vw] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {party.name}
              <Badge variant="outline" className="font-normal">
                {party.type === "retail"
                  ? "Retail Shop"
                  : party.type === "marketer"
                    ? "Marketer"
                    : "Distributor/Office Delivery"}
              </Badge>
            </DialogTitle>
            <DialogDescription>
              Everything that moved between the Warehouse and {party.name}, in quantities.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap gap-2">
            {canReturn && (
              <Button className="gap-2" onClick={() => setAct("products")}>
                <Undo2 className="h-4 w-4" /> Return products
              </Button>
            )}
            {canUnsold && mine("Dispenser Water") && (
              <Button variant="outline" className="gap-2" onClick={() => setAct("unsold")}>
                <Undo2 className="h-4 w-4" /> Receive unsold dispensers
              </Button>
            )}
            {canSoldRight && mine("Dispenser Water") && (
              <Button variant="outline" className="gap-2" onClick={() => setAct("jugs")}>
                <HandCoins className="h-4 w-4" /> Record sold Dispenser + Water
              </Button>
            )}
          </div>

          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle className="text-base">
                {holder ? "Holding now" : "Bought and can still come back"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {(holding.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {holding.isLoading
                    ? "Loading…"
                    : holding.isError
                      ? (holding.error as Error).message
                      : "Nothing."}
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(holding.data ?? [])
                    .filter((h) => mine(h.name))
                    .map((h) => (
                      <Badge key={h.name} variant="secondary" className="text-sm font-normal">
                        {h.name} × {num(h.quantity)} {h.unit}
                      </Badge>
                    ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle className="text-base">All transactions</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Activity</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Products</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scopeToMyProducts(history.data ?? [], mine).map((a) => {
                    const k = KIND[a.kind] ?? { label: a.kind, variant: "outline" as const };
                    return (
                      <TableRow key={`${a.kind}-${a.reference}`}>
                        <TableCell className="whitespace-nowrap text-xs">
                          {new Date(a.at).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <Badge variant={k.variant}>{k.label}</Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{a.reference}</TableCell>
                        <TableCell className="text-xs">{a.items ?? "—"}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="capitalize">
                            {a.status.replace(/_/g, " ")}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {canCancel(a) && (
                            <CancelPostingButton factoryId={factoryId} activity={a} />
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {scopeToMyProducts(history.data ?? [], mine).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                        {history.isLoading
                          ? "Loading…"
                          : history.isError
                            ? (history.error as Error).message
                            : "Nothing yet."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </DialogContent>
      </Dialog>

      {act === "products" && holder && (
        <HolderReturnDialog factoryId={factoryId} party={party} onClose={() => setAct(null)} />
      )}
      {act === "products" && !holder && (
        <CustomerUnsoldDialog
          factoryId={factoryId}
          allProducts
          distributorsOnly
          presetCustomerId={party.id}
          onClose={() => setAct(null)}
        />
      )}
      {act === "unsold" && (
        <ReceiveUnsoldDialog
          factoryId={factoryId}
          marketers={(marketers.data ?? []).filter((m) => m.active)}
          presetRepId={party.type === "marketer" ? party.id : undefined}
          presetCustomerId={party.type === "distributor" ? party.id : undefined}
          onClose={() => setAct(null)}
        />
      )}
      {act === "jugs" && <SoldJugsDialog party={party} onClose={() => setAct(null)} />}
    </>
  );
}

// Goods a marketer / the shop brings back to the Warehouse (create_rep_return):
// off their stock, into the Warehouse, on their next posting automatically.
function HolderReturnDialog({
  factoryId,
  party,
  onClose,
}: {
  factoryId: string;
  party: Party;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [qty, setQty] = useState<Record<string, number>>({});
  // Yesterday's goods keyed in today go on yesterday (2026-11-03).
  const perms = usePermissions();
  const [returnDate, setReturnDate] = useState(localDay());
  // What was already entered for this party on that day, to add up to it.
  const earlier = useDayReturns(party.id, returnDate);
  const stock = useQuery({
    queryKey: ["warehouse-party-van", party.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "rep_van_stock" as never,
        { p_rep: party.id } as never,
      );
      if (error) throw error;
      return (
        (data ?? []) as unknown as {
          product_id: string;
          name: string;
          unit: string;
          quantity: number;
        }[]
      ).map((r) => ({ ...r, quantity: Number(r.quantity) }));
    },
  });
  // Only the products this officer handles; the database refuses the rest.
  const mine = useMyProductMatcher();
  const held = (stock.data ?? []).filter((s) => mine(s.name));
  const items = held
    .map((s) => ({ product_id: s.product_id, quantity_returned: qty[s.product_id] ?? 0 }))
    .filter((i) => i.quantity_returned > 0);
  const over = held.some((s) => (qty[s.product_id] ?? 0) > s.quantity);
  const total = items.reduce((t, i) => t + i.quantity_returned, 0);

  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("create_rep_return", {
        payload: {
          factory_id: factoryId,
          sales_rep_id: party.id,
          return_date: returnDate,
          items,
        } as never,
      });
      if (error) throw error;
      return data as unknown as { return_number: string };
    },
    onSuccess: (r) => {
      toast.success(`${r.return_number}: ${num(total)} back in the Warehouse from ${party.name}`);
      for (const key of [
        "warehouse-party",
        "warehouse-party-holding",
        "warehouse-party-van",
        "warehouse-transactions",
        "dist-returns",
        "dispatch-open-returns",
        "finished-goods",
      ])
        qc.invalidateQueries({ queryKey: [key] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Return products from {party.name}</DialogTitle>
          <DialogDescription>
            They come off {party.name}&apos;s stock into the Warehouse now, and go back on their
            next posting automatically.
          </DialogDescription>
        </DialogHeader>
        <LastSuppliedPanel kind="marketer" id={party.id} />
        <ReturnDateField value={returnDate} onChange={setReturnDate} />
        <DayReturnsPanel
          party={party.name}
          date={returnDate}
          earlier={earlier}
          canCorrect={perms.canSubmit("distribution")}
        />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Holding</TableHead>
              {earlier.numbers.length > 0 && (
                <TableHead className="text-right">Already returned</TableHead>
              )}
              <TableHead className="w-28 text-right">Returning</TableHead>
              {earlier.numbers.length > 0 && <TableHead className="text-right">Total</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {held.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                  {stock.isLoading ? "Loading…" : "They hold nothing to return."}
                </TableCell>
              </TableRow>
            )}
            {held.map((s) => {
              const v = qty[s.product_id] ?? 0;
              return (
                <TableRow key={s.product_id}>
                  <TableCell>{s.name}</TableCell>
                  <TableCell className="text-right">
                    {num(s.quantity)} {s.unit}
                  </TableCell>
                  {earlier.numbers.length > 0 && (
                    <TableCell className="text-right text-muted-foreground">
                      {num(earlier.byProduct.get(s.product_id) ?? 0)}
                    </TableCell>
                  )}
                  <TableCell className="text-right">
                    <Input
                      type="number"
                      min={0}
                      className="ml-auto w-24 text-right"
                      value={v || ""}
                      placeholder="0"
                      onChange={(e) =>
                        setQty((q) => ({ ...q, [s.product_id]: Number(e.target.value) || 0 }))
                      }
                    />
                    {v > s.quantity && (
                      <div className="text-[11px] text-destructive">More than held</div>
                    )}
                  </TableCell>
                  {earlier.numbers.length > 0 && (
                    <TableCell className="text-right font-semibold">
                      {num((earlier.byProduct.get(s.product_id) ?? 0) + v)} {s.unit}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
            {/* Returned earlier that day and no longer held. */}
            {[...earlier.byProduct]
              .filter(
                ([id]) =>
                  !held.some((s) => s.product_id === id) && mine(earlier.names.get(id)?.name ?? ""),
              )
              .map(([id, q]) => (
                <TableRow key={`earlier-${id}`} className="text-muted-foreground">
                  <TableCell>{earlier.names.get(id)?.name ?? "Product"}</TableCell>
                  <TableCell className="text-right">0</TableCell>
                  <TableCell className="text-right">{num(q)}</TableCell>
                  <TableCell className="text-right">—</TableCell>
                  <TableCell className="text-right font-semibold">
                    {num(q)} {earlier.names.get(id)?.unit ?? ""}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={items.length === 0 || over || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Return {total > 0 ? num(total) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// The distributor sold dispensers with the jug: their customers keep the
// jugs, which are billed to the distributor at the empty-jug price.
function SoldJugsDialog({ party, onClose }: { party: Party; onClose: () => void }) {
  const qc = useQueryClient();
  const [qty, setQty] = useState("");
  const [date, setDate] = useState(localDay());
  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc(
        "record_sold_dispenser_jugs" as never,
        { payload: { customer_id: party.id, quantity: Number(qty), sale_date: date } } as never,
      );
      if (error) {
        if (/could not find the function/i.test(error.message))
          throw new Error(
            "The update is not in the database yet -- run supabase/migrations/20261104230000_record_sold_dispenser_jugs.sql in the SQL Editor.",
          );
        throw error;
      }
      return data as unknown as { invoice_number: string; quantity: number };
    },
    onSuccess: (r) => {
      toast.success(
        `${num(r.quantity)} sold Dispenser + Water recorded — invoice ${r.invoice_number} to Accounts`,
      );
      for (const k of [
        "warehouse-transactions",
        "warehouse-party",
        "warehouse-party-holding",
        "jug",
        "container-balances",
      ])
        void qc.invalidateQueries({ queryKey: [k] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record sold Dispenser + Water</DialogTitle>
          <DialogDescription>
            {party.name} sold dispensers with the jug — their customers keep the jugs. Each jug is
            billed to {party.name} at the empty-jug price, on an invoice Accounts confirms, and no
            longer owed back.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">Dispensers sold with the jug</label>
            <Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Date</label>
            <Input
              type="date"
              value={date}
              max={localDay()}
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            className="gap-2"
            disabled={!(Number(qty) > 0) || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
