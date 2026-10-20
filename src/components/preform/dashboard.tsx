import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, ClipboardPlus, FileText, Inbox, PackageCheck, TriangleAlert } from "lucide-react";
import { usePermissions } from "@/lib/permissions";
import { num } from "@/lib/format";
import { localDay } from "@/lib/production-shift";
import {
  rpc,
  useDaySummary,
  useIssues,
  useMyUserId,
  usePfAction,
  usePreformMaterials,
  usePreformOperators,
} from "./api";
import { Pieces, fmtDate } from "./shared";

export type PreformTab =
  | "dashboard"
  | "issues"
  | "shifts"
  | "qc"
  | "stocking"
  | "transfers"
  | "exceptions"
  | "reports"
  | "setup";

export function DashboardTab({
  factoryId,
  goTo,
}: {
  factoryId: string;
  goTo: (t: PreformTab) => void;
}) {
  const { can } = usePermissions();
  const isOperator = can("preform-production", "submit");
  const isManager = can("preform-production", "reverse");
  const me = useMyUserId();
  const operators = usePreformOperators(factoryId);
  const materials = usePreformMaterials(factoryId);
  const [operatorId, setOperatorId] = useState("");
  const [materialId, setMaterialId] = useState("");
  const [date, setDate] = useState(localDay());

  // Operators see themselves; everyone else starts on the first operator.
  useEffect(() => {
    if (operatorId) return;
    const mine = operators.data?.find((o) => o.id === me.data);
    if (mine) setOperatorId(mine.id);
    else if (operators.data?.length) setOperatorId(operators.data[0].id);
  }, [operators.data, me.data, operatorId]);
  useEffect(() => {
    if (!materialId && materials.data?.length) {
      setMaterialId((materials.data.find((m) => m.pieces_per_bag) ?? materials.data[0]).id);
    }
  }, [materials.data, materialId]);

  const m = materials.data?.find((x) => x.id === materialId);
  const pb = m?.pieces_per_bag;
  const s = useDaySummary(operatorId, materialId, date);
  const pending = useIssues(factoryId, { operatorId, status: "issued" });
  const isMine = operatorId === me.data;
  const accept = usePfAction(
    (id: string) => rpc("respond_preform_issue", { p_id: id, p_accept: true }),
    "Accepted — added to your available preforms",
  );
  const canPick = !isOperator || isManager || (operators.data ?? []).length > 1;
  const d = s.data;
  const usage = d
    ? d.good_bottles + d.damaged_preforms + d.damaged_bottles + d.other_losses - d.usage_reversed
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {canPick && (
          <Select value={operatorId} onValueChange={setOperatorId}>
            <SelectTrigger className="w-52">
              <SelectValue placeholder="Operator" />
            </SelectTrigger>
            <SelectContent>
              {(operators.data ?? []).map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.full_name}
                  {o.id === me.data ? " (you)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={materialId} onValueChange={setMaterialId}>
          <SelectTrigger className="w-52">
            <SelectValue placeholder="Preform" />
          </SelectTrigger>
          <SelectContent>
            {(materials.data ?? []).map((x) => (
              <SelectItem key={x.id} value={x.id}>
                {x.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="date"
          className="w-40"
          max={localDay()}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <div className="ml-auto flex flex-wrap gap-2">
          {isOperator && (
            <Button className="gap-2" onClick={() => goTo("shifts")}>
              <ClipboardPlus className="h-4 w-4" /> Record shift output
            </Button>
          )}
          <Button variant="outline" className="gap-2" onClick={() => goTo("reports")}>
            <FileText className="h-4 w-4" /> Reports
          </Button>
        </div>
      </div>

      {(operators.data ?? []).length === 0 && operators.isSuccess && (
        <Card className="rounded-2xl border-dashed">
          <CardContent className="py-6 text-sm text-muted-foreground">
            No operator is set up yet. Give the operator's role the Preform Production
            &quot;submit&quot; right (Admin → Roles &amp; Permissions).
          </CardContent>
        </Card>
      )}

      {(pending.data ?? []).length > 0 && (
        <Card className="rounded-2xl border-warning/50">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Inbox className="h-4 w-4" /> Preforms waiting to be accepted
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(pending.data ?? []).map((i) => (
              <div
                key={i.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2 text-sm"
              >
                <div>
                  <span className="font-mono text-xs">{i.reference}</span> · {fmtDate(i.issue_date)}{" "}
                  · <b>{num(i.pieces)} pcs</b> ({i.bags} bags
                  {i.loose_pieces ? ` + ${i.loose_pieces} pcs` : ""})
                  {i.notes && <span className="text-muted-foreground"> · {i.notes}</span>}
                </div>
                {(isMine || isManager) && isOperator && (
                  <Button
                    size="sm"
                    className="gap-1"
                    disabled={accept.isPending}
                    onClick={() => accept.mutate(i.id)}
                  >
                    <Check className="h-3.5 w-3.5" /> Accept
                  </Button>
                )}
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              To reject an issue (wrong count, damaged bags), use the Store issues tab.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="Opening stock"
          value={<Pieces value={d?.opening} perBag={pb} />}
          hint={`Start of ${fmtDate(date)}`}
        />
        <Tile
          label="Received from store"
          value={<Pieces value={d?.received} perBag={pb} />}
          hint="Accepted issues this day"
        />
        <Tile
          label="Available now"
          value={<Pieces value={d?.held_now} perBag={pb} />}
          hint={`${num(d?.received_unused ?? 0)} received, not yet used`}
          tone="text-primary"
        />
        <Tile
          label="Expected remaining"
          value={<Pieces value={d?.closing} perBag={pb} />}
          hint="End of this day, from the ledger"
        />
        <Tile
          label="Good bottles"
          value={num(d?.good_bottles ?? 0)}
          hint="Recorded this day"
          tone="text-success"
        />
        <Tile
          label="Damaged"
          value={num(
            (d?.damaged_preforms ?? 0) + (d?.damaged_bottles ?? 0) + (d?.other_losses ?? 0),
          )}
          hint={`${num(d?.damaged_preforms ?? 0)} preforms · ${num(d?.damaged_bottles ?? 0)} bottles · ${num(d?.other_losses ?? 0)} other${d?.qc_rejected ? ` · QC rejected ${num(d.qc_rejected)}` : ""}`}
          tone="text-destructive"
        />
        <Tile label="Total usage" value={num(usage)} hint="Good + damaged, counted once" />
        <Tile label="Stocked" value={num(d?.stocked ?? 0)} hint="Accepted by the Warehouse" />
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <Attention
          icon={ClipboardPlus}
          label="Drafts not submitted"
          count={d?.drafts ?? 0}
          onClick={() => goTo("shifts")}
        />
        <Attention
          icon={Check}
          label="Waiting for QC"
          count={d?.awaiting_qc ?? 0}
          onClick={() => goTo("qc")}
        />
        <Attention
          icon={PackageCheck}
          label="Good bottles left to stock"
          count={d?.to_stock ?? 0}
          onClick={() => goTo("shifts")}
        />
        <Attention
          icon={TriangleAlert}
          label="Open exceptions"
          count={d?.open_exceptions ?? 0}
          onClick={() => goTo("exceptions")}
          danger
        />
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  tone = "",
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: string;
}) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`mt-1 text-xl font-semibold ${tone}`}>{value}</div>
        {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function Attention({
  icon: Icon,
  label,
  count,
  onClick,
  danger,
}: {
  icon: React.ElementType;
  label: string;
  count: number;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-between rounded-2xl border p-3 text-left text-sm transition-colors hover:bg-muted/50 ${
        count > 0 && danger ? "border-destructive/50" : ""
      }`}
    >
      <span className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" /> {label}
      </span>
      <span
        className={`text-lg font-semibold ${count > 0 ? (danger ? "text-destructive" : "") : "text-muted-foreground"}`}
      >
        {num(count)}
      </span>
    </button>
  );
}
