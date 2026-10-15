import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { num } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Check, Factory, X } from "lucide-react";

type PendingRelease = {
  id: string;
  release_number: string;
  quantity: number;
  unit: string | null;
  notes: string | null;
  released_by: string | null;
  released_by_name: string | null;
  released_at: string;
  products: { name: string; unit: string } | null;
  production_requests: { request_number: string } | null;
};

// What Production has released to the Warehouse and is waiting to be received:
// the Warehouse accepts each release (counting what arrived, any damage or
// rejects) into finished-goods stock, or refuses it back to the production
// hall. Shown on the Warehouse Stock tab and on Finished Products. The person
// who released goods can't accept them (accept_production_release enforces it).
// `alwaysShow` keeps the card with an empty state instead of hiding it.
export function ReleasesToAccept({
  factoryId,
  alwaysShow,
}: {
  factoryId: string;
  alwaysShow?: boolean;
}) {
  const qc = useQueryClient();
  const { canConfirm, canReject } = usePermissions();
  const canAccept = canConfirm("production");
  const canRefuse = canReject("production");
  const [acceptTarget, setAcceptTarget] = useState<PendingRelease | null>(null);
  const [refuseTarget, setRefuseTarget] = useState<PendingRelease | null>(null);

  useRealtimeInvalidate(["production_releases"], [["pending-production-batches"]]);

  const pending = useQuery({
    queryKey: ["pending-production-batches", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production_releases")
        .select(
          "id,release_number,quantity,unit,notes,released_by,released_by_name,released_at,products(name,unit),production_requests(request_number)",
        )
        .eq("factory_id", factoryId)
        .eq("status", "pending")
        .order("released_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PendingRelease[];
    },
  });
  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const refresh = () => {
    for (const key of [
      "pending-production-batches",
      "finished-goods",
      "inventory-overview-products",
      "products-active",
      "dist-products",
      "production-hall",
      "production-releases",
      "warehouse-activity",
      "damage-records-finished-goods",
      "damage-value-finished-goods",
    ])
      qc.invalidateQueries({ queryKey: [key] });
  };

  const refuse = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc("reject_production_release", {
        p_id: id,
        p_reason: reason,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Release refused — the goods are back in the production hall");
      setRefuseTarget(null);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = pending.data ?? [];
  if (!alwaysShow && rows.length === 0) return null;

  return (
    <>
      <Card className="rounded-2xl border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Production Releases to Accept
            {rows.length > 0 && <Badge variant="destructive">{rows.length}</Badge>}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Finished goods Production has released to the Warehouse. Count what arrived and accept
            it into stock, or refuse it back to the production hall.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Release #</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Quantity Released</TableHead>
                <TableHead>Released</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((b) => {
                const isSelf = b.released_by === currentUser.data;
                return (
                  <TableRow key={b.id}>
                    <TableCell className="font-mono text-xs">
                      {b.release_number}
                      {b.production_requests && (
                        <div className="text-[11px] text-muted-foreground">
                          for {b.production_requests.request_number}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-medium">{b.products?.name ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      {num(Number(b.quantity))} {b.products?.unit ?? b.unit}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(b.released_at).toLocaleString()}
                      {b.released_by_name && <div>by {b.released_by_name}</div>}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {canAccept && !isSelf && (
                          <Button size="sm" className="gap-1" onClick={() => setAcceptTarget(b)}>
                            <Check className="h-4 w-4" /> Accept
                          </Button>
                        )}
                        {canRefuse && !isSelf && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Refuse"
                            onClick={() => setRefuseTarget(b)}
                          >
                            <X className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                    {pending.isLoading ? "Loading…" : "Nothing waiting — all releases received."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!acceptTarget} onOpenChange={(v) => !v && setAcceptTarget(null)}>
        {acceptTarget && (
          <AcceptReleaseDialog
            release={acceptTarget}
            onDone={() => {
              setAcceptTarget(null);
              refresh();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!refuseTarget} onOpenChange={(v) => !v && setRefuseTarget(null)}>
        {refuseTarget && (
          <RefuseReleaseDialog
            release={refuseTarget}
            isPending={refuse.isPending}
            onRefuse={(reason) => refuse.mutate({ id: refuseTarget.id, reason })}
          />
        )}
      </Dialog>
    </>
  );
}

function AcceptReleaseDialog({ release, onDone }: { release: PendingRelease; onDone: () => void }) {
  const [actualReceived, setActualReceived] = useState(Number(release.quantity));
  const [damaged, setDamaged] = useState(0);
  const [rejected, setRejected] = useState(0);
  const accepted = Math.max(actualReceived - damaged - rejected, 0);
  const unit = release.products?.unit ?? release.unit ?? "";

  const confirm = useMutation({
    mutationFn: async () => {
      if (actualReceived < 0) throw new Error("Actual quantity received must be >= 0");
      if (damaged < 0 || rejected < 0)
        throw new Error("Damaged/rejected quantities cannot be negative");
      if (damaged + rejected > actualReceived)
        throw new Error("Damaged + rejected cannot exceed actual quantity received");
      if (actualReceived > Number(release.quantity))
        throw new Error("Received cannot be more than was released");
      const { error } = await supabase.rpc("accept_production_release", {
        p_id: release.id,
        p_received: actualReceived,
        p_damaged: damaged,
        p_rejected: rejected,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`Accepted — ${num(accepted)} ${unit} added to stock`);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Factory className="h-5 w-5" /> Accept Release — {release.release_number}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {release.products?.name} · Released by Production: {num(Number(release.quantity))} {unit}
        </p>
        {release.notes && <p className="text-xs text-muted-foreground">Note: {release.notes}</p>}
        <div>
          <Label>Actual Quantity Received</Label>
          <MoneyInput min={0} step="0.001" value={actualReceived} onChange={setActualReceived} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Damaged Quantity</Label>
            <MoneyInput min={0} step="0.001" value={damaged} onChange={setDamaged} />
          </div>
          <div>
            <Label>Rejected Quantity</Label>
            <MoneyInput min={0} step="0.001" value={rejected} onChange={setRejected} />
          </div>
        </div>
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Accepted Quantity (enters stock)
          </div>
          <div className="mt-1 text-xl font-semibold">
            {num(accepted)} {unit}
          </div>
          {actualReceived < Number(release.quantity) && (
            <p className="mt-1 text-xs text-warning">
              {num(Number(release.quantity) - actualReceived)} {unit} released but not received —
              recorded as a shortfall.
            </p>
          )}
        </div>
      </div>
      <DialogFooter>
        <Button disabled={confirm.isPending} onClick={() => confirm.mutate()}>
          {confirm.isPending ? "Accepting…" : "Accept"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function RefuseReleaseDialog({
  release,
  isPending,
  onRefuse,
}: {
  release: PendingRelease;
  isPending: boolean;
  onRefuse: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <X className="h-5 w-5 text-destructive" /> Refuse Release — {release.release_number}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {release.products?.name} · Released: {num(Number(release.quantity))}{" "}
          {release.products?.unit ?? release.unit}
        </p>
        <div>
          <Label>Reason for refusing</Label>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain why this release is being refused…"
            autoFocus
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Nothing is added to stock. The goods go back into the production hall balance, and
          Production can release them again.
        </p>
      </div>
      <DialogFooter>
        <Button
          variant="destructive"
          disabled={isPending || !trimmed}
          onClick={() => onRefuse(trimmed)}
        >
          {isPending ? "Refusing…" : "Refuse release"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
