import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRightLeft, Loader2, Undo2, Warehouse } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { useCurrentUserName } from "@/lib/use-current-user";
import { num } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// The production hall: what Production has made and not yet handed to the
// Warehouse. Batches recorded on the Production page add to it; Production
// releases quantities to the Warehouse through the day (often against a
// request), and each release is accepted on the Warehouse's Finished Products
// page. Whatever is still here at closing -- typically the night's output,
// made after the Warehouse closes -- is the day's closing balance and is
// released the next morning. See migration 20261014190000.

type HallRow = {
  product_id: string;
  product_name: string;
  unit: string;
  produced: number;
  released: number;
  awaiting_warehouse: number;
  in_hall: number;
};
type Release = {
  id: string;
  release_number: string;
  quantity: number;
  unit: string | null;
  status: string;
  released_at: string;
  released_by_name: string | null;
  accepted_quantity: number | null;
  received_quantity: number | null;
  reject_reason: string | null;
  products: { name: string } | null;
  production_requests: { request_number: string } | null;
};
type RequestOption = {
  id: string;
  request_number: string;
  quantity_requested: number;
  unit: string | null;
};

const RELEASE_STATUS: Record<
  string,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  pending: { label: "Awaiting Warehouse", variant: "secondary" },
  accepted: { label: "In Warehouse", variant: "default" },
  rejected: { label: "Refused — back in hall", variant: "destructive" },
  cancelled: { label: "Withdrawn", variant: "outline" },
  reversed: { label: "Reversed — back in hall", variant: "outline" },
};

// Whoever can put stock into the hall (record or post batches) can release it.
// Mirrors release_to_warehouse()'s check.
function useCanRelease() {
  const { can } = usePermissions();
  return can("production", "create") || can("production", "submit") || can("production", "edit");
}

function useHallStock(factoryId: string) {
  return useQuery({
    queryKey: ["production-hall", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("production_hall_stock", {
        p_factory: factoryId,
      });
      if (error) throw error;
      return (data ?? []) as HallRow[];
    },
  });
}

// "Release" on a batch row of the Production page: releases that product from
// the hall (up to what is in the hall now, which may span several batches).
export function ReleaseBatchButton({
  factoryId,
  productId,
}: {
  factoryId: string;
  productId: string;
}) {
  const qc = useQueryClient();
  const canRelease = useCanRelease();
  const hall = useHallStock(factoryId);
  const [open, setOpen] = useState(false);
  const row = (hall.data ?? []).find((r) => r.product_id === productId);
  if (!canRelease || !row || Number(row.in_hall) <= 0) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="gap-1"
        title="Release to Warehouse"
        onClick={() => setOpen(true)}
      >
        <ArrowRightLeft className="h-3.5 w-3.5" /> Release
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <ReleaseDialog
            factoryId={factoryId}
            row={row}
            onDone={() => {
              setOpen(false);
              qc.invalidateQueries({ queryKey: ["production-hall"] });
              qc.invalidateQueries({ queryKey: ["production-releases"] });
              qc.invalidateQueries({ queryKey: ["production-report"] });
            }}
          />
        )}
      </Dialog>
    </>
  );
}

export function ProductionHall({ factoryId }: { factoryId: string }) {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canRelease = useCanRelease();
  const canWithdraw = can("production", "cancel");
  // Reversing an accepted release takes it back out of Warehouse stock.
  const canReverse = can("production", "confirm");
  const [releaseFor, setReleaseFor] = useState<HallRow | null>(null);

  useRealtimeInvalidate(
    ["production", "production_releases"],
    [["production-hall"], ["production-releases"]],
  );

  const hall = useHallStock(factoryId);

  const releases = useQuery({
    queryKey: ["production-releases", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production_releases")
        .select(
          "id,release_number,quantity,unit,status,released_at,released_by_name,accepted_quantity,received_quantity,reject_reason,products(name),production_requests(request_number)",
        )
        .eq("factory_id", factoryId)
        .order("released_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as unknown as Release[];
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["production-hall"] });
    qc.invalidateQueries({ queryKey: ["production-releases"] });
    qc.invalidateQueries({ queryKey: ["production-report"] });
  };

  const withdraw = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("cancel_production_release", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Release withdrawn — the goods are back in the production hall");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reverse = useMutation({
    mutationFn: async (r: Release) => {
      const { error } = await supabase.rpc("reverse_production_release", {
        p_id: r.id,
        p_reason: "Reversed from the Production Hall",
      });
      if (error) throw error;
      return r;
    },
    onSuccess: (r) => {
      toast.success(
        `${r.release_number} reversed — taken out of Warehouse stock, back in the hall`,
      );
      refresh();
      qc.invalidateQueries({ queryKey: ["finished-goods"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = (hall.data ?? []).filter(
    (r) => Number(r.produced) > 0 || Number(r.in_hall) !== 0 || Number(r.released) > 0,
  );
  const totalInHall = rows.reduce((t, r) => t + Number(r.in_hall), 0);

  return (
    <>
      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              Production Hall
              {totalInHall > 0 && <Badge variant="secondary">{num(totalInHall)} in hall</Badge>}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Products made and not yet released to the Warehouse. Release them as the Warehouse
              needs them; anything left at closing opens the next day.
            </p>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Produced</TableHead>
                <TableHead className="text-right">Released</TableHead>
                <TableHead className="text-right">Awaiting Warehouse</TableHead>
                <TableHead className="text-right">In hall now</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.product_id}>
                  <TableCell className="font-medium">{r.product_name}</TableCell>
                  <TableCell className="text-right">{num(Number(r.produced))}</TableCell>
                  <TableCell className="text-right">{num(Number(r.released))}</TableCell>
                  <TableCell className="text-right">
                    {Number(r.awaiting_warehouse) > 0 ? num(Number(r.awaiting_warehouse)) : "—"}
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    {num(Number(r.in_hall))} {r.unit}
                  </TableCell>
                  <TableCell className="text-right">
                    {canRelease && Number(r.in_hall) > 0 && (
                      <Button size="sm" className="gap-1" onClick={() => setReleaseFor(r)}>
                        <ArrowRightLeft className="h-3.5 w-3.5" /> Release
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    {hall.isLoading
                      ? "Loading…"
                      : "The production hall is empty. Record production with New Production."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Warehouse className="h-5 w-5" /> Releases to the Warehouse
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Release #</TableHead>
                <TableHead>Released</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(releases.data ?? []).map((r) => {
                const st = RELEASE_STATUS[r.status] ?? {
                  label: r.status,
                  variant: "outline" as const,
                };
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">
                      {r.release_number}
                      {r.production_requests && (
                        <div className="text-[11px] text-muted-foreground">
                          for {r.production_requests.request_number}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {new Date(r.released_at).toLocaleString()}
                      {r.released_by_name && (
                        <div className="text-muted-foreground">by {r.released_by_name}</div>
                      )}
                    </TableCell>
                    <TableCell>{r.products?.name ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      {num(Number(r.quantity))} {r.unit ?? ""}
                      {r.status === "accepted" &&
                        r.accepted_quantity != null &&
                        Number(r.accepted_quantity) !== Number(r.quantity) && (
                          <div className="text-[11px] text-muted-foreground">
                            {num(Number(r.accepted_quantity))} into stock
                          </div>
                        )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={st.variant}>{st.label}</Badge>
                      {r.status === "rejected" && r.reject_reason && (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {r.reject_reason}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.status === "pending" && canWithdraw && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Withdraw release"
                          disabled={withdraw.isPending}
                          onClick={() => withdraw.mutate(r.id)}
                        >
                          <Undo2 className="h-4 w-4" />
                        </Button>
                      )}
                      {r.status === "accepted" && canReverse && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1 text-destructive"
                          title="Reverse: take it back out of Warehouse stock"
                          disabled={reverse.isPending}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Reverse ${r.release_number}? Its accepted quantity is taken back out of Warehouse stock and returns to the production hall.`,
                              )
                            )
                              reverse.mutate(r);
                          }}
                        >
                          <Undo2 className="h-3.5 w-3.5" /> Reverse
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {(releases.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                    Nothing released yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!releaseFor} onOpenChange={(v) => !v && setReleaseFor(null)}>
        {releaseFor && (
          <ReleaseDialog
            factoryId={factoryId}
            row={releaseFor}
            onDone={() => {
              setReleaseFor(null);
              refresh();
            }}
          />
        )}
      </Dialog>
    </>
  );
}

function ReleaseDialog({
  factoryId,
  row,
  onDone,
}: {
  factoryId: string;
  row: HallRow;
  onDone: () => void;
}) {
  const available = Number(row.in_hall);
  const [quantity, setQuantity] = useState(available);
  const [requestId, setRequestId] = useState("none");
  const [notes, setNotes] = useState("");
  const [releasedBy, setReleasedBy] = useState("");
  const currentUserName = useCurrentUserName();

  useEffect(() => {
    if (!releasedBy && currentUserName.data) setReleasedBy(currentUserName.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserName.data]);

  // Requests for this product the release can be made against (optional).
  const requests = useQuery({
    queryKey: ["release-requests", factoryId, row.product_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production_requests")
        .select("id,request_number,quantity_requested,unit")
        .eq("factory_id", factoryId)
        .eq("product_id", row.product_id)
        .eq("request_type", "production_material")
        .eq("approval_status", "approved")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) return [] as RequestOption[];
      return (data ?? []) as RequestOption[];
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      if (quantity <= 0) throw new Error("Enter the quantity to release");
      if (quantity > available)
        throw new Error(`Only ${num(available)} ${row.unit} is in the production hall`);
      const { data, error } = await supabase.rpc("release_to_warehouse", {
        payload: {
          factory_id: factoryId,
          product_id: row.product_id,
          quantity,
          production_request_id: requestId === "none" ? null : requestId,
          notes: notes.trim() || null,
          released_by_name: releasedBy.trim() || null,
        },
      });
      if (error) throw error;
      return data as { release_number: string };
    },
    onSuccess: (data) => {
      toast.success(`${data.release_number} sent — awaiting Warehouse acceptance`);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Release to Warehouse — {row.product_name}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          In the production hall: {num(available)} {row.unit}. Release all of it or only what the
          Warehouse needs now; the rest stays in the hall.
        </p>
        <div>
          <Label>Quantity to release ({row.unit})</Label>
          <MoneyInput min={0.001} step="0.001" value={quantity} onChange={setQuantity} />
        </div>
        {(requests.data ?? []).length > 0 && (
          <div>
            <Label>Against request (optional)</Label>
            <Select value={requestId} onValueChange={setRequestId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— Not against a request —</SelectItem>
                {(requests.data ?? []).map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.request_number} · {num(Number(r.quantity_requested))} {r.unit ?? ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div>
          <Label>Released by</Label>
          <Input value={releasedBy} onChange={(e) => setReleasedBy(e.target.value)} />
        </div>
        <div>
          <Label>Note (optional)</Label>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()} className="gap-2">
          {save.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowRightLeft className="h-4 w-4" />
          )}
          {save.isPending ? "Releasing…" : "Release to Warehouse"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
