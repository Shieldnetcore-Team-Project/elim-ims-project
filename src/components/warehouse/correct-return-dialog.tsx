import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { num } from "@/lib/format";
import { ReturnDateField } from "@/components/shared/return-date";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// The Warehouse corrects a marketer's / the shop's return (correct_rep_return,
// supabase/migrations/20261103100000_correct_rep_return.sql): the wrong one
// is cancelled and the corrected one recorded in one step. Every line at 0
// removes a return entered by mistake. A wrong product: set it to 0 here and
// record the right product as a new return.

export type CorrectableReturn = {
  id: string;
  return_number: string;
  return_date: string;
  party: string;
  lines: { product_id: string; name: string; unit: string; quantity: number }[];
};

export function CorrectReturnDialog({
  ret,
  onClose,
}: {
  ret: CorrectableReturn;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // Two lines of one product are one figure here.
  const lines = Object.values(
    ret.lines.reduce<Record<string, CorrectableReturn["lines"][number]>>((m, l) => {
      m[l.product_id] = m[l.product_id]
        ? { ...m[l.product_id], quantity: m[l.product_id].quantity + l.quantity }
        : { ...l };
      return m;
    }, {}),
  );
  const [qty, setQty] = useState<Record<string, number>>(
    Object.fromEntries(lines.map((l) => [l.product_id, l.quantity])),
  );
  const [date, setDate] = useState(ret.return_date.slice(0, 10));
  const [reason, setReason] = useState("");
  const total = Object.values(qty).reduce((t, v) => t + v, 0);
  const changed =
    date !== ret.return_date.slice(0, 10) ||
    lines.some((l) => (qty[l.product_id] ?? 0) !== l.quantity);

  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc(
        "correct_rep_return" as never,
        {
          p_id: ret.id,
          payload: {
            reason,
            return_date: date,
            items: lines
              .map((l) => ({ product_id: l.product_id, quantity_returned: qty[l.product_id] ?? 0 }))
              .filter((i) => i.quantity_returned > 0),
          },
        } as never,
      );
      if (error) throw error;
      return data as unknown as { cancelled: string; return_number: string | null };
    },
    onSuccess: (r) => {
      toast.success(
        r.return_number
          ? `${r.cancelled} corrected — now ${r.return_number}`
          : `${r.cancelled} removed — the goods are back with ${ret.party}`,
      );
      for (const key of [
        "dist-returns",
        "dispatch-open-returns",
        "warehouse-party",
        "warehouse-party-holding",
        "warehouse-party-van",
        "warehouse-transactions",
        "dist-rep-activity",
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
          <DialogTitle>
            Correct return {ret.return_number} — {ret.party}
          </DialogTitle>
          <DialogDescription>
            Enter what really came back. The wrong entry is cancelled and the corrected one
            recorded; stock and jugs follow. All lines at 0 removes the return.
          </DialogDescription>
        </DialogHeader>
        <ReturnDateField value={date} onChange={setDate} />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Entered</TableHead>
              <TableHead className="w-28 text-right">Correct figure</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => (
              <TableRow key={l.product_id}>
                <TableCell>{l.name}</TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {num(l.quantity)} {l.unit}
                </TableCell>
                <TableCell className="text-right">
                  <Input
                    type="number"
                    min={0}
                    className="ml-auto w-24 text-right"
                    value={qty[l.product_id] ?? 0}
                    onChange={(e) =>
                      setQty((q) => ({
                        ...q,
                        [l.product_id]: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="space-y-1">
          <Label>Reason</Label>
          <Textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Counted 3, not 4"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={total === 0 ? "destructive" : "default"}
            disabled={!changed || !reason.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {total === 0 ? "Remove return" : "Save correction"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
