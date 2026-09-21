import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { logAudit } from "@/lib/audit";
import { useUnitsOfMeasure, UNIT_OPTIONS as UNIT_OPTIONS_FALLBACK } from "@/lib/units";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Sentinel value for the "+ Add new …" entry that sits at the bottom of the
// product / material dropdowns. Selects intercept it before touching state.
export const ADD_NEW_ITEM = "__add_new__";

// A newly added product or material is saved for real (same tables the
// Finished Goods / Raw Materials pages read), including the cost typed here.
// The cost is stored as-is and only changes when someone edits that
// product / material later.
function refreshItemLists(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({
    predicate: (q) => {
      const k = String(q.queryKey[0] ?? "");
      return k.startsWith("products") || k.startsWith("raw-materials") || k.startsWith("dist-products");
    },
  });
}

function UnitField({
  unitChoice,
  setUnitChoice,
  customUnit,
  setCustomUnit,
}: {
  unitChoice: string;
  setUnitChoice: (v: string) => void;
  customUnit: string;
  setCustomUnit: (v: string) => void;
}) {
  const unitsOfMeasure = useUnitsOfMeasure();
  const unitOptions = unitsOfMeasure.data ?? UNIT_OPTIONS_FALLBACK;
  return (
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
      {unitChoice === "__custom__" && (
        <Input
          className="mt-2"
          placeholder="Enter unit"
          value={customUnit}
          onChange={(e) => setCustomUnit(e.target.value)}
        />
      )}
    </div>
  );
}

export function QuickAddProductDialog({
  open,
  onOpenChange,
  factoryId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  factoryId: string;
  onCreated?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [productType, setProductType] = useState<"finished" | "semi_finished">("finished");
  const [categoryId, setCategoryId] = useState("none");
  const [unitChoice, setUnitChoice] = useState("pieces");
  const [customUnit, setCustomUnit] = useState("");
  const [unitPrice, setUnitPrice] = useState(0);
  const [costPrice, setCostPrice] = useState(0);
  const [openingStock, setOpeningStock] = useState(0);
  const unit = unitChoice === "__custom__" ? customUnit : unitChoice;

  useEffect(() => {
    if (open) {
      setName("");
      setProductType("finished");
      setCategoryId("none");
      setUnitChoice("pieces");
      setCustomUnit("");
      setUnitPrice(0);
      setCostPrice(0);
      setOpeningStock(0);
    }
  }, [open]);

  const categories = useQuery({
    queryKey: ["product-categories-quick-add", factoryId],
    enabled: open && !!factoryId,
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

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Product name is required");
      if (!unit.trim()) throw new Error("Select or enter a unit of measurement");
      // Goes through an RPC (permission-checked server side) because the
      // products table itself only lets Finished Goods writers insert.
      const { data, error } = await supabase.rpc("quick_add_product" as any, {
        payload: {
          factory_id: factoryId,
          name: name.trim(),
          product_type: productType,
          unit: unit.trim(),
          category_id: categoryId === "none" ? null : categoryId,
          unit_price: unitPrice,
          cost_price: costPrice,
          current_stock: openingStock,
        },
      } as any);
      if (error) throw error;
      return (data as { id: string }).id;
    },
    onSuccess: (id) => {
      toast.success(`"${name.trim()}" added`);
      logAudit({
        action: "create",
        entity: "products",
        entityId: id,
        factoryId,
        newValue: { name: name.trim(), unit: unit.trim(), cost_price: costPrice, unit_price: unitPrice },
      });
      refreshItemLists(qc);
      onCreated?.(id);
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add New Product</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label>Product name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Type</Label>
              <Select value={productType} onValueChange={(v) => setProductType(v as typeof productType)}>
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
              <Label>Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  {(categories.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <UnitField
              unitChoice={unitChoice}
              setUnitChoice={setUnitChoice}
              customUnit={customUnit}
              setCustomUnit={setCustomUnit}
            />
            <div>
              <Label>Opening stock</Label>
              <MoneyInput min={0} step="0.001" value={openingStock} onChange={setOpeningStock} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Cost price</Label>
              <MoneyInput value={costPrice} onChange={setCostPrice} />
            </div>
            <div>
              <Label>Selling price</Label>
              <MoneyInput value={unitPrice} onChange={setUnitPrice} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            The cost is saved with the product and stays until someone changes it on the Finished
            Goods page. The Sales picker only lists products that have a category.
          </p>
        </div>
        <DialogFooter>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Add product"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function QuickAddMaterialDialog({
  open,
  onOpenChange,
  factoryId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  factoryId: string;
  onCreated?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [unitChoice, setUnitChoice] = useState("kg");
  const [customUnit, setCustomUnit] = useState("");
  const [unitCost, setUnitCost] = useState(0);
  const [openingStock, setOpeningStock] = useState(0);
  const [reorderLevel, setReorderLevel] = useState(0);
  const unit = unitChoice === "__custom__" ? customUnit : unitChoice;

  useEffect(() => {
    if (open) {
      setName("");
      setUnitChoice("kg");
      setCustomUnit("");
      setUnitCost(0);
      setOpeningStock(0);
      setReorderLevel(0);
    }
  }, [open]);

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Material name is required");
      if (!unit.trim()) throw new Error("Select or enter a unit of measurement");
      const { data, error } = await supabase.rpc("request_new_material", {
        payload: {
          factory_id: factoryId,
          name: name.trim(),
          unit: unit.trim(),
          unit_cost: unitCost,
          opening_stock: openingStock,
          reorder_level: reorderLevel,
        } as any,
      });
      if (error) throw error;
      return (data as { id: string }).id;
    },
    onSuccess: (id) => {
      toast.success(`"${name.trim()}" added`);
      logAudit({
        action: "create",
        entity: "raw_materials",
        entityId: id,
        factoryId,
        newValue: { name: name.trim(), unit: unit.trim(), unit_cost: unitCost },
      });
      refreshItemLists(qc);
      onCreated?.(id);
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add New Raw Material</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label>Raw material name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <UnitField
              unitChoice={unitChoice}
              setUnitChoice={setUnitChoice}
              customUnit={customUnit}
              setCustomUnit={setCustomUnit}
            />
            <div>
              <Label>Unit cost</Label>
              <MoneyInput value={unitCost} onChange={setUnitCost} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Opening stock</Label>
              <MoneyInput min={0} step="0.001" value={openingStock} onChange={setOpeningStock} />
            </div>
            <div>
              <Label>Reorder level</Label>
              <MoneyInput min={0} step="0.001" value={reorderLevel} onChange={setReorderLevel} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            The unit cost is saved with the material and stays until someone changes it on the Raw
            Materials page.
          </p>
        </div>
        <DialogFooter>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Add material"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
