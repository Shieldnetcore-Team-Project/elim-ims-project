import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  useDailyReport,
  usePreformMaterials,
  usePreformOperators,
  useShiftReport,
  useStockings,
  useTransfers,
  useUserNames,
} from "./api";
import { preformReportPdf } from "./report-pdf";
import { fmtDate, fmtDateTime } from "./shared";

type Kind = "shift" | "daily" | "stocking" | "transfer";
type Col = { key: string; label: string; align?: "right" };
type Built = {
  columns: Col[];
  rows: Record<string, string | number>[];
  totals?: Record<string, string | number | undefined> | null;
  pending: number;
};

const KIND_LABEL: Record<Kind, string> = {
  shift: "Shift report",
  daily: "Daily report",
  stocking: "Inventory stocking report",
  transfer: "Transfer report",
};

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
  const [kind, setKind] = useState<Kind>("daily");
  const [from, setFrom] = useState(localDay());
  const [to, setTo] = useState(localDay());
  const [operatorId, setOperatorId] = useState(ALL);
  const [materialId, setMaterialId] = useState(ALL);
  const [shift, setShift] = useState<string>(ALL);
  const [status, setStatus] = useState(ALL);
  const [dept, setDept] = useState(ALL);

  const op = operatorId === ALL ? null : operatorId;
  const mat = materialId === ALL ? null : materialId;
  const shifts = useShiftReport(kind === "shift" ? factoryId : undefined, {
    from,
    to,
    operatorId: op,
    materialId: mat,
    shift: shift === ALL ? null : (shift as Shift),
    status: status === ALL ? null : status,
  });
  const daily = useDailyReport(kind === "daily" ? factoryId : undefined, from, to, op, mat);
  const stockings = useStockings(kind === "stocking" ? factoryId : undefined);
  const transfers = useTransfers(kind === "transfer" ? factoryId : undefined);
  const names = useUserNames([
    ...(stockings.data ?? []).flatMap((s) => [s.sent_by, s.received_by, s.record?.operator_id]),
    ...(transfers.data ?? []).flatMap((t) => [t.sent_by, t.received_by]),
  ]);
  const departments = [...new Set((transfers.data ?? []).map((t) => t.to_department))];

  const built: Built = useMemo(() => {
    const perBagByName = (name: string) =>
      materials.data?.find((m) => m.name === name)?.pieces_per_bag;
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
      const rows = (daily.data ?? []).map((r) => ({
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
    const rows = list.map((t) => ({
      sent: fmtDateTime(t.sent_at),
      ref: t.reference,
      product: t.product?.name ?? "",
      to: t.to_department,
      dispatched: t.quantity_sent,
      received: t.quantity_received ?? "",
      diff: t.quantity_received == null ? "" : t.quantity_sent - t.quantity_received,
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
        { key: "product", label: "Product" },
        { key: "to", label: "To" },
        { key: "dispatched", label: "Qty sent", align: "right" },
        { key: "received", label: "Qty received", align: "right" },
        { key: "diff", label: "Discrepancy", align: "right" },
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
  ]);

  const period = from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`;
  const filterText = [
    op && `Operator: ${operators.data?.find((o) => o.id === op)?.full_name ?? ""}`,
    mat &&
      kind !== "stocking" &&
      kind !== "transfer" &&
      `Preform: ${materials.data?.find((m) => m.id === mat)?.name ?? ""}`,
    shift !== ALL && kind === "shift" && `Shift: ${SHIFT_LABEL[shift as Shift]}`,
    status !== ALL && kind !== "daily" && `Status: ${STATUS_LABEL[status] ?? status}`,
    dept !== ALL && kind === "transfer" && `Department: ${dept}`,
  ].filter(Boolean) as string[];
  const pendingNote = built.pending
    ? `Includes ${built.pending} pending record(s) not yet final (drafts, awaiting QC, awaiting stocking or receipt).`
    : null;

  const statusOptions =
    kind === "shift"
      ? ["draft", "awaiting_inspection", "awaiting_stocking", "completed", "reversed"]
      : kind === "stocking"
        ? ["sent", "accepted", "rejected", "cancelled", "reversed"]
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
            <Input
              type="date"
              className="w-36"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              className="w-36"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
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
          {kind !== "transfer" && (
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
          {(kind === "shift" || kind === "daily") && (
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
          {kind === "shift" && (
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
          {kind !== "daily" && (
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
        </p>
        {pendingNote && <p className="text-xs text-warning">{pendingNote}</p>}
      </CardHeader>
      <CardContent className="overflow-x-auto">
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
              <TableRow key={i}>
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
      </CardContent>
    </Card>
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
