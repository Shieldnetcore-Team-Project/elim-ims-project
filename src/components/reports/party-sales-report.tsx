import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { FileSpreadsheet, FileText, Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { qcLetterheadPdf, sheetCompany } from "@/components/qc/qc-report-pdf";
import { exportExcel } from "@/lib/export";
import { logAudit } from "@/lib/audit";
import {
  PARTY_GROUPS,
  buildPartySales,
  partySalesTable,
  partySalesTitle,
  periodDays,
  type PartyGroup,
  type PartySalesRow,
  type PeriodKind,
} from "@/lib/party-sales-report";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const PERIODS: { key: PeriodKind; label: string }[] = [
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "yearly", label: "Yearly" },
  { key: "custom", label: "Custom" },
];

// All Reports › Sales Report (Marketer/Distributor): the Operations sales
// sheet, printed on the factory letterhead for everyone or one group.
export function PartySalesReport({
  factoryId,
  settings,
  printedBy,
}: {
  factoryId: string | undefined;
  settings: Parameters<typeof sheetCompany>[0];
  printedBy: string | null | undefined;
}) {
  const now = new Date();
  const [kind, setKind] = useState<PeriodKind>("weekly");
  const [group, setGroup] = useState<PartyGroup>("all");
  const [hideEmpty, setHideEmpty] = useState(false);
  const [day, setDay] = useState(format(now, "yyyy-MM-dd"));
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [from, setFrom] = useState(format(now, "yyyy-MM-01"));
  const [to, setTo] = useState(format(now, "yyyy-MM-dd"));

  const days = useMemo(
    () => periodDays(kind, { day, year, month, from, to }),
    [kind, day, year, month, from, to],
  );

  const data = useQuery({
    queryKey: ["party-sales-report", factoryId, days.from, days.to],
    enabled: !!factoryId && !!days.from && !!days.to,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "sales_report_by_party" as never,
        { p_factory: factoryId, p_from: days.from, p_to: days.to } as never,
      );
      if (error) throw error;
      return (data ?? []) as unknown as PartySalesRow[];
    },
  });

  const report = useMemo(
    () => buildPartySales(data.data ?? [], group, hideEmpty),
    [data.data, group, hideEmpty],
  );
  const table = useMemo(() => partySalesTable(report), [report]);
  const title = partySalesTitle(kind, group, days.from, days.to);

  const doPrint = (action: "print" | "download") => {
    if (table.rows.length === 0) return;
    const body = table.rows.slice(0, -1);
    const foot = table.rows[table.rows.length - 1];
    const asRow = (r: Record<string, unknown>) => table.columns.map((c) => String(r[c.key] ?? ""));
    qcLetterheadPdf(
      {
        company: sheetCompany(settings),
        filename: `Sales-Report-${days.from}-to-${days.to}`,
        reports: [
          {
            title,
            columns: table.columns.map((c, i) => ({
              label: c.label,
              align: i > 1 ? ("right" as const) : undefined,
            })),
            rows: body.map(asRow),
            foot: asRow(foot),
            printedBy,
          },
        ],
      },
      action,
    );
    logAudit({
      action: action === "print" ? "print" : "export",
      entity: "report",
      factoryId,
      newValue: { report: "Sales Report (Marketer/Distributor)", group, ...days },
    });
  };

  const years = Array.from({ length: 6 }, (_, i) => now.getFullYear() - i);

  return (
    <>
      <Card className="rounded-2xl">
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div>
            <Label className="mb-1 block text-xs">Period</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as PeriodKind)}>
              <SelectTrigger className="w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIODS.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {kind === "weekly" && (
            <div>
              <Label className="mb-1 block text-xs">Any day in the week</Label>
              <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </div>
          )}
          {kind === "monthly" && (
            <div>
              <Label className="mb-1 block text-xs">Month</Label>
              <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTHS.map((m, i) => (
                    <SelectItem key={m} value={String(i)}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {(kind === "monthly" || kind === "yearly") && (
            <div>
              <Label className="mb-1 block text-xs">Year</Label>
              <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                <SelectTrigger className="w-[100px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {years.map((y) => (
                    <SelectItem key={y} value={String(y)}>
                      {y}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {kind === "custom" && (
            <>
              <div>
                <Label className="mb-1 block text-xs">From</Label>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <Label className="mb-1 block text-xs">To</Label>
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </>
          )}
          <div>
            <Label className="mb-1 block text-xs">Print for</Label>
            <Select value={group} onValueChange={(v) => setGroup(v as PartyGroup)}>
              <SelectTrigger className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PARTY_GROUPS.map((g) => (
                  <SelectItem key={g.key} value={g.key}>
                    {g.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={hideEmpty}
              onChange={(e) => setHideEmpty(e.target.checked)}
            />
            Hide parties with no sales
          </label>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() =>
                exportExcel(`Sales-Report-${days.from}-to-${days.to}`, table.columns, table.rows)
              }
            >
              <FileSpreadsheet className="h-4 w-4" /> Excel
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => doPrint("download")}
            >
              <FileText className="h-4 w-4" /> PDF
            </Button>
            <Button size="sm" className="gap-2" onClick={() => doPrint("print")}>
              <Printer className="h-4 w-4" /> Print
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base uppercase">{title}</CardTitle>
          <p className="text-xs text-muted-foreground">
            Quantities the Warehouse sent out in the period, less what came back.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-[rgb(31,117,188)] hover:bg-[rgb(31,117,188)]">
                {table.columns.map((c, i) => (
                  <TableHead
                    key={c.key}
                    className={`text-white font-semibold ${i > 1 ? "text-right" : ""}`}
                  >
                    {c.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.rows.map((r, idx) => {
                const isTotal = idx === table.rows.length - 1;
                return (
                  <TableRow key={idx} className={isTotal ? "font-bold bg-muted" : undefined}>
                    {table.columns.map((c, i) => (
                      <TableCell
                        key={c.key}
                        className={i > 1 ? "text-right tabular-nums" : undefined}
                      >
                        {String(r[c.key] ?? "")}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
              {table.rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={table.columns.length}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {data.error instanceof Error
                      ? data.error.message
                      : data.isLoading
                        ? "Loading…"
                        : "Nothing for this period."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
