import { useMemo, useState } from "react";
import { FileSpreadsheet, FileText, Printer } from "lucide-react";
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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useUserNames } from "@/components/preform/api";
import { exportCsv, exportExcel, type ReportColumn } from "@/lib/export";
import { generateReportPdf, type PdfAction } from "@/lib/pdf";
import { useFactorySettings } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { addDays, localDay } from "@/lib/production-shift";
import { money, num } from "@/lib/format";
import { splitBags } from "@/lib/preform-units";
import {
  CHECK_LABEL,
  DISPOSITION_LABEL,
  MOVEMENT_LABEL,
  STOCK_STATUS_LABEL,
  stockStatus,
  useConsumption,
  useFactorySuppliers,
  useIssueLines,
  usePreformAdjustments,
  usePreformReceipts,
  useReconciliation,
  type PreformRow,
} from "./api";

export const REPORTS = {
  balance: "Preform stock balance",
  by_supplier: "Receipts by supplier",
  receipts: "Preform receipts & GRN",
  issues: "Issues to production",
  consumption: "Preform consumption",
  valuation: "Inventory valuation",
  low_stock: "Low stock",
  reconciliation: "Negative stock & reconciliation",
  prices: "Supplier price history",
  adjustments: "Opening balances & adjustments",
} as const;
export type ReportKind = keyof typeof REPORTS;

// Which filters apply to which report.
const USES_DATES: ReportKind[] = [
  "by_supplier",
  "receipts",
  "issues",
  "consumption",
  "prices",
  "adjustments",
];
const USES_SUPPLIER: ReportKind[] = ["by_supplier", "receipts", "prices"];
const USES_LOCATION: ReportKind[] = ["balance", "valuation", "low_stock"];

const NOTES: Partial<Record<ReportKind, string>> = {
  balance:
    "Available = posted store stock. Pending = delivered, awaiting Store confirmation (not available). Awaiting acknowledgement = issued, not yet accepted by the operator. Held by production = accepted by operators, not yet used.",
  by_supplier:
    "Stock on hand is one pooled balance per preform specification; this report attributes what each supplier delivered and was accepted, not which supplier's pieces are still on the shelf.",
  consumption:
    "From the blowing line's shift records. Valued at the average cost of the preforms issued to the line in the period.",
  valuation:
    "Valued at moving weighted average cost (the ERP's configured method). The last purchase price is shown for reference only — it is not the valuation cost.",
  reconciliation:
    "Nothing here changes stock. Fix a difference with a physical count, a reversal, or a reviewed data migration.",
};

type Row = Record<string, unknown>;
type Built = { columns: ReportColumn[]; rows: Row[] };

const bagText = (pieces: number, perBag: number | null) => {
  const s = splitBags(pieces, perBag);
  return s ? { full_bags: s.bags, loose: s.pieces } : { full_bags: "n/a", loose: "n/a" };
};

export function ReportsPanel({
  factoryId,
  preforms,
}: {
  factoryId: string;
  preforms: PreformRow[];
}) {
  const { can } = usePermissions();
  const settings = useFactorySettings(factoryId);
  const suppliers = useFactorySuppliers(factoryId);
  const [kind, setKind] = useState<ReportKind>("balance");
  const [from, setFrom] = useState(addDays(localDay(), -30));
  const [to, setTo] = useState(localDay());
  const [material, setMaterial] = useState("all");
  const [supplier, setSupplier] = useState("all");
  const [location, setLocation] = useState("all");

  const mat = material === "all" ? null : material;
  const sup = supplier === "all" ? null : supplier;
  const needs = (k: ReportKind[]) => k.includes(kind);
  const receipts = usePreformReceipts(
    needs(["by_supplier", "receipts", "prices"]) ? factoryId : undefined,
    { material: mat, supplier: sup, from, to },
  );
  const issues = useIssueLines(
    needs(["issues", "consumption"]) ? factoryId : undefined,
    from,
    to,
    mat,
  );
  const consumption = useConsumption(kind === "consumption" ? factoryId : undefined, from, to);
  const adjustments = usePreformAdjustments(
    kind === "adjustments" ? factoryId : undefined,
    from,
    to,
  );
  const recon = useReconciliation(kind === "reconciliation" ? factoryId : undefined);
  const names = useUserNames(
    kind === "issues" ? (issues.data ?? []).flatMap((i) => [i.operator_id, i.issued_by]) : [],
  );

  const locations = useMemo(
    () => [...new Set(preforms.map((p) => p.storage_location).filter(Boolean) as string[])].sort(),
    [preforms],
  );
  const byId = useMemo(() => Object.fromEntries(preforms.map((p) => [p.id, p])), [preforms]);

  const scoped = preforms.filter(
    (p) =>
      (!mat || p.id === mat) && (location === "all" || (p.storage_location ?? "") === location),
  );

  const built: Built = useMemo(() => {
    switch (kind) {
      case "balance":
        return {
          columns: [
            { key: "code", label: "Code" },
            { key: "name", label: "Preform" },
            { key: "location", label: "Location" },
            { key: "per_bag", label: "Pcs/bag" },
            { key: "pieces", label: "Available pcs" },
            { key: "full_bags", label: "Full bags" },
            { key: "loose", label: "Loose pcs" },
            { key: "pending", label: "Pending confirmation" },
            { key: "awaiting", label: "Awaiting ack." },
            { key: "held", label: "Held by production" },
            { key: "status", label: "Status" },
          ],
          rows: scoped.map((p) => ({
            code: p.material_code,
            name: p.name,
            location: p.storage_location,
            per_bag: p.pieces_per_bag ?? "n/a",
            pieces: p.current_stock,
            ...bagText(p.current_stock, p.pieces_per_bag),
            pending: p.pending_receipt_qty,
            awaiting: p.awaiting_ack_qty,
            held: p.production_held_qty,
            status: STOCK_STATUS_LABEL[stockStatus(p)] + (p.active ? "" : " (inactive)"),
          })),
        };
      case "by_supplier": {
        const groups = new Map<string, Row & { n: number }>();
        for (const r of receipts.data ?? []) {
          if (r.status !== "posted") continue;
          const key = `${r.supplier_id ?? "-"}|${r.material_id}`;
          const g =
            groups.get(key) ??
            ({
              supplier: r.supplier_name ?? "(no supplier recorded)",
              material: r.material_name,
              n: 0,
              delivered: 0,
              accepted: 0,
              rejected: 0,
              value: 0,
            } as Row & { n: number });
          g.n += 1;
          g.delivered = Number(g.delivered) + r.quantity;
          g.accepted = Number(g.accepted) + r.accepted_quantity;
          g.rejected = Number(g.rejected) + r.damaged_quantity;
          g.value = Number(g.value) + r.accepted_value;
          groups.set(key, g);
        }
        return {
          columns: [
            { key: "supplier", label: "Supplier" },
            { key: "material", label: "Preform" },
            { key: "n", label: "Deliveries" },
            { key: "delivered", label: "Delivered pcs" },
            { key: "accepted", label: "Accepted pcs" },
            { key: "rejected", label: "Rejected pcs" },
            { key: "value_fmt", label: "Accepted value" },
          ],
          rows: [...groups.values()]
            .sort((a, b) => String(a.supplier).localeCompare(String(b.supplier)))
            .map((g) => ({ ...g, value_fmt: money(Number(g.value)) })),
        };
      }
      case "receipts":
        return {
          columns: [
            { key: "date", label: "Delivery date" },
            { key: "grn", label: "GRN" },
            { key: "supplier", label: "Supplier" },
            { key: "material", label: "Preform" },
            { key: "po", label: "PO" },
            { key: "invoice", label: "Invoice / note" },
            { key: "bags", label: "Bags" },
            { key: "delivered", label: "Delivered pcs" },
            { key: "accepted", label: "Accepted pcs" },
            { key: "rejected", label: "Rejected pcs" },
            { key: "price", label: "Price/pc" },
            { key: "value", label: "Accepted value" },
            { key: "status", label: "Status" },
            { key: "by", label: "Recorded / confirmed by" },
          ],
          rows: (receipts.data ?? []).map((r) => ({
            date: r.delivery_date,
            grn: r.receipt_number,
            supplier: r.supplier_name,
            material: r.material_name,
            po: r.po_number,
            invoice: [r.supplier_invoice, r.delivery_reference].filter(Boolean).join(" / "),
            bags:
              r.bags != null
                ? `${r.bags} × ${r.pieces_per_bag}${r.loose_pieces ? ` + ${r.loose_pieces}` : ""}`
                : "pieces",
            delivered: r.quantity,
            accepted: r.accepted_quantity,
            rejected: r.damaged_quantity
              ? `${r.damaged_quantity} (${r.rejected_disposition ? DISPOSITION_LABEL[r.rejected_disposition] : "—"}${r.rejection_reason ? `: ${r.rejection_reason}` : ""})`
              : 0,
            price: r.unit_cost == null ? "—" : money(r.unit_cost),
            value: money(r.accepted_value),
            status: r.status.replace(/_/g, " "),
            by: [r.submitted_by_name, r.confirmed_by_name].filter(Boolean).join(" / "),
          })),
        };
      case "issues":
        return {
          columns: [
            { key: "date", label: "Date" },
            { key: "ref", label: "Reference" },
            { key: "material", label: "Preform" },
            { key: "operator", label: "Operator" },
            { key: "bags", label: "Bags" },
            { key: "pieces", label: "Pieces" },
            { key: "cost", label: "Cost" },
            { key: "status", label: "Status" },
            { key: "by", label: "Issued by" },
          ],
          rows: (issues.data ?? []).map((i) => ({
            date: i.issue_date,
            ref: i.reference,
            material: byId[i.material_id]?.name ?? "—",
            operator: names.data?.[i.operator_id] ?? "…",
            bags: `${i.bags} × ${i.pieces_per_bag}${i.loose_pieces ? ` + ${i.loose_pieces}` : ""}`,
            pieces: i.pieces,
            cost: money(i.pieces * i.unit_cost),
            status: i.status,
            by: names.data?.[i.issued_by ?? ""] ?? "—",
          })),
        };
      case "consumption": {
        // Average cost of preforms issued to the line in the period.
        const issued = new Map<string, { pcs: number; cost: number }>();
        for (const i of issues.data ?? []) {
          if (i.status === "cancelled" || i.status === "rejected") continue;
          const a = issued.get(i.material_id) ?? { pcs: 0, cost: 0 };
          a.pcs += i.pieces;
          a.cost += i.pieces * i.unit_cost;
          issued.set(i.material_id, a);
        }
        const used = new Map<string, Record<string, number>>();
        for (const mv of consumption.data ?? []) {
          if (mat && mv.material_id !== mat) continue;
          const u = used.get(mv.material_id) ?? {};
          // Usage lines are negative in the holdings ledger; reversals positive.
          const key = mv.movement_type === "usage_reversed" ? "reversed" : mv.movement_type;
          u[key] = (u[key] ?? 0) - mv.quantity;
          used.set(mv.material_id, u);
        }
        return {
          columns: [
            { key: "material", label: "Preform" },
            { key: "good", label: "Good bottles" },
            { key: "dmg_pf", label: "Damaged preforms" },
            { key: "dmg_bt", label: "Damaged bottles" },
            { key: "other", label: "Other losses" },
            { key: "total", label: "Total consumed" },
            { key: "avg", label: "Avg issue cost" },
            { key: "value", label: "Consumed value" },
            { key: "damage_value", label: "Damage value" },
          ],
          rows: [...used.entries()].map(([id, u]) => {
            const a = issued.get(id);
            const avg = a && a.pcs ? a.cost / a.pcs : 0;
            const total =
              (u.good_bottles ?? 0) +
              (u.damaged_preforms ?? 0) +
              (u.damaged_bottles ?? 0) +
              (u.other_losses ?? 0) +
              (u.reversed ?? 0);
            const damage = (u.damaged_preforms ?? 0) + (u.damaged_bottles ?? 0);
            return {
              material: byId[id]?.name ?? "—",
              good: u.good_bottles ?? 0,
              dmg_pf: u.damaged_preforms ?? 0,
              dmg_bt: u.damaged_bottles ?? 0,
              other: u.other_losses ?? 0,
              total,
              avg: avg ? money(avg) : "—",
              value: avg ? money(total * avg) : "—",
              damage_value: avg ? money(damage * avg) : "—",
            };
          }),
        };
      }
      case "valuation": {
        const rows: Row[] = scoped.map((p) => ({
          code: p.material_code,
          name: p.name,
          pieces: p.current_stock,
          avg: money(p.avg_unit_cost),
          per_bag_cost: p.pieces_per_bag ? money(p.avg_unit_cost * p.pieces_per_bag) : "n/a",
          last: p.last_purchase_cost == null ? "—" : money(p.last_purchase_cost),
          value: money(p.current_value),
        }));
        rows.push({
          code: "",
          name: "Total",
          value: money(scoped.reduce((s, p) => s + p.current_value, 0)),
        });
        return {
          columns: [
            { key: "code", label: "Code" },
            { key: "name", label: "Preform" },
            { key: "pieces", label: "Pieces" },
            { key: "avg", label: "Avg cost/pc" },
            { key: "per_bag_cost", label: "Avg cost/bag" },
            { key: "last", label: "Last purchase/pc" },
            { key: "value", label: "Value" },
          ],
          rows,
        };
      }
      case "low_stock":
        return {
          columns: [
            { key: "code", label: "Code" },
            { key: "name", label: "Preform" },
            { key: "pieces", label: "Available pcs" },
            { key: "reorder", label: "Reorder level" },
            { key: "pending", label: "Pending confirmation" },
            { key: "status", label: "Status" },
          ],
          rows: scoped
            .filter((p) => p.active && stockStatus(p) !== "ok")
            .map((p) => ({
              code: p.material_code,
              name: p.name,
              pieces: p.current_stock,
              reorder: p.reorder_level,
              pending: p.pending_receipt_qty,
              status: STOCK_STATUS_LABEL[stockStatus(p)],
            })),
        };
      case "reconciliation":
        return {
          columns: [
            { key: "severity", label: "Severity" },
            { key: "check", label: "Check" },
            { key: "material", label: "Preform / supplier" },
            { key: "reference", label: "Reference" },
            { key: "detail", label: "Detail" },
            { key: "expected", label: "Expected" },
            { key: "actual", label: "Actual" },
          ],
          rows: (recon.data ?? [])
            .filter((r) => !mat || r.material_id === mat)
            .map((r) => ({
              severity: r.severity,
              check: CHECK_LABEL[r.check_code] ?? r.check_code,
              material: r.material_name ?? "—",
              reference: r.reference,
              detail: r.detail,
              expected: r.expected,
              actual: r.actual,
            })),
        };
      case "prices":
        return {
          columns: [
            { key: "material", label: "Preform" },
            { key: "date", label: "Date" },
            { key: "supplier", label: "Supplier" },
            { key: "grn", label: "GRN" },
            { key: "price", label: "Price/pc" },
            { key: "bag_price", label: "Price/bag" },
            { key: "accepted", label: "Accepted pcs" },
          ],
          rows: (receipts.data ?? [])
            .filter(
              (r) => r.status !== "cancelled" && r.status !== "rejected" && r.unit_cost != null,
            )
            .sort((a, b) =>
              a.material_name === b.material_name
                ? a.delivery_date.localeCompare(b.delivery_date)
                : a.material_name.localeCompare(b.material_name),
            )
            .map((r) => ({
              material: r.material_name,
              date: r.delivery_date,
              supplier: r.supplier_name,
              grn: r.receipt_number,
              price: money(r.unit_cost),
              bag_price: r.pieces_per_bag ? money((r.unit_cost ?? 0) * r.pieces_per_bag) : "n/a",
              accepted: r.accepted_quantity,
            })),
        };
      case "adjustments":
        return {
          columns: [
            { key: "date", label: "Date" },
            { key: "ref", label: "Reference" },
            { key: "material", label: "Preform" },
            { key: "kind", label: "Type" },
            { key: "system", label: "System qty" },
            { key: "counted", label: "Counted" },
            { key: "variance", label: "Variance" },
            { key: "reason", label: "Reason" },
            { key: "support", label: "Supporting ref" },
            { key: "status", label: "Status" },
            { key: "by", label: "Requested / reviewed by" },
          ],
          rows: (adjustments.data ?? [])
            .filter((a) => !mat || a.material_id === mat)
            .map((a) => ({
              date: a.submitted_at.slice(0, 10),
              ref: a.reference_number,
              material: a.material_name,
              kind:
                a.adjustment_kind === "opening_balance"
                  ? "Opening balance"
                  : a.adjustment_kind === "count"
                    ? "Physical count"
                    : (MOVEMENT_LABEL[a.movement_type] ?? a.movement_type),
              system: a.system_quantity ?? "—",
              counted:
                a.counted_quantity == null
                  ? "—"
                  : a.counted_pieces_per_bag != null
                    ? `${a.counted_quantity} (${a.counted_bags ?? 0} × ${a.counted_pieces_per_bag}${a.counted_loose ? ` + ${a.counted_loose}` : ""})`
                    : a.counted_quantity,
              variance: a.quantity_delta,
              reason: a.reason,
              support: a.supporting_reference,
              status: a.status.replace(/_/g, " "),
              by: [a.submitted_by_name, a.reviewed_by_name].filter(Boolean).join(" / "),
            })),
        };
    }
  }, [
    kind,
    scoped,
    receipts.data,
    issues.data,
    consumption.data,
    adjustments.data,
    recon.data,
    names.data,
    byId,
    mat,
  ]);

  const loading =
    receipts.isFetching ||
    issues.isFetching ||
    consumption.isFetching ||
    adjustments.isFetching ||
    recon.isFetching;
  const title =
    REPORTS[kind] + (needs(USES_DATES) ? ` (${from} to ${to})` : ` (as at ${localDay()})`);
  const canExport = can("raw-materials", "export") || can("preform-production", "export");
  const canPrint = can("raw-materials", "print") || can("preform-production", "print");
  const pdf = (action: PdfAction) =>
    generateReportPdf(title, built.columns, built.rows, action, {
      name: settings.data?.company_name,
      logo_url: settings.data?.logo_url,
    });
  const fileName = `${REPORTS[kind].replace(/\W+/g, "-")}-${localDay()}`;

  return (
    <Card className="rounded-2xl">
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Reports</CardTitle>
          <div className="flex flex-wrap gap-2">
            {canPrint && (
              <Button size="sm" variant="outline" className="gap-1" onClick={() => pdf("print")}>
                <Printer className="h-4 w-4" /> Print (A4)
              </Button>
            )}
            {canExport && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1"
                  onClick={() => pdf("download")}
                >
                  <FileText className="h-4 w-4" /> PDF
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1"
                  onClick={() => exportExcel(fileName, built.columns, built.rows)}
                >
                  <FileSpreadsheet className="h-4 w-4" /> Excel
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => exportCsv(fileName, built.columns, built.rows)}
                >
                  CSV
                </Button>
              </>
            )}
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
          <div className="space-y-1 lg:col-span-2">
            <Label className="text-xs">Report</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as ReportKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(REPORTS).map(([k, v], i) => (
                  <SelectItem key={k} value={k}>
                    {i + 1}. {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Preform</Label>
            <Select value={material} onValueChange={setMaterial}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All preforms</SelectItem>
                {preforms.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {needs(USES_SUPPLIER) && (
            <div className="space-y-1">
              <Label className="text-xs">Supplier</Label>
              <Select value={supplier} onValueChange={setSupplier}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All suppliers</SelectItem>
                  {(suppliers.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {needs(USES_LOCATION) && (
            <div className="space-y-1">
              <Label className="text-xs">Location</Label>
              <Select value={location} onValueChange={setLocation}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All locations</SelectItem>
                  {locations.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {needs(USES_DATES) && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">From</Label>
                <Input
                  type="date"
                  value={from}
                  max={to}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">To</Label>
                <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
              </div>
            </>
          )}
        </div>
        {NOTES[kind] && <p className="text-xs text-muted-foreground">{NOTES[kind]}</p>}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {built.columns.map((c) => (
                <TableHead key={c.key} className="whitespace-nowrap">
                  {c.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {built.rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={built.columns.length}
                  className="py-8 text-center text-muted-foreground"
                >
                  {loading ? "Loading…" : "Nothing to report for these filters."}
                </TableCell>
              </TableRow>
            )}
            {built.rows.map((r, i) => (
              <TableRow key={i}>
                {built.columns.map((c) => (
                  <TableCell key={c.key} className="text-xs">
                    {typeof r[c.key] === "number"
                      ? num(r[c.key] as number)
                      : String(r[c.key] ?? "—")}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
