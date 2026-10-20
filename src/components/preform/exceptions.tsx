import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, ShieldCheck } from "lucide-react";
import { usePermissions } from "@/lib/permissions";
import { num } from "@/lib/format";
import {
  EXCEPTION_LABEL,
  rpc,
  useExceptions,
  useMyUserId,
  usePfAction,
  useUserNames,
  type PreformException,
} from "./api";
import { StatusBadge, fmtDateTime } from "./shared";

export function ExceptionsTab({ factoryId }: { factoryId: string }) {
  const { can } = usePermissions();
  const canResolve = can("preform-production", "reverse");
  const me = useMyUserId();
  const [filter, setFilter] = useState("open");
  const list = useExceptions(factoryId, filter === "all" ? undefined : filter);
  const names = useUserNames((list.data ?? []).flatMap((e) => [e.raised_by, e.resolved_by]));
  const [target, setTarget] = useState<PreformException | null>(null);

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Exceptions</CardTitle>
          <p className="text-sm text-muted-foreground">
            Every difference the system could not account for. Stock is never adjusted to make it
            disappear — a manager investigates and resolves it with a note.
          </p>
        </div>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="voided">Voided</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">Expected</TableHead>
              <TableHead className="text-right">Actual</TableHead>
              <TableHead className="text-right">Difference</TableHead>
              <TableHead>Raised</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(list.data ?? []).map((e) => (
              <TableRow key={e.id}>
                <TableCell className="font-mono text-xs">{e.reference}</TableCell>
                <TableCell>
                  {EXCEPTION_LABEL[e.kind]}
                  <div className="text-xs text-muted-foreground">{e.product?.name}</div>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {e.record?.reference ?? e.transfer?.reference ?? "—"}
                  {e.transfer && (
                    <div className="font-sans text-muted-foreground">
                      to {e.transfer.to_department}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">{num(e.expected_qty)}</TableCell>
                <TableCell className="text-right">{num(e.actual_qty)}</TableCell>
                <TableCell className="text-right font-semibold text-destructive">
                  {num(e.difference_qty)}
                </TableCell>
                <TableCell className="text-xs">
                  {names.data?.[e.raised_by ?? ""] ?? ""}
                  <div className="text-muted-foreground">{fmtDateTime(e.raised_at)}</div>
                  {e.note && <div className="max-w-56 text-muted-foreground">{e.note}</div>}
                </TableCell>
                <TableCell>
                  <StatusBadge status={e.status} />
                  {e.status !== "open" && (
                    <div className="mt-1 max-w-56 text-[11px] text-muted-foreground">
                      {e.resolution === "written_off"
                        ? "Written off"
                        : e.resolution === "returned_to_stock"
                          ? "Returned to stock"
                          : ""}
                      {e.resolution_note ? ` — ${e.resolution_note}` : ""}
                      {e.resolved_by && ` (${names.data?.[e.resolved_by] ?? ""})`}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {e.status === "open" && canResolve && e.raised_by !== me.data && (
                    <Button size="sm" className="gap-1" onClick={() => setTarget(e)}>
                      <ShieldCheck className="h-3.5 w-3.5" /> Resolve
                    </Button>
                  )}
                  {e.status === "open" && canResolve && e.raised_by === me.data && (
                    <span className="text-[11px] text-muted-foreground">
                      Raised by you — another manager resolves
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {(list.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  {filter === "open" ? "No open exceptions." : "Nothing here."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
      {target && <ResolveDialog e={target} onClose={() => setTarget(null)} />}
    </Card>
  );
}

function ResolveDialog({ e, onClose }: { e: PreformException; onClose: () => void }) {
  const [resolution, setResolution] = useState<"written_off" | "returned_to_stock" | "reopened">(
    "written_off",
  );
  const [note, setNote] = useState("");
  const resolve = usePfAction(
    () => rpc("resolve_preform_exception", { p_id: e.id, p_resolution: resolution, p_note: note }),
    "Exception resolved",
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Resolve {e.reference}</DialogTitle>
          <DialogDescription>
            {EXCEPTION_LABEL[e.kind]}: {num(e.difference_qty)} {e.product?.name ?? ""} unaccounted
            for.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Outcome</Label>
            <Select value={resolution} onValueChange={(v) => setResolution(v as typeof resolution)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="written_off">Accept as a loss (write off)</SelectItem>
                {e.kind === "transfer_shortfall" ? (
                  <SelectItem value="returned_to_stock">
                    Found at the Warehouse — return to stock
                  </SelectItem>
                ) : (
                  <SelectItem value="reopened">Bottles found — reopen for stocking</SelectItem>
                )}
              </SelectContent>
            </Select>
            {resolution === "reopened" && (
              <p className="text-[11px] text-muted-foreground">
                The bottles go back to &quot;left to stock&quot; on the shift record. The operator
                sends them as a new stocking and the Warehouse counts them again — nothing goes into
                stock directly.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>What was found (required)</Label>
            <Textarea rows={3} value={note} onChange={(ev) => setNote(ev.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            disabled={resolve.isPending || !note.trim()}
            onClick={() => resolve.mutate(undefined, { onSuccess: onClose })}
          >
            {resolve.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Resolve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
