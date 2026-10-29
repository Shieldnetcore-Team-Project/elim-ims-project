import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { money } from "@/lib/format";
import { fetchSaleLines, type SaleLine } from "@/lib/invoice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2 } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- adjust_sale_lines is newer than the generated types
const db = supabase as any;

// Discount and surcharge per pack, for each product on one posted invoice,
// all in one save (adjust_sale_lines): final at once, logged in the audit
// trail, no reason needed. Amounts are entered per pack (per unit of the
// product) and applied to every pack on the line. Opened from the
// Accountant's customer view and from the payment form (Postings → Pay). A
// discount can't take a pack's price below 0 or the invoice below what's
// already paid.
export function SaleAdjustDialog({
  sale,
  currency,
  onDone,
}: {
  sale: { id: string; invoice_number: string };
  currency: string;
  // The invoice's new balance, so a payment form can follow it.
  onDone: (balance: number | null) => void;
}) {
  const qc = useQueryClient();
  const [edits, setEdits] = useState<Record<string, { discount: number; surcharge: number }>>({});
  const [note, setNote] = useState("");
  const lines = useQuery({
    queryKey: ["sale-adjust-lines", sale.id],
    queryFn: async () => {
      const map = await fetchSaleLines([sale.id]);
      if (!map) throw new Error("Could not load the invoice lines");
      return map.get(sale.id) ?? [];
    },
  });

  const totals = useQuery({
    queryKey: ["sale-adjust-totals", sale.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("grand_total,balance")
        .eq("id", sale.id)
        .single();
      if (error) throw error;
      return data;
    },
  });

  const rows = (lines.data ?? []).filter((l) => l.item_id);
  const get = (id: string) => edits[id] ?? { discount: 0, surcharge: 0 };
  const set = (id: string, k: "discount" | "surcharge", v: number) =>
    setEdits((e) => ({ ...e, [id]: { ...get(id), [k]: v } }));
  // Entered per pack; a line moves by quantity x that (as adjust_sale_lines).
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const lineDisc = (l: SaleLine) => round2(l.quantity * get(l.item_id!).discount);
  const lineSurch = (l: SaleLine) => round2(l.quantity * get(l.item_id!).surcharge);
  const packPrice = (l: SaleLine) =>
    l.unit_price -
    (l.unit_discount ?? 0) -
    get(l.item_id!).discount +
    (l.unit_surcharge ?? 0) +
    get(l.item_id!).surcharge;
  const disc = rows.reduce((t, l) => t + lineDisc(l), 0);
  const surch = rows.reduce((t, l) => t + lineSurch(l), 0);
  const net = surch - disc;
  const total = Number(totals.data?.grand_total ?? 0);
  const owed = Number(totals.data?.balance ?? 0);
  const lineBelowZero = rows.some((l) => packPrice(l) < 0);
  const tooMuch = owed + net < 0;
  const nothing = disc === 0 && surch === 0;

  const save = useMutation({
    mutationFn: async () => {
      const payload = rows
        .map((l) => ({ item_id: l.item_id, ...get(l.item_id!) }))
        .filter((l) => l.discount > 0 || l.surcharge > 0);
      const { data, error } = await db.rpc("adjust_sale_lines", {
        p_sale: sale.id,
        p_lines: payload,
        p_note: note.trim() || null,
      });
      if (error) throw error;
      return data as { balance: number };
    },
    onSuccess: (res) => {
      toast.success(
        `${sale.invoice_number} updated — ${[
          disc > 0 && `${money(disc, currency)} discount`,
          surch > 0 && `${money(surch, currency)} surcharge`,
        ]
          .filter(Boolean)
          .join(", ")}; balance now ${money(Number(res?.balance ?? owed + net), currency)}`,
      );
      for (const key of [
        "acct-sales",
        "acct-customer-sales",
        "acct-postings",
        "acct-distributors",
        "acct-distributor-invoices",
        "party-sheets",
        "monthly-sales",
        "credit-sales",
        "sale-adjust-lines",
        "sale-adjust-totals",
      ])
        qc.invalidateQueries({ queryKey: [key] });
      onDone(res?.balance != null ? Number(res.balance) : null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Discount / surcharge on {sale.invoice_number}</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        Enter the discount (amount off) or surcharge (extra cost) <b>per pack</b> for each product;
        it is applied to every pack on the line. Leave a box at 0 to keep that product as it is.
      </p>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Qty × price</TableHead>
              <TableHead className="w-32">Discount per pack</TableHead>
              <TableHead className="w-32">Surcharge per pack</TableHead>
              <TableHead className="text-right">New price per pack</TableHead>
              <TableHead className="text-right">New amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((l) => {
              const e = get(l.item_id!);
              const after = l.line_total - lineDisc(l) + lineSurch(l);
              const unit = l.unit || "unit";
              return (
                <TableRow key={l.item_id}>
                  <TableCell>
                    {l.name}
                    {((l.unit_discount ?? 0) > 0 || (l.unit_surcharge ?? 0) > 0) && (
                      <div className="text-xs text-muted-foreground">
                        Already:{" "}
                        {[
                          (l.unit_discount ?? 0) > 0 &&
                            `−${money(l.unit_discount ?? 0, currency)}/${unit}`,
                          (l.unit_surcharge ?? 0) > 0 &&
                            `+${money(l.unit_surcharge ?? 0, currency)}/${unit}`,
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs">
                    {l.quantity.toLocaleString()} {l.unit} × {money(l.unit_price, currency)}
                    <div className="text-muted-foreground">{money(l.line_total, currency)}</div>
                  </TableCell>
                  <TableCell>
                    <MoneyInput
                      value={e.discount}
                      onChange={(v) => set(l.item_id!, "discount", v)}
                    />
                  </TableCell>
                  <TableCell>
                    <MoneyInput
                      value={e.surcharge}
                      onChange={(v) => set(l.item_id!, "surcharge", v)}
                    />
                  </TableCell>
                  <TableCell
                    className={`whitespace-nowrap text-right ${packPrice(l) < 0 ? "text-destructive" : ""}`}
                  >
                    {money(packPrice(l), currency)}
                  </TableCell>
                  <TableCell
                    className={`text-right font-medium ${after < 0 ? "text-destructive" : ""}`}
                  >
                    {money(after, currency)}
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                  {lines.isLoading
                    ? "Loading…"
                    : lines.error
                      ? (lines.error as Error).message
                      : "No product lines."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>Note (optional)</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div
          className={`grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg border p-3 text-sm ${tooMuch || lineBelowZero ? "border-destructive" : ""}`}
        >
          <span className="text-muted-foreground">Invoice total</span>
          <span className="text-right">{money(total, currency)}</span>
          {disc > 0 && (
            <>
              <span className="text-muted-foreground">Discount</span>
              <span className="text-right">−{money(disc, currency)}</span>
            </>
          )}
          {surch > 0 && (
            <>
              <span className="text-muted-foreground">Surcharge</span>
              <span className="text-right">+{money(surch, currency)}</span>
            </>
          )}
          <span className="text-muted-foreground">New total</span>
          <span className="text-right font-medium">{money(total + net, currency)}</span>
          <span className="text-muted-foreground">New balance</span>
          <span className="text-right font-medium">
            {tooMuch ? "More than owed" : money(owed + net, currency)}
          </span>
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={save.isPending || !totals.data || nothing || tooMuch || lineBelowZero}
          onClick={() => save.mutate()}
        >
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
