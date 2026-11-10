import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, PackageCheck, Pencil, Search, Send } from "lucide-react";
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
import { db, rpc } from "@/components/preform/api";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMarketers } from "@/components/jugs/api";
import type { JugBatch } from "./jug-api";
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

// Quick search (user, 2026-11-10): any of the texts contains what is typed.
const matches = (term: string, ...texts: (string | number | null | undefined)[]) => {
  const t = term.trim().toLowerCase();
  return (
    !t ||
    texts.some((x) =>
      String(x ?? "")
        .toLowerCase()
        .includes(t),
    )
  );
};

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
      <Input
        className="h-9 w-56 pl-8"
        placeholder="Search reference, name…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

// The Lagos day of a timestamp ("YYYY-MM-DD").
const lagosDay = (ts: string | null) =>
  ts ? new Date(ts).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" }) : "";

function fromText(note: string | null) {
  return note?.match(/^From (.+?)(?: -- |$)/)?.[1] ?? "Store / Warehouse";
}

export function QcPostToPm({ factoryId }: { factoryId: string }) {
  const { canSubmit } = usePermissions();
  const canPost = canSubmit("goods-receiving");
  useQcJugLive();
  const today = localDay();
  // From / To on the calendars (user, 2026-11-10): every jug that came to
  // QC in those days and where it is now; both start on today's date.
  // Cleared ("All with QC now"): what is with QC now.
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const qFrom = from || to;
  const qTo = to || from;
  const day = qFrom && qTo && qFrom <= qTo ? `${qFrom}|${qTo}` : "";
  const batches = useQcJugBatches(factoryId, qFrom || today, qTo || today);
  const atQc = (batches.data ?? []).filter((b) => b.status === "accepted");
  const total = atQc.reduce((s, b) => s + (b.quantity_accepted ?? 0), 0);
  const [q, setQ] = useState("");
  const rows = (
    day
      ? (batches.data ?? []).filter((b) => {
          const d = lagosDay(b.accepted_at ?? b.sent_at);
          return ["accepted", "verified", "received"].includes(b.status) && d >= qFrom && d <= qTo;
        })
      : atQc
  ).filter((b) =>
    matches(
      q,
      b.reference,
      fromText(b.send_notes),
      KIND_NAME[b.jug_kind],
      b.pm_posting,
      b.quantity_accepted,
    ),
  );
  const shown = rows.reduce((s, b) => s + (b.quantity_accepted ?? 0), 0);
  const [posting, setPosting] = useState(false);
  // Correcting one entry (user, 2026-11-10): the pencil on each row.
  const [correcting, setCorrecting] = useState<JugBatch | null>(null);

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
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox value={q} onChange={setQ} />
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            From
            <DatePicker value={from} max={to || today} onChange={setFrom} />
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            To
            <DatePicker value={to} min={from || undefined} max={today} onChange={setTo} />
          </div>
          {(from || to) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFrom("");
                setTo("");
              }}
            >
              All with QC now
            </Button>
          )}
          {canPost && (
            <Button className="gap-2" disabled={total <= 0} onClick={() => setPosting(true)}>
              <Send className="h-4 w-4" /> Post to PM
            </Button>
          )}
        </div>
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
              {day && <TableHead>Now</TableHead>}
              {canPost && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={(day ? 6 : 5) + (canPost ? 1 : 0)}
                  className="py-6 text-center text-muted-foreground"
                >
                  {batches.isLoading
                    ? "Loading…"
                    : day
                      ? "No jugs came to QC in these days."
                      : "No jugs with QC — everything has been posted."}
                </TableCell>
              </TableRow>
            )}
            {rows.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-mono text-xs">{b.reference}</TableCell>
                <TableCell>{fromText(b.send_notes)}</TableCell>
                <TableCell className="text-xs">{KIND_NAME[b.jug_kind]}</TableCell>
                <TableCell className="text-right font-medium">{num(b.quantity_accepted)}</TableCell>
                <TableCell className="text-xs">
                  {b.accepted_at ? fmtDateTime(b.accepted_at) : "—"}
                </TableCell>
                {day && (
                  <TableCell className="text-xs">
                    <Badge
                      variant={
                        b.status === "received"
                          ? "default"
                          : b.status === "verified"
                            ? "secondary"
                            : "outline"
                      }
                    >
                      {b.status === "accepted"
                        ? "With QC"
                        : b.status === "verified"
                          ? "Posted to PM"
                          : "Received by PM"}
                    </Badge>
                    {b.pm_posting && (
                      <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                        {b.pm_posting}
                      </div>
                    )}
                  </TableCell>
                )}
                {canPost && (
                  <TableCell className="text-right">
                    {b.status === "accepted" && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        title="Correct this entry"
                        onClick={() => setCorrecting(b)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
          {rows.length > 0 && (
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3}>
                  {day
                    ? qFrom === qTo
                      ? "Total that day"
                      : "Total for these days"
                    : "Total with QC"}
                </TableCell>
                <TableCell className="text-right">{num(shown)}</TableCell>
                <TableCell colSpan={(day ? 2 : 1) + (canPost ? 1 : 0)} />
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </CardContent>
      {posting && (
        <PostDialog
          factoryId={factoryId}
          entries={atQc}
          initialFrom={day ? qFrom : undefined}
          initialTo={day ? qTo : undefined}
          onClose={() => setPosting(false)}
        />
      )}
      {correcting && (
        <CorrectDialog
          factoryId={factoryId}
          entry={correcting}
          onClose={() => setCorrecting(null)}
        />
      )}
    </Card>
  );
}

// Put one entry right: the number of jugs, who brought them back (returned
// empties), or 0 to remove it -- with a reason (correct_qc_jug_entry,
// 20261110210000). The ledger, Jugs collected, reports and Accounts follow.
function CorrectDialog({
  factoryId,
  entry,
  onClose,
}: {
  factoryId: string;
  entry: JugBatch;
  onClose: () => void;
}) {
  const returned = !!entry.collected && !!entry.from_type;
  const [qty, setQty] = useState<number | null>(entry.quantity_accepted ?? 0);
  const [from, setFrom] = useState(
    entry.from_type === "walk_in"
      ? "walk_in:"
      : entry.from_type
        ? `${entry.from_type}:${entry.from_id ?? ""}`
        : "",
  );
  const [reason, setReason] = useState("");
  const reps = useMarketers(returned ? factoryId : undefined);
  const customers = useQuery({
    queryKey: ["qc-jugs", "correct-customers", factoryId],
    enabled: returned,
    queryFn: async () => {
      const { data, error } = await db
        .from("customers")
        .select("id,name")
        .eq("factory_id", factoryId)
        .is("removed_at", null)
        .order("name");
      if (error) return [];
      return (data ?? []) as { id: string; name: string }[];
    },
  });
  const [fromType, fromId] = from.split(":");
  const shops = (reps.data ?? []).filter((r) => r.kind === "outlet");
  const marketers = (reps.data ?? []).filter((r) => r.kind !== "outlet");
  const save = useQcJugAction(
    () =>
      rpc("correct_qc_jug_entry", {
        p_id: entry.id,
        p_quantity: qty ?? 0,
        p_reason: reason,
        p_from_type: returned ? fromType || null : null,
        p_from_id: returned && fromId ? fromId : null,
      }),
    qty === 0 ? `${entry.reference} removed` : `${entry.reference} corrected`,
  );
  const changed =
    (qty ?? 0) !== (entry.quantity_accepted ?? 0) ||
    (returned &&
      from !==
        (entry.from_type === "walk_in" ? "walk_in:" : `${entry.from_type}:${entry.from_id ?? ""}`));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Correct {entry.reference}</DialogTitle>
          <DialogDescription>
            Entered as {num(entry.quantity_accepted)} {KIND_NAME[entry.jug_kind]}(s)
            {returned ? ` from ${fromText(entry.send_notes)}` : ""}. Put it right below — 0 removes
            the entry.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label>Jugs</Label>
            <CountInput value={qty} onChange={setQty} placeholder="0" />
          </div>
          {returned && (
            <div className="space-y-1.5">
              <Label>From</Label>
              <Select value={from} onValueChange={setFrom}>
                <SelectTrigger>
                  <SelectValue placeholder="Who brought them back" />
                </SelectTrigger>
                <SelectContent>
                  {shops.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Retail Shop</SelectLabel>
                      {shops.map((r) => (
                        <SelectItem key={r.id} value={`sales_rep:${r.id}`}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  <SelectGroup>
                    <SelectLabel>Marketers</SelectLabel>
                    {marketers.map((r) => (
                      <SelectItem key={r.id} value={`sales_rep:${r.id}`}>
                        {r.code ? `${r.code} · ` : ""}
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  <SelectGroup>
                    <SelectLabel>Distributors / customers</SelectLabel>
                    {(customers.data ?? []).map((c) => (
                      <SelectItem key={c.id} value={`customer:${c.id}`}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  <SelectItem value="walk_in:">Walk-in customers</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Why is it being corrected? (required)</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. wrong count, entered under the wrong marketer"
            />
          </div>
          {qty === 0 && (
            <p className="text-xs text-destructive">
              This removes the entry: the jugs go back on {returned ? "the sender’s" : "the"}{" "}
              account as not returned.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={qty === 0 ? "destructive" : "default"}
            disabled={!changed || !reason.trim() || qty == null || save.isPending}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {qty === 0 ? "Remove entry" : "Save correction"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Post to the PM by period (user, 2026-11-10): every jug that came to QC from
// one date to another -- opening on the From / To picked on the page --
// damaged, and the good ones to send (fewer is fine: the rest stays with QC).
function PostDialog({
  factoryId,
  entries,
  initialFrom,
  initialTo,
  onClose,
}: {
  factoryId: string;
  entries: JugBatch[];
  initialFrom?: string;
  initialTo?: string;
  onClose: () => void;
}) {
  const today = localDay();
  const dayOf = (e: JugBatch) => lagosDay(e.accepted_at ?? e.sent_at);
  const days = entries.map(dayOf).sort();
  const [from, setFrom] = useState(initialFrom ?? days[0] ?? today);
  const [to, setTo] = useState(initialTo ?? today);
  const total = entries
    .filter((e) => {
      const d = dayOf(e);
      return d >= from && d <= to;
    })
    .reduce((s, e) => s + (e.quantity_accepted ?? 0), 0);
  const [damaged, setDamaged] = useState<number | null>(0);
  const [reason, setReason] = useState("");
  const [good, setGood] = useState<number | null>(null);
  const goodNow = good ?? Math.max(total - (damaged ?? 0), 0);
  const kept = total - goodNow - (damaged ?? 0);
  const post = useQcJugAction(
    () =>
      rpc<{ reference: string; good: number; damaged: number; kept: number }>(
        "qc_post_jugs_to_pm",
        {
          p_factory: factoryId,
          p_damaged: damaged ?? 0,
          p_damage_reason: reason || null,
          p_good: goodNow,
          p_day: from,
          p_to: to,
        },
      ),
    (r) => {
      const x = r as { reference: string; good: number; damaged: number; kept: number };
      return `${x.reference}: ${num(n(x.good))} posted to the PM${n(x.damaged) ? `, ${num(n(x.damaged))} damaged` : ""}`;
    },
  );
  const problem =
    from > to
      ? "The To date is before the From date"
      : total <= 0
        ? "No jugs with QC in these days"
        : kept < 0
          ? "More than the jugs of these days"
          : goodNow + (damaged ?? 0) <= 0
            ? "Enter the good jugs"
            : (damaged ?? 0) > 0 && !reason.trim()
              ? "Enter what is wrong with the damaged jugs"
              : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Post jugs to the PM</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 items-end gap-3">
            <div className="space-y-1.5">
              <Label>From</Label>
              <DatePicker
                value={from}
                max={to || today}
                className="w-full"
                onChange={(d) => {
                  setFrom(d);
                  setGood(null);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>To</Label>
              <DatePicker
                value={to}
                min={from || undefined}
                max={today}
                className="w-full"
                onChange={(d) => {
                  setTo(d);
                  setGood(null);
                }}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 items-end gap-3">
            <div className="space-y-1.5">
              <Label>With QC</Label>
              <div className="flex h-9 items-center rounded-md border bg-muted/30 px-3 font-semibold">
                {num(total)}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Damaged</Label>
              <CountInput value={damaged} onChange={setDamaged} placeholder="0" />
            </div>
            <div className="space-y-1.5">
              <Label>Good (to the PM)</Label>
              <CountInput value={goodNow} onChange={(v) => setGood(v ?? 0)} placeholder="0" />
            </div>
          </div>
          {(damaged ?? 0) > 0 && (
            <div className="space-y-1.5">
              <Label>Damage</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
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
            Post {num(goodNow)} to PM
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
  // The day's activity first (user, 2026-11-10): today until another date is picked.
  const [from, setFrom] = useState(today);
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
  const [q, setQ] = useState("");
  const rows = (postings.data ?? []).filter((p) =>
    matches(q, p.posting, p.sources, p.posted_by, p.received_by, p.damage_reason, p.total),
  );
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
        <div className="flex flex-wrap items-end gap-2">
          <SearchBox value={q} onChange={setQ} />
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
