import { useState } from "react";
import { PackageCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { usePermissions } from "@/lib/permissions";
import { num } from "@/lib/format";
import { useMyUserId, usePreformLive, useTransfers, useUserNames, type Transfer } from "./api";
import { RejectDialog, ReceiveDialog, RejectionsCard, useRejectedByTransfer } from "./transfers";
import { StatusBadge, fmtDateTime } from "./shared";

// Production → Good bottles from QC: PM's side of the bottle issue. QC (or
// the Warehouse) issues good blown bottles from bottle stock; PM confirms
// what arrived (never more than issued) and records any it later finds
// defective as a PM-stage rejection against that receipt. Bottles reach PM
// only this way -- never straight from preform stock.
// showEmpty keeps the card (with an empty-state row) when nothing was issued
// yet, for its own tab on the Production page.
export function PmBottlesFromQc({
  factoryId,
  showEmpty = false,
}: {
  factoryId: string;
  showEmpty?: boolean;
}) {
  const { can } = usePermissions();
  const canView = can("preform-production", "view");
  const canReceive = can("preform-production", "submit");
  usePreformLive();
  const me = useMyUserId();
  const transfers = useTransfers(canView ? factoryId : undefined);
  const rejected = useRejectedByTransfer(canView ? factoryId : undefined);
  const rows = (transfers.data ?? [])
    .filter((t) => ["dispatched", "received", "discrepancy"].includes(t.status))
    .slice(0, 30);
  const pending = rows.filter((t) => t.status === "dispatched");
  const names = useUserNames(rows.flatMap((t) => [t.sent_by, t.received_by]));
  const [receive, setReceive] = useState<Transfer | null>(null);
  const [reject, setReject] = useState<Transfer | null>(null);
  if (!canView || (!showEmpty && !rows.length && !transfers.isLoading)) return null;

  return (
    <>
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PackageCheck className="h-4 w-4" /> Good bottles from QC
            {pending.length > 0 && <Badge variant="secondary">{pending.length} to receive</Badge>}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Blown bottles issued to PM from bottle stock. Confirm what arrives; record any bottles
            found defective afterwards with Reject (PM-stage, separate from blowing damage).
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Bottle</TableHead>
                <TableHead className="text-right">Issued</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Rejected</TableHead>
                <TableHead>Issued by</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => {
                const rej = rejected.get(t.id) ?? 0;
                return (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-xs">
                      {t.reference}
                      {t.production_reference && (
                        <div className="font-sans text-[11px] text-muted-foreground">
                          {t.production_reference}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{t.product?.name}</TableCell>
                    <TableCell className="text-right font-semibold">
                      {num(t.quantity_sent)}
                    </TableCell>
                    <TableCell className="text-right">
                      {t.quantity_received == null ? "—" : num(t.quantity_received)}
                    </TableCell>
                    <TableCell className="text-right text-destructive">
                      {rej ? num(rej) : ""}
                    </TableCell>
                    <TableCell className="text-xs">
                      {names.data?.[t.sent_by ?? ""] ?? ""}
                      <div className="text-muted-foreground">{fmtDateTime(t.sent_at)}</div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={t.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      {canReceive && t.sent_by !== me.data && t.status === "dispatched" && (
                        <Button size="sm" onClick={() => setReceive(t)}>
                          Receive
                        </Button>
                      )}
                      {canReceive &&
                        t.sent_by !== me.data &&
                        t.status !== "dispatched" &&
                        (t.quantity_received ?? 0) > rej && (
                          <Button size="sm" variant="outline" onClick={() => setReject(t)}>
                            Reject
                          </Button>
                        )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                    {transfers.isLoading ? "Loading…" : "No bottles issued to PM yet."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <RejectionsCard factoryId={factoryId} />
      {receive && <ReceiveDialog t={receive} onClose={() => setReceive(null)} />}
      {reject && (
        <RejectDialog
          t={reject}
          alreadyRejected={rejected.get(reject.id) ?? 0}
          onClose={() => setReject(null)}
        />
      )}
    </>
  );
}
