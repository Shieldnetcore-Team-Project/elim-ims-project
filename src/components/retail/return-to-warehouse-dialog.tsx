import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { num } from "@/lib/format";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EarlierReturnsNote, ReturnDateField } from "@/components/shared/return-date";

export type ShopStockLine = { product_id: string; name: string; unit: string; quantity: number };

// End of business (user, 2026-11-02): the shop sends what it did not sell
// back to the Warehouse (return_shop_stock_to_warehouse). It comes off the
// shop's stock into the Warehouse now, and the Warehouse sees it on its next
// posting to the shop -- as a marketer's return -- so it goes back out then.
export function ReturnToWarehouseDialog({
  outletId,
  outletName,
  stock,
  onDone,
}: {
  outletId: string;
  outletName: string;
  stock: ShopStockLine[];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [qty, setQty] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState("");
  // An earlier day's unsold keyed in late go on that day (2026-11-03).
  const [returnDate, setReturnDate] = useState(localDay());
  const held = stock.filter((s) => s.quantity > 0);
  const items = held
    .map((s) => ({ product_id: s.product_id, quantity: qty[s.product_id] ?? 0 }))
    .filter((i) => i.quantity > 0);
  const over = held.some((s) => (qty[s.product_id] ?? 0) > s.quantity);
  const total = items.reduce((t, i) => t + i.quantity, 0);

  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc(
        "return_shop_stock_to_warehouse" as never,
        {
          payload: {
            outlet_id: outletId,
            return_date: returnDate,
            notes: notes || undefined,
            items,
          },
        } as never,
      );
      if (error) throw error;
      return data as unknown as { return_number: string };
    },
    onSuccess: (r) => {
      toast.success(
        `${r.return_number}: ${num(total)} unsold back to the Warehouse — it shows on the next posting to ${outletName}`,
      );
      for (const key of [
        "outlet-stock",
        "outlet-movements",
        "retail-activity",
        "retail-summary",
        "dispatch-open-returns",
        "dist-returns",
      ])
        qc.invalidateQueries({ queryKey: [key] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Fill every line with all the shop holds -- the usual end-of-day return.
  const returnAll = () => setQty(Object.fromEntries(held.map((s) => [s.product_id, s.quantity])));

  return (
    <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Return unsold to the Warehouse</DialogTitle>
        <DialogDescription>
          What {outletName} did not sell today goes back into the Warehouse. The Warehouse sees it
          on its next posting to the shop and sends it back out with that posting.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <ReturnDateField value={returnDate} onChange={setReturnDate} />
        <EarlierReturnsNote holderId={outletId} date={returnDate} />
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={returnAll} disabled={held.length === 0}>
            Return everything
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">In the shop</TableHead>
              <TableHead className="w-28 text-right">Returning</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {held.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                  Nothing in the shop to return.
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
                      max={s.quantity}
                      className="ml-auto w-24 text-right"
                      value={v || ""}
                      placeholder="0"
                      onChange={(e) =>
                        setQty((q) => ({ ...q, [s.product_id]: Number(e.target.value) || 0 }))
                      }
                    />
                    {v > s.quantity && (
                      <div className="text-[11px] text-destructive">More than in the shop</div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <div>
          <Label>Notes (optional)</Label>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={items.length === 0 || over || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Return {total > 0 ? num(total) : ""}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
