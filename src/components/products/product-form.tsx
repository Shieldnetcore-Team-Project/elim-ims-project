import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useUnitsOfMeasure,
  UNIT_OPTIONS as UNIT_OPTIONS_FALLBACK,
  isBottleWater,
  packUnitOf,
} from "@/lib/units";
import {
  ProductNameSelect,
  assertUniqueProductName,
  categoryForProduct,
  defaultPriceFor,
} from "@/components/shared/product-name-select";

// Add or edit a product: name, type, category, unit, selling and cost price.
// Used by Finished Products and by Settings → Products.
export type ProductFormProduct = {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  unit_price: number;
  cost_price: number;
  current_stock: number;
  reorder_level: number | null;
  category_id: string | null;
  product_type: string;
};
type Category = { id: string; name: string };

export function ProductForm({
  factoryId,
  categories,
  editing,
  onDone,
}: {
  factoryId: string;
  categories: Category[];
  editing: ProductFormProduct | null;
  onDone: () => void;
}) {
  const unitsOfMeasure = useUnitsOfMeasure();
  const unitOptions = unitsOfMeasure.data ?? UNIT_OPTIONS_FALLBACK;
  const [name, setName] = useState(editing?.name ?? "");
  const [sku, setSku] = useState(editing?.sku ?? "");
  const [productType, setProductType] = useState<"finished" | "semi_finished">(
    (editing?.product_type as "finished" | "semi_finished") ?? "finished",
  );
  const initialUnit = editing?.unit ?? "pieces";
  const [unitChoice, setUnitChoice] = useState(
    unitOptions.includes(initialUnit) ? initialUnit : "__custom__",
  );
  const [customUnit, setCustomUnit] = useState(
    unitOptions.includes(initialUnit) ? "" : initialUnit,
  );
  const unit = unitChoice === "__custom__" ? customUnit : unitChoice;
  const [categoryId, setCategoryId] = useState(editing?.category_id ?? "none");
  const [unitPrice, setUnitPrice] = useState(editing ? Number(editing.unit_price) : 0);
  const [costPrice, setCostPrice] = useState(editing ? Number(editing.cost_price) : 0);
  const [openingStock, setOpeningStock] = useState(editing ? Number(editing.current_stock) : 0);
  const [reorderLevel, setReorderLevel] = useState(
    editing ? Number(editing.reorder_level ?? 0) : 0,
  );

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Product name is required");
      if (!unit.trim()) throw new Error("Select or enter a unit of measurement");
      await assertUniqueProductName(factoryId, name, editing?.id);
      const payload = {
        name: name.trim(),
        sku: sku.trim() || null,
        product_type: productType,
        unit: unit.trim(),
        category_id: categoryId === "none" ? null : categoryId,
        unit_price: unitPrice,
        reorder_level: reorderLevel,
      };
      if (editing) {
        // cost_price is column-locked for direct updates; a manual change goes
        // through the audited set_product_cost_price RPC instead.
        const { error } = await supabase.from("products").update(payload).eq("id", editing.id);
        if (error) throw error;
        if (costPrice !== Number(editing.cost_price)) {
          const { error: costErr } = await supabase.rpc("set_product_cost_price", {
            p_id: editing.id,
            p_cost: costPrice,
          });
          if (costErr) throw costErr;
        }
      } else {
        const { error } = await supabase.from("products").insert({
          ...payload,
          cost_price: costPrice,
          factory_id: factoryId,
          current_stock: 0,
          active: true,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editing ? "Product updated" : "Product added");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{editing ? "Edit Product" : "Add New Product"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Product name</Label>
          <ProductNameSelect
            value={name}
            onChange={(n) => {
              setName(n);
              if (isBottleWater(n)) setUnitChoice(packUnitOf(unitOptions));
              // File it under its category (Bottle / Dispenser / Sachet Water).
              const cat = categoryForProduct(n);
              const match =
                cat && categories.find((c) => c.name.toLowerCase() === cat.toLowerCase());
              if (match) setCategoryId(match.id);
              // New product: start from its standard selling price.
              const price = defaultPriceFor(n);
              if (!editing && price) setUnitPrice(price);
            }}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Type</Label>
            <Select
              value={productType}
              onValueChange={(v) => setProductType(v as typeof productType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="finished">Finished product</SelectItem>
                <SelectItem value="semi_finished">Semi-finished product</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>SKU</Label>
            <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="Optional" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Category</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Unit of measurement</Label>
            <Select value={unitChoice} onValueChange={setUnitChoice}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {unitOptions.map((u) => (
                  <SelectItem key={u} value={u} className="capitalize">
                    {u}
                  </SelectItem>
                ))}
                <SelectItem value="__custom__">Other…</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {unitChoice === "__custom__" && (
          <div>
            <Label>Custom unit</Label>
            <Input
              value={customUnit}
              onChange={(e) => setCustomUnit(e.target.value)}
              placeholder="e.g. crates"
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Selling price</Label>
            <MoneyInput value={unitPrice} onChange={setUnitPrice} />
          </div>
          <div>
            <Label>Cost price</Label>
            <MoneyInput value={costPrice} onChange={setCostPrice} />
            {editing && (
              <p className="mt-1 text-xs text-muted-foreground">
                Stays as entered until changed here or by an approved Costing sheet.
              </p>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {/* No opening stock: a product starts at 0 and gets stock only from
              production released to the Warehouse (or an approved adjustment). */}
          {editing && (
            <div>
              <Label>Warehouse stock</Label>
              <MoneyInput value={openingStock} onChange={setOpeningStock} disabled />
            </div>
          )}
          <div>
            <Label>Reorder level</Label>
            <MoneyInput min={0} step="0.001" value={reorderLevel} onChange={setReorderLevel} />
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : editing ? "Save changes" : "Add product"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
