import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Factory, Loader2, PackagePlus } from "lucide-react";
import { rpc } from "@/components/preform/api";
import { CountInput } from "@/components/preform/shared";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePermissions } from "@/lib/permissions";
import { useFactoryId } from "@/lib/use-factory";
import { addDays, localDay } from "@/lib/production-shift";
import { num } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useJugLive, useJugMovements, useJugTypes } from "./api";
import { ReceiveNewJugsDialog } from "./dialogs";
import { WarehouseJugsToQc } from "@/components/qc/jug-handover";

// Store -> Jugs (user request 2026-11-01): the Store receives new jugs bought
// in and sends Old / New Jugs to Quality Control -- the same records as
// Warehouse -> Dispenser & jugs (receive_new_jugs, send_jugs_to_qc; see
// supabase/migrations/20261101090000_store_receives_sends_jugs.sql). QC
// accepts, verifies and posts the good ones to the PM.
export function StoreJugs() {
  const { data: factoryId } = useFactoryId();
  const { can } = usePermissions();
  const canReceive = can("raw-materials", "create") || can("raw-materials", "submit");
  const [receiving, setReceiving] = useState(false);
  useJugLive();
  const today = localDay();
  const types = useJugTypes(factoryId ?? undefined);
  const jugTypes = (types.data ?? []).filter((t) => t.active && /jug/i.test(t.name));
  const typeName = (id: string) => types.data?.find((t) => t.id === id)?.name ?? "Jug";
  const moves = useJugMovements(factoryId ?? undefined, addDays(today, -30), today);
  const received = (moves.data ?? []).filter((m) => m.source === "purchase");
  // Jugs the Store issued straight to Production (20261104120000).
  const toProduction = (moves.data ?? []).filter((m) => m.source === "store_to_production");
  const [issuing, setIssuing] = useState(false);

  if (!factoryId) return null;
  return (
    <div className="space-y-6">
      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-base">New jugs received</CardTitle>
            <p className="text-xs text-muted-foreground">
              Jugs bought in, counted on delivery. Last 30 days.
            </p>
          </div>
          {canReceive && (
            <Button
              className="gap-2"
              onClick={() => setReceiving(true)}
              disabled={!jugTypes.length}
            >
              <PackagePlus className="h-4 w-4" /> Receive new jugs
            </Button>
          )}
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Jug</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead>Delivery note</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {received.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(m.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell>{typeName(m.container_type_id)}</TableCell>
                  <TableCell className="text-right font-medium">{num(m.quantity)}</TableCell>
                  <TableCell className="font-mono text-xs">{m.reference ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{m.notes ?? "—"}</TableCell>
                </TableRow>
              ))}
              {received.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                    {moves.isLoading ? "Loading…" : "No new jugs received in the last 30 days."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <WarehouseJugsToQc factoryId={factoryId} />

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-base">Issued to Production</CardTitle>
            <p className="text-xs text-muted-foreground">
              Jugs the Store gave straight to Production, without QC. Last 30 days.
            </p>
          </div>
          {canReceive && (
            <Button variant="outline" className="gap-2" onClick={() => setIssuing(true)}>
              <Factory className="h-4 w-4" /> Issue to Production
            </Button>
          )}
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Jug</TableHead>
                <TableHead className="text-right">Issued</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {toProduction.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(m.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{m.reference ?? "—"}</TableCell>
                  <TableCell>{typeName(m.container_type_id)}</TableCell>
                  <TableCell className="text-right font-medium">{num(m.quantity)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {(m.notes ?? "").replace(/s*[[^]]*]$/, "") || "—"}
                  </TableCell>
                </TableRow>
              ))}
              {toProduction.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                    {moves.isLoading
                      ? "Loading…"
                      : "Nothing issued to Production in the last 30 days."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {issuing && (
        <IssueToProductionDialog factoryId={factoryId} onClose={() => setIssuing(false)} />
      )}

      {receiving && (
        <ReceiveNewJugsDialog
          factoryId={factoryId}
          types={jugTypes}
          onClose={() => setReceiving(false)}
        />
      )}
    </div>
  );
}

// Store -> Production, straight (user, 2026-11-04: "new jugs goes to store
// and issued to qc or production"); send_jugs_to_production.
function IssueToProductionDialog({
  factoryId,
  onClose,
}: {
  factoryId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<"new" | "old">("new");
  const [qty, setQty] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [clientRef] = useState(() => crypto.randomUUID());
  const send = useMutation({
    mutationFn: () =>
      rpc<{ reference?: string }>("send_jugs_to_production", {
        payload: {
          factory_id: factoryId,
          jug_kind: kind,
          quantity: qty,
          notes,
          client_ref: clientRef,
        },
      }),
    onSuccess: (r) => {
      toast.success(`${r?.reference ?? ""} ${num(qty ?? 0)} jugs issued to Production`.trim());
      void qc.invalidateQueries({ queryKey: ["jug"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Issue jugs to Production</DialogTitle>
          <DialogDescription>
            Jugs from the Store straight to Production. To have them checked first, use Send to QC.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as "new" | "old")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">New Jug</SelectItem>
                  <SelectItem value="old">Old Jug</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Quantity</Label>
              <CountInput value={qty} onChange={setQty} placeholder="0" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!qty || send.isPending} onClick={() => send.mutate()} className="gap-2">
            {send.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Issue to Production
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
