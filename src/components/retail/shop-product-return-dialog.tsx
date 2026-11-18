import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { money, num } from "@/lib/format";
import { localDay } from "@/lib/production-shift";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DialogContent,
  DialogDescription,
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
import { ReturnDateField } from "@/components/shared/return-date";

export type ShopProduct = { id: string; name: string; unit: string; price: number };

type Line = { key: number; productId: string; quantity: number; value: number | null };

const METHODS = [
  { value: "cash", label: "Cash" },
  { value: "transfer", label: "Transfer" },
  { value: "pos", label: "POS" },
];

// Return Product (user, 2026-11-17): a customer hands back a product the shop
// sold them -- they no longer want it, or want another one instead. It goes
// back into the shop's stock (record_shop_product_return); its value counts
// as money given back, taken off the day's cash-up. The other product is then
// sold with New outlet sale, so the customer pays only the difference.
export function ShopProductReturnDialog({
  outletId,
  outletName,
  products,
  onDone,
}: {
  outletId: string;
  outletName: string;
  products: ShopProduct[];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [lines, setLines] = useState<Line[]>([
    { key: 1, productId: "", quantity: 0, value: null },
  ]);
  const [method, setMethod] = useState("cash");
  const [reason, setReason] = useState("");
  const [returnDate, setReturnDate] = useState(localDay());

  // Sachet Water first, as on the sale dropdown, then A-Z.
  const options = [...products].sort(
    (a, b) =>
      Number(!/sachet/i.test(a.name)) - Number(!/sachet/i.test(b.name)) ||
      a.name.localeCompare(b.name),
  );
  const productOf = (id: string) => products.find((p) => p.id === id);
  const valueOf = (l: Line) => l.value ?? l.quantity * (productOf(l.productId)?.price ?? 0);
  const filled = lines.filter((l) => l.productId && l.quantity > 0);
  const total = filled.reduce((t, l) => t + valueOf(l), 0);
  const set = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc(
        "record_shop_product_return" as never,
        {
          payload: {
            outlet_id: outletId,
            return_date: returnDate,
            refund_method: method,
            reason: reason || undefined,
            items: filled.map((l) => ({
              product_id: l.productId,
              quantity: l.quantity,
              value: valueOf(l),
            })),
          },
        } as never,
      );
      if (error) throw error;
      return data as unknown as { return_number: string; refund: number };
    },
    onSuccess: (r) => {
      toast.success(
        `${r.return_number}: back in ${outletName}'s stock — ${money(Number(r.refund))} given back. Sell the customer's new product with New outlet sale.`,
      );
      for (const key of [
        "outlet-stock",
        "outlet-movements",
        "outlet-sales",
        "retail-activity",
        "retail-summary",
        "sales-rep-stock",
      ])
        qc.invalidateQueries({ queryKey: [key] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Return Product</DialogTitle>
        <DialogDescription className="sr-only">Return Product</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <ReturnDateField value={returnDate} onChange={setReturnDate} />
        {lines.map((l, i) => {
          const p = productOf(l.productId);
          return (
            <div key={l.key} className="grid gap-2 rounded-xl border p-3">
              <div className="flex items-end gap-2">
                <div className="grid flex-1 gap-1">
                  <Label>Product {lines.length > 1 ? i + 1 : ""}</Label>
                  <Select
                    value={l.productId}
                    onValueChange={(v) => set(l.key, { productId: v, value: null })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select the product returned…" />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.name} · {money(o.price)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {lines.length > 1 && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Remove line"
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1">
                  <Label>Quantity{p?.unit ? ` (${p.unit})` : ""}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={l.quantity || ""}
                    placeholder="0"
                    onChange={(e) =>
                      set(l.key, { quantity: Number(e.target.value) || 0, value: null })
                    }
                  />
                </div>
                <div className="grid gap-1">
                  <Label>Value given back (₦)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={valueOf(l) || ""}
                    placeholder="0"
                    onChange={(e) =>
                      set(l.key, { value: e.target.value === "" ? null : Number(e.target.value) })
                    }
                  />
                </div>
              </div>
            </div>
          );
        })}
        <Button
          variant="outline"
          size="sm"
          className="w-fit gap-1"
          onClick={() =>
            setLines((ls) => [
              ...ls,
              { key: Math.max(...ls.map((x) => x.key)) + 1, productId: "", quantity: 0, value: null },
            ])
          }
        >
          <Plus className="h-4 w-4" /> Another product
        </Button>
        <div className="grid gap-1">
          <Label>Money given back by</Label>
          <Select value={method} onValueChange={setMethod}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METHODS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            Comes off the day&apos;s money to hand over. When the customer takes another product,
            sell it at full price — they pay only the difference.
          </p>
        </div>
        <div className="grid gap-1">
          <Label>Reason (optional)</Label>
          <Textarea
            rows={2}
            value={reason}
            placeholder="e.g. changed 35cl for 50cl"
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={filled.length === 0 || save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Return {filled.length > 0 ? `${num(filled.reduce((t, l) => t + l.quantity, 0))} · ${money(total)}` : ""}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
