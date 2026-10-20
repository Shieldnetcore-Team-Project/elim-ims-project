import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check, ClipboardList, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ReasonDialog, fmtDate, fmtDateTime } from "@/components/preform/shared";
import { rpc, useMyUserId } from "@/components/preform/api";
import { usePermissions } from "@/lib/permissions";
import { addDays, localDay } from "@/lib/production-shift";
import { money, num } from "@/lib/format";
import { formatPieces } from "@/lib/preform-units";
import {
  CHECK_LABEL,
  DISPOSITION_LABEL,
  useFactorySuppliers,
  usePinvAction,
  usePreformAdjustments,
  usePreformReceipts,
  useReconciliation,
  type Adjustment,
  type PreformRow,
  type ReconRow,
  type Receipt,
} from "./api";

const RECEIPT_STATUS: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  pending_confirmation: { label: "Awaiting Store", variant: "secondary" },
  confirmed: { label: "Confirmed", variant: "default" },
  posted: { label: "In stock", variant: "default" },
  rejected: { label: "Rejected by Store", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "outline" },
};

// ------------------------------------------------------------- deliveries
export function DeliveriesPanel({
  factoryId,
  preforms,
  materialId,
}: {
  factoryId: string;
  preforms: PreformRow[];
  materialId?: string;
}) {
  const { can } = usePermissions();
  const me = useMyUserId();
  const suppliers = useFactorySuppliers(factoryId);
  const [supplier, setSupplier] = useState("all");
  const [from, setFrom] = useState(addDays(localDay(), -90));
  const [to, setTo] = useState(localDay());
  const receipts = usePreformReceipts(factoryId, {
    material: materialId ?? null,
    supplier: supplier === "all" ? null : supplier,
    from,
    to,
  });
  const perBag = useMemo(
    () => Object.fromEntries(preforms.map((p) => [p.id, p.pieces_per_bag])),
    [preforms],
  );
  const canConfirm = can("goods-receiving", "confirm");
  const [rejecting, setRejecting] = useState<Receipt | null>(null);
  const confirm = usePinvAction(
    (id: string) => rpc("confirm_goods_receipt", { p_id: id }),
    "Receipt confirmed — accepted pieces are now in stock",
  );
  const reject = usePinvAction(
    (a: { id: string; reason: string }) =>
      rpc("reject_goods_receipt", { p_id: a.id, p_reason: a.reason }),
    "Receipt rejected — nothing posted",
  );
  const rows = receipts.data ?? [];
  const pending = rows.filter((r) => r.status === "pending_confirmation");

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Deliveries &amp; supplier history</CardTitle>
          <p className="text-sm text-muted-foreground">
            {pending.length ? `${pending.length} awaiting Store confirmation. ` : ""}
            Prices and bag sizes are kept as recorded on each delivery.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={supplier} onValueChange={setSupplier}>
            <SelectTrigger className="w-44">
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
          <Input
            type="date"
            className="w-36"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
          />
          <Input
            type="date"
            className="w-36"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>GRN / date</TableHead>
              {!materialId && <TableHead>Preform</TableHead>}
              <TableHead>Supplier</TableHead>
              <TableHead>PO / invoice</TableHead>
              <TableHead className="text-right">Delivered</TableHead>
              <TableHead className="text-right">Accepted</TableHead>
              <TableHead className="text-right">Rejected</TableHead>
              <TableHead className="text-right">Price / value</TableHead>
              <TableHead>People</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
                  {receipts.isLoading ? "Loading…" : "No deliveries in this period."}
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => {
              const s = RECEIPT_STATUS[r.status] ?? {
                label: r.status,
                variant: "outline" as const,
              };
              const pb = r.pieces_per_bag ?? perBag[r.material_id] ?? null;
              // Maker-checker: the person who recorded a delivery cannot confirm it.
              const mine = r.submitted_by === me.data;
              return (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {r.receipt_number}
                    <div className="font-sans text-muted-foreground">
                      {fmtDate(r.delivery_date)}
                    </div>
                  </TableCell>
                  {!materialId && (
                    <TableCell>
                      <Link
                        to="/preform-inventory/$materialId"
                        params={{ materialId: r.material_id }}
                        className="hover:underline"
                      >
                        {r.material_name}
                      </Link>
                    </TableCell>
                  )}
                  <TableCell>{r.supplier_name ?? "—"}</TableCell>
                  <TableCell className="text-xs">
                    {r.po_number ?? "—"}
                    <div className="text-muted-foreground">
                      {[r.supplier_invoice, r.delivery_reference].filter(Boolean).join(" / ") || ""}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {num(r.quantity)}
                    <div className="text-[11px] text-muted-foreground">
                      {r.bags != null
                        ? `${num(r.bags)} bags × ${num(r.pieces_per_bag ?? 0)}${r.loose_pieces ? ` + ${num(r.loose_pieces)}` : ""}`
                        : "counted in pieces"}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {num(r.accepted_quantity)}
                    {pb && (
                      <div className="text-[11px] font-normal text-muted-foreground">
                        {formatPieces(r.accepted_quantity, pb).replace(/^[\d,]+ pcs /, "")}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {r.damaged_quantity > 0 ? (
                      <span className="text-destructive">{num(r.damaged_quantity)}</span>
                    ) : (
                      "0"
                    )}
                    {r.damaged_quantity > 0 && (
                      <div className="max-w-40 text-[11px] text-muted-foreground">
                        {r.rejected_disposition ? DISPOSITION_LABEL[r.rejected_disposition] : ""}
                        {r.rejection_reason ? ` — ${r.rejection_reason}` : ""}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {r.unit_cost == null ? "—" : `${money(r.unit_cost)}/pc`}
                    <div className="text-muted-foreground">{money(r.accepted_value)}</div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.submitted_by_name ?? "—"}
                    {r.confirmed_by_name && (
                      <div className="text-muted-foreground">✓ {r.confirmed_by_name}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={s.variant} className="whitespace-nowrap">
                      {s.label}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {r.status === "pending_confirmation" && canConfirm && !mine && me.data && (
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          className="gap-1"
                          disabled={confirm.isPending}
                          onClick={() => confirm.mutate(r.id)}
                        >
                          <Check className="h-3.5 w-3.5" /> Confirm
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setRejecting(r)}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
      <ReasonDialog
        open={!!rejecting}
        onOpenChange={(o) => !o && setRejecting(null)}
        title={`Reject ${rejecting?.receipt_number ?? ""}`}
        description="The delivery is not posted to stock. Say why, so QC / procurement can follow up."
        destructive
        confirmLabel="Reject receipt"
        pending={reject.isPending}
        onConfirm={(reason) =>
          rejecting &&
          reject.mutate({ id: rejecting.id, reason }, { onSuccess: () => setRejecting(null) })
        }
      />
    </Card>
  );
}

// ------------------------------------------------------------------ counts
export function CountsPanel({ factoryId, onCount }: { factoryId: string; onCount?: () => void }) {
  const { can } = usePermissions();
  const me = useMyUserId();
  const adjustments = usePreformAdjustments(factoryId, addDays(localDay(), -365), localDay());
  const [act, setAct] = useState<{ kind: "reject" | "cancel"; a: Adjustment } | null>(null);
  const approve = usePinvAction(
    (id: string) => rpc("approve_stock_adjustment", { p_id: id }),
    "Approved — post it to apply",
  );
  const post = usePinvAction(
    (id: string) => rpc("post_stock_adjustment", { p_id: id }),
    "Posted to the stock ledger",
  );
  const reject = usePinvAction(
    (a: { id: string; reason: string }) =>
      rpc("reject_stock_adjustment", { p_id: a.id, p_reason: a.reason }),
    "Adjustment rejected",
  );
  const cancel = usePinvAction(
    (a: { id: string; reason: string }) =>
      rpc("cancel_stock_adjustment", { p_id: a.id, p_reason: a.reason }),
    "Adjustment cancelled",
  );
  const rows = adjustments.data ?? [];

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Counts, opening balances &amp; adjustments</CardTitle>
          <p className="text-sm text-muted-foreground">
            A count raises an adjustment for the variance; someone else approves and posts it. A
            count is refused at posting if stock has moved since it was taken.
          </p>
        </div>
        {onCount && can("raw-materials", "submit") && (
          <Button className="gap-2" onClick={onCount}>
            <ClipboardList className="h-4 w-4" /> Record count
          </Button>
        )}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Preform</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">System</TableHead>
              <TableHead className="text-right">Counted</TableHead>
              <TableHead className="text-right">Variance</TableHead>
              <TableHead>Reason / support</TableHead>
              <TableHead>People</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                  {adjustments.isLoading
                    ? "Loading…"
                    : "No counts or adjustments in the last year."}
                </TableCell>
              </TableRow>
            )}
            {rows.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="whitespace-nowrap font-mono text-xs">
                  {a.reference_number}
                  <div className="font-sans text-muted-foreground">
                    {fmtDateTime(a.submitted_at)}
                  </div>
                </TableCell>
                <TableCell>{a.material_name}</TableCell>
                <TableCell className="text-xs">
                  {a.adjustment_kind === "opening_balance"
                    ? "Opening balance"
                    : a.adjustment_kind === "count"
                      ? "Physical count"
                      : a.movement_type === "damaged"
                        ? "Write-off"
                        : "Adjustment"}
                  {a.unit_cost != null && (
                    <div className="text-muted-foreground">at {money(a.unit_cost)}/pc</div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {a.system_quantity == null ? "—" : num(a.system_quantity)}
                </TableCell>
                <TableCell className="text-right">
                  {a.counted_quantity == null ? "—" : num(a.counted_quantity)}
                  {a.counted_pieces_per_bag != null && (
                    <div className="text-[11px] text-muted-foreground">
                      {num(a.counted_bags ?? 0)} × {num(a.counted_pieces_per_bag)}
                      {a.counted_loose ? ` + ${num(a.counted_loose)}` : ""}
                    </div>
                  )}
                </TableCell>
                <TableCell
                  className={`text-right font-medium ${a.quantity_delta < 0 ? "text-destructive" : "text-primary"}`}
                >
                  {a.quantity_delta > 0 ? "+" : ""}
                  {num(a.quantity_delta)}
                </TableCell>
                <TableCell className="max-w-56 text-xs">
                  {a.reason}
                  {a.supporting_reference && (
                    <div className="text-muted-foreground">Ref: {a.supporting_reference}</div>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {a.submitted_by_name ?? "—"}
                  {a.reviewed_by_name && (
                    <div className="text-muted-foreground">✓ {a.reviewed_by_name}</div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      a.status === "posted"
                        ? "default"
                        : a.status === "rejected" || a.status === "cancelled"
                          ? "outline"
                          : "secondary"
                    }
                    className="whitespace-nowrap"
                  >
                    {a.status.replace(/_/g, " ")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {a.status === "pending_approval" &&
                      a.submitted_by !== me.data &&
                      can("raw-materials", "approve") && (
                        <Button
                          size="sm"
                          disabled={approve.isPending}
                          onClick={() => approve.mutate(a.id)}
                        >
                          Approve
                        </Button>
                      )}
                    {a.status === "approved" &&
                      a.submitted_by !== me.data &&
                      can("raw-materials", "post") && (
                        <Button
                          size="sm"
                          disabled={post.isPending}
                          onClick={() => post.mutate(a.id)}
                        >
                          Post
                        </Button>
                      )}
                    {(a.status === "pending_approval" || a.status === "approved") &&
                      can("raw-materials", "reject") && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setAct({ kind: "reject", a })}
                        >
                          Reject
                        </Button>
                      )}
                    {a.status === "pending_approval" &&
                      a.submitted_by === me.data &&
                      can("raw-materials", "cancel") && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setAct({ kind: "cancel", a })}
                        >
                          Cancel
                        </Button>
                      )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      <ReasonDialog
        open={!!act}
        onOpenChange={(o) => !o && setAct(null)}
        title={`${act?.kind === "reject" ? "Reject" : "Cancel"} ${act?.a.reference_number ?? ""}`}
        destructive
        required={act?.kind === "reject"}
        confirmLabel={act?.kind === "reject" ? "Reject" : "Cancel adjustment"}
        pending={reject.isPending || cancel.isPending}
        onConfirm={(reason) => {
          if (!act) return;
          const done = { onSuccess: () => setAct(null) };
          if (act.kind === "reject") reject.mutate({ id: act.a.id, reason }, done);
          else cancel.mutate({ id: act.a.id, reason }, done);
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------- reconciliation
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

export function ReconciliationPanel({
  factoryId,
  onCount,
}: {
  factoryId: string;
  onCount?: (materialId?: string) => void;
}) {
  const [allMaterials, setAllMaterials] = useState(false);
  const recon = useReconciliation(factoryId, !allMaterials);
  const rows = useMemo(
    () =>
      [...(recon.data ?? [])].sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
          a.check_code.localeCompare(b.check_code),
      ),
    [recon.data],
  );
  const count = (s: ReconRow["severity"]) => rows.filter((r) => r.severity === s).length;

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Reconciliation</CardTitle>
          <p className="text-sm text-muted-foreground">
            {count("error")} errors · {count("warning")} warnings · {count("info")} notes. Nothing
            is corrected automatically — investigate, then count, reverse or migrate with approval.
          </p>
        </div>
        <Select
          value={allMaterials ? "all" : "preforms"}
          onValueChange={(v) => setAllMaterials(v === "all")}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="preforms">Preforms only</SelectItem>
            <SelectItem value="all">All raw materials</SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Severity</TableHead>
              <TableHead>Check</TableHead>
              <TableHead>Preform / supplier</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>Detail</TableHead>
              <TableHead className="text-right">Expected</TableHead>
              <TableHead className="text-right">Actual</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  {recon.isLoading ? "Checking…" : "No discrepancies found."}
                </TableCell>
              </TableRow>
            )}
            {rows.map((r, i) => (
              <TableRow key={i}>
                <TableCell>
                  <Badge
                    variant={
                      r.severity === "error"
                        ? "destructive"
                        : r.severity === "warning"
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {r.severity}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs font-medium">
                  {CHECK_LABEL[r.check_code] ?? r.check_code}
                </TableCell>
                <TableCell>
                  {r.material_id ? (
                    <Link
                      to="/preform-inventory/$materialId"
                      params={{ materialId: r.material_id }}
                      className="hover:underline"
                    >
                      {r.material_name}
                    </Link>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{r.reference ?? "—"}</TableCell>
                <TableCell className="max-w-md text-xs">{r.detail}</TableCell>
                <TableCell className="text-right">
                  {r.expected == null ? "—" : num(r.expected)}
                </TableCell>
                <TableCell className="text-right">
                  {r.actual == null ? "—" : num(r.actual)}
                </TableCell>
                <TableCell>
                  {onCount &&
                    r.material_id &&
                    ["ledger_mismatch", "negative_balance", "ledger_gap"].includes(
                      r.check_code,
                    ) && (
                      <Button size="sm" variant="outline" onClick={() => onCount(r.material_id!)}>
                        Count
                      </Button>
                    )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
