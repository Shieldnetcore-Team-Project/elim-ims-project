import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useDayReturns } from "@/lib/day-returns";
import { num } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Warehouse returns can be dated an earlier day and their date corrected
// (supabase/migrations/20261103090000_backdate_warehouse_returns.sql): the
// return, its stock moves and its jugs all count on the chosen day.

const lagosToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });

const fmt = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

// The calendar on a return form: today by default, never a future day.
export function ReturnDateField({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const back = value && value < lagosToday();
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <Label>Return date</Label>
      <Input
        type="date"
        className="w-44"
        value={value}
        max={lagosToday()}
        onChange={(e) => e.target.value && onChange(e.target.value)}
      />
      <p className={`text-[11px] ${back ? "text-warning" : "text-muted-foreground"}`}>
        {back
          ? `Back-dated: the goods count on ${fmt(value)}.`
          : "Pick an earlier day for goods that came back then."}
      </p>
    </div>
  );
}

// "Correct date" on a recorded return: moves the return and everything it
// moved to another day. kind 'rep' = a marketer's / the shop's return (RRN-),
// 'customer' = a customer's return (SR-, all its lines).
export function CorrectReturnDateButton({
  kind,
  reference,
  date,
  onDone,
}: {
  kind: "rep" | "customer";
  reference: string;
  date: string;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        title="Correct the return date"
        onClick={() => setOpen(true)}
      >
        <CalendarClock className="h-4 w-4" />
      </Button>
      {open && (
        <CorrectDateDialog
          kind={kind}
          reference={reference}
          date={date.slice(0, 10)}
          onClose={() => setOpen(false)}
          onDone={onDone}
        />
      )}
    </>
  );
}

function CorrectDateDialog({
  kind,
  reference,
  date,
  onClose,
  onDone,
}: {
  kind: "rep" | "customer";
  reference: string;
  date: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [next, setNext] = useState(date);
  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc(
        "correct_return_date" as never,
        { p_kind: kind, p_reference: reference, p_date: next, p_reason: null } as never,
      );
      if (error) throw error;
      return data as unknown as { reference: string; return_date: string };
    },
    onSuccess: (r) => {
      toast.success(`${r.reference} now dated ${fmt(r.return_date)}`);
      for (const key of [
        "dist-returns",
        "sales-returns-list",
        "warehouse-transactions",
        "warehouse-party",
        "dist-rep-activity",
        "finished-goods",
      ])
        qc.invalidateQueries({ queryKey: [key] });
      onDone?.();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Correct the date — {reference}</DialogTitle>
          <DialogDescription>
            Now dated {fmt(date)}. The return, its stock moves and its jugs all move to the new day;
            quantities don&apos;t change.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <ReturnDateField value={next} onChange={setNext} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending || next === date} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Correct date
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// What a marketer / the shop already returned on the chosen day, so a second
// entry adds up to it (2026-11-03). Nothing shows when there is none.
export function EarlierReturnsNote({
  holderId,
  date,
  only,
}: {
  holderId: string | null | undefined;
  date: string;
  // Limit to some products (e.g. dispensers on the dispenser form).
  only?: (productId: string) => boolean;
}) {
  const earlier = useDayReturns(holderId, date);
  const lines = [...earlier.byProduct].filter(([id]) => !only || only(id));
  if (lines.length === 0) return null;
  return (
    <div className="rounded-md border border-warning/40 bg-warning/5 p-2 text-xs">
      <div className="font-medium">
        Already entered for {fmt(date)}: {earlier.numbers.join(", ")}
      </div>
      <div className="text-muted-foreground">
        {lines
          .map(([id, q]) => `${earlier.names.get(id)?.name ?? "Product"} ${num(q)}`)
          .join(" · ")}{" "}
        — what you enter now adds to this.
      </div>
    </div>
  );
}
