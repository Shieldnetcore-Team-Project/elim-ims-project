import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Percent } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { money, num } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { Textarea } from "@/components/ui/textarea";
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Accounts' discount per pack on postings -- the Retail Shop's (user,
// 2026-11-03): set_posting_discount, supabase/migrations/20261103220000_posting_discount.sql.
// Final at once and audited; the posting invoice then prints the price after
// discount, so packs x price = amount.

type Line = {
  product_id: string;
  product_name: string;
  unit: string;
  unit_price: number;
  quantity: number;
  unit_discount: number;
};

// A "Discount" button that opens the dialog for the postings given.
export function PostingDiscountButton({
  dispatchIds,
  title,
  size = "sm",
}: {
  dispatchIds: string[];
  title: string;
  size?: "sm" | "icon";
}) {
  const [open, setOpen] = useState(false);
  if (dispatchIds.length === 0) return null;
  return (
    <>
      <Button
        variant={size === "icon" ? "ghost" : "outline"}
        size={size}
        className={size === "icon" ? "" : "gap-1"}
        title="Discount per pack on this posting"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Percent className="h-4 w-4" />
        {size !== "icon" && "Discount"}
      </Button>
      {open && (
        <PostingDiscountDialog
          dispatchIds={dispatchIds}
          title={title}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function PostingDiscountDialog({
  dispatchIds,
  title,
  onClose,
}: {
  dispatchIds: string[];
  title: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [disc, setDisc] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const key = (l: Line) => `${l.product_id}|${l.unit_price}`;

  const lines = useQuery({
    queryKey: ["posting-discount-lines", dispatchIds.join(",")],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "posting_discount_lines" as never,
        { p_dispatches: dispatchIds } as never,
      );
      if (error) throw error;
      return ((data ?? []) as unknown as Line[]).map((l) => ({
        ...l,
        unit_price: Number(l.unit_price),
        quantity: Number(l.quantity),
        unit_discount: Number(l.unit_discount),
      }));
    },
  });
  // Start from the discount already given.
  useEffect(() => {
    if (lines.data) setDisc(Object.fromEntries(lines.data.map((l) => [key(l), l.unit_discount])));
  }, [lines.data]);

  const rows = lines.data ?? [];
  const before = rows.reduce((t, l) => t + l.quantity * (l.unit_price - l.unit_discount), 0);
  const after = rows.reduce((t, l) => t + l.quantity * (l.unit_price - (disc[key(l)] ?? 0)), 0);
  const tooMuch = rows.some((l) => (disc[key(l)] ?? 0) > l.unit_price);
  const changed = rows.some((l) => (disc[key(l)] ?? 0) !== l.unit_discount);

  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc(
        "set_posting_discount" as never,
        {
          p_dispatches: dispatchIds,
          p_lines: rows.map((l) => ({
            product_id: l.product_id,
            unit_price: l.unit_price,
            unit_discount: disc[key(l)] ?? 0,
          })),
          p_note: note || null,
        } as never,
      );
      if (error) throw error;
      return data as unknown as { before: number; after: number };
    },
    onSuccess: (r) => {
      toast.success(`Discount saved — ${money(Number(r.before))} → ${money(Number(r.after))}`);
      for (const k of [
        "acct-activity-postings",
        "acct-activity-dated",
        "acct-postings",
        "dist-rep-activity",
        "rep-posting-lines",
        "retail-daily-book",
        "party-postings-returns",
        "dist-account",
      ])
        qc.invalidateQueries({ queryKey: [k] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Discount — {title}</DialogTitle>
          <DialogDescription>
            Money off each pack. Saved at once; the invoice then prints the price after discount.
          </DialogDescription>
        </DialogHeader>
        {lines.isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : lines.isError ? (
          <p className="text-sm text-destructive">{(lines.error as Error).message}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="w-32 text-right">Discount / pack</TableHead>
                <TableHead className="text-right">New price</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((l) => {
                const d = disc[key(l)] ?? 0;
                return (
                  <TableRow key={key(l)}>
                    <TableCell className="font-medium">{l.product_name}</TableCell>
                    <TableCell className="text-right">
                      {num(l.quantity)} {l.unit}
                    </TableCell>
                    <TableCell className="text-right">{money(l.unit_price)}</TableCell>
                    <TableCell className="text-right">
                      <MoneyInput
                        value={d}
                        onChange={(v) => setDisc((m) => ({ ...m, [key(l)]: Math.max(0, v) }))}
                        className="h-8"
                      />
                      {d > l.unit_price && (
                        <div className="text-[11px] text-destructive">More than the price</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {money(Math.max(l.unit_price - d, 0))}
                    </TableCell>
                    <TableCell className="text-right">
                      {money(l.quantity * Math.max(l.unit_price - d, 0))}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={5} className="font-semibold">
                  Total {money(before)} → {money(after)}
                </TableCell>
                <TableCell className="text-right font-semibold">{money(after)}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
        <div className="space-y-1">
          <Label>Note (optional)</Label>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!changed || tooMuch || save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save discount
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
