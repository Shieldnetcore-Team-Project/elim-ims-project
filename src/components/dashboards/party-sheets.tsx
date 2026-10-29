import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { generateMarketerSheetPdf } from "@/lib/pdf";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { useFactorySettings } from "@/lib/use-factory";
import {
  PARTY_KINDS,
  fetchPartySheets,
  sheetDayLabel,
  sheetMonth,
  sheetTotals,
  type PartyKind,
  type PartySheet,
  type SheetRow,
} from "@/lib/marketer-sales-sheet";

const num = (v: number) =>
  v === 0 ? "-" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(v);

type Totals = Omit<SheetRow, "day">;

// The office's monthly performance sheet ("AYUBA (OCT, 2026)": Date, Total
// Sales, Credit Sales, Cash Sales, Recovery, Total Cash Remitted) for every
// marketer, the retail shop, every distributor, and walk-ins / other customers
// together. The summary lists each party's month with a total per group and a
// grand total; picking a party shows its day-by-day sheet. Print/PDF gives the
// summary page, then one sheet per party shown.
export function PartySheetsCard({ factoryId }: { factoryId: string }) {
  const settings = useFactorySettings(factoryId);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [kind, setKind] = useState<PartyKind | "all">("all");
  const [party, setParty] = useState("all");
  const [y, m] = month.split("-").map(Number);
  const span = useMemo(() => (month ? sheetMonth(y, m - 1) : null), [month, y, m]);
  useRealtimeInvalidate(["sales", "payments_received"], [["party-sheets"]]);

  const sheets = useQuery({
    queryKey: ["party-sheets", factoryId, span?.from, span?.to],
    enabled: !!factoryId && !!span,
    queryFn: () => fetchPartySheets(supabase, factoryId, span!.from, span!.to),
  });

  const inKind = (sheets.data ?? []).filter((s) => kind === "all" || s.kind === kind);
  const selected = inKind.find((s) => s.repId === party) ?? null;
  const shown = selected ? [selected] : inKind;

  const print = (action: "print" | "download") =>
    span &&
    generateMarketerSheetPdf(
      {
        company: { name: settings.data?.company_name, logo_url: settings.data?.logo_url },
        sheets: shown,
        periodLabel: span.label,
        summary: !selected,
        fileName: selected ? selected.name : "monthly-performance",
      },
      action,
    );

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Monthly Performance by Customer · {span?.label ?? ""}</CardTitle>
          <p className="text-sm text-muted-foreground">
            Each marketer, the retail shop, each distributor, and walk-in &amp; other customers:
            total, credit and cash sales, recovery (debts paid) and total cash remitted (cash sales
            + recovery). Posted sales only, PR excluded.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="month"
            className="w-40"
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
              setParty("all");
            }}
          />
          <Select
            value={kind}
            onValueChange={(v) => {
              setKind(v as typeof kind);
              setParty("all");
            }}
          >
            <SelectTrigger className="w-[190px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Everyone</SelectItem>
              {PARTY_KINDS.map((k) => (
                <SelectItem key={k.kind} value={k.kind}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={party} onValueChange={setParty}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All ({inKind.length})</SelectItem>
              {inKind.map((s) => (
                <SelectItem key={s.repId} value={s.repId}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={shown.length === 0}
            onClick={() => print("download")}
          >
            <FileText className="h-4 w-4" /> PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={shown.length === 0}
            onClick={() => print("print")}
          >
            <Printer className="h-4 w-4" /> Print
          </Button>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {sheets.error ? (
          <p className="text-sm text-destructive">
            Could not load the sheets: {(sheets.error as Error).message}
          </p>
        ) : selected ? (
          <DaySheet sheet={selected} onBack={() => setParty("all")} />
        ) : (
          <Summary sheets={inKind} loading={sheets.isLoading} onPick={setParty} />
        )}
      </CardContent>
    </Card>
  );
}

const HEADS = ["Total Sales", "Credit Sales", "Cash Sales", "Recovery", "Total Cash Remitted"];

function Figures({ t }: { t: Totals }) {
  return (
    <>
      <TableCell className="text-right">{num(t.total)}</TableCell>
      <TableCell className="text-right">{num(t.credit)}</TableCell>
      <TableCell className="text-right">{num(t.cash)}</TableCell>
      <TableCell className="text-right">{num(t.recovery)}</TableCell>
      <TableCell className="text-right font-medium">{num(t.remitted)}</TableCell>
    </>
  );
}

const sum = (list: PartySheet[]) => sheetTotals(list.map((s) => ({ day: "", ...s.totals })));

function Summary({
  sheets,
  loading,
  onPick,
}: {
  sheets: PartySheet[];
  loading: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          {HEADS.map((h) => (
            <TableHead key={h} className="text-right">
              {h}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {PARTY_KINDS.map((k) => {
          const group = sheets.filter((s) => s.kind === k.kind);
          if (group.length === 0) return null;
          return [
            <TableRow key={`h-${k.kind}`} className="bg-muted/50">
              <TableCell colSpan={6} className="text-xs font-semibold uppercase">
                {k.label}
              </TableCell>
            </TableRow>,
            ...group.map((s) => (
              <TableRow
                key={s.repId}
                className="cursor-pointer"
                title="Show the day-by-day sheet"
                onClick={() => onPick(s.repId)}
              >
                <TableCell className="text-primary underline-offset-2 hover:underline">
                  {s.name}
                  {s.code && <span className="text-xs text-muted-foreground"> ({s.code})</span>}
                </TableCell>
                <Figures t={s.totals} />
              </TableRow>
            )),
            <TableRow key={`t-${k.kind}`} className="font-bold">
              <TableCell>Total {k.label.toLowerCase()}</TableCell>
              <Figures t={sum(group)} />
            </TableRow>,
          ];
        })}
        {sheets.length > 0 ? (
          <TableRow className="bg-muted font-bold">
            <TableCell>Grand total</TableCell>
            <Figures t={sum(sheets)} />
          </TableRow>
        ) : (
          <TableRow>
            <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
              {loading ? "Loading…" : "No sales or recoveries in this month."}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

function DaySheet({ sheet, onBack }: { sheet: PartySheet; onBack: () => void }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold">
          {sheet.name.toUpperCase()}
          {sheet.code && (
            <span className="text-xs font-normal text-muted-foreground"> ({sheet.code})</span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← All
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            {HEADS.map((h) => (
              <TableHead key={h} className="text-right">
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sheet.rows.map((r) => (
            <TableRow key={r.day}>
              <TableCell className="whitespace-nowrap">{sheetDayLabel(r.day)}</TableCell>
              <Figures t={r} />
            </TableRow>
          ))}
          <TableRow className="bg-muted font-bold">
            <TableCell>TOTAL</TableCell>
            <Figures t={sheet.totals} />
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
