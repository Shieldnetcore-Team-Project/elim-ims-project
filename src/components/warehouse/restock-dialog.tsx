import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackagePlus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { num } from "@/lib/format";
import { isRestockable } from "@/lib/units";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type RestockProduct = { id: string; name: string; unit: string; current_stock: number };

// Warehouse → Restock: Sachet Water is added straight to the Warehouse
// (warehouse_restock) -- the only product restocked this way.
export function RestockButton({ factoryId }: { factoryId: string }) {
  const { canCreate } = usePermissions();
  const [open, setOpen] = useState(false);
  if (!canCreate("finished-goods")) return null;
  return (
    <>
      <Button variant="outline" className="gap-2" onClick={() => setOpen(true)}>
        <PackagePlus className="h-4 w-4" /> Restock
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && <RestockDialog factoryId={factoryId} onDone={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

// productId opens it on one product (the restock icon on a stock row).
export function RestockDialog({
  factoryId,
  productId: initialProductId,
  onDone,
}: {
  factoryId: string;
  productId?: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const products = useQuery({
    queryKey: ["restock-products", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,unit,current_stock")
        .eq("factory_id", factoryId)
        .eq("active", true)
        .eq("product_type", "finished")
        .order("name");
      if (error) throw error;
      return ((data ?? []) as RestockProduct[]).filter((p) => isRestockable(p.name));
    },
  });
  const list = products.data ?? [];
  const sachet = list.find((p) => /sachet/i.test(p.name));
  const [productId, setProductId] = useState(initialProductId ?? "");
  const chosen = productId || sachet?.id || "";
  const product = list.find((p) => p.id === chosen);
  const [qty, setQty] = useState(0);
  const [notes, setNotes] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      if (!chosen) throw new Error("Pick the product");
      if (qty <= 0) throw new Error("Enter the quantity received");
      const { data, error } = await supabase.rpc(
        "warehouse_restock" as never,
        {
          payload: {
            factory_id: factoryId,
            product_id: chosen,
            quantity: qty,
            notes: notes || null,
          },
        } as never,
      );
      if (error) throw error;
      return data as unknown as { reference: string; stock: number };
    },
    onSuccess: (r) => {
      toast.success(
        `${product?.name ?? "Product"} restocked (${r.reference}) — now ${num(Number(r.stock))} ${product?.unit ?? ""}`,
      );
      for (const key of [
        "restock-products",
        "inventory-overview-products",
        "finished-goods",
        "products-active",
        "dist-products",
        "warehouse-products-report",
      ])
        qc.invalidateQueries({ queryKey: [key] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Restock the Warehouse</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        Sachet Water received into the Warehouse is added at once. Bottle Water and Dispenser/Jug
        Water come in as Production Releases, unsold dispensers as marketer returns, and empty jugs
        through the Store.
      </p>
      <div className="grid gap-3">
        <div>
          <Label>Product</Label>
          <Select value={chosen} onValueChange={setProductId}>
            <SelectTrigger>
              <SelectValue placeholder="Select product…" />
            </SelectTrigger>
            <SelectContent>
              {list.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name} · stock {num(Number(p.current_stock))} {p.unit}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Quantity received{product ? ` (${product.unit})` : ""}</Label>
          <MoneyInput min={0} value={qty} onChange={setQty} />
        </div>
        <div>
          <Label>Notes (optional)</Label>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. from the sachet line"
          />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Add to stock"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
