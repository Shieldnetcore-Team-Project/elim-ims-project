import { useState } from "react";
import { Badge } from "@/components/ui/badge";
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
import { Loader2 } from "lucide-react";
import { num } from "@/lib/format";
import { formatBags, splitBags } from "@/lib/preform-units";
import { STATUS_LABEL, statusVariant } from "./api";

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={statusVariant(status)} className="whitespace-nowrap">
      {STATUS_LABEL[status] ?? status.replace(/_/g, " ")}
    </Badge>
  );
}

// "46,080" with "40 bags" underneath when the material has a bag size.
export function Pieces({
  value,
  perBag,
  className = "",
}: {
  value: number | null | undefined;
  perBag?: number | null;
  className?: string;
}) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const split = splitBags(value, perBag);
  return (
    <span className={className}>
      {num(value)}
      {split && (
        <span className="block text-[11px] font-normal text-muted-foreground">
          {formatBags(split)}
        </span>
      )}
    </span>
  );
}

// Whole-number entry (pieces / bottles). Empty = not entered.
export function CountInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={0}
      step={1}
      className={className}
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(e) => {
        const raw = e.target.value;
        onChange(raw === "" ? null : Math.max(0, Math.floor(Number(raw))));
      }}
    />
  );
}

// Asks for a reason (and optionally a quantity) before running an action.
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  label = "Reason",
  confirmLabel = "Confirm",
  destructive,
  required = true,
  quantity,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: React.ReactNode;
  label?: string;
  confirmLabel?: string;
  destructive?: boolean;
  required?: boolean;
  quantity?: { label: string; initial: number | null; hint?: string };
  pending?: boolean;
  onConfirm: (reason: string, qty: number | null) => void;
}) {
  const [reason, setReason] = useState("");
  const [qty, setQty] = useState<number | null>(quantity?.initial ?? null);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setReason("");
          setQty(quantity?.initial ?? null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-3">
          {quantity && (
            <div className="space-y-1.5">
              <Label>{quantity.label}</Label>
              <CountInput value={qty} onChange={setQty} />
              {quantity.hint && <p className="text-xs text-muted-foreground">{quantity.hint}</p>}
            </div>
          )}
          <div className="space-y-1.5">
            <Label>
              {label}
              {!required && <span className="text-muted-foreground"> (optional)</span>}
            </Label>
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Back
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={pending || (required && !reason.trim()) || (!!quantity && qty == null)}
            onClick={() => onConfirm(reason.trim(), qty)}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString() : "—";
export const fmtDateTime = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString() : "—";
