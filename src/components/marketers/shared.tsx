import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { money } from "@/lib/format";
import {
  MARKETER_KEYS,
  PERIODS,
  marketerRpc,
  periodRange,
  type PeriodKey,
} from "@/lib/marketer-accounts";

// ------------------------------------------------------------- period pick ---

export type PeriodState = { key: PeriodKey; from: string; to: string };

export function usePeriod(initial: PeriodKey = "this_month") {
  const [state, setState] = useState<PeriodState>({ key: initial, from: "", to: "" });
  const range = periodRange(state.key, { from: state.from, to: state.to });
  return { state, setState, range };
}

export function PeriodPicker({
  value,
  onChange,
  allowAll = true,
}: {
  value: PeriodState;
  onChange: (v: PeriodState) => void;
  allowAll?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-44">
        <Label className="text-xs">Period</Label>
        <Select
          value={value.key}
          onValueChange={(k) => {
            const key = k as PeriodKey;
            // Starting a custom range from whatever was showing.
            if (key === "custom") {
              const r = periodRange(value.key);
              onChange({ key, from: r.from ?? "", to: r.to ?? "" });
            } else onChange({ ...value, key });
          }}
        >
          <SelectTrigger className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.filter((p) => allowAll || p.key !== "all").map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {value.key === "custom" && (
        <>
          <div>
            <Label className="text-xs">From</Label>
            <Input
              type="date"
              className="h-9"
              value={value.from}
              onChange={(e) => onChange({ ...value, from: e.target.value })}
            />
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <Input
              type="date"
              className="h-9"
              value={value.to}
              onChange={(e) => onChange({ ...value, to: e.target.value })}
            />
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- tiles ---

export type Tone = "debt" | "pending" | "ok" | "muted" | undefined;

const TONES: Record<NonNullable<Tone>, string> = {
  debt: "text-destructive",
  pending: "text-amber-600",
  ok: "text-emerald-600",
  muted: "text-muted-foreground",
};

export function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="pt-5">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`mt-1 text-lg font-semibold ${tone ? TONES[tone] : ""}`}>{value}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function Loading() {
  return (
    <div className="flex justify-center py-10">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

export function LoadError({ error }: { error: unknown }) {
  return (
    <p className="py-6 text-center text-sm text-destructive">
      {(error as Error)?.message ?? "Couldn't load this."}
    </p>
  );
}

export const invalidateMarketerData = (qc: ReturnType<typeof useQueryClient>) => {
  for (const key of [
    ...MARKETER_KEYS,
    "dist-account",
    "dist-rep-customers",
    "dist-rep-customer-accounts",
    "dist-remittances",
    "dist-rep-activity",
    "customer-account",
    "credit-sales",
  ])
    qc.invalidateQueries({ queryKey: [key] });
};

// ---------------------------------------------------------- add customer ---

export function AddCustomerDialog({
  repId,
  repName,
  onDone,
}: {
  repId: string;
  repName: string;
  onDone: (customerId: string) => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    phone: "",
    address: "",
    email: "",
    status: "active",
    notes: "",
  });
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const save = useMutation({
    mutationFn: () => marketerRpc.registerCustomer({ ...form, sales_rep_id: repId }),
    onSuccess: (res) => {
      toast.success(
        res.adopted_walk_in
          ? `Registered under ${repName} — their earlier walk-in purchases are now on this account`
          : `Customer registered under ${repName}`,
      );
      invalidateMarketerData(qc);
      qc.invalidateQueries({ queryKey: ["customers"] });
      onDone(res.customer_id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Add new customer</DialogTitle>
        <DialogDescription>
          The customer is registered under <strong>{repName}</strong>.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Full name or business name *</Label>
          <Input value={form.name} onChange={(e) => set("name")(e.target.value)} autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Phone</Label>
            <Input
              value={form.phone}
              inputMode="tel"
              onChange={(e) => set("phone")(e.target.value)}
              placeholder="0803…"
            />
          </div>
          <div>
            <Label>Status</Label>
            <Select value={form.status} onValueChange={set("status")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="dormant">Dormant</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label>Address / market location</Label>
          <Input value={form.address} onChange={(e) => set("address")(e.target.value)} />
        </div>
        <div>
          <Label>Email / other contact</Label>
          <Input value={form.email} onChange={(e) => set("email")(e.target.value)} />
        </div>
        <div>
          <Label>Notes</Label>
          <Textarea rows={2} value={form.notes} onChange={(e) => set("notes")(e.target.value)} />
        </div>
        <p className="text-xs text-muted-foreground">
          A phone number already used by another registered customer is refused, so the same
          customer isn&apos;t entered twice.
        </p>
      </div>
      <DialogFooter>
        <Button
          disabled={save.isPending || form.name.trim().length < 2}
          onClick={() => save.mutate()}
        >
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Register customer
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// ------------------------------------------------- payment against invoice ---

const METHODS = ["cash", "transfer", "pos", "card", "cheque"] as const;

// A customer payment, aimed at one invoice (or the customer's oldest debts
// when no invoice is given). Anything beyond that invoice goes to their next
// oldest debts, then to their advance — record_payment keeps the allocation
// history, so every naira can be traced to the invoice it reduced.
export function InvoicePaymentDialog({
  factoryId,
  customerId,
  customerName,
  saleId,
  invoiceNumber,
  owed,
  repId,
  repName,
  onDone,
}: {
  factoryId: string;
  customerId: string;
  customerName: string;
  saleId?: string;
  invoiceNumber?: string;
  owed: number;
  repId?: string | null;
  repName?: string | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState(owed > 0 ? String(owed) : "");
  const [method, setMethod] = useState<(typeof METHODS)[number]>("cash");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [byRep, setByRep] = useState(!!repId);
  const [key] = useState(() => crypto.randomUUID());
  const value = Number(amount);

  const save = useMutation({
    mutationFn: async () => {
      if (!(value > 0)) throw new Error("Enter the amount received");
      if (method !== "cash" && !reference.trim())
        throw new Error("Enter the transfer / POS / cheque reference");
      const { data, error } = await supabase.rpc("record_payment", {
        payload: {
          factory_id: factoryId,
          customer_id: customerId,
          sale_id: saleId ?? null,
          amount: value,
          payment_method: method,
          payment_date: date,
          remarks: [
            invoiceNumber ? `Payment on ${invoiceNumber}` : "Payment on account",
            reference.trim() ? `Ref ${reference.trim()}` : null,
            byRep && repName ? `collected by ${repName}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
          collected_by_rep: byRep && repId ? repId : null,
          idempotency_key: key,
        },
      });
      if (error) throw error;
      return data as { receipt_number?: string; credit_added?: number };
    },
    onSuccess: (res) => {
      const extra = Number(res?.credit_added ?? 0);
      toast.success(
        `Receipt ${res?.receipt_number ?? ""} recorded${extra > 0 ? ` — ${money(extra)} kept as advance` : ""}`,
      );
      invalidateMarketerData(qc);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          Payment from {customerName}
          {invoiceNumber ? ` — ${invoiceNumber}` : ""}
        </DialogTitle>
        <DialogDescription>
          {invoiceNumber
            ? `${invoiceNumber} has ${money(owed)} outstanding. The payment goes to this invoice first; any extra clears the customer's oldest debts, then becomes their advance.`
            : `${customerName} owes ${money(owed)}. The payment clears the oldest invoices first; any extra becomes their advance.`}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Amount</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
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
          <div>
            <Label>Payment date</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <Label>Reference {method !== "cash" && "*"}</Label>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Bank / POS ref"
            />
          </div>
        </div>
        {repId && repName && (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={byRep}
              onCheckedChange={(v) => setByRep(v === true)}
              className="mt-0.5"
            />
            <span>
              Brought in by {repName}
              <span className="block text-xs text-muted-foreground">
                The money is being handed to the factory now, so it is not also recorded as a
                remittance.
              </span>
            </span>
          </label>
        )}
      </div>
      <DialogFooter>
        <Button disabled={save.isPending || !(value > 0)} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Record payment
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
