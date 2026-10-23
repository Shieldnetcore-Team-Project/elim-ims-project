import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ReportActions } from "@/components/shared/report-actions";
import { rpc } from "@/components/preform/api";
import { formatBags, splitBags } from "@/lib/preform-units";
import { localDay } from "@/lib/production-shift";
import { num } from "@/lib/format";

// Quality Control → Good bottles → QC reports: the two reports the factory
// prints for a period (qc_preform_report / qc_bottle_report,
// 20261023210000). Read from the blowing records, stockings and transfers;
// only good bottles are ever stocked.

type PreformRow = {
  material_id: string;
  material: string;
  brand: string | null;
  grammage: string | null;
  pieces_per_bag: number | null;
  received: number;
  received_bags: number | null;
  opening: number;
  total: number;
  blown: number;
  damages: number;
  expected_bottles: number;
  balance: number;
};
type BottleRow = {
  product_id: string;
  product: string;
  opening: number;
  quantity_in: number;
  total: number;
  released: number;
  balance: number;
};

const n = (v: unknown) => Number(v ?? 0);
// "PRIMA (Preform 29mm-13g)" as on the printed report.
const preformLabel = (r: PreformRow) =>
  r.brand ? `${r.material} (${r.brand}${r.grammage ? `-${r.grammage}` : ""})` : r.material;
// "684 Bags", "2 bags + 300 pcs", or pieces when the bag size is unknown.
const fromStore = (r: PreformRow) => {
  const s = splitBags(n(r.received), r.pieces_per_bag);
  return s ? formatBags(s) : `${num(n(r.received))} pcs`;
};

export function QcReportsPanel({ factoryId }: { factoryId: string }) {
  const today = localDay();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const ok = !!from && !!to && from <= to;
  const period = `FROM ${from} TO ${to}`;

  const preforms = useQuery({
    queryKey: ["qc-reports", "preform", factoryId, from, to],
    enabled: ok,
    queryFn: () =>
      rpc<PreformRow[]>("qc_preform_report", { p_factory: factoryId, p_from: from, p_to: to }),
  });
  const bottles = useQuery({
    queryKey: ["qc-reports", "bottle", factoryId, from, to],
    enabled: ok,
    queryFn: () =>
      rpc<BottleRow[]>("qc_bottle_report", { p_factory: factoryId, p_from: from, p_to: to }),
  });
  const preformRows = preforms.data ?? [];
  const bottleRows = bottles.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="qc-report-from">From</Label>
          <Input
            id="qc-report-from"
            type="date"
            className="h-9 w-40"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="qc-report-to">To</Label>
          <Input
            id="qc-report-to"
            type="date"
            className="h-9 w-40"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        {!ok && <p className="text-sm text-destructive">The end date is before the start date.</p>}
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Preform report</CardTitle>
            <p className="text-xs text-muted-foreground">
              Total = Opening + From Store · Expected Bottles = Blown − Damages (the good bottles
              stocked) · Balance = Total − Blown (preforms still held).
            </p>
          </div>
          <ReportActions
            size="sm"
            title={`Quality Control Department: Preform Report ${period}`}
            fileName={`qc-preform-report-${from}-to-${to}`}
            columns={[
              { key: "sn", label: "S/N" },
              { key: "material", label: "Material" },
              { key: "fromStore", label: "From Store" },
              { key: "pieces", label: "Pieces" },
              { key: "opening", label: "Opening" },
              { key: "total", label: "Total" },
              { key: "blown", label: "Blown" },
              { key: "damages", label: "Damages" },
              { key: "expected", label: "Expected Bottles" },
              { key: "balance", label: "Balance" },
            ]}
            rows={preformRows.map((r, i) => ({
              sn: i + 1,
              material: preformLabel(r),
              fromStore: fromStore(r),
              pieces: r.pieces_per_bag ? num(n(r.pieces_per_bag)) : "—",
              opening: num(n(r.opening)),
              total: num(n(r.total)),
              blown: num(n(r.blown)),
              damages: num(n(r.damages)),
              expected: num(n(r.expected_bottles)),
              balance: num(n(r.balance)),
            }))}
          />
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">S/N</TableHead>
                <TableHead>Material</TableHead>
                <TableHead>From Store</TableHead>
                <TableHead className="text-right">Pieces</TableHead>
                <TableHead className="text-right">Opening</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Blown</TableHead>
                <TableHead className="text-right">Damages</TableHead>
                <TableHead className="text-right">Expected Bottles</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preformRows.map((r, i) => (
                <TableRow key={r.material_id}>
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="font-medium">{preformLabel(r)}</TableCell>
                  <TableCell>{fromStore(r)}</TableCell>
                  <TableCell className="text-right">
                    {r.pieces_per_bag ? num(n(r.pieces_per_bag)) : "—"}
                  </TableCell>
                  <TableCell className="text-right">{num(n(r.opening))}</TableCell>
                  <TableCell className="text-right">{num(n(r.total))}</TableCell>
                  <TableCell className="text-right">{num(n(r.blown))}</TableCell>
                  <TableCell className="text-right text-destructive">{num(n(r.damages))}</TableCell>
                  <TableCell className="text-right font-medium">
                    {num(n(r.expected_bottles))}
                  </TableCell>
                  <TableCell className="text-right font-medium">{num(n(r.balance))}</TableCell>
                </TableRow>
              ))}
              {preformRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                    {preforms.isLoading
                      ? "Loading…"
                      : preforms.isError
                        ? (preforms.error as Error).message
                        : "No preforms received or blown in this period."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Bottles report</CardTitle>
            <p className="text-xs text-muted-foreground">
              Quantity In = good bottles stocked · Released = sent to production · Balance = Total −
              Released.
            </p>
          </div>
          <ReportActions
            size="sm"
            title={`Quality Control Department: Bottles Report ${period}`}
            fileName={`qc-bottles-report-${from}-to-${to}`}
            columns={[
              { key: "sn", label: "S/N" },
              { key: "material", label: "Material" },
              { key: "opening", label: "Opening" },
              { key: "in", label: "Quantity In" },
              { key: "total", label: "Total" },
              { key: "released", label: "Released" },
              { key: "balance", label: "Balance" },
            ]}
            rows={bottleRows.map((r, i) => ({
              sn: i + 1,
              material: r.product,
              opening: num(n(r.opening)),
              in: num(n(r.quantity_in)),
              total: num(n(r.total)),
              released: num(n(r.released)),
              balance: num(n(r.balance)),
            }))}
          />
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">S/N</TableHead>
                <TableHead>Material</TableHead>
                <TableHead className="text-right">Opening</TableHead>
                <TableHead className="text-right">Quantity In</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Released</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bottleRows.map((r, i) => (
                <TableRow key={r.product_id}>
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="font-medium">{r.product}</TableCell>
                  <TableCell className="text-right">{num(n(r.opening))}</TableCell>
                  <TableCell className="text-right">{num(n(r.quantity_in))}</TableCell>
                  <TableCell className="text-right">{num(n(r.total))}</TableCell>
                  <TableCell className="text-right">{num(n(r.released))}</TableCell>
                  <TableCell className="text-right font-medium">{num(n(r.balance))}</TableCell>
                </TableRow>
              ))}
              {bottleRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    {bottles.isLoading
                      ? "Loading…"
                      : bottles.isError
                        ? (bottles.error as Error).message
                        : "No good bottles stocked or released in this period."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
