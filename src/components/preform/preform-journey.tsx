import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatPieces } from "@/lib/preform-units";
import { num } from "@/lib/format";
import { preformDetail, usePreformOverview, useTransfers } from "./api";

// Store → Preform Inventory → Store to PM (moved from Quality Control →
// Preforms, 2026-10-26).
// Every preform, from the Store to the good bottles, one line each
// (qc_preform_overview), then the good bottles sent to PM by bottle type.
export function PreformJourney({ factoryId }: { factoryId: string }) {
  const overview = usePreformOverview(factoryId);
  const transfers = useTransfers(factoryId);
  const rows = overview.data ?? [];
  const toPm = new Map<string, { sent: number; received: number; inTransit: number }>();
  for (const t of transfers.data ?? []) {
    if (t.status === "cancelled" || t.status === "reversed") continue;
    const k = t.product?.name ?? "—";
    const x = toPm.get(k) ?? { sent: 0, received: 0, inTransit: 0 };
    x.sent += t.quantity_sent;
    if (t.status === "dispatched") x.inTransit += t.quantity_sent;
    else x.received += t.quantity_received ?? 0;
    toPm.set(k, x);
  }

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>All preforms — Store to PM</CardTitle>
        <p className="text-xs text-muted-foreground">
          Every preform with its details: what the Store issued, what QC has accepted, blown and
          damaged, the good bottles (Blown − Damages) and what QC still holds.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Preform</TableHead>
              <TableHead>Pieces/bag</TableHead>
              <TableHead className="text-right">In Store</TableHead>
              <TableHead className="text-right">Issued</TableHead>
              <TableHead className="text-right">Waiting to accept</TableHead>
              <TableHead className="text-right">Received by QC</TableHead>
              <TableHead className="text-right">Blown</TableHead>
              <TableHead className="text-right">Damages</TableHead>
              <TableHead className="text-right">Good bottles</TableHead>
              <TableHead className="text-right">QC holds</TableHead>
              <TableHead>Last issued</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((o) => {
              const detail = preformDetail(o);
              return (
                <TableRow key={o.material_id}>
                  <TableCell>
                    <div className="font-medium">{o.material}</div>
                    {detail && <div className="text-[11px] text-muted-foreground">{detail}</div>}
                  </TableCell>
                  <TableCell>{o.pieces_per_bag ? num(o.pieces_per_bag) : "—"}</TableCell>
                  <TableCell className="text-right">
                    {formatPieces(o.in_store, o.pieces_per_bag)}
                  </TableCell>
                  <TableCell className="text-right">{num(o.issued)}</TableCell>
                  <TableCell className="text-right">
                    {o.waiting > 0 ? <Badge variant="secondary">{num(o.waiting)}</Badge> : "0"}
                  </TableCell>
                  <TableCell className="text-right">{num(o.received)}</TableCell>
                  <TableCell className="text-right">{num(o.blown)}</TableCell>
                  <TableCell className="text-right text-destructive">{num(o.damages)}</TableCell>
                  <TableCell className="text-right font-medium">{num(o.good)}</TableCell>
                  <TableCell className="text-right">{num(o.qc_holds)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{o.last_issue ?? "—"}</TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={11} className="py-6 text-center text-muted-foreground">
                  {overview.isLoading
                    ? "Loading…"
                    : overview.isError
                      ? (overview.error as Error).message
                      : "No preforms set up yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {toPm.size > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
              Good bottles sent to PM
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bottle type</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead className="text-right">Received by PM</TableHead>
                  <TableHead className="text-right">On the way</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...toPm.entries()].map(([name, x]) => (
                  <TableRow key={name}>
                    <TableCell>{name}</TableCell>
                    <TableCell className="text-right">{num(x.sent)}</TableCell>
                    <TableCell className="text-right">{num(x.received)}</TableCell>
                    <TableCell className="text-right">{num(x.inTransit)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
