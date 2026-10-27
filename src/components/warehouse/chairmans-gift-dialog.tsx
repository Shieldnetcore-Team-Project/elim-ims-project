import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { logAudit } from "@/lib/audit";
import { money, num } from "@/lib/format";
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
import { Loader2, Plus, Trash2 } from "lucide-react";

type GiftProduct = {
  id: string;
  name: string;
  unit: string;
  cost_price: number;
  current_stock: number;
};
type GiftLine = { product_id: string; quantity: number };

// Warehouse → Post → Others → Chairman's gift. The warehouse manager picks
// the products and quantities; the unit cost comes from the product. Posting
// takes the stock out of the Warehouse and sends the gift to Accounting
// (Accountant → Postings) to review and record. No sale, nothing to pay, and
// never revenue (post_chairmans_gift).
export function ChairmansGiftDialog({
  factoryId,
  onDone,
}: {
  factoryId: string;
  onDone: () => void;
}) {
  const products = useQuery({
    queryKey: ["chairmans-gift-products", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,unit,cost_price,current_stock")
        .eq("factory_id", factoryId)
        .eq("active", true)
        .eq("product_type", "finished")
        .order("name");
      if (error) throw error;
      return (data ?? []) as GiftProduct[];
    },
  });
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [recipient, setRecipient] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<GiftLine[]>([{ product_id: "", quantity: 0 }]);

  const byId = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data]);
  const total = lines.reduce((t, l) => {
    const p = byId.get(l.product_id);
    return t + (p ? Number(p.cost_price) * (l.quantity || 0) : 0);
  }, 0);
  const update = (i: number, patch: Partial<GiftLine>) =>
    setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const submit = useMutation({
    mutationFn: async () => {
      const clean = lines.filter((l) => l.product_id && l.quantity > 0);
      if (clean.length === 0) throw new Error("Add at least one product and quantity");
      for (const l of clean) {
        const p = byId.get(l.product_id);
        if (p && l.quantity > Number(p.current_stock))
          throw new Error(`Only ${num(Number(p.current_stock))} ${p.unit} of ${p.name} in stock`);
      }
      const { data, error } = await supabase.rpc(
        "post_chairmans_gift" as never,
        {
          payload: {
            factory_id: factoryId,
            gift_date: date,
            recipient: recipient || null,
            notes: notes || null,
            items: clean,
          },
        } as never,
      );
      if (error) throw error;
      return data as unknown as { id: string; gift_number: string; total_value: number };
    },
    onSuccess: (data) => {
      toast.success(`Chairman's gift ${data.gift_number} posted — sent to Accounting`);
      logAudit({ action: "create", entity: "chairmans_gifts", entityId: data.id, factoryId });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>Chairman's gift</DialogTitle>
        <DialogDescription>
          Products given out on the chairman's request. Stock leaves the Warehouse and the record
          goes to Accounting. Nothing is billed and it is not revenue.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Given to (optional)</Label>
            <Input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Visitor, guest, organisation…"
            />
          </div>
          <div>
            <Label>Date</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>

        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_6rem_7rem_7rem_2rem] gap-2 text-xs text-muted-foreground">
            <span>Product</span>
            <span>Qty</span>
            <span className="text-right">Unit cost</span>
            <span className="text-right">Value</span>
            <span />
          </div>
          {lines.map((l, i) => {
            const p = byId.get(l.product_id);
            return (
              <div key={i} className="grid grid-cols-[1fr_6rem_7rem_7rem_2rem] items-center gap-2">
                <Select value={l.product_id} onValueChange={(v) => update(i, { product_id: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder={products.isLoading ? "Loading…" : "Select…"} />
                  </SelectTrigger>
                  <SelectContent>
                    {(products.data ?? []).map((x) => (
                      <SelectItem key={x.id} value={x.id} disabled={Number(x.current_stock) <= 0}>
                        {x.name} · {num(Number(x.current_stock))} {x.unit}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min={0}
                  value={l.quantity || ""}
                  onChange={(e) => update(i, { quantity: Number(e.target.value) })}
                />
                <div className="text-right text-sm text-muted-foreground">
                  {p ? money(Number(p.cost_price)) : "—"}
                </div>
                <div className="text-right text-sm font-medium">
                  {p ? money(Number(p.cost_price) * (l.quantity || 0)) : "—"}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  disabled={lines.length === 1}
                  onClick={() => setLines(lines.filter((_, idx) => idx !== i))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => setLines([...lines, { product_id: "", quantity: 0 }])}
          >
            <Plus className="h-4 w-4" /> Add product
          </Button>
        </div>

        <div>
          <Label>Notes</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <div className="flex justify-between border-t pt-2 text-sm font-medium">
          <span>Value of products given out (at cost)</span>
          <span>{money(total)}</span>
        </div>
      </div>
      <DialogFooter>
        <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
          {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Post
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
