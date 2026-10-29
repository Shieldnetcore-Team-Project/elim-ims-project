import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { num } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Line = { key: number; product_id: string; quantity: number; unit_price: number };
type Product = {
  id: string;
  name: string;
  unit: string;
  unit_price: number;
  current_stock: number;
};

type DispatchLine = { key: number; product_id: string; quantity: number };
type Dispatch = {
  id: string;
  dispatch_number: string;
  dispatch_date: string;
  sales_reps: { full_name: string; kind: string } | null;
  stock_dispatch_items: { product_id: string | null; quantity: number }[];
};

function useFinishedProducts(factoryId: string) {
  return useQuery({
    queryKey: ["correct-posting-products", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,unit,unit_price,current_stock")
        .eq("factory_id", factoryId)
        .eq("active", true)
        .eq("product_type", "finished")
        .order("name");
      if (error) throw error;
      return (data ?? []) as Product[];
    },
  });
}

// Correct a posting to a marketer or the Company Retail Shop and repost it
// (correct_stock_dispatch, 20261027200000): the old posting is reversed --
// goods back in the Warehouse, off the marketer's / shop's stock -- and the
// corrected one takes them out again. What they have already sold or returned
// can't be taken off them.
export function CorrectDispatchPostingDialog({
  factoryId,
  dispatchNumber,
  onDone,
}: {
  factoryId: string;
  dispatchNumber: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const dispatch = useQuery({
    queryKey: ["correct-dispatch", factoryId, dispatchNumber],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_dispatches")
        .select(
          "id,dispatch_number,dispatch_date,sales_reps(full_name,kind),stock_dispatch_items(product_id,quantity)",
        )
        .eq("factory_id", factoryId)
        .eq("dispatch_number", dispatchNumber)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error(`${dispatchNumber} not found`);
      return data as unknown as Dispatch;
    },
  });
  const products = useFinishedProducts(factoryId);

  if (dispatch.isLoading || products.isLoading)
    return (
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Correct {dispatchNumber}</DialogTitle>
        </DialogHeader>
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      </DialogContent>
    );
  if (dispatch.isError || !dispatch.data)
    return (
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Correct {dispatchNumber}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-destructive">{(dispatch.error as Error)?.message}</p>
      </DialogContent>
    );
  return (
    <CorrectDispatchForm
      dispatch={dispatch.data}
      products={products.data ?? []}
      onDone={() => {
        for (const key of [
          "warehouse-activity",
          "acct-postings",
          "finished-goods",
          "dist-dispatches",
          "dist-rep-stock",
          "dist-account",
        ])
          qc.invalidateQueries({ queryKey: [key] });
        onDone();
      }}
    />
  );
}

function CorrectDispatchForm({
  dispatch,
  products,
  onDone,
}: {
  dispatch: Dispatch;
  products: Product[];
  onDone: () => void;
}) {
  const original = dispatch.stock_dispatch_items
    .filter((it) => it.product_id)
    .map((it, i) => ({ key: i + 1, product_id: it.product_id!, quantity: Number(it.quantity) }));
  const [lines, setLines] = useState<DispatchLine[]>(original);
  const [nextKey, setNextKey] = useState(original.length + 1);
  const [date, setDate] = useState(dispatch.dispatch_date.slice(0, 10));
  const [reason, setReason] = useState("");
  const holder = dispatch.sales_reps?.kind === "outlet" ? "the Retail Shop" : "the marketer";
  // What a line can take: Warehouse stock plus what this posting already took
  // of it (it comes back before the corrected posting is made).
  const stockOf = (pid: string) =>
    Number(products.find((p) => p.id === pid)?.current_stock ?? 0) +
    original.filter((l) => l.product_id === pid).reduce((s, l) => s + l.quantity, 0);
  const update = (key: number, patch: Partial<DispatchLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const run = useMutation({
    mutationFn: async () => {
      const clean = lines.filter((l) => l.product_id && l.quantity > 0);
      if (clean.length === 0) throw new Error("Add at least one product line");
      const { data, error } = await supabase.rpc(
        "correct_stock_dispatch" as never,
        {
          p_id: dispatch.id,
          payload: {
            dispatch_date: date,
            reason: reason.trim() || undefined,
            items: clean.map((l) => ({ product_id: l.product_id, quantity: l.quantity })),
          },
        } as never,
      );
      if (error) throw error;
      return data as unknown as { dispatch_number?: string };
    },
    onSuccess: (data) => {
      toast.success(
        `${dispatch.dispatch_number} corrected — reposted as ${data?.dispatch_number ?? ""}`,
      );
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Correct {dispatch.dispatch_number}</DialogTitle>
        <DialogDescription>
          {dispatch.sales_reps?.full_name ?? "Posting"} — change the products or quantities, then
          repost. The old posting&apos;s goods come back into the Warehouse and off {holder}
          &apos;s stock; what they have already sold or returned can&apos;t be taken off them.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <div className="max-w-xs">
          <Label className="text-xs">Date</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {lines.map((l) => {
          const over = !!l.product_id && l.quantity > stockOf(l.product_id);
          return (
            <div key={l.key} className="grid grid-cols-[1fr_7rem_auto] items-end gap-2">
              <div>
                <Label className="text-xs">Product</Label>
                <Select
                  value={l.product_id}
                  onValueChange={(v) => update(l.key, { product_id: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose" />
                  </SelectTrigger>
                  <SelectContent>
                    {products.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({num(stockOf(p.id))} {p.unit})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Qty</Label>
                <MoneyInput
                  min={0}
                  value={l.quantity}
                  onChange={(v) => update(l.key, { quantity: v })}
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                title="Remove"
                onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
              {over && (
                <p className="col-span-3 text-xs text-destructive">
                  Only {num(stockOf(l.product_id))} available.
                </p>
              )}
            </div>
          );
        })}
        <div>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => {
              setLines((ls) => [...ls, { key: nextKey, product_id: "", quantity: 0 }]);
              setNextKey((k) => k + 1);
            }}
          >
            <Plus className="h-4 w-4" /> Add product
          </Button>
        </div>
        <div>
          <Label className="text-xs">What was wrong (optional)</Label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. typed 100 instead of 60"
          />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Repost corrected
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// Correct a posting to a distributor and repost it (correct_warehouse_posting,
// 20261029170000): the old one is reversed -- goods back in stock, anything
// paid on it kept as the distributor's credit -- and the corrected one is
// posted at once with that credit applied. Like Correct on a marketer
// posting.
export function CorrectDistributorPostingDialog({
  factoryId,
  invoiceNumber,
  onDone,
}: {
  factoryId: string;
  invoiceNumber: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const sale = useQuery({
    queryKey: ["correct-posting", factoryId, invoiceNumber],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select(
          "id,invoice_number,customer_name,discount,sale_items(product_id,quantity,unit_price)",
        )
        .eq("factory_id", factoryId)
        .eq("invoice_number", invoiceNumber)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error(`${invoiceNumber} not found`);
      return data as unknown as {
        id: string;
        invoice_number: string;
        customer_name: string | null;
        discount: number;
        sale_items: { product_id: string; quantity: number; unit_price: number }[];
      };
    },
  });
  const products = useFinishedProducts(factoryId);

  if (sale.isLoading || products.isLoading)
    return (
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Correct {invoiceNumber}</DialogTitle>
        </DialogHeader>
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      </DialogContent>
    );
  if (sale.isError || !sale.data)
    return (
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Correct {invoiceNumber}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-destructive">{(sale.error as Error)?.message}</p>
      </DialogContent>
    );
  return (
    <CorrectForm
      sale={sale.data}
      products={products.data ?? []}
      onDone={() => {
        for (const key of ["warehouse-activity", "acct-postings", "finished-goods", "sales-list"])
          qc.invalidateQueries({ queryKey: [key] });
        onDone();
      }}
    />
  );
}

function CorrectForm({
  sale,
  products,
  onDone,
}: {
  sale: {
    id: string;
    invoice_number: string;
    customer_name: string | null;
    discount: number;
    sale_items: { product_id: string; quantity: number; unit_price: number }[];
  };
  products: Product[];
  onDone: () => void;
}) {
  const original = sale.sale_items.map((it, i) => ({
    key: i + 1,
    product_id: it.product_id,
    quantity: Number(it.quantity),
    unit_price: Number(it.unit_price),
  }));
  const [lines, setLines] = useState<Line[]>(original);
  const [nextKey, setNextKey] = useState(original.length + 1);
  const [discount, setDiscount] = useState(Number(sale.discount ?? 0));
  const [reason, setReason] = useState("");
  // What a line can take: Warehouse stock plus what this posting already took
  // of it (it goes back before the corrected posting is made).
  const stockOf = (pid: string) =>
    Number(products.find((p) => p.id === pid)?.current_stock ?? 0) +
    original.filter((l) => l.product_id === pid).reduce((s, l) => s + l.quantity, 0);
  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);

  const run = useMutation({
    mutationFn: async () => {
      const clean = lines.filter((l) => l.product_id && l.quantity > 0);
      if (clean.length === 0) throw new Error("Add at least one product line");
      const { data, error } = await supabase.rpc(
        "correct_warehouse_posting" as never,
        {
          p_id: sale.id,
          payload: {
            reason: reason.trim() || undefined,
            discount,
            items: clean.map((l) => ({
              product_id: l.product_id,
              quantity: l.quantity,
              unit_price: l.unit_price,
            })),
          },
        } as never,
      );
      if (error) throw error;
      return data as unknown as { invoice_number?: string };
    },
    onSuccess: (data) => {
      toast.success(`${sale.invoice_number} corrected — reposted as ${data?.invoice_number ?? ""}`);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Correct {sale.invoice_number}</DialogTitle>
        <DialogDescription>
          {sale.customer_name ?? "Distributor"} — change the products, quantities or prices, then
          repost. The old posting&apos;s goods go back into stock and anything already paid on it is
          applied to the corrected one.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        {lines.map((l) => {
          const over = !!l.product_id && l.quantity > stockOf(l.product_id);
          return (
            <div key={l.key} className="grid grid-cols-[1fr_6rem_7rem_auto] items-end gap-2">
              <div>
                <Label className="text-xs">Product</Label>
                <Select
                  value={l.product_id}
                  onValueChange={(v) =>
                    update(l.key, {
                      product_id: v,
                      unit_price: Number(products.find((p) => p.id === v)?.unit_price ?? 0),
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose" />
                  </SelectTrigger>
                  <SelectContent>
                    {products.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({num(stockOf(p.id))} {p.unit})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Qty</Label>
                <MoneyInput
                  min={0}
                  value={l.quantity}
                  onChange={(v) => update(l.key, { quantity: v })}
                />
              </div>
              <div>
                <Label className="text-xs">Price</Label>
                <MoneyInput
                  min={0}
                  value={l.unit_price}
                  onChange={(v) => update(l.key, { unit_price: v })}
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                title="Remove"
                onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
              {over && (
                <p className="col-span-4 text-xs text-destructive">
                  Only {num(stockOf(l.product_id))} available.
                </p>
              )}
            </div>
          );
        })}
        <div>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => {
              setLines((ls) => [
                ...ls,
                { key: nextKey, product_id: "", quantity: 0, unit_price: 0 },
              ]);
              setNextKey((k) => k + 1);
            }}
          >
            <Plus className="h-4 w-4" /> Add product
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Discount</Label>
            <MoneyInput min={0} value={discount} onChange={setDiscount} />
          </div>
          <div className="self-end text-right text-sm">
            Amount to pay{" "}
            <span className="font-semibold">{num(Math.max(subtotal - discount, 0))}</span>
          </div>
        </div>
        <div>
          <Label className="text-xs">What was wrong (optional)</Label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. typed 30 instead of 20"
          />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Repost corrected
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
