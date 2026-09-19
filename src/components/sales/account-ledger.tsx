import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { money, num } from "@/lib/format";
import {
  buildDisplayRows,
  type AccountSummary,
  type LedgerLookups,
  type LedgerTxn,
  type PendingSale,
} from "@/lib/customer-account";

export function AccountStatusBadge({ status }: { status: AccountSummary["account_status"] }) {
  const cls =
    status === "CREDIT BALANCE"
      ? "border-success/30 bg-success/15 text-success"
      : status === "OUTSTANDING DEBT"
        ? "border-destructive/30 bg-destructive/10 text-destructive"
        : status === "CREDIT AND DEBT"
          ? "border-warning/30 bg-warning/15 text-warning"
          : "";
  return (
    <Badge variant="outline" className={cls}>
      {status}
    </Badge>
  );
}

// Big-number cards for the account position. "Available Advance" and
// "Outstanding Debt" are always two separate figures — never one signed number.
export function AccountSummaryCards({ summary }: { summary: AccountSummary }) {
  const cells: { label: string; value: string; tone?: "success" | "destructive" }[] = [
    {
      label: "Available Advance",
      value: money(summary.available_advance),
      tone: summary.available_advance > 0 ? "success" : undefined,
    },
    {
      label: "Outstanding Debt",
      value: money(summary.outstanding_debt),
      tone: summary.outstanding_debt > 0 ? "destructive" : undefined,
    },
    { label: "Total Advance Paid", value: money(summary.total_advance_paid) },
    { label: "Goods Collected", value: money(summary.goods_collected) },
    { label: "Advance Used", value: money(summary.advance_used) },
    { label: "Total Payments", value: money(summary.total_payments) },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/30 p-3 text-sm sm:grid-cols-3">
      {cells.map((c) => (
        <div key={c.label}>
          <span className="block text-muted-foreground">{c.label}</span>
          <span
            className={`font-medium ${
              c.tone === "success"
                ? "text-success"
                : c.tone === "destructive"
                  ? "text-destructive"
                  : ""
            }`}
          >
            {c.value}
          </span>
        </div>
      ))}
    </div>
  );
}

const dash = <span className="text-muted-foreground">—</span>;

export function AccountLedgerTable({
  ledger,
  pendingSales,
  lookups,
  compact = false,
  limit,
  broughtForward,
}: {
  ledger: LedgerTxn[];
  pendingSales: PendingSale[];
  lookups?: LedgerLookups;
  compact?: boolean;
  limit?: number;
  // Set when the statement starts part-way through the history.
  broughtForward?: { credit: number; debt: number };
}) {
  const all = buildDisplayRows(ledger, pendingSales, lookups);
  const rows = limit ? all.slice(-limit) : all;

  if (rows.length === 0 && !broughtForward) {
    return (
      <p className="py-4 text-center text-sm text-muted-foreground">No account activity yet.</p>
    );
  }

  return (
    <Table className={compact ? "text-xs" : ""}>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          {!compact && <TableHead>Reference</TableHead>}
          <TableHead>Description</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          {!compact && <TableHead className="text-right">Paid</TableHead>}
          {!compact && <TableHead className="text-right">Advance used</TableHead>}
          <TableHead className="text-right">Advance balance</TableHead>
          <TableHead className="text-right">Debt balance</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {broughtForward && (
          <TableRow className="bg-muted/30 font-medium">
            <TableCell colSpan={compact ? 2 : 3}>Balance brought forward</TableCell>
            <TableCell />
            {!compact && <TableCell />}
            {!compact && <TableCell />}
            <TableCell className="text-right">{money(broughtForward.credit)}</TableCell>
            <TableCell className="text-right">{money(broughtForward.debt)}</TableCell>
          </TableRow>
        )}
        {rows.map((r) => (
          <TableRow key={r.key} className={r.pending ? "bg-muted/30 text-muted-foreground" : ""}>
            <TableCell className="whitespace-nowrap">
              {new Date(r.date).toLocaleDateString()}
            </TableCell>
            {!compact && <TableCell className="font-mono text-xs">{r.reference}</TableCell>}
            <TableCell>
              {r.description}
              {r.pending && (
                <Badge variant="outline" className="ml-2">
                  Pending
                </Badge>
              )}
            </TableCell>
            <TableCell
              className={`text-right ${r.sign === "+" ? "text-success" : r.sign === "-" ? "text-destructive" : ""}`}
            >
              {r.sign}
              {money(r.amount)}
            </TableCell>
            {!compact && (
              <TableCell className="text-right">
                {r.paid && r.paid > 0 ? money(r.paid) : dash}
              </TableCell>
            )}
            {!compact && (
              <TableCell className="text-right">
                {r.advanceUsed && r.advanceUsed > 0 ? money(r.advanceUsed) : dash}
              </TableCell>
            )}
            <TableCell
              className={`text-right font-medium ${r.creditAfter && r.creditAfter > 0 ? "text-success" : ""}`}
            >
              {r.creditAfter === null ? dash : money(r.creditAfter)}
            </TableCell>
            <TableCell
              className={`text-right font-medium ${r.debtAfter && r.debtAfter > 0 ? "text-destructive" : ""}`}
            >
              {r.debtAfter === null ? dash : money(r.debtAfter)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// "100 Carton, 20 Sachet" for the ledger's sale rows.
export function summariseItems(
  items: { quantity: number; products: { name: string; unit: string } | null }[],
): string {
  return items
    .map((it) =>
      `${num(Number(it.quantity))} ${it.products?.unit ?? ""} ${it.products?.name ?? ""}`
        .replace(/\s+/g, " ")
        .trim(),
    )
    .join(", ");
}
