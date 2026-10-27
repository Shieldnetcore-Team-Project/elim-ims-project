import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { localDay } from "@/lib/production-shift";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
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
import { Badge } from "@/components/ui/badge";
import { Plus, Eye, Ban, Undo2, Loader2, Trash2 } from "lucide-react";
import { num } from "@/lib/format";
import { toast } from "sonner";
import { logAudit } from "@/lib/audit";
import { QuickAddProductDialog, ADD_NEW_ITEM } from "@/components/shared/quick-add-item";
import { ReturnsTab, type Rep } from "@/routes/_app.distribution";
import {
  startOfDay,
  endOfDay,
  subDays,
  startOfWeek,
  startOfMonth,
  startOfYear,
  format,
} from "date-fns";

export const Route = createFileRoute("/_app/sales-returns")({
  head: () => ({
    meta: [{ title: "Sales Returns — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <>
      <SectionTabs section="Retail" />
      <RequireAccess module="sales-returns">
        <SalesReturnsPage />
      </RequireAccess>
    </>
  ),
});

type Product = { id: string; name: string; unit: string };
type Sale = { id: string; invoice_number: string; customer_name: string | null };
type ReturnRow = {
  id: string;
  return_number: string;
  sale_id: string | null;
  customer_id: string | null;
  product_id: string;
  quantity_returned: number;
  unit: string | null;
  reason: string | null;
  status: string;
  accepted_quantity: number | null;
  damaged_quantity: number;
  rejected_quantity: number;
  received_by: string;
  received_at: string;
  return_date: string | null;
  inspected_by: string | null;
  inspected_at: string | null;
  notes: string | null;
  products: { name: string; unit: string } | null;
  customers: { name: string } | null;
  sales: { invoice_number: string } | null;
};

const statusBadge = (s: string): "default" | "secondary" | "outline" | "destructive" => {
  if (s === "completed") return "secondary";
  if (s === "cancelled") return "destructive";
  return "outline";
};

type StockRow = {
  product_id: string;
  product_name: string;
  unit: string;
  opening_stock: number;
  new_production: number;
  quantity_sold: number;
  pr: number;
  damages: number;
  closing_stock: number;
};

type RangeKey = "today" | "yesterday" | "weekly" | "monthly" | "yearly" | "custom";
const RANGES: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "weekly", label: "This Week" },
  { key: "monthly", label: "This Month" },
  { key: "yearly", label: "This Year" },
  { key: "custom", label: "Custom Date" },
];

function rangeBounds(key: RangeKey, from: string, to: string): { start: string; end: string } {
  const now = new Date();
  if (key === "yesterday") {
    const y = subDays(now, 1);
    return { start: startOfDay(y).toISOString(), end: endOfDay(y).toISOString() };
  }
  if (key === "weekly")
    return { start: startOfWeek(now).toISOString(), end: endOfDay(now).toISOString() };
  if (key === "monthly")
    return { start: startOfMonth(now).toISOString(), end: endOfDay(now).toISOString() };
  if (key === "yearly")
    return { start: startOfYear(now).toISOString(), end: endOfDay(now).toISOString() };
  if (key === "custom")
    return {
      start: from ? new Date(from).toISOString() : startOfDay(now).toISOString(),
      end: to ? new Date(to + "T23:59:59").toISOString() : endOfDay(now).toISOString(),
    };
  return { start: startOfDay(now).toISOString(), end: endOfDay(now).toISOString() };
}

function SalesReturnsPage() {
  const { data: factoryId } = useFactoryId();
  const perms = usePermissions();
  const { canSubmit, canConfirm, canCancel } = perms;
  // A marketer's return is a rep return (distribution:submit); any other
  // return is a sales return (sales-returns:submit).
  const canLogMarketerReturn = canSubmit("distribution");
  const submitPerm = canSubmit("sales-returns") || canLogMarketerReturn;
  const inspectPerm = canConfirm("sales-returns");
  const cancelPerm = canCancel("sales-returns");
  const qc = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [inspectTarget, setInspectTarget] = useState<ReturnRow | null>(null);
  const [detailTarget, setDetailTarget] = useState<ReturnRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<ReturnRow | null>(null);
  const [stockRange, setStockRange] = useState<RangeKey>("today");
  const [stockFrom, setStockFrom] = useState(format(new Date(), "yyyy-MM-dd"));
  const [stockTo, setStockTo] = useState(format(new Date(), "yyyy-MM-dd"));
  const stockBounds = useMemo(
    () => rangeBounds(stockRange, stockFrom, stockTo),
    [stockRange, stockFrom, stockTo],
  );

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const products = useQuery({
    queryKey: ["products-for-returns", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,unit")
        .eq("factory_id", factoryId!)
        .eq("active", true)
        .eq("product_type", "finished")
        .order("name");
      if (error) throw error;
      return (data ?? []) as Product[];
    },
  });

  // Marketers (and the retail outlet) for the Log Return form's Marketer box
  // and the Marketer returns list. Same query keys and shapes as the
  // Distribution page, so the caches are shared.
  const reps = useQuery({
    queryKey: ["dist-reps", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_reps")
        .select("id,code,full_name,phone,status,employee_id,remarks,kind")
        .eq("factory_id", factoryId!)
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as Rep[];
    },
  });
  const distProducts = useQuery({
    queryKey: ["dist-products", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,unit,unit_price,current_stock")
        .eq("factory_id", factoryId!)
        .eq("active", true)
        .eq("product_type", "finished")
        .order("name");
      if (error) throw error;
      return (data ?? []) as {
        id: string;
        name: string;
        unit: string;
        unit_price: number;
        current_stock: number;
      }[];
    },
  });
  const marketers = (reps.data ?? []).filter((r) => r.kind === "rep" && r.status === "active");

  const sales = useQuery({
    queryKey: ["sales-for-returns", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("id,invoice_number,customer_name")
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as Sale[];
    },
  });

  const list = useQuery({
    queryKey: ["sales-returns-list", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_returns")
        .select(
          "id,return_number,sale_id,customer_id,product_id,quantity_returned,unit,reason,status,accepted_quantity,damaged_quantity,rejected_quantity,received_by,received_at,return_date,inspected_by,inspected_at,notes,products(name,unit),customers(name),sales(invoice_number)",
        )
        .eq("factory_id", factoryId!)
        .order("received_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as unknown as ReturnRow[];
    },
  });

  const stockSummary = useQuery({
    queryKey: ["stock-movement-summary", factoryId, stockBounds.start, stockBounds.end],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_stock_movement_summary", {
        p_factory_id: factoryId!,
        p_start: stockBounds.start,
        p_end: stockBounds.end,
      });
      if (error) throw error;
      return (data ?? []) as StockRow[];
    },
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["sales-returns-list"] });
    qc.invalidateQueries({ queryKey: ["finished-goods"] });
    qc.invalidateQueries({ queryKey: ["products-for-returns"] });
    qc.invalidateQueries({ queryKey: ["stock-movement-summary"] });
    for (const key of [
      "dist-returns",
      "dist-rep-stock",
      "dist-products",
      "dist-account",
      "inventory-overview-products",
    ])
      qc.invalidateQueries({ queryKey: [key] });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sales Returns</h1>
          <p className="text-sm text-muted-foreground">
            Returned goods must be inspected before any of it goes back into sellable stock — only
            the accepted portion posts, and only after someone other than the receiver inspects it.
          </p>
        </div>
        {submitPerm && (
          <Button className="gap-2" onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4" /> Log Return
          </Button>
        )}
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>Stock Movement Summary</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={stockRange} onValueChange={(v) => setStockRange(v as RangeKey)}>
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGES.map((r) => (
                  <SelectItem key={r.key} value={r.key}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {stockRange === "custom" && (
              <>
                <Input
                  type="date"
                  className="w-[150px]"
                  value={stockFrom}
                  onChange={(e) => setStockFrom(e.target.value)}
                />
                <Input
                  type="date"
                  className="w-[150px]"
                  value={stockTo}
                  onChange={(e) => setStockTo(e.target.value)}
                />
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Opening Stock</TableHead>
                <TableHead className="text-right">New Production</TableHead>
                <TableHead className="text-right">Quantity Sold</TableHead>
                <TableHead className="text-right">PR</TableHead>
                <TableHead className="text-right">Damages</TableHead>
                <TableHead className="text-right">Closing Stock</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(stockSummary.data ?? []).map((r) => (
                <TableRow key={r.product_id}>
                  <TableCell className="font-medium">{r.product_name}</TableCell>
                  <TableCell className="text-right">
                    {num(r.opening_stock)} {r.unit}
                  </TableCell>
                  <TableCell className="text-right">
                    {num(r.new_production)} {r.unit}
                  </TableCell>
                  <TableCell className="text-right">
                    {num(r.quantity_sold)} {r.unit}
                  </TableCell>
                  <TableCell className="text-right">
                    {num(r.pr)} {r.unit}
                  </TableCell>
                  <TableCell className="text-right">
                    {num(r.damages)} {r.unit}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {num(r.closing_stock)} {r.unit}
                  </TableCell>
                </TableRow>
              ))}
              {(stockSummary.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    No active products for this factory.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {factoryId && perms.canView("distribution") && (
        <ReturnsTab
          factoryId={factoryId}
          reps={reps.data ?? []}
          products={distProducts.data ?? []}
          perms={perms}
          currentUserId={currentUser.data ?? null}
          title="Marketer returns"
          hideLog
        />
      )}

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Returns</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Return #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead className="text-right">Returned</TableHead>
                <TableHead className="text-right">Accepted</TableHead>
                <TableHead className="text-right">Damaged</TableHead>
                <TableHead className="text-right">Rejected</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.return_number}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(row.return_date ?? row.received_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="font-medium">{row.products?.name ?? "—"}</TableCell>
                  <TableCell>{row.customers?.name ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.sales?.invoice_number ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {num(Number(row.quantity_returned))} {row.unit}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.accepted_quantity != null ? num(Number(row.accepted_quantity)) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.damaged_quantity > 0 ? num(Number(row.damaged_quantity)) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.rejected_quantity > 0 ? num(Number(row.rejected_quantity)) : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusBadge(row.status)} className="capitalize">
                      {row.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {row.status === "received" &&
                        inspectPerm &&
                        row.received_by !== currentUser.data && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Inspect"
                            onClick={() => setInspectTarget(row)}
                          >
                            <Undo2 className="h-4 w-4 text-warning" />
                          </Button>
                        )}
                      {row.status === "received" && cancelPerm && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Cancel"
                          onClick={() => setCancelTarget(row)}
                        >
                          <Ban className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        title="View"
                        onClick={() => setDetailTarget(row)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(list.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                    No sales returns logged yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        {formOpen && factoryId && (
          <CreateReturnDialog
            factoryId={factoryId}
            products={products.data ?? []}
            marketers={marketers}
            canLogMarketerReturn={canLogMarketerReturn}
            canLogSalesReturn={canSubmit("sales-returns")}
            sales={sales.data ?? []}
            onDone={() => {
              setFormOpen(false);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!inspectTarget} onOpenChange={(v) => !v && setInspectTarget(null)}>
        {inspectTarget && (
          <InspectDialog
            row={inspectTarget}
            onDone={() => {
              setInspectTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!cancelTarget} onOpenChange={(v) => !v && setCancelTarget(null)}>
        {cancelTarget && (
          <CancelDialog
            row={cancelTarget}
            onDone={() => {
              setCancelTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!detailTarget} onOpenChange={(v) => !v && setDetailTarget(null)}>
        {detailTarget && <DetailDialog row={detailTarget} />}
      </Dialog>
    </div>
  );
}

type ReturnLine = { product_id: string; quantity: number };
const emptyLine = (): ReturnLine => ({ product_id: "", quantity: 0 });

function CreateReturnDialog({
  factoryId,
  products,
  marketers,
  canLogMarketerReturn,
  canLogSalesReturn,
  sales,
  onDone,
}: {
  factoryId: string;
  products: Product[];
  marketers: Rep[];
  canLogMarketerReturn: boolean;
  canLogSalesReturn: boolean;
  sales: Sale[];
  onDone: () => void;
}) {
  const [saleId, setSaleId] = useState("none");
  // The marketer whose returns the Warehouse is collecting. Picked: the
  // goods come off that marketer's van stock (create_rep_return). None: an
  // ordinary sales return, optionally against an invoice.
  const [repId, setRepId] = useState(canLogSalesReturn ? "none" : "");
  const isMarketerReturn = repId !== "none" && repId !== "";
  const repStock = useQuery({
    queryKey: ["dist-rep-stock", repId],
    enabled: isMarketerReturn,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rep_stock")
        .select("product_id,quantity")
        .eq("sales_rep_id", repId);
      if (error) throw error;
      return (data ?? []) as { product_id: string; quantity: number }[];
    },
  });
  const heldBy = (pid: string) =>
    Number(repStock.data?.find((r) => r.product_id === pid)?.quantity ?? 0);
  // One line per returned product, so a customer bringing back several
  // different items in one visit can be logged in a single go instead of
  // reopening this dialog once per product.
  const [lines, setLines] = useState<ReturnLine[]>([emptyLine()]);
  // Which line's "+ Add new product…" is open, if any — QuickAddProductDialog
  // is shared across lines but only one can be adding at a time.
  const [addingProductIndex, setAddingProductIndex] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  // The day the goods came back. Defaults to today; set it back (e.g. to
  // yesterday) when products returned at close are logged the next morning,
  // so the return sits on the same day as the supply.
  const today = localDay();
  const [returnDate, setReturnDate] = useState(today);

  const updateLine = (i: number, patch: Partial<ReturnLine>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((prev) => [...prev, emptyLine()]);
  const removeLine = (i: number) => setLines((prev) => prev.filter((_, idx) => idx !== i));

  const validLines = lines.filter((l) => l.product_id && l.quantity > 0);
  const linesReady = lines.length > 0 && validLines.length === lines.length;

  const submit = useMutation({
    mutationFn: async () => {
      if (validLines.length === 0) throw new Error("Add at least one returned product");
      if (!linesReady) throw new Error("Every product line needs a product and a quantity > 0");
      if (!canLogSalesReturn && !isMarketerReturn) throw new Error("Select the marketer");
      if (!returnDate) throw new Error("Pick the date the products came back");
      if (returnDate > today) throw new Error("A return can't be dated in the future");
      if (isMarketerReturn) {
        const { data, error } = await supabase.rpc("create_rep_return", {
          payload: {
            factory_id: factoryId,
            sales_rep_id: repId,
            return_date: returnDate,
            notes: reason || undefined,
            items: validLines.map((l) => ({
              product_id: l.product_id,
              quantity_returned: l.quantity,
            })),
          } as never,
        });
        if (error) throw error;
        const r = data as { id: string; return_number: string };
        logAudit({ action: "create", entity: "rep_returns", entityId: r.id, factoryId });
        return [r];
      }
      // Sequential, not Promise.all: each call inserts its own sales_returns
      // row and there's no need to race them against each other.
      const results: { id: string; return_number: string }[] = [];
      for (const line of validLines) {
        const { data, error } = await supabase.rpc("create_sales_return", {
          payload: {
            factory_id: factoryId,
            sale_id: saleId === "none" ? undefined : saleId,
            product_id: line.product_id,
            quantity_returned: line.quantity,
            reason: reason || undefined,
            return_date: returnDate,
          } as any,
        });
        if (error) throw error;
        results.push(data as { id: string; return_number: string });
      }
      return results;
    },
    onSuccess: (results) => {
      toast.success(
        isMarketerReturn
          ? `Return ${results[0].return_number} received — back in the Warehouse and credited to the marketer`
          : results.length === 1
            ? `Return ${results[0].return_number} logged — awaiting inspection`
            : `${results.length} returns logged (${results.map((r) => r.return_number).join(", ")}) — awaiting inspection`,
      );
      if (!isMarketerReturn)
        results.forEach((r) =>
          logAudit({ action: "create", entity: "sales_returns", entityId: r.id, factoryId }),
        );
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Log a Sales Return</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        {canLogMarketerReturn && (
          <div>
            <Label>Marketer{canLogSalesReturn ? " (optional)" : ""}</Label>
            <Select value={repId} onValueChange={setRepId}>
              <SelectTrigger>
                <SelectValue placeholder="Select the marketer…" />
              </SelectTrigger>
              <SelectContent>
                {canLogSalesReturn && <SelectItem value="none">— None —</SelectItem>}
                {marketers.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isMarketerReturn && (
              <p className="mt-1 text-xs text-muted-foreground">
                Collected from this marketer (what they hold is in brackets). The products go
                straight back into the Warehouse and are credited to the marketer's account.
              </p>
            )}
          </div>
        )}
        {!isMarketerReturn && canLogSalesReturn && (
          <div>
            <Label>Invoice (optional)</Label>
            <Select value={saleId} onValueChange={setSaleId}>
              <SelectTrigger>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {sales.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.invoice_number} · {s.customer_name ?? "Walk-in"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div>
          <Label>Return date</Label>
          <Input
            type="date"
            value={returnDate}
            max={today}
            onChange={(e) => setReturnDate(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Set it back to the day the products came back (e.g. yesterday) when logging them the
            next day.
          </p>
        </div>
        <div>
          <Label>Products returned</Label>
          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select
                  value={line.product_id}
                  onValueChange={(v) =>
                    v === ADD_NEW_ITEM ? setAddingProductIndex(i) : updateLine(i, { product_id: v })
                  }
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Select product…" />
                  </SelectTrigger>
                  <SelectContent>
                    {products.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                        {isMarketerReturn && ` (${num(heldBy(p.id))})`}
                      </SelectItem>
                    ))}
                    {!isMarketerReturn && (
                      <SelectItem value={ADD_NEW_ITEM} className="font-medium text-primary">
                        + Add new product…
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <MoneyInput
                  min={0.001}
                  step="0.001"
                  value={line.quantity}
                  onChange={(v) => updateLine(i, { quantity: v })}
                  className="w-28 shrink-0"
                />
                {lines.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={() => removeLine(i)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
          <QuickAddProductDialog
            open={addingProductIndex !== null}
            onOpenChange={(v) => !v && setAddingProductIndex(null)}
            factoryId={factoryId}
            onCreated={(id) => {
              if (addingProductIndex !== null) updateLine(addingProductIndex, { product_id: id });
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 gap-1.5"
            onClick={addLine}
          >
            <Plus className="h-3.5 w-3.5" /> Add product
          </Button>
        </div>
        <div>
          <Label>Reason</Label>
          <Textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Customer says it leaked"
          />
        </div>
        {!isMarketerReturn && (
          <p className="text-xs text-muted-foreground">
            This only records that the return was received — nothing is added back to stock until
            someone else inspects it.
          </p>
        )}
      </div>
      <DialogFooter>
        <Button
          disabled={submit.isPending || !linesReady}
          onClick={() => submit.mutate()}
          className="gap-2"
        >
          {submit.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {submit.isPending
            ? "Saving…"
            : lines.length > 1
              ? `Log ${lines.length} Returns`
              : "Log Return"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function InspectDialog({ row, onDone }: { row: ReturnRow; onDone: () => void }) {
  const [accepted, setAccepted] = useState(Number(row.quantity_returned));
  const [damaged, setDamaged] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [notes, setNotes] = useState("");

  const total = accepted + damaged + rejected;
  const balanced = Math.abs(total - Number(row.quantity_returned)) < 0.0005;

  const submit = useMutation({
    mutationFn: async () => {
      if (!balanced)
        throw new Error(
          `Accepted + damaged + rejected must equal ${num(Number(row.quantity_returned))}`,
        );
      const { error } = await supabase.rpc("inspect_sales_return", {
        p_id: row.id,
        p_accepted: accepted,
        p_damaged: damaged,
        p_rejected: rejected,
        p_notes: notes || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Return inspected — accepted quantity posted to stock");
      logAudit({
        action: "update",
        entity: "sales_returns",
        entityId: row.id,
        newValue: { accepted, damaged, rejected },
      });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Inspect Return — {row.return_number}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {row.products?.name} · {num(Number(row.quantity_returned))} {row.unit} returned
        </p>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>Accepted (good)</Label>
            <MoneyInput min={0} step="0.001" value={accepted} onChange={setAccepted} />
          </div>
          <div>
            <Label>Damaged</Label>
            <MoneyInput min={0} step="0.001" value={damaged} onChange={setDamaged} />
          </div>
          <div>
            <Label>Rejected</Label>
            <MoneyInput min={0} step="0.001" value={rejected} onChange={setRejected} />
          </div>
        </div>
        {!balanced && (
          <p className="text-xs text-destructive">
            These must add up to {num(Number(row.quantity_returned))} {row.unit} (currently{" "}
            {num(total)}).
          </p>
        )}
        <div>
          <Label>Inspection notes</Label>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <p className="text-xs text-muted-foreground">
          Only the accepted quantity posts to finished-goods stock. Damaged goes to the Damage
          register; rejected is logged with no stock effect.
        </p>
      </div>
      <DialogFooter>
        <Button disabled={submit.isPending || !balanced} onClick={() => submit.mutate()}>
          {submit.isPending ? "Saving…" : "Complete Inspection"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function CancelDialog({ row, onDone }: { row: ReturnRow; onDone: () => void }) {
  const [reason, setReason] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("cancel_sales_return", {
        p_id: row.id,
        p_reason: reason || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Return cancelled");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Cancel — {row.return_number}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {row.products?.name} · {num(Number(row.quantity_returned))} {row.unit}
        </p>
        <div>
          <Label>Reason</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="destructive" disabled={submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? "Cancelling…" : "Cancel Return"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function DetailDialog({ row }: { row: ReturnRow }) {
  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{row.return_number}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <span className="text-muted-foreground">Product:</span> {row.products?.name ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Customer:</span> {row.customers?.name ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Invoice:</span>{" "}
            {row.sales?.invoice_number ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Returned:</span>{" "}
            {num(Number(row.quantity_returned))} {row.unit}
          </div>
          <div>
            <span className="text-muted-foreground">Status:</span>{" "}
            <Badge variant={statusBadge(row.status)} className="capitalize">
              {row.status}
            </Badge>
          </div>
          <div>
            <span className="text-muted-foreground">Return date:</span>{" "}
            {new Date(row.return_date ?? row.received_at).toLocaleDateString()}
            <span className="ml-2 text-muted-foreground">Logged:</span>{" "}
            {new Date(row.received_at).toLocaleString()}
          </div>
          {row.status === "completed" && (
            <>
              <div>
                <span className="text-muted-foreground">Accepted:</span>{" "}
                {num(Number(row.accepted_quantity ?? 0))} {row.unit}
              </div>
              <div>
                <span className="text-muted-foreground">Damaged:</span>{" "}
                {num(Number(row.damaged_quantity))} {row.unit}
              </div>
              <div>
                <span className="text-muted-foreground">Rejected:</span>{" "}
                {num(Number(row.rejected_quantity))} {row.unit}
              </div>
              <div>
                <span className="text-muted-foreground">Inspected:</span>{" "}
                {row.inspected_at ? new Date(row.inspected_at).toLocaleString() : "—"}
              </div>
            </>
          )}
        </div>
        {row.reason && (
          <div>
            <span className="text-muted-foreground">Reason:</span> {row.reason}
          </div>
        )}
        {row.notes && (
          <div>
            <span className="text-muted-foreground">Inspection notes:</span> {row.notes}
          </div>
        )}
      </div>
    </DialogContent>
  );
}
