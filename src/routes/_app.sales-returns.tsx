import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Plus, Eye, Ban, Undo2, Loader2 } from "lucide-react";
import { num } from "@/lib/format";
import { toast } from "sonner";
import { logAudit } from "@/lib/audit";

export const Route = createFileRoute("/_app/sales-returns")({
  head: () => ({
    meta: [{ title: "Sales Returns — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="sales">
      <SalesReturnsPage />
    </RequireAccess>
  ),
});

type Product = { id: string; name: string; unit: string };
type Customer = { id: string; name: string };
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

function SalesReturnsPage() {
  const { data: factoryId } = useFactoryId();
  const { canSubmit, canConfirm, canCancel } = usePermissions();
  const submitPerm = canSubmit("sales");
  const inspectPerm = canConfirm("sales");
  const cancelPerm = canCancel("sales");
  const qc = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [inspectTarget, setInspectTarget] = useState<ReturnRow | null>(null);
  const [detailTarget, setDetailTarget] = useState<ReturnRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<ReturnRow | null>(null);

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
        .order("name");
      if (error) throw error;
      return (data ?? []) as Product[];
    },
  });

  const customers = useQuery({
    queryKey: ["customers-for-returns", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("id,name")
        .eq("factory_id", factoryId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Customer[];
    },
  });

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
          "id,return_number,sale_id,customer_id,product_id,quantity_returned,unit,reason,status,accepted_quantity,damaged_quantity,rejected_quantity,received_by,received_at,inspected_by,inspected_at,notes,products(name,unit),customers(name),sales(invoice_number)",
        )
        .eq("factory_id", factoryId!)
        .order("received_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as unknown as ReturnRow[];
    },
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["sales-returns-list"] });
    qc.invalidateQueries({ queryKey: ["finished-goods"] });
    qc.invalidateQueries({ queryKey: ["products-for-returns"] });
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
                    {new Date(row.received_at).toLocaleDateString()}
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
            customers={customers.data ?? []}
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

function CreateReturnDialog({
  factoryId,
  products,
  customers,
  sales,
  onDone,
}: {
  factoryId: string;
  products: Product[];
  customers: Customer[];
  sales: Sale[];
  onDone: () => void;
}) {
  const [saleId, setSaleId] = useState("none");
  const [customerId, setCustomerId] = useState("none");
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState(0);
  const [reason, setReason] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      if (!productId) throw new Error("Select the returned product");
      if (quantity <= 0) throw new Error("Quantity must be > 0");
      const { data, error } = await supabase.rpc("create_sales_return", {
        payload: {
          factory_id: factoryId,
          sale_id: saleId === "none" ? undefined : saleId,
          customer_id: customerId === "none" ? undefined : customerId,
          product_id: productId,
          quantity_returned: quantity,
          reason: reason || undefined,
        } as any,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: (data) => {
      toast.success(`Return ${data?.return_number ?? ""} logged — awaiting inspection`);
      logAudit({ action: "create", entity: "sales_returns", entityId: data?.id, factoryId });
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
        <div>
          <Label>Customer (optional)</Label>
          <Select value={customerId} onValueChange={setCustomerId}>
            <SelectTrigger>
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— None —</SelectItem>
              {customers.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Product returned</Label>
          <Select value={productId} onValueChange={setProductId}>
            <SelectTrigger>
              <SelectValue placeholder="Select product…" />
            </SelectTrigger>
            <SelectContent>
              {products.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Quantity returned</Label>
          <Input
            type="number"
            min={0.001}
            step="0.001"
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
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
        <p className="text-xs text-muted-foreground">
          This only records that the return was received — nothing is added back to stock until
          someone else inspects it.
        </p>
      </div>
      <DialogFooter>
        <Button
          disabled={submit.isPending || !productId || quantity <= 0}
          onClick={() => submit.mutate()}
          className="gap-2"
        >
          {submit.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {submit.isPending ? "Saving…" : "Log Return"}
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
            <Input
              type="number"
              min={0}
              step="0.001"
              value={accepted}
              onChange={(e) => setAccepted(Number(e.target.value))}
            />
          </div>
          <div>
            <Label>Damaged</Label>
            <Input
              type="number"
              min={0}
              step="0.001"
              value={damaged}
              onChange={(e) => setDamaged(Number(e.target.value))}
            />
          </div>
          <div>
            <Label>Rejected</Label>
            <Input
              type="number"
              min={0}
              step="0.001"
              value={rejected}
              onChange={(e) => setRejected(Number(e.target.value))}
            />
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
            <span className="text-muted-foreground">Received:</span>{" "}
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
