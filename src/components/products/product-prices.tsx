import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Pencil, Plus, Save, Search, Tag, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useIsAdmin } from "@/lib/permissions";
import { money } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ProductForm, type ProductFormProduct } from "@/components/products/product-form";
import { FINISHED_PRODUCT_NAMES } from "@/components/shared/product-name-select";

type PriceRow = ProductFormProduct;

// Costing → Product Prices: the selling price of every finished product.
// POS and postings fill the unit price in from here, so the sales
// person only enters the quantity. Prices are edited in place and saved
// together (set_product_prices); Add product / the pencil open the product
// form for everything else about a product.
export function ProductPricesCard({ factoryId }: { factoryId: string }) {
  const qc = useQueryClient();
  // Only the administrator changes products here (user, 2026-11-01); the
  // database refuses anyone else (20261101110000).
  const isAdmin = useIsAdmin();
  const canPrice = isAdmin;
  const canManage = isAdmin;
  const [q, setQ] = useState("");
  // Prices typed but not saved yet, by product id.
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PriceRow | null>(null);
  const [deleting, setDeleting] = useState<PriceRow | null>(null);
  // Every price change is confirmed first (user, 2026-11-03: Dispenser Water
  // was priced wrongly for a while and every posting kept the wrong price).
  const [confirming, setConfirming] = useState(false);
  // "The old price was a mistake": also correct postings and returns made at
  // it since this day (reprice_posted_lines, 20261103190000).
  const [fixOld, setFixOld] = useState(false);
  const [fixFrom, setFixFrom] = useState(() =>
    new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" }),
  );

  const products = useQuery({
    queryKey: ["product-prices", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select(
          "id,name,sku,unit,unit_price,cost_price,current_stock,reorder_level,category_id,product_type",
        )
        .eq("factory_id", factoryId)
        .eq("active", true)
        .eq("product_type", "finished");
      if (error) throw error;
      // The factory's product list first, in its order, then the rest A-Z.
      const rank = (name: string) => {
        const i = (FINISHED_PRODUCT_NAMES as readonly string[]).findIndex(
          (n) => n.toLowerCase() === name.trim().toLowerCase(),
        );
        return i < 0 ? FINISHED_PRODUCT_NAMES.length : i;
      };
      return ((data ?? []) as PriceRow[]).sort(
        (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name),
      );
    },
  });

  const categories = useQuery({
    queryKey: ["product-categories", factoryId],
    enabled: canManage,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_categories")
        .select("id,name")
        .eq("factory_id", factoryId)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  // Search by name, SKU, or a pasted #ID (the start of the product id).
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase().replace(/^#/, "");
    const all = products.data ?? [];
    if (!term) return all;
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        (p.sku ?? "").toLowerCase().includes(term) ||
        p.id.toLowerCase().startsWith(term),
    );
  }, [products.data, q]);

  const priceOf = (p: PriceRow) => drafts[p.id] ?? Number(p.unit_price);
  const changed = (products.data ?? []).filter(
    (p) => drafts[p.id] !== undefined && drafts[p.id] !== Number(p.unit_price),
  );

  // What looks wrong about a new price: a big jump, or the same price as
  // another product (e.g. Dispenser Water typed at Dispenser Empty's price).
  const warningsFor = (p: PriceRow) => {
    const old = Number(p.unit_price);
    const next = drafts[p.id];
    const out: string[] = [];
    if (old > 0 && Math.abs(next - old) / old > 0.5)
      out.push(`${next > old ? "up" : "down"} ${Math.round((Math.abs(next - old) / old) * 100)}%`);
    const same = (products.data ?? [])
      .filter((o) => o.id !== p.id && priceOf(o) === next)
      .map((o) => o.name);
    if (same.length) out.push(`same price as ${same.join(", ")}`);
    return out;
  };

  const invalidate = () => {
    for (const key of [
      "product-prices",
      "settings-products",
      "finished-goods",
      "products-active",
      "products-for-production",
      "dist-products",
      "inventory-overview-products",
    ])
      qc.invalidateQueries({ queryKey: [key] });
  };

  // Delete (delete_product, 20261101120000): deleted outright if nothing
  // refers to it, otherwise taken off every list with its history kept.
  const remove = useMutation({
    mutationFn: async (p: PriceRow) => {
      const { data, error } = await supabase.rpc(
        "delete_product" as never,
        { p_id: p.id } as never,
      );
      if (error) throw error;
      return data as unknown as { mode: "deleted" | "deactivated"; name: string };
    },
    onSuccess: (r) => {
      toast.success(
        r.mode === "deleted"
          ? `${r.name} deleted`
          : `${r.name} removed from every list — its past sales and postings keep it`,
      );
      setDeleting(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const save = useMutation({
    mutationFn: async () => {
      if (changed.length === 0) return { n: 0, fixed: 0 };
      const { data, error } = await supabase.rpc(
        "set_product_prices" as never,
        { p_prices: changed.map((p) => ({ id: p.id, unit_price: drafts[p.id] })) } as never,
      );
      if (error) throw error;
      const n = (data as unknown as { changed?: number })?.changed ?? changed.length;
      // The old price was a mistake: postings and returns made at it follow.
      let fixed = 0;
      if (fixOld)
        for (const p of changed) {
          const { data: lines, error: e2 } = await supabase.rpc(
            "reprice_posted_lines" as never,
            {
              p_product: p.id,
              p_reason: `Price corrected on Costing: ${Number(p.unit_price)} -> ${drafts[p.id]}`,
              p_dry_run: false,
              p_from: fixFrom,
              p_old_price: Number(p.unit_price),
            } as never,
          );
          if (e2) throw e2;
          fixed += ((lines ?? []) as unknown[]).length;
        }
      return { n, fixed };
    },
    onSuccess: ({ n, fixed }) => {
      toast.success(
        (n === 1 ? "1 price saved" : `${n} prices saved`) +
          (fixOld ? ` — ${fixed} posting / return line(s) corrected` : ""),
      );
      setDrafts({});
      setConfirming(false);
      setFixOld(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card className="rounded-2xl">
      <AlertDialog open={confirming} onOpenChange={(o) => !save.isPending && setConfirming(o)}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Save {changed.length === 1 ? "this price" : "these prices"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              New postings, sales and returns use the new price from now on.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 text-sm">
            {changed.map((p) => {
              const w = warningsFor(p);
              return (
                <div key={p.id} className="rounded-md border p-2">
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{p.name}</span>
                    <span>
                      {money(Number(p.unit_price))} → <b>{money(drafts[p.id])}</b>
                    </span>
                  </div>
                  {w.length > 0 && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-warning">
                      <AlertTriangle className="h-3.5 w-3.5" /> Check: {w.join("; ")}
                    </div>
                  )}
                </div>
              );
            })}
            <div className="space-y-2 rounded-md border p-2">
              <div className="flex items-start gap-2">
                <Checkbox
                  id="fix-old-price"
                  checked={fixOld}
                  onCheckedChange={(v) => setFixOld(v === true)}
                />
                <Label htmlFor="fix-old-price" className="text-sm font-normal leading-snug">
                  The old price was a mistake: also correct postings and returns made at the old
                  price
                </Label>
              </div>
              {fixOld && (
                <div className="flex items-center gap-2 pl-6 text-xs">
                  since
                  <Input
                    type="date"
                    className="h-8 w-40"
                    value={fixFrom}
                    max={new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" })}
                    onChange={(e) => e.target.value && setFixFrom(e.target.value)}
                  />
                  <span className="text-muted-foreground">
                    (marketers&apos; and the shop&apos;s accounts follow)
                  </span>
                </div>
              )}
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={save.isPending}
              onClick={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              {save.isPending ? "Saving…" : "Save prices"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Tag className="h-4 w-4" /> Product Prices
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            The selling price of each product. POS fills the unit price in from this list — the
            sales person only enters the quantity, and the total is worked out automatically.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && (
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> Add product
            </Button>
          )}
          {canPrice && (
            <Button
              className="gap-2"
              disabled={changed.length === 0 || save.isPending}
              onClick={() => setConfirming(true)}
            >
              <Save className="h-4 w-4" /> {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search or paste #ID…"
            className="h-9 pl-8"
          />
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead className="w-48">Selling price (per unit)</TableHead>
                {canManage && <TableHead className="w-12"></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {[p.sku, `#${p.id.slice(0, 8)}`].filter(Boolean).join(" · ")}
                    </div>
                  </TableCell>
                  <TableCell>{p.unit}</TableCell>
                  <TableCell>
                    {canPrice ? (
                      <MoneyInput
                        min={0}
                        value={priceOf(p)}
                        onChange={(v) => setDrafts((d) => ({ ...d, [p.id]: v }))}
                      />
                    ) : (
                      money(Number(p.unit_price))
                    )}
                  </TableCell>
                  {canManage && (
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Edit product"
                        aria-label="Edit product"
                        onClick={() => {
                          setEditing(p);
                          setFormOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Delete product"
                        aria-label="Delete product"
                        onClick={() => setDeleting(p)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={canManage ? 4 : 3}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {products.isLoading ? "Loading…" : "No products found."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {changed.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {changed.length === 1 ? "1 price changed" : `${changed.length} prices changed`} — click
            Save changes to keep {changed.length === 1 ? "it" : "them"}.
          </p>
        )}
      </CardContent>
      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It leaves every product list. If it was never sold, posted or produced it is deleted
              for good; otherwise its past records keep it and an admin can bring it back in
              Settings → Products. A product still holding stock can&apos;t be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleting) remove.mutate(deleting);
              }}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={formOpen}
        onOpenChange={(v) => {
          setFormOpen(v);
          if (!v) setEditing(null);
        }}
      >
        {formOpen && (
          <ProductForm
            key={editing?.id ?? "new"}
            factoryId={factoryId}
            categories={categories.data ?? []}
            editing={editing}
            onDone={() => {
              setFormOpen(false);
              setEditing(null);
              invalidate();
            }}
          />
        )}
      </Dialog>
    </Card>
  );
}
