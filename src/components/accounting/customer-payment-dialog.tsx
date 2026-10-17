import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { logAudit } from "@/lib/audit";
import { money } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";

const METHODS = ["cash", "transfer", "pos", "card", "cheque"] as const;

// A payment from a distributor (registered customer), entered by Accounting.
// With `sale` it pays that invoice; without, it settles the customer's oldest
// debts first and anything more is kept as their advance (record_payment).
export function CustomerPaymentDialog({
  factoryId,
  customerId,
  customerName,
  owed,
  sale,
  onDone,
}: {
  factoryId: string;
  customerId: string;
  customerName: string;
  owed: number;
  sale?: { id: string; invoice_number: string };
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState(Math.max(owed, 0));
  const [method, setMethod] = useState<(typeof METHODS)[number]>("cash");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [remarks, setRemarks] = useState("");
  // One key per dialog: a double-click replays the first result.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const save = useMutation({
    mutationFn: async () => {
      if (!(amount > 0)) throw new Error("Enter the amount received");
      const { data, error } = await supabase.rpc("record_payment", {
        payload: {
          factory_id: factoryId,
          customer_id: customerId,
          sale_id: sale?.id ?? null,
          amount,
          payment_method: method,
          payment_date: date,
          remarks: remarks.trim() || (sale ? `Payment for ${sale.invoice_number}` : null),
          idempotency_key: idempotencyKey,
        } as never,
      });
      if (error) throw error;
      return data as { payment_id?: string; receipt_number?: string; credit_added?: number };
    },
    onSuccess: (res) => {
      const extra = Number(res?.credit_added ?? 0);
      toast.success(
        `Receipt ${res?.receipt_number ?? ""} recorded${extra > 0 ? ` — ${money(extra)} kept as advance` : ""}`,
      );
      logAudit({
        action: "payment",
        entity: "payments_received",
        entityId: res?.payment_id,
        factoryId,
      });
      for (const key of [
        "acct-postings",
        "acct-distributors",
        "acct-distributor-invoices",
        "acct-distributor-payments",
        "acct-sales",
        "acct-payments",
        "credit-sales",
      ])
        qc.invalidateQueries({ queryKey: [key] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Payment from {customerName}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {sale
            ? `Against invoice ${sale.invoice_number}, which has ${money(owed)} unpaid.`
            : `${customerName} owes ${money(owed)} in total. The payment clears their oldest invoices first; anything more is kept as their advance.`}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Amount</Label>
            <MoneyInput value={amount} onChange={setAmount} />
          </div>
          <div>
            <Label>Method</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHODS.map((m) => (
                  <SelectItem key={m} value={m} className="capitalize">
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label>Date</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <Label>Remarks</Label>
          <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending || !(amount > 0)} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Record payment
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
