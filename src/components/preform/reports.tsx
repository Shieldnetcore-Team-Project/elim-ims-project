import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Download, Printer } from "lucide-react";
import { usePermissions } from "@/lib/permissions";
import { useFactorySettings } from "@/lib/use-factory";
import { exportCsv } from "@/lib/export";
import { formatBags, splitBags } from "@/lib/preform-units";
import { SHIFT_LABEL, addDays, localDay, type Shift } from "@/lib/production-shift";
import {
  STATUS_LABEL,
  useBottleSources,
  useBottleStockReport,
  useDailyReport,
  useGrammageReport,
  usePreformMaterials,
  usePreformOperators,
  usePreformOverview,
  useRejections,
  useShiftReport,
  useStockings,
  useTransfers,
  useUserNames,
  type GrammageRow,
} from "./api";
import { preformReportPdf } from "./report-pdf";
import { fmtDate, fmtDateTime } from "./shared";
import { TraceDialog } from "./trace-dialog";
import { DatePicker } from "@/components/shared/date-picker";

type Kind = "grammage" | "bottle" | "shift" | "daily" | "stocking" | "transfer" | "rejection";
type Col = { key: string; label: string; align?: "right" };
type Row = Record<string, string | number>;
// A summary below the main rows, under its own heading. It never replaces
// the individual rows.
type Section = { title: string; columns: Col[]; rows: Row[] };
type Built = {
  columns: Col[];
  rows: Row[];
  totals?: Record<string, string | number | undefined> | null;
  pending: number;
  // Blowing record behind each row, for the drill-down.
  ids?: (string | null)[];
  sections?: Section[];
  note?: string;
};

const KIND_LABEL: Record<Kind, string> = {
  grammage: "Preform processing by grammage",
  bottle: "Bottle inventory report",
  shift: "Shift report",
  daily: "Daily report",
  stocking: "Inventory stocking report",
  transfer: "Issues to PM report",
  rejection: "PM-stage rejection report",
};

// Reconciliation of one blowing session (preform_grammage_report).
const reconLabel = (r: GrammageRow) => {
  if (r.status === "reversed") return "Reversed";
  if (r.status === "awaiting_inspection") return "Awaiting QC";
  if ((r.ledger_variance ?? 0) !== 0) return "Flagged — investigate";
  if (r.status === "awaiting_stocking") return "Awaiting stocking";
  if ((r.stock_variance ?? 0) !== 0) return "Flagged — investigate";
  return "Reconciled";
};
const spec = (material: string, brand: string | null | undefined) =>
  brand ? `${material} (${brand})` : material;

const ALL = "all";
const inRange = (iso: string | null | undefined, from: string, to: string) => {
  if (!iso) return false;
  const d = new Date(iso).toLocaleDateString("en-CA");
  return d >= from && d <= to;
};
const bagsText = (pieces: number, perBag: number | null | undefined) => {
  const s = splitBags(pieces, perBag);
  return s ? formatBags(s) : "";
};

export function ReportsTab({ factoryId }: { factoryId: string }) {
  const { can } = usePermissions();
  const canExport = can("preform-production", "export") || can("preform-production", "print");
  const settings = useFactorySettings(factoryId);
  const operators = usePreformOperators(factoryId);
  const materials = usePreformMaterials(factoryId);
  const [kind, setKind] = useState<Kind>("grammage");
  const [from, setFrom] = useState(localDay());
  const [to, setTo] = useState(localDay());
  const [operatorId, setOperatorId] = useState(ALL);
  const [materialId, setMaterialId] = useState(ALL);
  const [shift, setShift] = useState<string>(ALL);
  const [status, setStatus] = useState(ALL);
  const [dept, setDept] = useState(ALL);
  const [gram, setGram] = useState(ALL);
  const [supplier, setSupplier] = useState(ALL);
  const [capacity, setCapacity] = useState(ALL);
  const [trace, setTrace] = useState<string | null>(null);

  const op = operatorId === ALL ? null : operatorId;
  const mat = materialId === ALL ? null : materialId;
  const grammage = useGrammageReport(kind === "grammage" ? factoryId : undefined, {
    from,
    to,
    shift: shift === ALL ? null : shift,
    materialId: mat,
    operatorId: op,
    status: status === ALL ? null : status,
  });
  const overview = usePreformOverview(kind === "grammage" ? factoryId : undefined);
  const bottleStock = useBottleStockReport(kind === "bottle" ? factoryId : undefined, from, to);
  const bottleSources = useBottleSources(kind === "bottle" ? factoryId : undefined, from, to);
  const rejections = useRejections(
    kind === "rejection" || kind === "transfer" ? factoryId : undefined,
  );
  const shifts = useShiftReport(kind === "shift" ? factoryId : undefined, {
    from,
    to,
    operatorId: op,
    materialId: mat,
    shift: shift === ALL ? null : (shift as Shift),
    status: status === ALL ? null : status,
  });
  const daily = useDailyReport(
    kind === "daily" || kind === "grammage" ? factoryId : undefined,
    from,
    to,
    op,
    mat,
  );
  const stockings = useStockings(kind === "stocking" ? factoryId : undefined);
  const transfers = useTransfers(kind === "transfer" ? factoryId : undefined);
  const names = useUserNames([
    ...(stockings.data ?? []).flatMap((s) => [s.sent_by, s.received_by, s.record?.operator_id]),
    ...(transfers.data ?? []).flatMap((t) => [t.sent_by, t.received_by]),
    ...(rejections.data ?? []).flatMap((r) => [r.recorded_by]),
  ]);
  const departments = [...new Set((transfers.data ?? []).map((t) => t.to_department))];
  // Grammage / supplier / capacity choices from what the period holds.
  const options = (vals: (string | null | undefined)[]) =>
    [...new Set(vals.map((v) => v ?? "—"))].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
  const gramOptions = options((grammage.data ?? []).map((r) => r.grammage));
  const supplierOptions = options((grammage.data ?? []).map((r) => r.supplier));
  const capacityOptions = options(
    kind === "bottle"
      ? (bottleStock.data ?? []).map((r) => r.capacity)
      : (grammage.data ?? []).map((r) => r.capacity),
  );
  const pick = (v: string | null | undefined, chosen: string) =>
    chosen === ALL || (v ?? "—") === chosen;

  const built: Built = useMemo(() => {
    const perBagByName = (name: string) =>
      materials.data?.find((m) => m.name === name)?.pieces_per_bag;
    if (kind === "grammage") {
      const list = (grammage.data ?? []).filter(
        (r) => pick(r.grammage, gram) && pick(r.supplier, supplier) && pick(r.capacity, capacity),
      );
      const live = list.filter((r) => r.status !== "reversed");
      const rows = list.map((r) => ({
        date: fmtDate(r.production_date),
        shift: SHIFT_LABEL[r.shift],
        preform: spec(r.material, r.brand),
        supplier: r.supplier ?? "",
        capacity: r.capacity ?? "",
        grammage: r.grammage ?? "",
        ppb: r.pieces_per_bag ?? "",
        opening: r.opening_qty ?? "",
        opening_bags: r.opening_qty == null ? "" : bagsText(r.opening_qty, r.pieces_per_bag),
        recv_bags: r.pieces_per_bag
          ? formatBags({ bags: r.received_bags, pieces: r.received_loose })
          : "",
        recv_pcs: r.received_pieces ?? "",
        available: r.available_qty ?? "",
        processed: r.processed ?? "",
        damaged: r.damaged_preforms + r.damaged_bottles,
        other: r.other_losses,
        good: r.good_bottles - r.qc_rejected,
        closing: r.closing_qty ?? "",
        closing_bags: r.closing_qty == null ? "" : bagsText(r.closing_qty, r.pieces_per_bag),
        to_stock: r.stocked,
        variance: r.status === "reversed" ? "" : (r.ledger_variance ?? 0) + (r.stock_variance ?? 0),
        recon: reconLabel(r),
        operator: r.operator,
        ref: r.reference,
      }));
      const sum = (f: (r: GrammageRow) => number | null) =>
        live.reduce((t, r) => t + (f(r) ?? 0), 0);

      // Daily summary per preform specification, from the holding ledger
      // (every blower added together; a day with only receipts still shows).
      const ov = new Map((overview.data ?? []).map((o) => [o.material_id, o]));
      const byDay = new Map<string, Row & { _o: number; _r: number; _u: number; _c: number }>();
      for (const d of daily.data ?? []) {
        const o = ov.get(d.material_id);
        if (!pick(o?.grammage, gram) || !pick(o?.supplier, supplier)) continue;
        if (!d.opening && !d.received && !d.usage && !d.closing) continue;
        const k = `${d.day}|${d.material_id}`;
        const x = byDay.get(k) ?? {
          date: fmtDate(d.day),
          _day: d.day,
          preform: spec(d.material, o?.brand),
          grammage: o?.grammage ?? "",
          ppb: d.pieces_per_bag ?? "",
          _o: 0,
          _r: 0,
          _u: 0,
          _c: 0,
          damaged: 0,
          good: 0,
          sessions: 0,
        };
        x._o += d.opening;
        x._r += d.received;
        x._u += d.usage;
        x._c += d.closing;
        x.damaged = (x.damaged as number) + d.damaged_preforms + d.damaged_bottles;
        x.good = (x.good as number) + d.good_bottles;
        x.sessions = (x.sessions as number) + d.shifts;
        byDay.set(k, x);
      }
      const dailyRows = [...byDay.values()]
        .sort(
          (a, b) =>
            String(b._day).localeCompare(String(a._day)) ||
            String(a.preform).localeCompare(String(b.preform)),
        )
        .map(({ _o, _r, _u, _c, _day, ...x }) => {
          void _day;
          const perBag = typeof x.ppb === "number" ? x.ppb : null;
          return {
            ...x,
            opening: _o,
            received: _r,
            received_bags: bagsText(_r, perBag),
            available: _o + _r,
            processed: _u,
            closing: _c,
            closing_bags: bagsText(_c, perBag),
          };
        });

      // Combined by bottle capacity, with the grammages under each total.
      const byCap = new Map<
        string,
        {
          day: string;
          grams: Set<string>;
          sessions: number;
          processed: number;
          damaged: number;
          good: number;
          to_stock: number;
        }
      >();
      for (const r of live) {
        const k = `${r.production_date}|${r.capacity ?? "—"}`;
        const x = byCap.get(k) ?? {
          day: r.production_date,
          grams: new Set<string>(),
          sessions: 0,
          processed: 0,
          damaged: 0,
          good: 0,
          to_stock: 0,
        };
        x.grams.add(r.grammage ?? spec(r.material, r.brand));
        x.sessions += 1;
        x.processed += r.processed ?? 0;
        x.damaged += r.damaged_preforms + r.damaged_bottles;
        x.good += r.good_bottles - r.qc_rejected;
        x.to_stock += r.stocked;
        byCap.set(k, x);
      }
      const capRows: Row[] = [...byCap.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([k, x]) => ({
          date: fmtDate(x.day),
          capacity: k.split("|")[1],
          grammages: [...x.grams]
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .join(", "),
          sessions: x.sessions,
          processed: x.processed,
          damaged: x.damaged,
          good: x.good,
          to_stock: x.to_stock,
        }));

      return {
        columns: [
          { key: "date", label: "Date" },
          { key: "shift", label: "Shift" },
          { key: "preform", label: "Preform" },
          { key: "supplier", label: "Supplier" },
          { key: "capacity", label: "Capacity" },
          { key: "grammage", label: "Grammage" },
          { key: "ppb", label: "Pcs/bag", align: "right" },
          { key: "opening", label: "Opening", align: "right" },
          { key: "opening_bags", label: "(bags)" },
          { key: "recv_bags", label: "From Store (bags)" },
          { key: "recv_pcs", label: "From Store (pcs)", align: "right" },
          { key: "available", label: "Available", align: "right" },
          { key: "processed", label: "Processed", align: "right" },
          { key: "damaged", label: "Damaged", align: "right" },
          { key: "other", label: "Other", align: "right" },
          { key: "good", label: "Good bottles", align: "right" },
          { key: "closing", label: "Unprocessed", align: "right" },
          { key: "closing_bags", label: "(bags)" },
          { key: "to_stock", label: "To bottle stock", align: "right" },
          { key: "variance", label: "Variance", align: "right" },
          { key: "recon", label: "Reconciliation" },
          { key: "operator", label: "Operator" },
          { key: "ref", label: "Reference" },
        ],
        rows,
        ids: list.map((r) => r.id),
        totals: rows.length
          ? {
              date: "Totals",
              recv_pcs: sum((r) => r.received_pieces),
              processed: sum((r) => r.processed),
              damaged: sum((r) => r.damaged_preforms + r.damaged_bottles),
              other: sum((r) => r.other_losses),
              good: sum((r) => r.good_bottles - r.qc_rejected),
              to_stock: sum((r) => r.stocked),
            }
          : null,
        pending: list.filter((r) => ["awaiting_inspection", "awaiting_stocking"].includes(r.status))
          .length,
        note: "One row per blowing session and preform specification — grammages are never merged. Available = Opening + From Store; Processed = Good + Damaged + Other; Unprocessed = Available − Processed. Variance = preforms the ledger does not explain + good bottles not yet in bottle stock (0 when reconciled). Totals leave out reversed sessions. Click a row for its full trail.",
        sections: [
          {
            title: "Daily summary by grammage (from the preform ledger)",
            columns: [
              { key: "date", label: "Date" },
              { key: "preform", label: "Preform" },
              { key: "grammage", label: "Grammage" },
              { key: "ppb", label: "Pcs/bag", align: "right" },
              { key: "opening", label: "Opening", align: "right" },
              { key: "received_bags", label: "From Store (bags)" },
              { key: "received", label: "From Store (pcs)", align: "right" },
              { key: "available", label: "Available", align: "right" },
              { key: "processed", label: "Processed", align: "right" },
              { key: "damaged", label: "Damaged", align: "right" },
              { key: "good", label: "Good bottles", align: "right" },
              { key: "closing", label: "Closing", align: "right" },
              { key: "closing_bags", label: "(bags)" },
              { key: "sessions", label: "Sessions", align: "right" },
            ],
            rows: dailyRows,
          },
          {
            title: "Daily summary by bottle capacity (grammages kept underneath)",
            columns: [
              { key: "date", label: "Date" },
              { key: "capacity", label: "Capacity" },
              { key: "grammages", label: "From grammages" },
              { key: "sessions", label: "Sessions", align: "right" },
              { key: "processed", label: "Processed", align: "right" },
              { key: "damaged", label: "Damaged", align: "right" },
              { key: "good", label: "Good bottles", align: "right" },
              { key: "to_stock", label: "To bottle stock", align: "right" },
            ],
            rows: capRows,
          },
        ],
      };
    }
    if (kind === "bottle") {
      const list = (bottleStock.data ?? []).filter((r) => pick(r.capacity, capacity));
      const rows = list.map((r) => ({
        product: r.product,
        capacity: r.capacity ?? "",
        opening: r.opening,
        from_blowing: r.from_blowing,
        issued: r.issued_to_pm,
        other: r.other,
        closing: r.closing,
        in_transit: r.in_transit,
        pm_received: r.pm_received,
        pm_rejected: r.pm_rejected,
      }));
      const srcRows = (bottleSources.data ?? [])
        .filter((r) => pick(r.capacity, capacity) && (r.good_in_period > 0 || r.good_all_time > 0))
        .map((r) => ({
          product: r.product,
          capacity: r.capacity ?? "",
          preform: spec(r.material, r.brand),
          grammage: r.grammage ?? "",
          supplier: r.supplier ?? "",
          sessions: r.sessions,
          good_period: r.good_in_period,
          good_all: r.good_all_time,
        }));
      const sum = (k: keyof (typeof rows)[number]) =>
        rows.reduce((t, r) => t + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
      return {
        columns: [
          { key: "product", label: "Bottle" },
          { key: "capacity", label: "Capacity" },
          { key: "opening", label: "Opening", align: "right" },
          { key: "from_blowing", label: "Good from blowing", align: "right" },
          { key: "issued", label: "Issued to PM", align: "right" },
          { key: "other", label: "Other movements", align: "right" },
          { key: "closing", label: "Closing", align: "right" },
          { key: "in_transit", label: "Awaiting PM receipt (now)", align: "right" },
          { key: "pm_received", label: "PM received", align: "right" },
          { key: "pm_rejected", label: "PM-stage rejected", align: "right" },
        ],
        rows,
        totals: rows.length
          ? {
              product: "Totals",
              from_blowing: sum("from_blowing"),
              issued: sum("issued"),
              other: sum("other"),
              pm_received: sum("pm_received"),
              pm_rejected: sum("pm_rejected"),
            }
          : null,
        pending: 0,
        note: "From each bottle's stock ledger: Closing = Opening + Good from blowing − Issued to PM + Other movements. Only good bottles enter; blowing damage stays with the preform. PM-stage rejections come out of PM's stock, shown here for the record.",
        sections: [
          {
            title: "Good bottles in, by source preform grammage",
            columns: [
              { key: "product", label: "Bottle" },
              { key: "capacity", label: "Capacity" },
              { key: "preform", label: "Preform" },
              { key: "grammage", label: "Grammage" },
              { key: "supplier", label: "Supplier" },
              { key: "sessions", label: "Sessions", align: "right" },
              { key: "good_period", label: "Good in period", align: "right" },
              { key: "good_all", label: "Good to date", align: "right" },
            ],
            rows: srcRows,
          },
        ],
      };
    }
    if (kind === "rejection") {
      const list = (rejections.data ?? []).filter(
        (r) =>
          r.production_date >= from &&
          r.production_date <= to &&
          (status === ALL || r.status === status),
      );
      const rows = list.map((r) => ({
        date: fmtDate(r.production_date),
        shift: r.shift ? SHIFT_LABEL[r.shift] : "",
        ref: r.reference,
        receipt: r.transfer?.reference ?? "",
        product: r.product?.name ?? "",
        dept: r.department,
        qty: r.quantity,
        reason: r.reason,
        prod_ref: r.production_reference ?? "",
        by: names.data?.[r.recorded_by ?? ""] ?? "",
        status: STATUS_LABEL[r.status] + (r.reversal_reason ? ` — ${r.reversal_reason}` : ""),
      }));
      return {
        columns: [
          { key: "date", label: "Date" },
          { key: "shift", label: "Shift" },
          { key: "ref", label: "Rejection" },
          { key: "receipt", label: "PM receipt" },
          { key: "product", label: "Bottle" },
          { key: "dept", label: "Department" },
          { key: "qty", label: "Rejected", align: "right" },
          { key: "reason", label: "Reason" },
          { key: "prod_ref", label: "Production ref." },
          { key: "by", label: "Recorded by" },
          { key: "status", label: "Status" },
        ],
        rows,
        totals: rows.length
          ? {
              date: "Totals (posted)",
              qty: list.filter((r) => r.status === "posted").reduce((t, r) => t + r.quantity, 0),
            }
          : null,
        pending: 0,
        note: "Bottles PM found defective after receiving them. Separate from blowing-stage damage.",
      };
    }
    if (kind === "shift") {
      const rows = (shifts.data ?? []).map((r) => ({
        date: fmtDate(r.production_date),
        shift: SHIFT_LABEL[r.shift],
        ref: r.reference,
        operator: r.operator,
        machine: r.machine ?? "",
        material: r.material,
        opening: r.opening_qty ?? "",
        issued: r.issued_qty ?? "",
        available: r.available_qty ?? "",
        good: r.good_bottles,
        dmg_pre: r.damaged_preforms,
        dmg_bot: r.damaged_bottles,
        other: r.other_losses,
        usage: r.usage_qty ?? "",
        remaining: r.expected_remaining ?? "",
        rem_bags:
          r.expected_remaining == null
            ? ""
            : bagsText(r.expected_remaining, perBagByName(r.material)),
        qc_good: r.qc_good ?? "",
        qc_rej: r.qc_rejected ?? "",
        stocked: r.stocked,
        variance: r.status === "completed" && r.variance != null ? r.variance : "",
        status: STATUS_LABEL[r.status] + (r.open_exceptions ? " · exception open" : ""),
      }));
      const sum = (k: keyof (typeof rows)[number]) =>
        rows.reduce((t, r) => t + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
      return {
        columns: [
          { key: "date", label: "Date" },
          { key: "shift", label: "Shift" },
          { key: "ref", label: "Record" },
          { key: "operator", label: "Operator" },
          { key: "machine", label: "Machine" },
          { key: "material", label: "Preform" },
          { key: "opening", label: "Opening", align: "right" },
          { key: "issued", label: "Issues", align: "right" },
          { key: "available", label: "Available", align: "right" },
          { key: "good", label: "Good", align: "right" },
          { key: "dmg_pre", label: "Dmg preforms", align: "right" },
          { key: "dmg_bot", label: "Dmg bottles", align: "right" },
          { key: "other", label: "Other loss", align: "right" },
          { key: "usage", label: "Usage", align: "right" },
          { key: "remaining", label: "Exp. remaining", align: "right" },
          { key: "rem_bags", label: "(bags)" },
          { key: "qc_good", label: "QC good", align: "right" },
          { key: "qc_rej", label: "QC rejected", align: "right" },
          { key: "stocked", label: "Stocked", align: "right" },
          { key: "variance", label: "Variance", align: "right" },
          { key: "status", label: "Status" },
        ],
        rows,
        totals: rows.length
          ? {
              date: "Totals",
              good: sum("good"),
              dmg_pre: sum("dmg_pre"),
              dmg_bot: sum("dmg_bot"),
              other: sum("other"),
              usage: sum("usage"),
              qc_good: sum("qc_good"),
              qc_rej: sum("qc_rej"),
              stocked: sum("stocked"),
              variance: sum("variance"),
            }
          : null,
        pending: (shifts.data ?? []).filter((r) =>
          ["draft", "awaiting_inspection", "awaiting_stocking"].includes(r.status),
        ).length,
      };
    }
    if (kind === "daily") {
      const rows = (daily.data ?? [])
        // Days with nothing held or moved (incl. cleared test data) are left out.
        .filter((r) => r.opening || r.received || r.usage || r.closing)
        .map((r) => ({
          date: fmtDate(r.day),
          operator: r.operator,
          material: r.material,
          opening: r.opening,
          received: r.received,
          available: r.opening + r.received,
          good: r.good_bottles,
          dmg_pre: r.damaged_preforms,
          dmg_bot: r.damaged_bottles,
          other: r.other_losses,
          reversed: r.reversed,
          usage: r.usage,
          closing: r.closing,
          closing_bags: bagsText(r.closing, r.pieces_per_bag),
          shifts: r.shifts,
          qc_good: r.qc_good,
          qc_rej: r.qc_rejected,
          stocked: r.stocked,
          pending: r.pending_shifts,
        }));
      return {
        columns: [
          { key: "date", label: "Date" },
          { key: "operator", label: "Operator" },
          { key: "material", label: "Preform" },
          { key: "opening", label: "Opening", align: "right" },
          { key: "received", label: "Received", align: "right" },
          { key: "available", label: "Available", align: "right" },
          { key: "good", label: "Good", align: "right" },
          { key: "dmg_pre", label: "Dmg preforms", align: "right" },
          { key: "dmg_bot", label: "Dmg bottles", align: "right" },
          { key: "other", label: "Other loss", align: "right" },
          { key: "reversed", label: "Reversed", align: "right" },
          { key: "usage", label: "Usage", align: "right" },
          { key: "closing", label: "Closing", align: "right" },
          { key: "closing_bags", label: "(bags)" },
          { key: "shifts", label: "Shifts", align: "right" },
          { key: "qc_good", label: "QC good", align: "right" },
          { key: "qc_rej", label: "QC rejected", align: "right" },
          { key: "stocked", label: "Stocked", align: "right" },
          { key: "pending", label: "Pending shifts", align: "right" },
        ],
        rows,
        // Opening and closing are balances: never summed across days.
        totals: null,
        pending: rows.reduce((t, r) => t + r.pending, 0),
      };
    }
    if (kind === "stocking") {
      const list = (stockings.data ?? []).filter(
        (s) =>
          inRange(s.sent_at, from, to) &&
          (status === ALL || s.status === status) &&
          (!op || s.record?.operator_id === op),
      );
      const rows = list.map((s) => ({
        sent: fmtDateTime(s.sent_at),
        ref: s.reference,
        record: s.record?.reference ?? "",
        prod: s.record ? `${fmtDate(s.record.production_date)} ${SHIFT_LABEL[s.record.shift]}` : "",
        product: s.product?.name ?? "",
        location: "Warehouse",
        expected: s.expected_qty,
        counted: s.counted_qty,
        accepted: s.accepted_qty ?? "",
        variance: s.accepted_qty == null ? "" : s.counted_qty - s.accepted_qty,
        sender: names.data?.[s.sent_by ?? ""] ?? "",
        officer: names.data?.[s.received_by ?? ""] ?? "",
        status: STATUS_LABEL[s.status],
      }));
      return {
        columns: [
          { key: "sent", label: "Sent" },
          { key: "ref", label: "Stocking" },
          { key: "record", label: "Shift record" },
          { key: "prod", label: "Produced" },
          { key: "product", label: "Product" },
          { key: "location", label: "Location" },
          { key: "expected", label: "Left to stock", align: "right" },
          { key: "counted", label: "Sent (count)", align: "right" },
          { key: "accepted", label: "Accepted", align: "right" },
          { key: "variance", label: "Variance", align: "right" },
          { key: "sender", label: "Sent by" },
          { key: "officer", label: "Stocking officer" },
          { key: "status", label: "Status" },
        ],
        rows,
        totals: rows.length
          ? {
              sent: "Totals",
              counted: list.reduce((t, s) => t + s.counted_qty, 0),
              accepted: list.reduce((t, s) => t + (s.accepted_qty ?? 0), 0),
            }
          : null,
        pending: list.filter((s) => s.status === "sent").length,
      };
    }
    const list = (transfers.data ?? []).filter(
      (t) =>
        inRange(t.sent_at, from, to) &&
        (status === ALL || t.status === status) &&
        (dept === ALL || t.to_department === dept),
    );
    const rejectedBy = new Map<string, number>();
    for (const r of rejections.data ?? [])
      if (r.status === "posted")
        rejectedBy.set(r.transfer_id, (rejectedBy.get(r.transfer_id) ?? 0) + r.quantity);
    const rows = list.map((t) => ({
      sent: fmtDateTime(t.sent_at),
      ref: t.reference,
      shift: t.shift ? SHIFT_LABEL[t.shift] : "",
      prod_ref: t.production_reference ?? "",
      product: t.product?.name ?? "",
      to: t.to_department,
      requested: t.quantity_requested ?? "",
      dispatched: t.quantity_sent,
      received: t.quantity_received ?? "",
      diff: t.quantity_received == null ? "" : t.quantity_sent - t.quantity_received,
      rejected: rejectedBy.get(t.id) ?? "",
      sender: names.data?.[t.sent_by ?? ""] ?? "",
      receiver: names.data?.[t.received_by ?? ""] ?? "",
      received_at: t.received_at ? fmtDateTime(t.received_at) : "",
      note: t.receive_note ?? t.reversal_reason ?? "",
      status: STATUS_LABEL[t.status],
    }));
    return {
      columns: [
        { key: "sent", label: "Dispatched" },
        { key: "ref", label: "Transfer" },
        { key: "shift", label: "Shift" },
        { key: "prod_ref", label: "Production ref." },
        { key: "product", label: "Product" },
        { key: "to", label: "To" },
        { key: "requested", label: "Requested", align: "right" },
        { key: "dispatched", label: "Qty sent", align: "right" },
        { key: "received", label: "Qty received", align: "right" },
        { key: "diff", label: "Discrepancy", align: "right" },
        { key: "rejected", label: "PM rejected", align: "right" },
        { key: "sender", label: "Sender" },
        { key: "receiver", label: "Receiver" },
        { key: "received_at", label: "Received" },
        { key: "note", label: "Notes" },
        { key: "status", label: "Status" },
      ],
      rows,
      totals: rows.length
        ? {
            sent: "Totals",
            dispatched: list.reduce((t, x) => t + x.quantity_sent, 0),
            received: list.reduce((t, x) => t + (x.quantity_received ?? 0), 0),
          }
        : null,
      pending: list.filter((t) => t.status === "dispatched").length,
    };
  }, [
    kind,
    shifts.data,
    daily.data,
    stockings.data,
    transfers.data,
    names.data,
    from,
    to,
    status,
    op,
    dept,
    materials.data,
    grammage.data,
    overview.data,
    bottleStock.data,
    bottleSources.data,
    rejections.data,
    gram,
    supplier,
    capacity,
  ]);

  const period = from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`;
  const withOperator = ["shift", "daily", "stocking", "grammage"].includes(kind);
  const withPreform = ["shift", "daily", "grammage"].includes(kind);
  const withShift = kind === "shift" || kind === "grammage";
  const withStatus = !["daily", "bottle"].includes(kind);
  const filterText = [
    op && withOperator && `Operator: ${operators.data?.find((o) => o.id === op)?.full_name ?? ""}`,
    mat && withPreform && `Preform: ${materials.data?.find((m) => m.id === mat)?.name ?? ""}`,
    shift !== ALL && withShift && `Shift: ${SHIFT_LABEL[shift as Shift]}`,
    gram !== ALL && kind === "grammage" && `Grammage: ${gram}`,
    supplier !== ALL && kind === "grammage" && `Supplier: ${supplier}`,
    capacity !== ALL && (kind === "grammage" || kind === "bottle") && `Capacity: ${capacity}`,
    status !== ALL && withStatus && `Status: ${STATUS_LABEL[status] ?? status}`,
    dept !== ALL && kind === "transfer" && `Department: ${dept}`,
  ].filter(Boolean) as string[];
  const pendingNote = built.pending
    ? `Includes ${built.pending} pending record(s) not yet final (drafts, awaiting QC, awaiting stocking or receipt).`
    : null;

  const statusOptions =
    kind === "shift" || kind === "grammage"
      ? ["draft", "awaiting_inspection", "awaiting_stocking", "completed", "reversed"]
      : kind === "stocking"
        ? ["sent", "accepted", "rejected", "cancelled", "reversed"]
        : kind === "rejection"
          ? ["posted", "reversed"]
          : ["dispatched", "received", "discrepancy", "cancelled", "reversed"];

  const doPdf = (action: "print" | "download") =>
    preformReportPdf(
      {
        company: settings.data?.company_name ?? "Elim Table Water",
        title: KIND_LABEL[kind],
        period,
        filters: filterText,
        pendingNote,
        columns: built.columns.map((c) => ({ label: c.label, align: c.align })),
        rows: built.rows.map((r) => built.columns.map((c) => r[c.key] ?? "")),
        totals: built.totals ? built.columns.map((c) => built.totals?.[c.key] ?? "") : null,
        sections: (built.sections ?? []).map((s) => ({
          title: s.title,
          columns: s.columns.map((c) => ({ label: c.label, align: c.align })),
          rows: s.rows.map((r) => s.columns.map((c) => r[c.key] ?? "")),
        })),
        filename: `${KIND_LABEL[kind].toLowerCase().replace(/ /g, "-")}-${from}-${to}`,
      },
      action,
    );

  return (
    <Card className="rounded-2xl">
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Reports</CardTitle>
          {canExport && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => doPdf("print")}
                disabled={!built.rows.length}
              >
                <Printer className="h-4 w-4" /> Print
              </Button>
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => doPdf("download")}
                disabled={!built.rows.length}
              >
                <Download className="h-4 w-4" /> PDF
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  exportCsv(
                    `${kind}-report-${from}-${to}`,
                    built.columns,
                    built.rows as Record<string, unknown>[],
                  )
                }
                disabled={!built.rows.length}
              >
                CSV
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Report">
            <Select
              value={kind}
              onValueChange={(v) => {
                setKind(v as Kind);
                setStatus(ALL);
              }}
            >
              <SelectTrigger className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="From">
            <DatePicker value={from} max={to} onChange={setFrom} />
          </Field>
          <Field label="To">
            <DatePicker value={to} min={from} max={localDay()} onChange={setTo} />
          </Field>
          <Field label="">
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setFrom(localDay());
                  setTo(localDay());
                }}
              >
                Today
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setFrom(addDays(localDay(), -6));
                  setTo(localDay());
                }}
              >
                7 days
              </Button>
            </div>
          </Field>
          {withOperator && (
            <Field label="Operator">
              <Select value={operatorId} onValueChange={setOperatorId}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All operators</SelectItem>
                  {(operators.data ?? []).map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {withPreform && (
            <Field label="Preform">
              <Select value={materialId} onValueChange={setMaterialId}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All preforms</SelectItem>
                  {(materials.data ?? []).map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {kind === "grammage" && (
            <>
              <OptionField
                label="Grammage"
                value={gram}
                onChange={setGram}
                all="All grammages"
                options={gramOptions}
              />
              <OptionField
                label="Supplier"
                value={supplier}
                onChange={setSupplier}
                all="All suppliers"
                options={supplierOptions}
              />
            </>
          )}
          {(kind === "grammage" || kind === "bottle") && (
            <OptionField
              label="Capacity"
              value={capacity}
              onChange={setCapacity}
              all="All capacities"
              options={capacityOptions}
            />
          )}
          {withShift && (
            <Field label="Shift">
              <Select value={shift} onValueChange={setShift}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Both</SelectItem>
                  <SelectItem value="day">Day</SelectItem>
                  <SelectItem value="night">Night</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
          {kind === "transfer" && (
            <Field label="Department">
              <Select value={dept} onValueChange={setDept}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {withStatus && (
            <Field label="Status">
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All statuses</SelectItem>
                  {statusOptions.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {KIND_LABEL[kind]} · {period}
          {kind === "daily" &&
            " · Opening and closing come from the operator's preform ledger, so each day's opening is shown once and shifts are never double counted."}
          {built.note && ` · ${built.note}`}
        </p>
        {pendingNote && <p className="text-xs text-warning">{pendingNote}</p>}
      </CardHeader>
      <CardContent className="space-y-6 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {built.columns.map((c) => (
                <TableHead
                  key={c.key}
                  className={`whitespace-nowrap ${c.align === "right" ? "text-right" : ""}`}
                >
                  {c.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {built.rows.map((r, i) => (
              <TableRow
                key={i}
                className={built.ids?.[i] ? "cursor-pointer hover:bg-muted/50" : undefined}
                title={built.ids?.[i] ? "Open the full trail of this session" : undefined}
                onClick={() => built.ids?.[i] && setTrace(built.ids[i])}
              >
                {built.columns.map((c) => (
                  <TableCell
                    key={c.key}
                    className={`whitespace-nowrap text-xs ${c.align === "right" ? "text-right" : ""}`}
                  >
                    {typeof r[c.key] === "number"
                      ? (r[c.key] as number).toLocaleString()
                      : r[c.key]}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {built.rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={built.columns.length}
                  className="py-8 text-center text-muted-foreground"
                >
                  Nothing in this period.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          {built.totals && (
            <TableFooter>
              <TableRow>
                {built.columns.map((c) => (
                  <TableCell
                    key={c.key}
                    className={`text-xs font-semibold ${c.align === "right" ? "text-right" : ""}`}
                  >
                    {typeof built.totals?.[c.key] === "number"
                      ? (built.totals[c.key] as number).toLocaleString()
                      : (built.totals?.[c.key] ?? "")}
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          )}
        </Table>
        {(built.sections ?? []).map((s) => (
          <div key={s.title}>
            <div className="mb-2 text-sm font-semibold">{s.title}</div>
            <Table>
              <TableHeader>
                <TableRow>
                  {s.columns.map((c) => (
                    <TableHead
                      key={c.key}
                      className={`whitespace-nowrap ${c.align === "right" ? "text-right" : ""}`}
                    >
                      {c.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.rows.map((r, i) => (
                  <TableRow key={i}>
                    {s.columns.map((c) => (
                      <TableCell
                        key={c.key}
                        className={`whitespace-nowrap text-xs ${c.align === "right" ? "text-right" : ""}`}
                      >
                        {typeof r[c.key] === "number"
                          ? (r[c.key] as number).toLocaleString()
                          : r[c.key]}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {s.rows.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={s.columns.length}
                      className="py-4 text-center text-muted-foreground"
                    >
                      Nothing in this period.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        ))}
      </CardContent>
      {trace && <TraceDialog id={trace} onClose={() => setTrace(null)} />}
    </Card>
  );
}

function OptionField({
  label,
  value,
  onChange,
  all,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  all: string;
  options: string[];
}) {
  return (
    <Field label={label}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{all}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label || " "}</Label>
      {children}
    </div>
  );
}
