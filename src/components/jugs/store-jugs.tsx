import { useState } from "react";
import { PackagePlus } from "lucide-react";
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
