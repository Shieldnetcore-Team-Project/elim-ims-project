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
// is still holding empty jugs they have not returned -- marketers,
// Distributors / Office Delivery and marketers' customers -- and the jugs
// owed as sold, with quantities only (no money). As of now. Server side:
// qc_jug_holders (20261114090000).

type Holder = {
  holder_type: "sales_rep" | "customer";
  holder_id: string;
  holder_name: string;
  holder_code: string | null;
  holder_kind: "rep" | "customer" | "rep_customer";
  via_name: string | null;
  phone: string | null;
  jugs_out: number;
  unsold_back: number;
  full_with_them: number;
  empties_back: number;
  waiting_count: number;
  empty_not_returned: number;
  owing_as_sold: number;
  jugs_sold: number;
  last_out: string | null;
  last_returned: string | null;
};

const NUMS = [
  "jugs_out",
  "unsold_back",
  "full_with_them",
  "empties_back",
  "waiting_count",
  "empty_not_returned",
  "owing_as_sold",
  "jugs_sold",
] as const;

const KIND_LABEL: Record<Holder["holder_kind"], string> = {
  rep: "Marketer",
  customer: "Distributor / Office Delivery",
  rep_customer: "Marketer's customer",
};

type Who = "all" | Holder["holder_kind"];
type Show = "holding" | "owing" | "sold" | "all";

const name = (h: Holder) => (h.holder_code ? `${h.holder_name} (${h.holder_code})` : h.holder_name);

function daysSince(day: string | null, today: string) {
  if (!day) return null;
  return Math.round((Date.parse(today) - Date.parse(day)) / 86_400_000);
}

export function QcJugHolders({ factoryId }: { factoryId: string }) {
  const settings = useFactorySettings(factoryId);
  const me = useCurrentUserName();
  const today = localDay();
  const [who, setWho] = useState<Who>("all");
  const [show, setShow] = useState<Show>("holding");
  const [q, setQ] = useState("");

  useRealtimeInvalidate(
    ["jug_returns", "container_movements", "stock_dispatches", "rep_returns"],
    [["qc-jugs", "holders"]],
  );

  const holders = useQuery({
    queryKey: ["qc-jugs", "holders", factoryId],
    queryFn: async () =>
      ((await rpc<Holder[]>("qc_jug_holders", { p_factory: factoryId })) ?? []).map((h) => {
        const out = { ...h };
        for (const k of NUMS) out[k] = Number(h[k] ?? 0);
        return out;
      }),
  });

  const all = useMemo(() => holders.data ?? [], [holders.data]);
  const term = q.trim().toLowerCase();
  const rows = useMemo(
    () =>
      all.filter(
        (h) =>
          (who === "all" || h.holder_kind === who) &&
          (!term ||
            name(h).toLowerCase().includes(term) ||
            (h.via_name ?? "").toLowerCase().includes(term)) &&
          (show === "all" ||
            (show === "holding" && h.empty_not_returned + h.full_with_them + h.waiting_count > 0) ||
            (show === "owing" && h.owing_as_sold > 0) ||
            (show === "sold" && h.jugs_sold > 0)),
      ),
    [all, who, term, show],
  );
  const sum = (k: (typeof NUMS)[number]) => rows.reduce((s, r) => s + r[k], 0);
  // The cards leave out marketers' customers: their jugs are already within
  // their marketer's figures.
  const main = all.filter((h) => h.holder_kind !== "rep_customer");
  const total = (k: (typeof NUMS)[number]) => main.reduce((s, r) => s + r[k], 0);

  const columns: ReportColumn[] = [
    { key: "sn", label: "S/N" },
    { key: "name", label: "Name" },
    { key: "kind", label: "Type" },
    { key: "phone", label: "Phone" },
    { key: "out", label: "Jugs out" },
    { key: "unsold", label: "Unsold back" },
    { key: "empties", label: "Empties returned" },
    { key: "waiting", label: "Waiting QC count" },
    { key: "full", label: "Full with them" },
    { key: "not_returned", label: "Empty not returned" },
    { key: "owing", label: "Owing as Empty Jug sold" },
    { key: "sold", label: "Jugs sold (theirs)" },
    { key: "last", label: "Last returned" },
  ];
  const exportRows = rows.map((r, i) => ({
    sn: i + 1,
    name: name(r),
    kind: r.via_name ? `${KIND_LABEL[r.holder_kind]} — ${r.via_name}` : KIND_LABEL[r.holder_kind],
    phone: r.phone ?? "",
    out: r.jugs_out,
    unsold: r.unsold_back,
    empties: r.empties_back,
    waiting: r.waiting_count,
    full: r.full_with_them,
    not_returned: r.empty_not_returned,
    owing: r.owing_as_sold,
    sold: r.jugs_sold,
    last: r.last_returned ? formatDay(r.last_returned) : "Never",
  }));
  const print = () =>
    generateReportPdf(
      "Quality Control — Who Holds Dispenser Jugs",
      columns,
      exportRows,
      "print",
      { name: settings.data?.company_name, logo_url: settings.data?.logo_url },
      [
        `As of ${formatDay(today)}.`,
        "Owing as Empty Jug sold: marketers' jugs not back, charged by Accounts at the Empty Jug price until returned.",
        `Printed by: ${me.data ?? "—"}`,
      ],
    );

  const status = holders.isLoading
    ? "Loading…"
    : holders.error
      ? (holders.error as Error).message
      : null;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Stat
          label="Empty jugs not returned"
          value={num(total("empty_not_returned"))}
          hint={`${num(main.filter((h) => h.empty_not_returned > 0).length)} marketers / distributors`}
          alert
        />
        <Stat
          label="Owing as Empty Jug sold"
          value={num(total("owing_as_sold"))}
          hint={`${num(main.filter((h) => h.owing_as_sold > 0).length)} marketers charged by Accounts`}
          alert
        />
        <Stat
          label="Full with marketers"
          value={num(total("full_with_them"))}
          hint="Unsold dispensers still on their vans"
        />
        <Stat
          label="Waiting for QC count"
          value={num(total("waiting_count"))}
          hint="Handed to the Warehouse, QC has not counted"
        />
        <Stat
          label="Jugs sold (theirs)"
          value={num(total("jugs_sold"))}
          hint="Jug + Water / Empty Jug — nothing to bring back"
        />
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="space-y-3">
          <div>
            <CardTitle className="text-base">
              Who holds jugs — marketers, distributors, office delivery
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              As of now. <b>Empty not returned</b>: jugs that went out and have not come back (for
              distributors the ledger can't tell full from empty). <b>Owing as Empty Jug sold</b>: a
              marketer's jugs not back — Accounts charge them at the Empty Jug price until QC counts
              them in (waiting ones included). <b>Jugs sold</b>: Jug + Water / Empty Jug sold to
              them, theirs to keep.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Who</Label>
              <Select value={who} onValueChange={(v) => setWho(v as Who)}>
                <SelectTrigger className="w-60">
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
                <SelectTrigger className="w-60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="holding">Still holding jugs</SelectItem>
                  <SelectItem value="owing">Owing as Empty Jug sold</SelectItem>
                  <SelectItem value="sold">Bought jugs (sold to them)</SelectItem>
                  <SelectItem value="all">All</SelectItem>
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
                onClick={() => exportExcel(`qc-jug-holders-${today}`, columns, exportRows)}
              >
                <FileSpreadsheet className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Jugs out</TableHead>
                <TableHead className="text-right">Unsold back</TableHead>
                <TableHead className="text-right">Empties returned</TableHead>
                <TableHead className="text-right">Waiting QC count</TableHead>
                <TableHead className="text-right">Full with them</TableHead>
                <TableHead className="text-right">Empty not returned</TableHead>
                <TableHead className="text-right">Owing as Empty Jug sold</TableHead>
                <TableHead className="text-right">Jugs sold (theirs)</TableHead>
                <TableHead>Last returned</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(status || rows.length === 0) && (
                <TableRow>
                  <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                    {status ?? "Nobody for this choice."}
                  </TableCell>
                </TableRow>
              )}
              {!status &&
                rows.map((r) => {
                  const ago = daysSince(r.last_returned, today);
                  return (
                    <TableRow key={`${r.holder_type}:${r.holder_id}`}>
                      <TableCell>
                        <div className="font-medium">{name(r)}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {KIND_LABEL[r.holder_kind]}
                          {r.via_name ? ` — ${r.via_name}` : ""}
                          {r.phone ? ` · ${r.phone}` : ""}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{num(r.jugs_out)}</TableCell>
                      <TableCell className="text-right">{num(r.unsold_back)}</TableCell>
                      <TableCell className="text-right text-primary">
                        {num(r.empties_back)}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.waiting_count > 0 ? (
                          <span className="text-amber-600">{num(r.waiting_count)}</span>
                        ) : (
                          "0"
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.holder_type === "sales_rep" ? num(r.full_with_them) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.empty_not_returned > 0 ? (
                          <span className="font-semibold text-destructive">
                            {num(r.empty_not_returned)}
                          </span>
                        ) : (
                          "0"
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.holder_type !== "sales_rep" ? (
                          "—"
                        ) : r.owing_as_sold > 0 ? (
                          <span className="font-semibold text-destructive">
                            {num(r.owing_as_sold)}
                          </span>
                        ) : (
                          "0"
                        )}
                      </TableCell>
                      <TableCell className="text-right">{num(r.jugs_sold)}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {r.last_returned ? formatDay(r.last_returned) : "Never"}
                        {ago != null && ago > 0 && (
                          <div
                            className={`text-[11px] ${ago > 7 && r.empty_not_returned > 0 ? "text-destructive" : "text-muted-foreground"}`}
                          >
                            {ago} day{ago === 1 ? "" : "s"} ago
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
            {!status && rows.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell>Total</TableCell>
                  <TableCell className="text-right">{num(sum("jugs_out"))}</TableCell>
                  <TableCell className="text-right">{num(sum("unsold_back"))}</TableCell>
                  <TableCell className="text-right">{num(sum("empties_back"))}</TableCell>
                  <TableCell className="text-right">{num(sum("waiting_count"))}</TableCell>
                  <TableCell className="text-right">{num(sum("full_with_them"))}</TableCell>
                  <TableCell className="text-right">{num(sum("empty_not_returned"))}</TableCell>
                  <TableCell className="text-right">{num(sum("owing_as_sold"))}</TableCell>
                  <TableCell className="text-right">{num(sum("jugs_sold"))}</TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </CardContent>
      </Card>
    </div>
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
