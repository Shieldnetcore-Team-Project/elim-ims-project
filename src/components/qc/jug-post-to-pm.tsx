import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, PackageCheck, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DatePicker } from "@/components/shared/date-picker";
import { CountInput, fmtDateTime } from "@/components/preform/shared";
import { rpc } from "@/components/preform/api";
import { usePermissions } from "@/lib/permissions";
import { useMyProductMatcher } from "@/lib/product-rules";
import { localDay } from "@/lib/production-shift";
import { num } from "@/lib/format";
import { KIND_NAME, useQcJugAction, useQcJugBatches, useQcJugLive } from "./jug-api";

// Returned empty jugs: marketer / distributor / shop -> QC -> PM (user,
// 2026-11-10). QC holds every jug brought back; once a day (or whenever she
// likes) she posts them ALL to the PM in one posting, entering the damaged
// ones; the PM confirms the posting on the Production page.
//   QcPostToPm        QC: what is with QC now + "Post to PM"
//   JugPostingsCard   every posting QC has made (PM confirms; QC reads)
// Server side: qc_post_jugs_to_pm, receive_qc_jug_posting, qc_pm_jug_postings
// (20261110140000).

type Posting = {
  posting: string;
  posted_at: string;
  posted_by: string | null;
  total: number;
  good: number;
  damaged: number;
  damage_reason: string | null;
  consignments: number;
  sources: string | null;
  status: "verified" | "received";
  received_at: string | null;
  received_by: string | null;
};

const n = (v: unknown) => (v == null ? 0 : Number(v));
// Postings go back to the start of jug tracking by default: "all QC has posted so far".
const FIRST_DAY = "2026-10-01";

function fromText(note: string | null) {
  return note?.match(/^From (.+?)(?: -- |$)/)?.[1] ?? "Store / Warehouse";
}

export function QcPostToPm({ factoryId }: { factoryId: string }) {
  const { canSubmit } = usePermissions();
  const canPost = canSubmit("goods-receiving");
  useQcJugLive();
  const today = localDay();
  const batches = useQcJugBatches(factoryId, today, today);
  const atQc = (batches.data ?? []).filter((b) => b.status === "accepted");
  const total = atQc.reduce((s, b) => s + (b.quantity_accepted ?? 0), 0);
  const [posting, setPosting] = useState(false);

  return (
    <Card className="rounded-2xl border-primary/40">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            Jugs with QC — post to PM
            <Badge variant={total > 0 ? "default" : "outline"}>{num(total)}</Badge>
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Every empty jug returned by marketers, distributors and the shop comes to QC. Post them
            all to the Production Manager in one go — daily — and record the damaged ones.
          </p>
        </div>
        {canPost && (
          <Button className="gap-2" disabled={total <= 0} onClick={() => setPosting(true)}>
            <Send className="h-4 w-4" /> Post {num(total)} to PM
          </Button>
        )}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>From</TableHead>
              <TableHead>Jug</TableHead>
              <TableHead className="text-right">Jugs</TableHead>
              <TableHead>With QC since</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {atQc.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                  {batches.isLoading ? "Loading…" : "No jugs with QC — everything has been posted."}
                </TableCell>
              </TableRow>
            )}
            {atQc.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-mono text-xs">{b.reference}</TableCell>
                <TableCell>{fromText(b.send_notes)}</TableCell>
                <TableCell className="text-xs">{KIND_NAME[b.jug_kind]}</TableCell>
                <TableCell className="text-right font-medium">{num(b.quantity_accepted)}</TableCell>
                <TableCell className="text-xs">
                  {b.accepted_at ? fmtDateTime(b.accepted_at) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          {atQc.length > 0 && (
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3}>Total with QC</TableCell>
                <TableCell className="text-right">{num(total)}</TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </CardContent>
      {posting && (
        <PostDialog factoryId={factoryId} total={total} onClose={() => setPosting(false)} />
      )}
    </Card>
  );
}

function PostDialog({
  factoryId,
  total,
  onClose,
}: {
  factoryId: string;
  total: number;
  onClose: () => void;
}) {
  const [damaged, setDamaged] = useState<number | null>(0);
  const [reason, setReason] = useState("");
  const good = total - (damaged ?? 0);
  const post = useQcJugAction(
    () =>
      rpc<{ reference: string; good: number; damaged: number }>("qc_post_jugs_to_pm", {
        p_factory: factoryId,
        p_damaged: damaged ?? 0,
        p_damage_reason: reason || null,
      }),
    (r) => {
      const x = r as { reference: string; good: number; damaged: number };
      return `${x.reference}: ${num(n(x.good))} good jugs posted to the PM${n(x.damaged) ? `, ${num(n(x.damaged))} damaged` : ""}`;
    },
  );
  const problem =
    good < 0
      ? "Damaged cannot be more than the jugs with QC"
      : (damaged ?? 0) > 0 && !reason.trim()
        ? "Record what is wrong with the damaged jugs"
        : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Post jugs to the PM</DialogTitle>
          <DialogDescription>
            {num(total)} jug(s) with QC. Enter the damaged ones; the rest go to the Production
            Manager as good.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Damaged</Label>
              <CountInput value={damaged} onChange={setDamaged} placeholder="0" />
            </div>
            <div className="space-y-1.5">
              <Label>Good (to the PM)</Label>
              <div
                className={`flex h-10 items-center rounded-md border bg-muted/30 px-3 font-semibold ${good < 0 ? "text-destructive" : "text-primary"}`}
              >
                {num(good)}
              </div>
            </div>
          </div>
          {(damaged ?? 0) > 0 && (
            <div className="space-y-1.5">
              <Label>What is wrong with the damaged jugs?</Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. cracked body, broken handle, leaking"
              />
            </div>
          )}
          {problem && <p className="text-xs text-destructive">{problem}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!!problem || post.isPending}
            onClick={() => post.mutate(undefined, { onSuccess: onClose })}
          >
            {post.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Post to PM
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Every posting QC has made to the PM. On the Production page the PM
// confirms each posting when the jugs arrive; QC sees the same list.
export function JugPostingsCard({ factoryId, mode }: { factoryId: string; mode: "qc" | "pm" }) {
  const { can } = usePermissions();
  // Empty jugs go to dispenser production only (20261102290000).
  const mine = useMyProductMatcher();
  const dispenserProduction = mine("Dispenser+Water");
  const canReceive =
    mode === "pm" &&
    dispenserProduction &&
    (can("production", "submit") || can("production", "create"));
  useQcJugLive();
  const today = localDay();
  const [from, setFrom] = useState(FIRST_DAY);
  const [to, setTo] = useState(today);
  const ok = !!from && !!to && from <= to;
  const postings = useQuery({
    queryKey: ["qc-jugs", "postings", factoryId, from, to],
    enabled: ok,
    queryFn: async () =>
      (
        (await rpc<Posting[]>("qc_pm_jug_postings", {
          p_factory: factoryId,
          p_from: from,
          p_to: to,
        })) ?? []
      ).map((p) => ({ ...p, total: n(p.total), good: n(p.good), damaged: n(p.damaged) })),
  });
  const rows = postings.data ?? [];
  const pending = rows.filter((p) => p.status === "verified" && p.good > 0);
  const receive = useQcJugAction(
    (posting: string) =>
      rpc<{ reference: string; good: number }>("receive_qc_jug_posting", {
        p_factory: factoryId,
        p_posting: posting,
      }),
    (r) => {
      const x = r as { reference: string; good: number };
      return `${x.reference}: ${num(n(x.good))} jugs received from QC`;
    },
  );
  if (mode === "pm" && !dispenserProduction) return null;
  const sum = (k: "total" | "good" | "damaged") => rows.reduce((s, r) => s + r[k], 0);

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <PackageCheck className="h-4 w-4" />
            {mode === "pm" ? "Empty jugs from QC" : "Posted to the PM"}
            {pending.length > 0 && <Badge variant="secondary">{pending.length} to confirm</Badge>}
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {mode === "pm"
              ? "Every posting QC has made: jugs returned by marketers, distributors and the shop. Confirm each one when the jugs reach Production."
              : "Every posting to the Production Manager, and whether the PM has confirmed it."}
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <Label className="text-xs">From</Label>
            <DatePicker value={from} max={to} onChange={setFrom} />
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <DatePicker value={to} min={from} max={today} onChange={setTo} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Posting</TableHead>
              <TableHead>Posted by QC</TableHead>
              <TableHead>From</TableHead>
              <TableHead className="text-right">Jugs</TableHead>
              <TableHead className="text-right">Good</TableHead>
              <TableHead className="text-right">Damaged</TableHead>
              <TableHead>Production Manager</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  {!ok
                    ? "The To date is before the From date."
                    : postings.isLoading
                      ? "Loading…"
                      : postings.error
                        ? (postings.error as Error).message
                        : "QC has not posted any jugs in this period."}
                </TableCell>
              </TableRow>
            )}
            {rows.map((p) => (
              <TableRow key={p.posting}>
                <TableCell className="font-mono text-xs">
                  {p.posting}
                  {p.consignments > 1 && (
                    <div className="text-muted-foreground">{p.consignments} returns</div>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {fmtDateTime(p.posted_at)}
                  <div className="text-muted-foreground">{p.posted_by ?? ""}</div>
                </TableCell>
                <TableCell className="max-w-64 text-xs">{p.sources ?? "—"}</TableCell>
                <TableCell className="text-right">{num(p.total)}</TableCell>
                <TableCell className="text-right font-semibold text-primary">
                  {num(p.good)}
                </TableCell>
                <TableCell className="text-right text-destructive">
                  {num(p.damaged)}
                  {p.damage_reason && (
                    <div className="text-[11px] text-muted-foreground">{p.damage_reason}</div>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  <Badge variant={p.status === "received" ? "default" : "secondary"}>
                    {p.status === "received" ? "Received" : "Waiting for PM"}
                  </Badge>
                  {p.received_at && (
                    <div className="text-muted-foreground">
                      {fmtDateTime(p.received_at)} · {p.received_by ?? ""}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {canReceive && p.status === "verified" && p.good > 0 && (
                    <Button
                      size="sm"
                      disabled={receive.isPending}
                      onClick={() => receive.mutate(p.posting)}
                    >
                      Confirm received
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          {rows.length > 0 && (
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3}>Total</TableCell>
                <TableCell className="text-right">{num(sum("total"))}</TableCell>
                <TableCell className="text-right">{num(sum("good"))}</TableCell>
                <TableCell className="text-right">{num(sum("damaged"))}</TableCell>
                <TableCell colSpan={2} />
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </CardContent>
    </Card>
  );
}
