import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileSpreadsheet, Printer, Search } from "lucide-react";
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
import { rpc } from "@/components/preform/api";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { useFactorySettings } from "@/lib/use-factory";
import { useCurrentUserName } from "@/lib/use-current-user";
import { localDay } from "@/lib/production-shift";
import { formatDay } from "@/lib/jug-accountability";
import { num } from "@/lib/format";
import { exportExcel, type ReportColumn } from "@/lib/export";
import { generateReportPdf } from "@/lib/pdf";

// Quality Control -> Dispenser Jug -> Accountability (user, 2026-11-14): who
// still holds jugs -- marketers, Distributors / Office Delivery, marketers'
// customers -- worked out day by day from their postings and returns, for any
// From / To the user picks. Quantities only (no money). Server side:
// qc_jug_holder_days and qc_jug_holders (20261114100000), both from the same
// daily calculation, so the two always agree.

type Kind = "rep" | "customer" | "rep_customer";

type DayRow = {
  day: string;
  holder_type: "sales_rep" | "customer";
  holder_id: string;
  holder_name: string;
  holder_code: string | null;
  holder_kind: Kind;
  via_name: string | null;
  brought_forward: number;
  supplied: number;
  opening: number;
  unsold_back: number;
  empties_back: number;
  written_off: number;
  sold_on: number;
  with_them: number;
  jugs_sold: number;
};

type NowRow = {
  holder_type: "sales_rep" | "customer";
  holder_id: string;
  phone: string | null;
  with_them: number;
  full_with_them: number;
  waiting_count: number;
  empty_not_returned: number;
  owing_as_sold: number;
  last_returned: string | null;
};

const DAY_NUMS = [
  "brought_forward",
  "supplied",
  "opening",
  "unsold_back",
  "empties_back",
  "written_off",
  "sold_on",
  "with_them",
  "jugs_sold",
] as const;
const NOW_NUMS = [
  "with_them",
  "full_with_them",
  "waiting_count",
  "empty_not_returned",
  "owing_as_sold",
] as const;

// One person over the period: b/f on the first day, c/f on the last.
type Person = Omit<DayRow, "day"> & {
  key: string;
  phone: string | null;
  last_returned: string | null;
  now: NowRow | null;
};

const KIND_LABEL: Record<Kind, string> = {
  rep: "Marketer",
  customer: "Distributor / Office Delivery",
  rep_customer: "Marketer's customer",
};

type Who = "all" | Kind;
type Show = "holding" | "owing" | "sold" | "all";
type View = "person" | "day";

const keyOf = (r: { holder_type: string; holder_id: string }) => `${r.holder_type}:${r.holder_id}`;
const nameOf = (r: { holder_name: string; holder_code: string | null }) =>
  r.holder_code ? `${r.holder_name} (${r.holder_code})` : r.holder_name;
const kindText = (r: { holder_kind: Kind; via_name: string | null }) =>
  r.via_name ? `${KIND_LABEL[r.holder_kind]} — ${r.via_name}` : KIND_LABEL[r.holder_kind];

function daysSince(day: string | null, today: string) {
  if (!day) return null;
  return Math.round((Date.parse(today) - Date.parse(day)) / 86_400_000);
}

export function QcJugHolders({ factoryId }: { factoryId: string }) {
  const settings = useFactorySettings(factoryId);
  const me = useCurrentUserName();
  const today = localDay();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [who, setWho] = useState<Who>("all");
  const [show, setShow] = useState<Show>("holding");
  const [view, setView] = useState<View>("person");
  const [q, setQ] = useState("");
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  const ok = !!from && !!to && from <= to && span <= 92;
  // Full on the van, waiting for QC and owing are only known for today.
  const isNow = to === today;

  useRealtimeInvalidate(
    ["jug_returns", "container_movements", "stock_dispatches", "rep_returns"],
    [["qc-jugs", "holders"]],
  );

  const days = useQuery({
    queryKey: ["qc-jugs", "holders", "days", factoryId, from, to],
    enabled: ok,
    queryFn: async () =>
      (
        (await rpc<DayRow[]>("qc_jug_holder_days", {
          p_factory: factoryId,
          p_from: from,
          p_to: to,
        })) ?? []
      ).map((r) => {
        const out = { ...r };
        for (const k of DAY_NUMS) out[k] = Number(r[k] ?? 0);
        return out;
      }),
  });
  const now = useQuery({
    queryKey: ["qc-jugs", "holders", "now", factoryId],
    queryFn: async () =>
      ((await rpc<NowRow[]>("qc_jug_holders", { p_factory: factoryId })) ?? []).map((r) => {
        const out = { ...r };
        for (const k of NOW_NUMS) out[k] = Number(r[k] ?? 0);
        return out;
      }),
  });

  const nowByKey = useMemo(() => new Map((now.data ?? []).map((r) => [keyOf(r), r])), [now.data]);

  // Rows come newest day first; walk oldest first to get b/f and c/f.
  const people = useMemo(() => {
    const map = new Map<string, Person>();
    for (const r of [...(days.data ?? [])].reverse()) {
      const key = keyOf(r);
      const p = map.get(key);
      if (!p) {
        const n = nowByKey.get(key) ?? null;
        map.set(key, {
          ...r,
          key,
          phone: n?.phone ?? null,
          last_returned: n?.last_returned ?? null,
          now: n,
        });
      } else {
        p.supplied += r.supplied;
        p.opening += r.opening;
        p.unsold_back += r.unsold_back;
        p.empties_back += r.empties_back;
        p.written_off += r.written_off;
        p.sold_on += r.sold_on;
        p.jugs_sold += r.jugs_sold;
        p.with_them = r.with_them;
      }
    }
    return [...map.values()];
  }, [days.data, nowByKey]);

  const term = q.trim().toLowerCase();
  const match = (r: {
    holder_kind: Kind;
    holder_name: string;
    holder_code: string | null;
    via_name: string | null;
  }) =>
    (who === "all" || r.holder_kind === who) &&
    (!term ||
      nameOf(r).toLowerCase().includes(term) ||
      (r.via_name ?? "").toLowerCase().includes(term));
  const keep = (p: Person) =>
    show === "all" ||
    (show === "holding" && p.with_them !== 0) ||
    (show === "owing" && (p.now?.owing_as_sold ?? 0) > 0) ||
    (show === "sold" && p.jugs_sold > 0);
  const personRows = people
    .filter((p) => match(p) && keep(p))
    .sort(
      (a, b) =>
        b.with_them - a.with_them ||
        a.holder_kind.localeCompare(b.holder_kind) ||
        a.holder_name.localeCompare(b.holder_name),
    );
  const shownKeys = new Set(personRows.map((p) => p.key));
  const dayRows = (days.data ?? []).filter((r) => shownKeys.has(keyOf(r)));

  // The cards leave out marketers' customers: their jugs are already counted
  // with their marketer.
  const main = people.filter((p) => p.holder_kind !== "rep_customer");
  const mainSum = (f: (p: Person) => number) => main.reduce((s, p) => s + f(p), 0);
  const rowSum = (f: (p: Person) => number) => personRows.reduce((s, p) => s + f(p), 0);
  const daySum = (k: (typeof DAY_NUMS)[number]) => dayRows.reduce((s, r) => s + r[k], 0);
  const period = from === to ? formatDay(from) : `${formatDay(from)} – ${formatDay(to)}`;

  const status = !ok
    ? from > to
      ? "The To date is before the From date."
      : "Choose 3 months or less."
    : days.isLoading
      ? "Loading…"
      : days.error
        ? (days.error as Error).message
        : null;

  // ---------------------------------------------------------------- export
  const movementCols: ReportColumn[] = [
    { key: "bf", label: "B/f" },
    { key: "supplied", label: "Posted / supplied" },
    { key: "opening", label: "Opening bal." },
    { key: "unsold", label: "Unsold back" },
    { key: "empties", label: "Empties returned" },
    { key: "lost", label: "Written off" },
    { key: "sold_on", label: "Sold on" },
    { key: "with_them", label: "With them (c/f)" },
  ];
  const nowCols: ReportColumn[] = isNow
    ? [
        { key: "full", label: "Full on van" },
        { key: "waiting", label: "Waiting QC count" },
        { key: "not_returned", label: "Empty not returned" },
        { key: "owing", label: "Owing as Empty Jug sold" },
      ]
    : [];
  const columns: ReportColumn[] =
    view === "person"
      ? [
          { key: "sn", label: "S/N" },
          { key: "name", label: "Name" },
          { key: "kind", label: "Type" },
          ...movementCols,
          ...nowCols,
          { key: "sold", label: "Jugs sold (theirs)" },
        ]
      : [
          { key: "sn", label: "S/N" },
          { key: "date", label: "Date" },
          { key: "name", label: "Name" },
          { key: "kind", label: "Type" },
          ...movementCols,
          { key: "sold", label: "Jugs sold (theirs)" },
        ];
  const moves = (r: Omit<DayRow, "day">) => ({
    bf: r.brought_forward,
    supplied: r.supplied,
    opening: r.opening,
    unsold: r.unsold_back,
    empties: r.empties_back,
    lost: r.written_off,
    sold_on: r.sold_on,
    with_them: r.with_them,
    sold: r.jugs_sold,
  });
  const exportRows =
    view === "person"
      ? personRows.map((p, i) => ({
          sn: i + 1,
          name: nameOf(p),
          kind: kindText(p),
          ...moves(p),
          full: p.now?.full_with_them ?? 0,
          waiting: p.now?.waiting_count ?? 0,
          not_returned: p.now?.empty_not_returned ?? 0,
          owing: p.holder_type === "sales_rep" ? (p.now?.owing_as_sold ?? 0) : "—",
        }))
      : dayRows.map((r, i) => ({
          sn: i + 1,
          date: formatDay(r.day),
          name: nameOf(r),
          kind: kindText(r),
          ...moves(r),
        }));
  const print = () =>
    generateReportPdf(
      view === "person"
        ? "Quality Control — Who Holds Dispenser Jugs"
        : "Quality Control — Dispenser Jugs Day by Day",
      columns,
      exportRows,
      "print",
      { name: settings.data?.company_name, logo_url: settings.data?.logo_url },
      [
        `Period: ${period}. From marketers' postings and returns and the jug ledger, on the day of each.`,
        ...(isNow
          ? [
              "Owing as Empty Jug sold: marketers' jugs not back that Accounts charge at the Empty Jug price.",
            ]
          : []),
        `Printed by: ${me.data ?? "—"}`,
      ],
    );

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end gap-3 p-3">
          <div>
            <Label htmlFor="jh-from" className="text-xs">
              From
            </Label>
            <DatePicker id="jh-from" value={from} max={to} onChange={setFrom} />
          </div>
          <div>
            <Label htmlFor="jh-to" className="text-xs">
              To
            </Label>
            <DatePicker id="jh-to" value={to} min={from} max={today} onChange={setTo} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Who</Label>
            <Select value={who} onValueChange={(v) => setWho(v as Who)}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everyone</SelectItem>
                <SelectItem value="rep">Marketers</SelectItem>
                <SelectItem value="customer">Distributors / Office Delivery</SelectItem>
                <SelectItem value="rep_customer">Marketers' customers</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Show</Label>
            <Select value={show} onValueChange={(v) => setShow(v as Show)}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="holding">Still holding jugs</SelectItem>
                {isNow && <SelectItem value="owing">Owing as Empty Jug sold</SelectItem>}
                <SelectItem value="sold">Bought jugs (sold to them)</SelectItem>
                <SelectItem value="all">Everyone with activity</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="w-48 pl-8"
              placeholder="Search name…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="ml-auto flex gap-1">
            <Button className="gap-2" onClick={print} disabled={!!status || !exportRows.length}>
              <Printer className="h-4 w-4" /> Print
            </Button>
            <Button
              size="icon"
              variant="outline"
              title="Excel"
              disabled={!!status || !exportRows.length}
              onClick={() =>
                exportExcel(
                  `qc-jug-holders-${view === "person" ? "per-person" : "daily"}-${from}-to-${to}`,
                  columns,
                  exportRows,
                )
              }
            >
              <FileSpreadsheet className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Stat label="Posted / supplied" value={num(mainSum((p) => p.supplied))} hint={period} />
        <Stat label="Empties returned" value={num(mainSum((p) => p.empties_back))} hint={period} />
        <Stat
          label={`With them on ${formatDay(to)}`}
          value={num(mainSum((p) => p.with_them))}
          hint={`${num(main.filter((p) => p.with_them > 0).length)} marketers / distributors`}
          alert
        />
        {isNow && (
          <>
            <Stat
              label="Empty not returned"
              value={num(mainSum((p) => p.now?.empty_not_returned ?? 0))}
              hint="Not full on a van, not waiting for QC"
              alert
            />
            <Stat
              label="Owing as Empty Jug sold"
              value={num(mainSum((p) => p.now?.owing_as_sold ?? 0))}
              hint="Marketers, as Accounts charge them"
              alert
            />
            <Stat
              label="Waiting for QC count"
              value={num(mainSum((p) => p.now?.waiting_count ?? 0))}
              hint="Handed to the Warehouse"
            />
          </>
        )}
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">
              Who holds jugs — marketers, distributors, office delivery · {period}
            </CardTitle>
            <div className="flex gap-1 rounded-md border p-0.5">
              {(
                [
                  ["person", "Per person"],
                  ["day", "Day by day"],
                ] as [View, string][]
              ).map(([v, label]) => (
                <Button
                  key={v}
                  size="sm"
                  variant={view === v ? "default" : "ghost"}
                  className="h-7 px-3"
                  onClick={() => setView(v)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Worked out day by day: marketers from their postings (posting day) and returns (return
            day, back-dated returns on their own day); distributors and office delivery from their
            invoices and returns. <b>B/f</b> is what they held the morning of {formatDay(from)};{" "}
            <b>With them</b> is what they held at the close of each day (full or empty). A marketer
            answers for every Dispenser Water posted until it comes back, sold or not.{" "}
            {isNow ? (
              <>
                <b>Empty not returned</b> leaves out what is full on the van and what is waiting for
                QC's count. <b>Owing as Empty Jug sold</b> is what Accounts charge (opening balances
                aside).
              </>
            ) : (
              <>Set To to today to see full on the van, waiting for QC and owing.</>
            )}{" "}
            <b>Jugs sold</b>: Jug + Water / Empty Jug sold to them — theirs to keep.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {view === "person" ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">B/f</TableHead>
                  <TableHead className="text-right">Posted / supplied</TableHead>
                  <TableHead className="text-right">Opening bal.</TableHead>
                  <TableHead className="text-right">Unsold back</TableHead>
                  <TableHead className="text-right">Empties returned</TableHead>
                  <TableHead className="text-right">Written off</TableHead>
                  <TableHead className="text-right">Sold on</TableHead>
                  <TableHead className="text-right">With them</TableHead>
                  {isNow && (
                    <>
                      <TableHead className="text-right">Full on van</TableHead>
                      <TableHead className="text-right">Waiting QC count</TableHead>
                      <TableHead className="text-right">Empty not returned</TableHead>
                      <TableHead className="text-right">Owing as Empty Jug sold</TableHead>
                    </>
                  )}
                  <TableHead className="text-right">Jugs sold (theirs)</TableHead>
                  <TableHead>Last returned</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(status || personRows.length === 0) && (
                  <TableRow>
                    <TableCell
                      colSpan={isNow ? 15 : 11}
                      className="py-8 text-center text-muted-foreground"
                    >
                      {status ?? "Nobody for this choice."}
                    </TableCell>
                  </TableRow>
                )}
                {!status &&
                  personRows.map((p) => {
                    const ago = daysSince(p.last_returned, today);
                    return (
                      <TableRow key={p.key}>
                        <TableCell>
                          <div className="font-medium">{nameOf(p)}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {kindText(p)}
                            {p.phone ? ` · ${p.phone}` : ""}
                          </div>
                        </TableCell>
                        <MoveCells r={p} />
                        {isNow && (
                          <>
                            <TableCell className="text-right">
                              {p.holder_type === "sales_rep"
                                ? num(p.now?.full_with_them ?? 0)
                                : "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              <Warn v={p.now?.waiting_count ?? 0} tone="amber" />
                            </TableCell>
                            <TableCell className="text-right">
                              <Warn v={p.now?.empty_not_returned ?? 0} />
                            </TableCell>
                            <TableCell className="text-right">
                              {p.holder_type === "sales_rep" ? (
                                <Warn v={p.now?.owing_as_sold ?? 0} />
                              ) : (
                                "—"
                              )}
                            </TableCell>
                          </>
                        )}
                        <TableCell className="text-right">{num(p.jugs_sold)}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {p.last_returned ? formatDay(p.last_returned) : "Never"}
                          {ago != null && ago > 0 && (
                            <div
                              className={`text-[11px] ${ago > 7 && p.with_them > 0 ? "text-destructive" : "text-muted-foreground"}`}
                            >
                              {ago} day{ago === 1 ? "" : "s"} ago
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
              {!status && personRows.length > 0 && (
                <TableFooter>
                  <TableRow>
                    <TableCell>Total</TableCell>
                    <TableCell className="text-right">
                      {num(rowSum((p) => p.brought_forward))}
                    </TableCell>
                    <TableCell className="text-right">{num(rowSum((p) => p.supplied))}</TableCell>
                    <TableCell className="text-right">{num(rowSum((p) => p.opening))}</TableCell>
                    <TableCell className="text-right">
                      {num(rowSum((p) => p.unsold_back))}
                    </TableCell>
                    <TableCell className="text-right">
                      {num(rowSum((p) => p.empties_back))}
                    </TableCell>
                    <TableCell className="text-right">
                      {num(rowSum((p) => p.written_off))}
                    </TableCell>
                    <TableCell className="text-right">{num(rowSum((p) => p.sold_on))}</TableCell>
                    <TableCell className="text-right">{num(rowSum((p) => p.with_them))}</TableCell>
                    {isNow && (
                      <>
                        <TableCell className="text-right">
                          {num(rowSum((p) => p.now?.full_with_them ?? 0))}
                        </TableCell>
                        <TableCell className="text-right">
                          {num(rowSum((p) => p.now?.waiting_count ?? 0))}
                        </TableCell>
                        <TableCell className="text-right">
                          {num(rowSum((p) => p.now?.empty_not_returned ?? 0))}
                        </TableCell>
                        <TableCell className="text-right">
                          {num(rowSum((p) => p.now?.owing_as_sold ?? 0))}
                        </TableCell>
                      </>
                    )}
                    <TableCell className="text-right">{num(rowSum((p) => p.jugs_sold))}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableFooter>
              )}
            </Table>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">B/f</TableHead>
                  <TableHead className="text-right">Posted / supplied</TableHead>
                  <TableHead className="text-right">Opening bal.</TableHead>
                  <TableHead className="text-right">Unsold back</TableHead>
                  <TableHead className="text-right">Empties returned</TableHead>
                  <TableHead className="text-right">Written off</TableHead>
                  <TableHead className="text-right">Sold on</TableHead>
                  <TableHead className="text-right">With them (c/f)</TableHead>
                  <TableHead className="text-right">Jugs sold (theirs)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(status || dayRows.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
                      {status ?? "Nothing for this choice."}
                    </TableCell>
                  </TableRow>
                )}
                {!status &&
                  dayRows.map((r) => (
                    <TableRow key={`${r.day}:${keyOf(r)}`}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {formatDay(r.day)}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{nameOf(r)}</div>
                        <div className="text-[11px] text-muted-foreground">{kindText(r)}</div>
                      </TableCell>
                      <MoveCells r={r} />
                      <TableCell className="text-right">{num(r.jugs_sold)}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
              {!status && dayRows.length > 0 && (
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={3}>Total moved in the period</TableCell>
                    <TableCell className="text-right">{num(daySum("supplied"))}</TableCell>
                    <TableCell className="text-right">{num(daySum("opening"))}</TableCell>
                    <TableCell className="text-right">{num(daySum("unsold_back"))}</TableCell>
                    <TableCell className="text-right">{num(daySum("empties_back"))}</TableCell>
                    <TableCell className="text-right">{num(daySum("written_off"))}</TableCell>
                    <TableCell className="text-right">{num(daySum("sold_on"))}</TableCell>
                    <TableCell />
                    <TableCell className="text-right">{num(daySum("jugs_sold"))}</TableCell>
                  </TableRow>
                </TableFooter>
              )}
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// B/f, the day's movements and c/f -- the same in both tables.
function MoveCells({ r }: { r: Omit<DayRow, "day"> }) {
  return (
    <>
      <TableCell className="text-right">{num(r.brought_forward)}</TableCell>
      <TableCell className="text-right">{num(r.supplied)}</TableCell>
      <TableCell className="text-right">{r.opening ? num(r.opening) : "0"}</TableCell>
      <TableCell className="text-right">{num(r.unsold_back)}</TableCell>
      <TableCell className="text-right text-primary">{num(r.empties_back)}</TableCell>
      <TableCell className="text-right">{num(r.written_off)}</TableCell>
      <TableCell className="text-right">{num(r.sold_on)}</TableCell>
      <TableCell className="text-right">
        {r.with_them < 0 ? (
          <span
            className="font-semibold text-amber-600"
            title="More came back than was recorded going out -- check their postings"
          >
            {num(r.with_them)}
          </span>
        ) : (
          <Warn v={r.with_them} />
        )}
      </TableCell>
    </>
  );
}

function Warn({ v, tone = "red" }: { v: number; tone?: "red" | "amber" }) {
  if (!v) return <>0</>;
  return (
    <span className={`font-semibold ${tone === "amber" ? "text-amber-600" : "text-destructive"}`}>
      {num(v)}
    </span>
  );
}

function Stat({
  label,
  value,
  hint,
  alert,
}: {
  label: string;
  value: string;
  hint?: string;
  alert?: boolean;
}) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
        <div
          className={`mt-1.5 text-xl font-semibold ${alert && value !== "0" ? "text-destructive" : ""}`}
        >
          {value}
        </div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}
