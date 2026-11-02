import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Undo2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { localDay } from "@/lib/production-shift";
import { num } from "@/lib/format";
import { type Activity, KIND, scopeToMyProducts } from "@/components/warehouse/activity";
import { useMyProductMatcher } from "@/lib/product-rules";
import { CustomerUnsoldDialog, RecordReturnDialog } from "@/components/jugs/dialogs";
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
  const canReturn = holder
    ? perms.can("distribution", "submit")
    : perms.can("sales-returns", "submit") || perms.can("distribution", "submit");
  const canJugs = perms.can("distribution", "create") || perms.can("sales", "create");
  const [act, setAct] = useState<"products" | "jugs" | null>(null);
  const marketers = useMarketers(factoryId);
  // Only the products this Warehouse officer handles (2026-11-02).
  const mine = useMyProductMatcher();
  const types = useJugTypes(factoryId);

  const history = useQuery({
    queryKey: ["warehouse-party", party.id],
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
        "customer_returnable_dispensers" as never,
        { p_customer: party.id, p_all: true } as never,
      );
      if (error) throw error;
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
            {canJugs && (types.data ?? []).length > 0 && (
              <Button variant="outline" className="gap-2" onClick={() => setAct("jugs")}>
                <Undo2 className="h-4 w-4" /> Return empty jugs
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
                  {holding.isLoading ? "Loading…" : "Nothing."}
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
                      </TableRow>
                    );
                  })}
                  {scopeToMyProducts(history.data ?? [], mine).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
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
      {act === "jugs" && (
        <RecordReturnDialog
          factoryId={factoryId}
          marketers={(marketers.data ?? []).filter((m) => m.active)}
          types={(types.data ?? []).filter((t) => t.active)}
          initialRepId={holder ? party.id : undefined}
          initialCustomerId={holder ? undefined : party.id}
          onClose={() => setAct(null)}
        />
      )}
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
          return_date: localDay(),
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Holding</TableHead>
              <TableHead className="w-28 text-right">Returning</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {held.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
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
                </TableRow>
              );
            })}
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
