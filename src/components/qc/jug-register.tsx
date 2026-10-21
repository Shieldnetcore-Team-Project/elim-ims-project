import { useState } from "react";
import { CheckCircle2, Download, FileSpreadsheet, Loader2, Printer } from "lucide-react";
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CountInput, ReasonDialog, fmtDateTime } from "@/components/preform/shared";
import { rpc, useUserNames } from "@/components/preform/api";
import { useFactorySettings } from "@/lib/use-factory";
import { useCurrentUserName } from "@/lib/use-current-user";
import { usePermissions } from "@/lib/permissions";
import { localDay } from "@/lib/production-shift";
import { num } from "@/lib/format";
import { formatDay } from "@/lib/jug-accountability";
import { exportCsv, exportExcel, type ReportColumn } from "@/lib/export";
import { generateReportPdf } from "@/lib/pdf";
import {
  KIND_NAME,
  STATUS_LABEL,
  useQcJugAction,
  useQcJugBatches,
  useQcJugLive,
  useQcJugReport,
  type JugBatch,
  type JugKind,
} from "./jug-api";

// Quality Control → Old & New Jugs. Jugs the Warehouse sends wait here until
// QC counts them in (Accept); QC then verifies each consignment into good
// jugs, posted to the Production Manager, and damaged ones with what is
// wrong. The register below is worked out from those steps.

const COLUMNS: ReportColumn[] = [
  { key: "sn", label: "S/N" },
  { key: "date", label: "Date" },
  { key: "name", label: "Name" },
  { key: "bf", label: "Balance B/F" },
  { key: "in", label: "Qty In" },
  { key: "total", label: "Total" },
  { key: "good", label: "Good to PM" },
  { key: "damaged", label: "Damaged" },
  { key: "out", label: "Qty Out" },
  { key: "balance", label: "Balance" },
];

export function QcJugRegister({ factoryId }: { factoryId: string }) {
  const settings = useFactorySettings(factoryId);
  const me = useCurrentUserName();
  const { canSubmit } = usePermissions();
  const canWork = canSubmit("goods-receiving");
  useQcJugLive();

  const today = localDay();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [kind, setKind] = useState<"all" | JugKind>("all");
  const rangeOk = !!from && !!to && from <= to;
  const qFrom = rangeOk ? from : today;
  const qTo = rangeOk ? to : today;

  const report = useQcJugReport(factoryId, qFrom, qTo);
  const batches = useQcJugBatches(factoryId, qFrom, qTo);
  const all = (batches.data ?? []).filter((b) => kind === "all" || b.jug_kind === kind);
  const toAccept = all.filter((b) => b.status === "sent");
  const toVerify = all.filter((b) => b.status === "accepted");
  const done = all.filter((b) => b.status === "verified" || b.status === "received");
  const names = useUserNames(
    (batches.data ?? []).flatMap((b) => [b.sent_by, b.accepted_by, b.verified_by, b.received_by]),
  );

  const [accepting, setAccepting] = useState<JugBatch | null>(null);
  const [verifying, setVerifying] = useState<JugBatch | null>(null);
  const accept = useQcJugAction(
    (a: { id: string; qty: number; note: string }) =>
      rpc<{ reference: string; accepted: number; short: number }>("accept_qc_jugs", {
        p_id: a.id,
        p_quantity: a.qty,
        p_note: a.note || null,
      }),
    (r) => {
      const x = r as { reference: string; accepted: number; short: number };
      return Number(x.short) > 0
        ? `${x.reference}: ${num(Number(x.accepted))} accepted, ${num(Number(x.short))} short`
        : `${x.reference}: ${num(Number(x.accepted))} accepted — verify them next`;
    },
  );

  const rows = (report.data ?? []).filter((r) => kind === "all" || r.jug_kind === kind);
  const sum = (k: "quantity_in" | "quantity_good" | "quantity_damaged" | "quantity_out") =>
    rows.reduce((s, r) => s + r[k], 0);
  // Jugs at QC at the end of the period, per jug.
  const closing = (k: JugKind) =>
    [...(report.data ?? [])].reverse().find((r) => r.jug_kind === k)?.balance ?? 0;
  const period = qFrom === qTo ? formatDay(qFrom) : `${formatDay(qFrom)} – ${formatDay(qTo)}`;

  const exportRows = rows.map((r, i) => ({
    sn: i + 1,
    date: r.report_date,
    name: r.jug_name,
    bf: r.balance_bf,
    in: r.quantity_in,
    total: r.total,
    good: r.quantity_good,
    damaged: r.quantity_damaged,
    out: r.quantity_out,
    balance: r.balance,
  }));
  const fileName = `qc-jugs-${qFrom}${qFrom === qTo ? "" : `-to-${qTo}`}`;
  const print = () =>
    generateReportPdf(
      "QC Jug Register — Old & New Jugs",
      COLUMNS,
      exportRows.map((r) => ({ ...r, date: formatDay(r.date) })),
      "print",
      { name: settings.data?.company_name, logo_url: settings.data?.logo_url },
      [
        `Reporting period: ${period}`,
        `Good to PM: ${num(sum("quantity_good"))} · Damaged: ${num(sum("quantity_damaged"))}`,
        `At QC at close: Old Jug ${num(closing("old"))} · New Jug ${num(closing("new"))}`,
        `Printed by: ${me.data ?? "—"}`,
      ],
    );

  const who = (id: string | null) => (id ? (names.data?.[id] ?? "") : "");

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end gap-2 p-3">
          <Button className="gap-2" onClick={print} disabled={!rows.length}>
            <Printer className="h-4 w-4" /> Print report
          </Button>
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <Input
              type="date"
              className="w-40"
              value={from}
              max={today}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To</Label>
            <Input
              type="date"
              className="w-40"
              value={to}
              min={from}
              max={today}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Name</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Old &amp; New</SelectItem>
                <SelectItem value="old">Old Jug</SelectItem>
                <SelectItem value="new">New Jug</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="ml-auto flex gap-1">
            <Button
              size="icon"
              variant="outline"
              title="Excel"
              disabled={!rows.length}
              onClick={() => exportExcel(fileName, COLUMNS, exportRows)}
            >
              <FileSpreadsheet className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              title="CSV"
              disabled={!rows.length}
              onClick={() => exportCsv(fileName, COLUMNS, exportRows)}
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>
          {!rangeOk && (
            <p className="w-full text-xs text-destructive">
              Choose a valid date range — showing today.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="From the Warehouse"
          value={num(toAccept.length)}
          hint="Consignments to accept"
        />
        <Stat label="Old Jug at QC" value={num(closing("old"))} hint={`End of ${formatDay(qTo)}`} />
        <Stat label="New Jug at QC" value={num(closing("new"))} hint={`End of ${formatDay(qTo)}`} />
        <Stat
          label="Good to PM / Damaged"
          value={`${num(sum("quantity_good"))} / ${num(sum("quantity_damaged"))}`}
          hint={period}
        />
      </div>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base">Sent by the Warehouse — to accept</CardTitle>
          <p className="text-xs text-muted-foreground">
            Count the jugs that arrived and accept them. Fewer than sent needs a note.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <BatchTable
            rows={toAccept}
            empty="Nothing waiting from the Warehouse."
            who={who}
            action={(b) =>
              canWork && (
                <Button size="sm" onClick={() => setAccepting(b)}>
                  Accept
                </Button>
              )
            }
          />
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base">Accepted — to verify</CardTitle>
          <p className="text-xs text-muted-foreground">
            Record the damaged jugs; the good ones are posted to the Production Manager.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <BatchTable
            rows={toVerify}
            empty="No jugs waiting for verification."
            who={who}
            action={(b) =>
              canWork && (
                <Button size="sm" className="gap-1" onClick={() => setVerifying(b)}>
                  <CheckCircle2 className="h-4 w-4" /> Verify
                </Button>
              )
            }
          />
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Old &amp; New Jugs — {period}</CardTitle>
          <p className="text-xs text-muted-foreground">
            Balance B/F + Qty In (accepted) = Total; Qty Out = Good to PM + Damaged; Total − Qty Out
            = Balance at QC, carried to the next day&apos;s B/F.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>S/N</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Balance B/F</TableHead>
                <TableHead className="text-right">Qty In</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Good to PM</TableHead>
                <TableHead className="text-right">Damaged</TableHead>
                <TableHead className="text-right">Qty Out</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                    {report.isLoading
                      ? "Loading…"
                      : report.error
                        ? (report.error as Error).message
                        : "No jugs for this period."}
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r, i) => (
                <TableRow key={`${r.report_date}-${r.jug_kind}`}>
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {formatDay(r.report_date)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.jug_kind === "new" ? "default" : "secondary"}>
                      {r.jug_name}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{num(r.balance_bf)}</TableCell>
                  <TableCell className="text-right">{num(r.quantity_in)}</TableCell>
                  <TableCell className="text-right font-medium">{num(r.total)}</TableCell>
                  <TableCell className="text-right text-primary">{num(r.quantity_good)}</TableCell>
                  <TableCell className="text-right text-destructive">
                    {num(r.quantity_damaged)}
                  </TableCell>
                  <TableCell className="text-right">{num(r.quantity_out)}</TableCell>
                  <TableCell className="text-right font-semibold">{num(r.balance)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            {rows.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={4}>Total for the period</TableCell>
                  <TableCell className="text-right">{num(sum("quantity_in"))}</TableCell>
                  <TableCell />
                  <TableCell className="text-right">{num(sum("quantity_good"))}</TableCell>
                  <TableCell className="text-right">{num(sum("quantity_damaged"))}</TableCell>
                  <TableCell className="text-right">{num(sum("quantity_out"))}</TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base">Verified — good posted to the PM</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Accepted</TableHead>
                <TableHead className="text-right">Good</TableHead>
                <TableHead className="text-right">Damaged</TableHead>
                <TableHead>Verified</TableHead>
                <TableHead>Production Manager</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {done.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    Nothing verified in this period.
                  </TableCell>
                </TableRow>
              )}
              {done.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="font-mono text-xs">{b.reference}</TableCell>
                  <TableCell>{KIND_NAME[b.jug_kind]}</TableCell>
                  <TableCell className="text-right">{num(b.quantity_accepted)}</TableCell>
                  <TableCell className="text-right text-primary">{num(b.quantity_good)}</TableCell>
                  <TableCell className="text-right text-destructive">
                    {num(b.quantity_damaged)}
                    {b.damage_reason && (
                      <div className="text-[11px] text-muted-foreground">{b.damage_reason}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {b.verified_at ? fmtDateTime(b.verified_at) : "—"}
                    <div className="text-muted-foreground">{who(b.verified_by)}</div>
                  </TableCell>
                  <TableCell className="text-xs">
                    <Badge variant={b.status === "received" ? "default" : "secondary"}>
                      {STATUS_LABEL[b.status]}
                    </Badge>
                    {b.received_at && (
                      <div className="text-muted-foreground">
                        {fmtDateTime(b.received_at)} · {who(b.received_by)}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ReasonDialog
        key={accepting?.id ?? "none"}
        open={!!accepting}
        onOpenChange={(o) => !o && setAccepting(null)}
        title={`Accept ${accepting?.reference ?? ""}`}
        description={`The Warehouse sent ${num(accepting?.quantity_sent ?? 0)} ${accepting ? KIND_NAME[accepting.jug_kind] : ""}(s). Enter what you counted.`}
        label="Note (required if fewer arrived)"
        required={false}
        quantity={{ label: "Jugs counted", initial: accepting?.quantity_sent ?? null }}
        confirmLabel="Accept"
        pending={accept.isPending}
        onConfirm={(note, qty) =>
          accepting &&
          accept.mutate(
            { id: accepting.id, qty: qty ?? 0, note },
            { onSuccess: () => setAccepting(null) },
          )
        }
      />
      {verifying && <VerifyDialog batch={verifying} onClose={() => setVerifying(null)} />}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="mt-1.5 text-xl font-semibold">{value}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function BatchTable({
  rows,
  empty,
  who,
  action,
}: {
  rows: JugBatch[];
  empty: string;
  who: (id: string | null) => string;
  action: (b: JugBatch) => React.ReactNode;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Reference</TableHead>
          <TableHead>Name</TableHead>
          <TableHead className="text-right">Sent</TableHead>
          <TableHead className="text-right">Accepted</TableHead>
          <TableHead>Sent by</TableHead>
          <TableHead>Notes</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
              {empty}
            </TableCell>
          </TableRow>
        )}
        {rows.map((b) => (
          <TableRow key={b.id}>
            <TableCell className="font-mono text-xs">{b.reference}</TableCell>
            <TableCell>
              <Badge variant={b.jug_kind === "new" ? "default" : "secondary"}>
                {KIND_NAME[b.jug_kind]}
              </Badge>
            </TableCell>
            <TableCell className="text-right">{num(b.quantity_sent)}</TableCell>
            <TableCell className="text-right">
              {b.quantity_accepted == null ? "—" : num(b.quantity_accepted)}
            </TableCell>
            <TableCell className="text-xs">
              {fmtDateTime(b.sent_at)}
              <div className="text-muted-foreground">{who(b.sent_by)}</div>
            </TableCell>
            <TableCell className="max-w-56 text-xs">
              {[b.send_notes, b.accept_note].filter(Boolean).join(" · ") || "—"}
            </TableCell>
            <TableCell className="text-right">{action(b)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function VerifyDialog({ batch, onClose }: { batch: JugBatch; onClose: () => void }) {
  const accepted = batch.quantity_accepted ?? 0;
  const [damaged, setDamaged] = useState<number | null>(0);
  const [reason, setReason] = useState("");
  const good = accepted - (damaged ?? 0);
  const verify = useQcJugAction(
    () =>
      rpc<{ reference: string; good: number; damaged: number }>("verify_qc_jugs", {
        p_id: batch.id,
        p_good: good,
        p_damaged: damaged ?? 0,
        p_damage_reason: reason || null,
      }),
    (r) => {
      const x = r as { reference: string; good: number; damaged: number };
      return `${x.reference}: ${num(Number(x.good))} good posted to the PM, ${num(Number(x.damaged))} damaged`;
    },
  );
  const problem =
    good < 0
      ? "Damaged cannot be more than accepted"
      : (damaged ?? 0) > 0 && !reason.trim()
        ? "Record what is wrong with the damaged jugs"
        : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Verify {batch.reference}</DialogTitle>
          <DialogDescription>
            {num(accepted)} {KIND_NAME[batch.jug_kind]}(s) accepted. Record the damaged ones; the
            rest are posted to the Production Manager as good.
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
            disabled={!!problem || verify.isPending}
            onClick={() => verify.mutate(undefined, { onSuccess: onClose })}
          >
            {verify.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Verify &amp; post to PM
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
