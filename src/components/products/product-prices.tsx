import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Save, Search, Tag } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { money } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
// Sales & POS and postings fill the unit price in from here, so the sales
// person only enters the quantity. Prices are edited in place and saved
// together (set_product_prices); Add product / the pencil open the product
// form for everything else about a product.
export function ProductPricesCard({ factoryId }: { factoryId: string }) {
  const qc = useQueryClient();
  const { canEdit, canWrite } = usePermissions();
  const canPrice = canEdit("costing") || canWrite("finished-goods");
  const canManage = canWrite("finished-goods");
  const [q, setQ] = useState("");
  // Prices typed but not saved yet, by product id.
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PriceRow | null>(null);

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

  const save = useMutation({
    mutationFn: async () => {
      if (changed.length === 0) return 0;
      const { data, error } = await supabase.rpc(
        "set_product_prices" as never,
        { p_prices: changed.map((p) => ({ id: p.id, unit_price: drafts[p.id] })) } as never,
      );
      if (error) throw error;
      return (data as unknown as { changed?: number })?.changed ?? changed.length;
    },
    onSuccess: (n) => {
      toast.success(n === 1 ? "1 price saved" : `${n} prices saved`);
      setDrafts({});
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Tag className="h-4 w-4" /> Product Prices
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            The selling price of each product. Sales &amp; POS fills the unit price in from this
            list — the sales person only enters the quantity, and the total is worked out
            automatically.
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
              onClick={() => save.mutate()}
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
