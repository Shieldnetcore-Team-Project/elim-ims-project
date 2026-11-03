import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Pencil } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { num } from "@/lib/format";
import { CorrectReturnDateButton, ReturnDateField } from "@/components/shared/return-date";
import type { DayReturn } from "@/lib/day-returns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

// The Warehouse edits a marketer's / the shop's return in place
// (correct_rep_return, supabase/migrations/20261103120000_edit_rep_return_in_place.sql):
// the same return takes the new figures at once, stock and jugs move by the
// difference, and the audit log keeps the old figures -- no reason asked, no
// second record (user, 2026-11-03). Every line at 0 removes the return. A
// wrong product: set it to 0 here and record the right product as a new return.

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
            return_date: date,
            items: lines
              .map((l) => ({ product_id: l.product_id, quantity_returned: qty[l.product_id] ?? 0 }))
              .filter((i) => i.quantity_returned > 0),
          },
        } as never,
      );
      if (error) throw error;
      return data as unknown as { return_number: string; removed: boolean };
    },
    onSuccess: (r) => {
      toast.success(
        r.removed
          ? `${r.return_number} removed — the goods are back with ${ret.party}`
          : `${r.return_number} updated`,
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
            Enter what really came back. The return is updated at once and stock and jugs follow.
            All lines at 0 removes the return.
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
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={total === 0 ? "destructive" : "default"}
            disabled={!changed || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {total === 0 ? "Remove return" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// The returns already entered for a marketer / the shop on the chosen day,
// inside the Return box: each can be corrected (figures, or removed) or moved
// to its right day from here (user, 2026-11-03). Pick a day on the box's
// calendar to see that day's returns.
export function DayReturnsPanel({
  party,
  date,
  earlier,
  canCorrect,
}: {
  party: string;
  date: string;
  earlier: {
    rows: DayReturn[];
    isLoading: boolean;
    error: Error | null;
  };
  canCorrect: boolean;
}) {
  const [correcting, setCorrecting] = useState<DayReturn | null>(null);
  const day = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  if (earlier.error)
    return (
      <p className="text-xs text-destructive">
        Couldn&apos;t load the returns already entered: {earlier.error.message}
      </p>
    );
  if (earlier.isLoading) return null;
  if (earlier.rows.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        Nothing returned by {party} on {day} yet. To correct an earlier return, pick its day on the
        calendar above.
      </p>
    );
  return (
    <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-2 text-xs">
      <div className="font-medium">
        Already entered for {day} — what you enter below adds to it (Total column).
        {canCorrect && " Use ✎ to correct a wrong figure or remove it, or the calendar to move it."}
      </div>
      {earlier.rows.map((r) => {
        const inPosting = r.carried && r.carried.status !== "reversed";
        return (
          <div
            key={r.id}
            className="flex flex-wrap items-center gap-2 rounded border bg-background p-1.5"
          >
            <span className="font-mono">{r.return_number}</span>
            {r.received_at && (
              <span className="text-muted-foreground">
                {new Date(r.received_at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            )}
            <span className="flex-1">
              {(r.rep_return_items ?? [])
                .map(
                  (i) => `${i.products?.name ?? "Product"} × ${num(Number(i.quantity_returned))}`,
                )
                .join(", ")}
            </span>
            {inPosting ? (
              <span className="text-muted-foreground">
                Added to {r.carried!.dispatch_number} — correct that posting
              </span>
            ) : (
              canCorrect &&
              r.status === "completed" && (
                <span className="flex">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title="Correct this return (wrong figure, or entered by mistake)"
                    onClick={() => setCorrecting(r)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <CorrectReturnDateButton
                    kind="rep"
                    reference={r.return_number}
                    date={r.return_date}
                  />
                </span>
              )
            )}
          </div>
        );
      })}
      {correcting && (
        <CorrectReturnDialog
          ret={{
            id: correcting.id,
            return_number: correcting.return_number,
            return_date: correcting.return_date,
            party,
            lines: (correcting.rep_return_items ?? []).map((i) => ({
              product_id: i.product_id,
              name: i.products?.name ?? "Product",
              unit: i.products?.unit ?? "",
              quantity: Number(i.quantity_returned),
            })),
          }}
          onClose={() => setCorrecting(null)}
        />
      )}
    </div>
  );
}
