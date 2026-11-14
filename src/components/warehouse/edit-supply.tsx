import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, PackageMinus } from "lucide-react";
import { db, rpc } from "@/components/preform/api";
import { CountInput } from "@/components/preform/shared";
import { num } from "@/lib/format";
import { saleLineName } from "@/lib/sale-line-name";
import type { Activity } from "@/components/warehouse/activity";
import { Button } from "@/components/ui/button";
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

// Edit a dispenser supply in place (user, 2026-11-13): when a marketer /
// distributor brings dispensers straight back unsold -- e.g. the customer had
// no empties for all of them -- the Warehouse Manager lowers the supply on
// the same posting instead of recording a return (edit_dispenser_supply,
// 20261113120000). Dispenser lines only, and only down; stock, money and jugs
// follow on the server.

// Dispenser Water / Jug + Water -- not the Empty Jug ("Empty Jug", or the old
// "Dispenser Jug"). The server checks it properly.
export const isDispenserLine = (name: string) =>
  /(dispenser|jug)/i.test(name) && !/^\s*empty/i.test(name) && !/jug\s*$/i.test(name);

export function useCanEditSupply() {
  const q = useQuery({
    queryKey: ["can-edit-dispenser-supply"],
    staleTime: 5 * 60_000,
    queryFn: () => rpc<boolean>("can_edit_dispenser_supply", {}),
  });
  return (a: Pick<Activity, "kind" | "status" | "items">) =>
    q.data === true &&
    (a.status === "posted" || a.status === "corrected") &&
    (a.kind === "distributor" || a.kind === "marketer" || a.kind === "retail") &&
    (a.items ?? "").split(", ").some((p) => isDispenserLine(p.split(" × ")[0]));
}

// Whether the signed-in user may edit supplies at all (return windows).
export function useIsSupplyEditor() {
  return (
    useQuery({
      queryKey: ["can-edit-dispenser-supply"],
      staleTime: 5 * 60_000,
      queryFn: () => rpc<boolean>("can_edit_dispenser_supply", {}),
    }).data === true
  );
}

type Line = {
  id: string;
  name: string;
  unit: string;
  quantity: number;
  unit_price: number;
  dispenser: boolean;
  // A distributor's Dispenser Water line can turn part into Jug + Water.
  canSwitch: boolean;
};

export function EditSupplyButton({
  kind,
  reference,
  compact = true,
}: {
  kind: "sale" | "dispatch";
  reference: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {compact ? (
        <Button
          variant="ghost"
          size="icon"
          title="Edit dispenser supply"
          aria-label="Edit dispenser supply"
          onClick={() => setOpen(true)}
        >
          <PackageMinus className="h-4 w-4" />
        </Button>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <PackageMinus className="mr-1 h-3.5 w-3.5" /> Edit supply {reference}
        </Button>
      )}
      {open && (
        <EditSupplyDialog kind={kind} reference={reference} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function EditSupplyDialog({
  kind,
  reference,
  onClose,
}: {
  kind: "sale" | "dispatch";
  reference: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [qty, setQty] = useState<Record<string, number | null>>({});
  const [toJw, setToJw] = useState<Record<string, number | null>>({});
  const [reason, setReason] = useState("");

  const posting = useQuery({
    queryKey: ["edit-supply", kind, reference],
    queryFn: async () => {
      const { data, error } =
        kind === "sale"
          ? await db
              .from("sales")
              .select(
                "id,invoice_number,sale_items(id,product_id,quantity,unit_price,jar_mode,products(name,unit))",
              )
              .eq("invoice_number", reference)
              .is("deleted_at", null)
              .maybeSingle()
          : await db
              .from("stock_dispatches")
              .select(
                "id,dispatch_number,stock_dispatch_items(id,product_id,quantity,unit_price,jar_mode,products(name,unit))",
              )
              .eq("dispatch_number", reference)
              .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error(`${reference} not found`);
      const items = (kind === "sale" ? data.sale_items : data.stock_dispatch_items) as {
        id: string;
        quantity: number;
        unit_price: number;
        jar_mode: string | null;
        products: { name: string; unit: string } | null;
      }[];
      return {
        id: data.id as string,
        lines: (items ?? []).map<Line>((i) => {
          const name = saleLineName(i.products?.name, i.jar_mode);
          return {
            id: i.id,
            name,
            unit: i.products?.unit ?? "",
            quantity: Number(i.quantity),
            unit_price: Number(i.unit_price),
            dispenser: isDispenserLine(i.products?.name ?? ""),
            canSwitch:
              kind === "sale" &&
              isDispenserLine(i.products?.name ?? "") &&
              i.jar_mode !== "permanent",
          };
        }),
      };
    },
  });

  const lines = posting.data?.lines ?? [];
  const newQty = (l: Line) => qty[l.id] ?? l.quantity;
  const jwOf = (l: Line) => (l.canSwitch ? (toJw[l.id] ?? 0) : 0);
  const changed = lines
    .filter((l) => l.dispenser && (newQty(l) !== l.quantity || jwOf(l) > 0))
    .map((l) => ({
      item_id: l.id,
      quantity: newQty(l),
      ...(jwOf(l) > 0 ? { to_jug_water: jwOf(l) } : {}),
    }));
  const up = lines.some((l) => newQty(l) > l.quantity);
  const tooManyJw = lines.some((l) => jwOf(l) > newQty(l));
  const jwTotal = lines.reduce((t, l) => t + jwOf(l), 0);
  const off = lines.reduce(
    (t, l) => t + Math.max(0, l.quantity - (qty[l.id] ?? l.quantity)) * l.unit_price,
    0,
  );

  const save = useMutation({
    mutationFn: () =>
      rpc<{ reference: string; value_off: number }>("edit_dispenser_supply", {
        p_kind: kind,
        p_id: posting.data!.id,
        p_lines: changed,
        p_reason: reason.trim(),
      }),
    onSuccess: () => {
      toast.success(`${reference}: supply edited`);
      void qc.invalidateQueries();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit dispenser supply · {reference}</DialogTitle>
          <DialogDescription>
            Dispensers that came straight back unsold: lower the quantity on this same posting --
            the difference goes back into Warehouse stock, and the invoice / account and jugs go
            down with it.
            {kind === "sale" &&
              " Customers who had no empty jug to swap: put how many of the Dispenser Water become Jug + Water -- they keep the jug and pay the Jug + Water price."}{" "}
            Other products come back as a return.
          </DialogDescription>
        </DialogHeader>
        {posting.isLoading ? (
          <div className="py-4 text-sm text-muted-foreground">Loading…</div>
        ) : posting.isError ? (
          <div className="py-4 text-sm text-destructive">{(posting.error as Error).message}</div>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1 text-sm">
              <div className="grid grid-cols-[1fr_auto_6rem_6rem] gap-2 text-xs text-muted-foreground">
                <span>Product</span>
                <span className="text-right">Supplied</span>
                <span className="text-right">Supplied now</span>
                <span className="text-right">{kind === "sale" ? "of these, Jug + Water" : ""}</span>
              </div>
              {lines.map((l) => (
                <div key={l.id} className="grid grid-cols-[1fr_auto_6rem_6rem] items-center gap-2">
                  <span>
                    {l.name}
                    {!l.dispenser && (
                      <span className="text-[11px] text-muted-foreground"> · return only</span>
                    )}
                  </span>
                  <span className="text-right">
                    {num(l.quantity)} {l.unit}
                  </span>
                  {l.dispenser ? (
                    <CountInput
                      className="text-right"
                      value={qty[l.id] ?? l.quantity}
                      onChange={(v) => setQty((q) => ({ ...q, [l.id]: v }))}
                    />
                  ) : (
                    <span className="text-right text-muted-foreground">—</span>
                  )}
                  {l.canSwitch ? (
                    <CountInput
                      className="text-right"
                      value={toJw[l.id] ?? null}
                      placeholder="0"
                      onChange={(v) => setToJw((q) => ({ ...q, [l.id]: v }))}
                    />
                  ) : (
                    <span />
                  )}
                </div>
              ))}
              {tooManyJw && (
                <div className="text-[11px] text-destructive">
                  Jug + Water can't be more than what is supplied now.
                </div>
              )}
              {jwTotal > 0 && !tooManyJw && (
                <div className="text-xs text-muted-foreground">
                  {num(jwTotal)} become Jug + Water: the invoice goes up by the Jug + Water price
                  difference, and the jugs are recorded as sold.
                </div>
              )}
              {up && <div className="text-[11px] text-destructive">A supply can only go down.</div>}
              {off > 0 && !up && (
                <div className="text-xs text-muted-foreground">
                  About ₦{num(off)} comes off {kind === "sale" ? "the invoice" : "the posting"}.
                </div>
              )}
            </div>
            <div className="grid gap-1">
              <Label>Reason</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. customer had only 421 empty jugs"
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={changed.length === 0 || up || tooManyJw || !reason.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
