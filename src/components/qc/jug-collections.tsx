import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileSpreadsheet, Printer, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { DatePicker } from "@/components/shared/date-picker";
import { fmtDateTime } from "@/components/preform/shared";
import { rpc } from "@/components/preform/api";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { useFactorySettings } from "@/lib/use-factory";
import { useCurrentUserName } from "@/lib/use-current-user";
import { localDay } from "@/lib/production-shift";
import { formatDay } from "@/lib/jug-accountability";
import { num } from "@/lib/format";
import { exportExcel, type ReportColumn } from "@/lib/export";
import { generateReportPdf } from "@/lib/pdf";
import { QcPostToPm } from "./jug-post-to-pm";
import { useQcJugBatches } from "./jug-api";

// Quality Control -> Jugs collected (user, 2026-11-10): the empty Dispenser
// Jugs collected from each marketer, distributor / customer and the shop,
// where they are now -- waiting for QC's count, with QC to verify, posted to
// the PM, received by the PM -- and who still holds jugs (not returned).
// Old and New Jug together, as everywhere. Server side:
// qc_jug_collections / qc_jug_collection_lines (20261110120000).

type Party = {
  holder_type: "sales_rep" | "customer" | "walk_in";
  holder_id: string | null;
  holder_name: string;
  holder_code: string | null;
  holder_kind: "rep" | "outlet" | "customer" | "walk_in";
  collected: number;
  awaiting_count: number;
  at_qc: number;
  posted_to_pm: number;
  received_by_pm: number;
  damaged: number;
  full_with_them: number;
  not_returned: number;
  last_collected: string | null;
};

type Stage =
  | "awaiting_count"
  | "at_qc"
  | "posted_to_pm"
  | "received_by_pm"
  | "none_counted"
  | "cancelled"
  | "direct";

type Line = {
  id: string;
  reference: string;
  collected_on: string;
  holder_type: Party["holder_type"];
  holder_id: string | null;
  holder_name: string;
  holder_kind: Party["holder_kind"];
  recorded: number;
  counted: number | null;
  good: number | null;
  damaged: number | null;
  stage: Stage;
  stage_at: string | null;
  notes: string | null;
};

const KIND_LABEL: Record<Party["holder_kind"], string> = {
  rep: "Marketer",
  outlet: "Retail shop",
  customer: "Distributor / customer",
  walk_in: "Walk-in",
};

const STAGE: Record<
  Stage,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  awaiting_count: { label: "Waiting for QC count", variant: "destructive" },
  at_qc: { label: "With QC — to verify", variant: "secondary" },
  posted_to_pm: { label: "Posted to PM — not confirmed", variant: "outline" },
  received_by_pm: { label: "Received by PM", variant: "default" },
  none_counted: { label: "Counted 0", variant: "outline" },
  cancelled: { label: "Cancelled", variant: "outline" },
  direct: { label: "Recorded directly (no QC count)", variant: "outline" },
};

type KindFilter = "all" | "rep" | "customer" | "outlet";

const n = (v: unknown) => (v == null ? 0 : Number(v));
const nn = (v: unknown) => (v == null ? null : Number(v));
const partyKey = (t: string, id: string | null) => `${t}:${id ?? ""}`;
const partyName = (p: { holder_name: string; holder_code?: string | null }) =>
  p.holder_code ? `${p.holder_name} (${p.holder_code})` : p.holder_name;
const kindOk = (k: KindFilter, kind: Party["holder_kind"]) =>
  k === "all" || k === kind || (k === "customer" && kind === "walk_in");

// Jug tracking began in October 2026.
const FIRST_DAY = "2026-10-01";

export function QcJugCollections({ factoryId }: { factoryId: string }) {
  const settings = useFactorySettings(factoryId);
  const me = useCurrentUserName();
  const today = localDay();
  // Every return recorded since jug tracking began, by default (user,
  // 2026-11-10: a record of all that was collected).
  const [from, setFrom] = useState(FIRST_DAY);
  const [to, setTo] = useState(today);
  const [kind, setKind] = useState<KindFilter>("all");
  const [show, setShow] = useState<"all" | "holding" | "with_qc">("all");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [stage, setStage] = useState<"all" | "open" | Stage>("all");
  const ok = !!from && !!to && from <= to;

  useRealtimeInvalidate(
    ["jug_returns", "qc_jug_batches", "container_movements"],
    [["qc-jugs", "collections"]],
  );

  const parties = useQuery({
    queryKey: ["qc-jugs", "collections", "parties", factoryId, from, to],
    enabled: ok,
    queryFn: async () =>
      (
        (await rpc<Party[]>("qc_jug_collections", {
          p_factory: factoryId,
          p_from: from,
          p_to: to,
        })) ?? []
      ).map((p) => ({
        ...p,
        collected: n(p.collected),
        awaiting_count: n(p.awaiting_count),
        at_qc: n(p.at_qc),
        posted_to_pm: n(p.posted_to_pm),
        received_by_pm: n(p.received_by_pm),
        damaged: n(p.damaged),
        full_with_them: n(p.full_with_them),
        not_returned: n(p.not_returned),
      })),
  });
  // The cards (user, 2026-11-10): every jug QC holds, posted and the PM
  // received -- the same figures as Collect & post to PM, whoever brought them.
  const batches = useQcJugBatches(factoryId, from, to);
  const postings = useQuery({
    queryKey: ["qc-jugs", "collections", "postings", factoryId, from, to],
    enabled: ok,
    queryFn: async () =>
      (
        (await rpc<
          { status: string; good: number; posted_at: string; received_at: string | null }[]
        >("qc_pm_jug_postings", { p_factory: factoryId, p_from: from, p_to: to })) ?? []
      ).map((p) => ({ ...p, good: n(p.good) })),
  });
  const lines = useQuery({
    queryKey: ["qc-jugs", "collections", "lines", factoryId, from, to],
    enabled: ok,
    queryFn: async () =>
      (
        (await rpc<Line[]>("qc_jug_collection_lines", {
          p_factory: factoryId,
          p_from: from,
          p_to: to,
        })) ?? []
      ).map((l) => ({
        ...l,
        recorded: n(l.recorded),
        counted: nn(l.counted),
        good: nn(l.good),
        damaged: nn(l.damaged),
      })),
  });

  const term = q.trim().toLowerCase();
  const rows = useMemo(
    () =>
      (parties.data ?? [])
        .filter(
          (p) =>
            p.holder_kind !== "outlet" &&
            kindOk(kind, p.holder_kind) &&
            (!term || partyName(p).toLowerCase().includes(term)) &&
            (show === "all" ||
              (show === "holding" && p.not_returned > 0) ||
              (show === "with_qc" && p.awaiting_count + p.at_qc + p.posted_to_pm > 0)),
        )
        .sort(
          (a, b) =>
            (show === "holding" ? b.not_returned - a.not_returned : 0) ||
            a.holder_kind.localeCompare(b.holder_kind) ||
            a.holder_name.localeCompare(b.holder_name),
        ),
    [parties.data, kind, term, show],
  );
  const pickedParty = (parties.data ?? []).find(
    (p) => partyKey(p.holder_type, p.holder_id) === picked,
  );
  const lineRows = (lines.data ?? []).filter(
    (l) =>
      (picked
        ? partyKey(l.holder_type, l.holder_id) === picked
        : kindOk(kind, l.holder_kind) && (!term || l.holder_name.toLowerCase().includes(term))) &&
      (stage === "all" ||
        (stage === "open" && ["awaiting_count", "at_qc", "posted_to_pm"].includes(l.stage)) ||
        l.stage === stage),
  );

  const sum = (k: keyof Party) => rows.reduce((s, r) => s + n(r[k]), 0);
  // The Retail Shop (factory shop) stands on its own (user, 2026-11-10).
  const shops = (parties.data ?? []).filter((p) => p.holder_kind === "outlet");
  const showShop = kind === "all" || kind === "outlet";
  const showPeople = kind !== "outlet";
  const all = parties.data ?? [];
  const total = (k: keyof Party) => all.reduce((s, r) => s + n(r[k]), 0);
  const period = from === to ? formatDay(from) : `${formatDay(from)} – ${formatDay(to)}`;
  const withQc = (batches.data ?? [])
    .filter((b) => b.status === "accepted")
    .reduce((s, b) => s + (b.quantity_accepted ?? 0), 0);
  const pst = postings.data ?? [];
  const toPm = pst.filter((p) => p.status !== "received");
  const atPm = pst.filter((p) => p.status === "received");
  const goodOf = (list: typeof pst) => list.reduce((s, p) => s + p.good, 0);

  const columns: ReportColumn[] = [
    { key: "sn", label: "S/N" },
    { key: "name", label: "Name" },
    { key: "kind", label: "Type" },
    { key: "collected", label: "Collected" },
    { key: "awaiting", label: "Waiting QC count" },
    { key: "at_qc", label: "With QC" },
    { key: "posted", label: "Posted to PM" },
    { key: "received", label: "Received by PM" },
    { key: "damaged", label: "Damaged" },
    { key: "not_returned", label: "Not returned" },
    { key: "last", label: "Last collected" },
  ];
  const exportRows = rows.map((r, i) => ({
    sn: i + 1,
    name: partyName(r),
    kind: KIND_LABEL[r.holder_kind],
    collected: r.collected,
    awaiting: r.awaiting_count,
    at_qc: r.at_qc,
    posted: r.posted_to_pm,
    received: r.received_by_pm,
    damaged: r.damaged,
    not_returned: r.not_returned,
    last: r.last_collected ? formatDay(r.last_collected) : "—",
  }));
  const print = () =>
    generateReportPdf(
      "Quality Control — Dispenser Jugs Collected",
      columns,
      exportRows,
      "print",
      { name: settings.data?.company_name, logo_url: settings.data?.logo_url },
      [
        `Collected / received / damaged: ${period}. Waiting, With QC, Posted to PM and Not returned: as of now.`,
        `Printed by: ${me.data ?? "—"}`,
      ],
    );

  const status = !ok
    ? "The To date is before the From date."
    : parties.isLoading
      ? "Loading…"
      : parties.error
        ? (parties.error as Error).message
        : null;

  return (
    <div className="space-y-4">
      {/* Filters and totals sit at the top (user, 2026-11-10). */}
      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end gap-3 p-3">
          <div>
            <Label htmlFor="jc-from" className="text-xs">
              From
            </Label>
            <DatePicker id="jc-from" value={from} max={to} onChange={setFrom} />
          </div>
          <div>
            <Label htmlFor="jc-to" className="text-xs">
              To
            </Label>
            <DatePicker id="jc-to" value={to} min={from} max={today} onChange={setTo} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">From who</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as KindFilter)}>
              <SelectTrigger className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everyone</SelectItem>
                <SelectItem value="rep">Marketers</SelectItem>
                <SelectItem value="customer">Distributors / customers</SelectItem>
                <SelectItem value="outlet">Retail Shop only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Show</Label>
            <Select value={show} onValueChange={(v) => setShow(v as typeof show)}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="holding">Not returned their jugs</SelectItem>
                <SelectItem value="with_qc">Jugs still with QC / PM</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="w-52 pl-8"
              placeholder="Search name…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="ml-auto flex gap-1">
            <Button className="gap-2" onClick={print} disabled={!!status || !rows.length}>
              <Printer className="h-4 w-4" /> Print
            </Button>
            <Button
              size="icon"
              variant="outline"
              title="Excel"
              disabled={!!status || !rows.length}
              onClick={() => exportExcel(`qc-jugs-collected-${from}-to-${to}`, columns, exportRows)}
            >
              <FileSpreadsheet className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Stat
          label="Waiting for QC count"
          value={num(total("awaiting_count"))}
          hint="Recorded by the Warehouse, not counted yet"
        />
        <Stat
          label="With QC — to verify"
          value={num(withQc)}
          hint="With QC now, not yet posted to the PM"
        />
        <Stat
          label="Posted to PM"
          value={num(goodOf(toPm))}
          hint={`${num(toPm.length)} posting(s) the PM has not confirmed yet`}
        />
        <Stat
          label="Received by PM"
          value={num(goodOf(atPm))}
          hint={`Good jugs the PM confirmed, ${period}`}
        />
        <Stat
          label="Not returned"
          value={num(total("not_returned"))}
          hint={`${num(all.filter((p) => p.not_returned > 0).length)} people still hold jugs`}
        />
      </div>

      {/* QC collects the returns and posts them to the PM daily (2026-11-10). */}
      <QcPostToPm factoryId={factoryId} />

      {showShop && (
        <Card className="rounded-2xl border-primary/30">
          <CardHeader>
            <CardTitle className="text-base">Retail Shop — empty jugs returned</CardTitle>
            <p className="text-xs text-muted-foreground">
              The factory shop, on its own. Collected, Received by PM and Damaged are for {period};
              the rest as of now.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {shops.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {status ?? "No jugs returned by or held at the Retail Shop."}
              </p>
            )}
            {shops.map((sh) => {
              const key = partyKey(sh.holder_type, sh.holder_id);
              return (
                <div key={key} className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">{partyName(sh)}</div>
                    <Button
                      size="sm"
                      variant={picked === key ? "default" : "outline"}
                      onClick={() => setPicked(picked === key ? null : key)}
                    >
                      {picked === key ? "Showing its returns below" : "See its returns"}
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-4 lg:grid-cols-7">
                    {(
                      [
                        ["Collected", sh.collected],
                        ["Waiting QC count", sh.awaiting_count],
                        ["With QC", sh.at_qc],
                        ["Posted to PM", sh.posted_to_pm],
                        ["Received by PM", sh.received_by_pm],
                        ["Damaged", sh.damaged],
                        ["Not returned", sh.not_returned],
                      ] as [string, number][]
                    ).map(([label, v]) => (
                      <div key={label} className="rounded-xl border p-2.5">
                        <div className="text-[11px] text-muted-foreground">{label}</div>
                        <div
                          className={`text-lg font-semibold ${label === "Not returned" && v > 0 ? "text-destructive" : ""}`}
                        >
                          {num(v)}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Last returned: {sh.last_collected ? formatDay(sh.last_collected) : "never"}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {showPeople && (
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="text-base">Jugs collected — marketers and distributors</CardTitle>
            <p className="text-xs text-muted-foreground">
              Collected, Received by PM and Damaged are for {period}. Waiting, With QC, Posted to PM
              and Not returned are as of now. Not returned counts every jug still with them, full or
              empty (Full = dispensers on their stock that Accounts have not recorded as sold).
              Click a name to see each collection.
            </p>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Collected</TableHead>
                  <TableHead className="text-right">Waiting QC count</TableHead>
                  <TableHead className="text-right">With QC</TableHead>
                  <TableHead className="text-right">Posted to PM</TableHead>
                  <TableHead className="text-right">Received by PM</TableHead>
                  <TableHead className="text-right">Damaged</TableHead>
                  <TableHead className="text-right">Not returned</TableHead>
                  <TableHead>Last collected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(status || rows.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                      {status ?? "No jugs collected or held for this choice."}
                    </TableCell>
                  </TableRow>
                )}
                {!status &&
                  rows.map((r) => {
                    const key = partyKey(r.holder_type, r.holder_id);
                    return (
                      <TableRow
                        key={key}
                        className={`cursor-pointer ${picked === key ? "bg-muted/60" : ""}`}
                        onClick={() => setPicked(picked === key ? null : key)}
                      >
                        <TableCell>
                          <div className="font-medium">{partyName(r)}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {KIND_LABEL[r.holder_kind]}
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {num(r.collected)}
                        </TableCell>
                        <TableCell className="text-right">
                          {r.awaiting_count > 0 ? (
                            <span className="text-amber-600">{num(r.awaiting_count)}</span>
                          ) : (
                            "0"
                          )}
                        </TableCell>
                        <TableCell className="text-right">{num(r.at_qc)}</TableCell>
                        <TableCell className="text-right">{num(r.posted_to_pm)}</TableCell>
                        <TableCell className="text-right text-primary">
                          {num(r.received_by_pm)}
                        </TableCell>
                        <TableCell className="text-right text-destructive">
                          {num(r.damaged)}
                        </TableCell>
                        <TableCell className="text-right">
                          {r.not_returned > 0 ? (
                            <span className="font-semibold text-destructive">
                              {num(r.not_returned)}
                            </span>
                          ) : (
                            "0"
                          )}
                          {r.full_with_them > 0 && (
                            <div className="text-[11px] text-muted-foreground">
                              {num(r.full_with_them)} full
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {r.last_collected ? formatDay(r.last_collected) : "Never"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
              {!status && rows.length > 0 && (
                <TableFooter>
                  <TableRow>
                    <TableCell>Total</TableCell>
                    <TableCell className="text-right">{num(sum("collected"))}</TableCell>
                    <TableCell className="text-right">{num(sum("awaiting_count"))}</TableCell>
                    <TableCell className="text-right">{num(sum("at_qc"))}</TableCell>
                    <TableCell className="text-right">{num(sum("posted_to_pm"))}</TableCell>
                    <TableCell className="text-right">{num(sum("received_by_pm"))}</TableCell>
                    <TableCell className="text-right">{num(sum("damaged"))}</TableCell>
                    <TableCell className="text-right">{num(sum("not_returned"))}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableFooter>
              )}
            </Table>
          </CardContent>
        </Card>
      )}

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">
              Each collection{pickedParty ? ` — ${partyName(pickedParty)}` : ""}
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Collections in {period}, plus any still waiting for QC or the PM from earlier days.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {pickedParty && (
              <Button size="sm" variant="ghost" className="gap-1" onClick={() => setPicked(null)}>
                <X className="h-4 w-4" /> Everyone
              </Button>
            )}
            <Select value={stage} onValueChange={(v) => setStage(v as typeof stage)}>
              <SelectTrigger className="w-60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Every stage</SelectItem>
                <SelectItem value="open">Still with QC / PM</SelectItem>
                {(Object.keys(STAGE) as Stage[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {STAGE[s].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>From</TableHead>
                <TableHead className="text-right">Recorded</TableHead>
                <TableHead className="text-right">Counted</TableHead>
                <TableHead className="text-right">Good</TableHead>
                <TableHead className="text-right">Damaged</TableHead>
                <TableHead>Where it is</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lineRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                    {lines.isLoading
                      ? "Loading…"
                      : lines.error
                        ? (lines.error as Error).message
                        : "No collections for this choice."}
                  </TableCell>
                </TableRow>
              )}
              {lineRows.map((l) => (
                <TableRow key={`${l.stage}-${l.id}`}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {formatDay(l.collected_on)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{l.reference}</TableCell>
                  <TableCell>
                    {l.holder_name}
                    <div className="text-[11px] text-muted-foreground">
                      {KIND_LABEL[l.holder_kind]}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{num(l.recorded)}</TableCell>
                  <TableCell className="text-right">
                    {l.counted == null ? "—" : num(l.counted)}
                  </TableCell>
                  <TableCell className="text-right text-primary">
                    {l.good == null ? "—" : num(l.good)}
                  </TableCell>
                  <TableCell className="text-right text-destructive">
                    {l.damaged == null ? "—" : num(l.damaged)}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Badge variant={STAGE[l.stage]?.variant ?? "outline"}>
                      {STAGE[l.stage]?.label ?? l.stage}
                    </Badge>
                    {l.stage_at && (
                      <div className="mt-0.5 text-muted-foreground">{fmtDateTime(l.stage_at)}</div>
                    )}
                  </TableCell>
                  <TableCell className="max-w-56 text-xs text-muted-foreground">
                    {l.notes ?? ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
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
