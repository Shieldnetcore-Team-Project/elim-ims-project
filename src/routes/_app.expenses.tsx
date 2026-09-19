import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { money } from "@/lib/format";
import { COUNTED_STATUSES, fetchAll } from "@/lib/metrics";
import { requestDelete } from "@/lib/request-delete";
import { RequestDeleteDialog } from "@/components/shared/request-delete-dialog";
import { toast } from "sonner";
import {
  Plus,
  Printer,
  FileDown,
  Paperclip,
  Trash2,
  Pencil,
  Receipt,
  Check,
  X,
  Send,
  Ban,
  Undo2,
  Search,
  TrendingUp,
  TrendingDown,
  Wallet,
  ArrowDownToLine,
  ArrowUpFromLine,
} from "lucide-react";
import { generateExpenseVoucherPdf, generateReportPdf } from "@/lib/pdf";
import { logAudit } from "@/lib/audit";
import { ApprovalHistory } from "@/components/workflow/approval-history";
import { startOfDay, startOfWeek, startOfMonth, startOfYear, format } from "date-fns";

export const Route = createFileRoute("/_app/expenses")({
  head: () => ({ meta: [{ title: "Expenses — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="expenses">
      <ExpensesPage />
    </RequireAccess>
  ),
});

type PaymentMethod = "cash" | "transfer" | "pos" | "card" | "cheque" | "credit";
type EntryType = "cash_out" | "cash_in";
type Category = { id: string; name: string };
type Expense = {
  id: string;
  expense_date: string;
  category_id: string | null;
  description: string | null;
  vendor: string | null;
  receipt_number: string | null;
  payment_method: string;
  amount: number;
  approved_by: string | null;
  requested_by_name: string | null;
  approval_status: string;
  approved_at: string | null;
  recorded_by: string | null;
  attachment_url: string | null;
  remarks: string | null;
  created_at: string;
  submitted_by: string | null;
  status: string;
  expense_categories: { name: string } | null;
};
type CashIn = {
  id: string;
  transaction_number: string;
  transaction_date: string;
  category: string;
  description: string | null;
  amount: number;
  payment_method: string;
  payer_payee: string | null;
  recorded_by_name: string;
  recorded_by: string | null;
  created_at: string;
};

const statusBadge = (s: string): "default" | "secondary" | "outline" | "destructive" =>
  s === "posted"
    ? "secondary"
    : s === "rejected" || s === "cancelled" || s === "reversed"
      ? "destructive"
      : "outline";

// Only approved/posted expenses are money spent; pending, rejected, cancelled and
// reversed ones are listed but never added to the totals (same rule the
// dashboards use).
const COUNTED = new Set(COUNTED_STATUSES);

type RangeKey = "all" | "today" | "week" | "month" | "year";

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "today", label: "Daily" },
  { key: "week", label: "Weekly" },
  { key: "month", label: "Monthly" },
  { key: "year", label: "Yearly" },
];

function rangeStart(key: RangeKey): Date | null {
  const now = new Date();
  if (key === "today") return startOfDay(now);
  if (key === "week") return startOfWeek(now);
  if (key === "month") return startOfMonth(now);
  if (key === "year") return startOfYear(now);
  return null;
}

type LedgerRow = {
  key: string;
  date: string;
  createdAt: string;
  kind: EntryType;
  details: string;
  sub: string | null;
  category: string;
  amount: number;
  counts: boolean;
  statusLabel: string | null;
  statusVariant: "default" | "secondary" | "outline" | "destructive";
  expense?: Expense;
  cashIn?: CashIn;
  balanceAfter?: number;
  totalExpensesAfter?: number;
};

function ExpensesPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const currency = settings.data?.currency ?? "NGN";
  const qc = useQueryClient();
  const { canWrite, canApprove, canReject, canPost, canCancel, canReverse } = usePermissions();
  const write = canWrite("expenses");
  // Cash-in entries are recorded via create_cash_transaction / the
  // cash_transactions table, both gated server-side on 'receipts-payments'
  // write (see RLS + RPC), not 'expenses' write — a different permission
  // from the cash-out (expense) side of this same ledger page. Gating the
  // Cash In option on `write` alone let a user with only expenses:write
  // fill out and submit a cash-in entry that the server would then reject
  // with "Insufficient permissions".
  const writeCashIn = canWrite("receipts-payments");
  const approve = canApprove("expenses");
  const reject = canReject("expenses");
  const post = canPost("expenses");
  const cancel = canCancel("expenses");
  const reverse = canReverse("expenses");
  const [formOpen, setFormOpen] = useState(false);
  const [defaultEntryType, setDefaultEntryType] = useState<EntryType>("cash_out");
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [editingCashIn, setEditingCashIn] = useState<CashIn | null>(null);
  const [deleteExpenseTarget, setDeleteExpenseTarget] = useState<Expense | null>(null);
  const [deleteCashInTarget, setDeleteCashInTarget] = useState<CashIn | null>(null);
  const [range, setRange] = useState<RangeKey>("month");
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [approveTarget, setApproveTarget] = useState<Expense | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Expense | null>(null);
  const [postTarget, setPostTarget] = useState<Expense | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Expense | null>(null);
  const [reverseTarget, setReverseTarget] = useState<Expense | null>(null);

  const categories = useQuery({
    queryKey: ["expense-categories", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expense_categories")
        .select("id,name")
        .eq("factory_id", factoryId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Category[];
    },
  });

  const list = useQuery({
    queryKey: ["expenses-list", factoryId],
    enabled: !!factoryId,
    // Every row, not a capped page: the cards and running balance below are
    // sums over this list.
    queryFn: () =>
      fetchAll<Expense>(
        (a, b) =>
          supabase
            .from("expenses")
            .select(
              "id,expense_date,category_id,description,vendor,receipt_number,payment_method,amount,approved_by,requested_by_name,approval_status,approved_at,recorded_by,attachment_url,remarks,created_at,submitted_by,status,expense_categories(name)",
            )
            .eq("factory_id", factoryId!)
            .order("expense_date", { ascending: false })
            .order("id")
            .range(a, b) as any,
      ),
  });

  const cashIns = useQuery({
    queryKey: ["expenses-cash-in", factoryId],
    enabled: !!factoryId,
    queryFn: () =>
      fetchAll<CashIn>(
        (a, b) =>
          supabase
            .from("cash_transactions")
            .select(
              "id,transaction_number,transaction_date,category,description,amount,payment_method,payer_payee,recorded_by_name,recorded_by,created_at",
            )
            .eq("factory_id", factoryId!)
            .eq("transaction_type", "receipt")
            .order("transaction_date", { ascending: false })
            .order("id")
            .range(a, b) as any,
      ),
  });

  const profiles = useQuery({
    queryKey: ["profiles-map"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id,full_name");
      if (error) throw error;
      const map: Record<string, string> = {};
      (data ?? []).forEach((p) => {
        map[p.id] = p.full_name ?? "—";
      });
      return map;
    },
  });

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const currentUserName = (currentUser.data && profiles.data?.[currentUser.data]) || "";

  // Chronological (oldest→newest) so cumulative Balance/Total Expenses read
  // naturally; the table then displays this reversed (newest first) while
  // keeping each row's already-computed running totals.
  const rangeFiltered = useMemo(() => {
    const since = rangeStart(range);
    const rows: LedgerRow[] = [];
    (list.data ?? []).forEach((e) => {
      if (since && new Date(e.expense_date) < since) return;
      rows.push({
        key: `e-${e.id}`,
        date: e.expense_date,
        createdAt: e.created_at,
        kind: "cash_out",
        details: e.description ?? "—",
        sub: e.vendor ?? null,
        category: e.expense_categories?.name ?? "Uncategorized",
        amount: Number(e.amount),
        counts: COUNTED.has(e.status),
        statusLabel: e.status === "posted" ? null : e.status.replace(/_/g, " "),
        statusVariant: statusBadge(e.status),
        expense: e,
      });
    });
    (cashIns.data ?? []).forEach((c) => {
      if (since && new Date(c.transaction_date) < since) return;
      rows.push({
        key: `c-${c.id}`,
        date: c.transaction_date,
        createdAt: c.created_at,
        kind: "cash_in",
        details: c.description ?? "Cash in",
        sub: c.payer_payee ? `From: ${c.payer_payee}` : null,
        category: "Cash In",
        amount: Number(c.amount),
        counts: true,
        statusLabel: null,
        statusVariant: "outline",
        cashIn: c,
      });
    });
    rows.sort((a, b) => {
      const d = new Date(a.date).getTime() - new Date(b.date).getTime();
      if (d !== 0) return d;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    let runningBalance = 0;
    let runningExpenses = 0;
    for (const row of rows) {
      if (row.counts) {
        if (row.kind === "cash_in") runningBalance += row.amount;
        else {
          runningBalance -= row.amount;
          runningExpenses += row.amount;
        }
      }
      row.balanceAfter = runningBalance;
      row.totalExpensesAfter = runningExpenses;
    }
    return rows;
  }, [list.data, cashIns.data, range]);

  const categoryColumns = useMemo(() => {
    const totals: Record<string, number> = {};
    rangeFiltered.forEach((r) => {
      if (r.kind === "cash_out" && r.counts)
        totals[r.category] = (totals[r.category] ?? 0) + r.amount;
    });
    return Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
  }, [rangeFiltered]);

  const totalExpenses = rangeFiltered.length
    ? (rangeFiltered[rangeFiltered.length - 1].totalExpensesAfter ?? 0)
    : 0;
  const totalCashIn = useMemo(
    () => rangeFiltered.filter((r) => r.kind === "cash_in").reduce((s, r) => s + r.amount, 0),
    [rangeFiltered],
  );
  const balance = totalCashIn - totalExpenses;
  const expenseCount = rangeFiltered.filter((r) => r.kind === "cash_out" && r.counts).length;
  const cashInCount = rangeFiltered.filter((r) => r.kind === "cash_in").length;

  const displayRows = useMemo(() => {
    let rows = [...rangeFiltered].reverse();
    if (typeFilter === "cash_in") rows = rows.filter((r) => r.kind === "cash_in");
    else if (typeFilter !== "all")
      rows = rows.filter((r) => r.kind === "cash_out" && r.category === typeFilter);
    const query = q.trim().toLowerCase();
    if (query) {
      rows = rows.filter(
        (r) =>
          r.details.toLowerCase().includes(query) ||
          (r.sub ?? "").toLowerCase().includes(query) ||
          r.category.toLowerCase().includes(query),
      );
    }
    return rows;
  }, [rangeFiltered, typeFilter, q]);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["expenses-list"] });
    qc.invalidateQueries({ queryKey: ["expenses-cash-in"] });
  };

  const del = useMutation({
    mutationFn: async ({ expense, reason }: { expense: Expense; reason: string }) => {
      await requestDelete("expenses", expense.id, reason);
    },
    onSuccess: () => {
      toast.success("Deletion requested — pending admin approval");
      setDeleteExpenseTarget(null);
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const delCashIn = useMutation({
    mutationFn: async ({ cashIn, reason }: { cashIn: CashIn; reason: string }) => {
      await requestDelete("cash_transactions", cashIn.id, reason);
    },
    onSuccess: () => {
      toast.success("Deletion requested — pending admin approval");
      setDeleteCashInTarget(null);
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const printExpense = (e: Expense, action: "print" | "download") => {
    generateExpenseVoucherPdf(
      {
        company: {
          name: settings.data?.company_name ?? "FMIS",
          address: settings.data?.address,
          phone: settings.data?.phone,
          logo_url: settings.data?.logo_url,
        },
        expense_date: e.expense_date,
        category: e.expense_categories?.name,
        description: e.description,
        vendor: e.vendor,
        receipt_number: e.receipt_number,
        payment_method: e.payment_method,
        amount: Number(e.amount),
        requested_by: e.requested_by_name,
        approval_status: e.status,
        approved_by: e.approved_by,
        recorded_by: e.recorded_by ? profiles.data?.[e.recorded_by] : undefined,
        remarks: e.remarks,
        currency: settings.data?.currency ?? "NGN",
      },
      action,
    );
  };

  const printLedger = (action: "print" | "download") => {
    const columns = [
      { key: "date", label: "Date" },
      { key: "details", label: "Details" },
      { key: "cash_in", label: "Cash In" },
      ...categoryColumns.map((c) => ({ key: c, label: `Cash Out — ${c}` })),
      { key: "balance", label: "Balance" },
      { key: "total_expenses", label: "Total Expenses" },
    ];
    const rows = rangeFiltered.map((r) => {
      const row: Record<string, unknown> = {
        date: r.date,
        details: r.details,
        cash_in: r.kind === "cash_in" ? money(r.amount, currency) : "",
        balance: money(r.balanceAfter ?? 0, currency),
        total_expenses: money(r.totalExpensesAfter ?? 0, currency),
      };
      categoryColumns.forEach((c) => {
        row[c] = r.kind === "cash_out" && r.category === c ? money(r.amount, currency) : "";
      });
      return row;
    });
    generateReportPdf(
      `Expense Ledger — ${RANGES.find((rg) => rg.key === range)?.label}`,
      columns,
      rows,
      action,
      { name: settings.data?.company_name, logo_url: settings.data?.logo_url },
    );
  };

  const viewAttachment = async (path: string) => {
    const { data, error } = await supabase.storage
      .from("expense-attachments")
      .createSignedUrl(path, 60);
    if (error) {
      toast.error(error.message);
      return;
    }
    window.open(data.signedUrl, "_blank");
  };

  const openAdd = (type: EntryType) => {
    setEditingExpense(null);
    setEditingCashIn(null);
    setDefaultEntryType(type);
    setFormOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Expenses</h1>
          <p className="text-sm text-muted-foreground">
            Cash-out entries go for admin approval before they're finalized; cash-in entries post
            immediately.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" className="gap-2" onClick={() => printLedger("print")}>
            <Printer className="h-4 w-4" /> Print
          </Button>
          {(write || writeCashIn) && (
            <Dialog
              open={formOpen}
              onOpenChange={(v) => {
                setFormOpen(v);
                if (!v) {
                  setEditingExpense(null);
                  setEditingCashIn(null);
                }
              }}
            >
              <DialogTrigger asChild>
                <Button className="gap-2" onClick={() => openAdd(write ? "cash_out" : "cash_in")}>
                  <Plus className="h-4 w-4" /> Add Entry
                </Button>
              </DialogTrigger>
              {formOpen && factoryId && (
                <EntryForm
                  factoryId={factoryId}
                  categories={categories.data ?? []}
                  editingExpense={editingExpense}
                  editingCashIn={editingCashIn}
                  defaultType={defaultEntryType}
                  canCashOut={write}
                  canCashIn={writeCashIn}
                  currentUserName={currentUserName}
                  onDone={() => {
                    setFormOpen(false);
                    setEditingExpense(null);
                    setEditingCashIn(null);
                    invalidateAll();
                    qc.invalidateQueries({ queryKey: ["expense-categories"] });
                  }}
                />
              )}
            </Dialog>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <Button
            key={r.key}
            size="sm"
            variant={range === r.key ? "default" : "outline"}
            onClick={() => setRange(r.key)}
          >
            {r.label}
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="rounded-2xl">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Total Expenses
              </div>
              <div className="mt-2 text-2xl font-semibold text-destructive">
                {money(totalExpenses, currency)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {expenseCount} expense entr{expenseCount === 1 ? "y" : "ies"}
              </div>
            </div>
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-destructive/10 text-destructive">
              <TrendingDown className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Cash In</div>
              <div className="mt-2 text-2xl font-semibold text-success">
                {money(totalCashIn, currency)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {cashInCount} cash-in entr{cashInCount === 1 ? "y" : "ies"}
              </div>
            </div>
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-success/10 text-success">
              <TrendingUp className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Balance</div>
              <div
                className={`mt-2 text-2xl font-semibold ${balance >= 0 ? "" : "text-destructive"}`}
              >
                {money(balance, currency)}
              </div>
            </div>
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
              <Wallet className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Ledger</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search entries…"
                className="pl-8 h-9 w-48"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="h-9 w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="cash_in">Cash In</SelectItem>
                {categoryColumns.map((c) => (
                  <SelectItem key={c} value={c}>
                    Cash Out — {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Details</TableHead>
                <TableHead className="text-right">Cash In (₦)</TableHead>
                {categoryColumns.map((c) => (
                  <TableHead key={c} className="text-right whitespace-nowrap">
                    Cash Out — {c}
                  </TableHead>
                ))}
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Total Expenses</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayRows.map((row) => {
                const e = row.expense;
                const c = row.cashIn;
                const isSelf = e ? e.submitted_by === currentUser.data : false;
                const canEditCashIn =
                  c && writeCashIn && (c.recorded_by === currentUser.data || reverse);
                return (
                  <TableRow key={row.key}>
                    <TableCell className="whitespace-nowrap">{row.date}</TableCell>
                    <TableCell>
                      <div className="font-medium">{row.details}</div>
                      {row.sub && <div className="text-xs text-muted-foreground">{row.sub}</div>}
                      {row.statusLabel && (
                        <Badge variant={row.statusVariant} className="mt-1 capitalize">
                          {row.statusLabel}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium text-success">
                      {row.kind === "cash_in" ? money(row.amount, currency) : ""}
                    </TableCell>
                    {categoryColumns.map((cat) => (
                      <TableCell key={cat} className="text-right font-medium text-warning">
                        {row.kind === "cash_out" && row.category === cat
                          ? money(row.amount, currency)
                          : ""}
                      </TableCell>
                    ))}
                    <TableCell className="text-right font-semibold">
                      {money(row.balanceAfter ?? 0, currency)}
                    </TableCell>
                    <TableCell className="text-right text-destructive">
                      {money(row.totalExpensesAfter ?? 0, currency)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {e && e.status === "pending_approval" && approve && !isSelf && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Approve"
                            onClick={() => setApproveTarget(e)}
                          >
                            <Check className="h-4 w-4 text-success" />
                          </Button>
                        )}
                        {e && e.status === "pending_approval" && reject && !isSelf && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Reject"
                            onClick={() => setRejectTarget(e)}
                          >
                            <X className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                        {e && e.status === "approved" && post && !isSelf && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Post"
                            onClick={() => setPostTarget(e)}
                          >
                            <Send className="h-4 w-4 text-success" />
                          </Button>
                        )}
                        {e &&
                          (e.status === "pending_approval" || e.status === "approved") &&
                          cancel && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Cancel"
                              onClick={() => setCancelTarget(e)}
                            >
                              <Ban className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          )}
                        {e && e.status === "posted" && reverse && !isSelf && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Reverse"
                            onClick={() => setReverseTarget(e)}
                          >
                            <Undo2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                        {e && e.attachment_url && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="View attachment"
                            onClick={() => viewAttachment(e.attachment_url!)}
                          >
                            <Paperclip className="h-4 w-4" />
                          </Button>
                        )}
                        {e && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Print"
                              onClick={() => printExpense(e, "print")}
                            >
                              <Printer className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Download PDF"
                              onClick={() => printExpense(e, "download")}
                            >
                              <FileDown className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                        {e && e.status === "pending_approval" && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Edit"
                              onClick={() => {
                                setEditingExpense(e);
                                setEditingCashIn(null);
                                setFormOpen(true);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Delete"
                              onClick={() => setDeleteExpenseTarget(e)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </>
                        )}
                        {c && canEditCashIn && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Edit"
                              onClick={() => {
                                setEditingCashIn(c);
                                setEditingExpense(null);
                                setFormOpen(true);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Delete"
                              onClick={() => setDeleteCashInTarget(c)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {displayRows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={5 + categoryColumns.length}
                    className="text-center text-muted-foreground py-8"
                  >
                    No entries in this range.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!approveTarget} onOpenChange={(v) => !v && setApproveTarget(null)}>
        {approveTarget && (
          <ApproveDialog
            expense={approveTarget}
            onDone={() => {
              setApproveTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!rejectTarget} onOpenChange={(v) => !v && setRejectTarget(null)}>
        {rejectTarget && (
          <RejectDialog
            expense={rejectTarget}
            onDone={() => {
              setRejectTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!postTarget} onOpenChange={(v) => !v && setPostTarget(null)}>
        {postTarget && (
          <PostDialog
            expense={postTarget}
            onDone={() => {
              setPostTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!cancelTarget} onOpenChange={(v) => !v && setCancelTarget(null)}>
        {cancelTarget && (
          <CancelDialog
            expense={cancelTarget}
            onDone={() => {
              setCancelTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!reverseTarget} onOpenChange={(v) => !v && setReverseTarget(null)}>
        {reverseTarget && (
          <ReverseDialog
            expense={reverseTarget}
            onDone={() => {
              setReverseTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>

      <RequestDeleteDialog
        open={!!deleteExpenseTarget}
        onOpenChange={(v) => !v && setDeleteExpenseTarget(null)}
        isPending={del.isPending}
        title={
          deleteExpenseTarget
            ? `Request deletion — ${deleteExpenseTarget.description ?? "Expense"}`
            : "Request deletion"
        }
        onConfirm={(reason) =>
          deleteExpenseTarget && del.mutate({ expense: deleteExpenseTarget, reason })
        }
      />
      <RequestDeleteDialog
        open={!!deleteCashInTarget}
        onOpenChange={(v) => !v && setDeleteCashInTarget(null)}
        isPending={delCashIn.isPending}
        title={
          deleteCashInTarget
            ? `Request deletion — ${deleteCashInTarget.description ?? "Cash-in entry"}`
            : "Request deletion"
        }
        onConfirm={(reason) =>
          deleteCashInTarget && delCashIn.mutate({ cashIn: deleteCashInTarget, reason })
        }
      />
    </div>
  );
}

function ApproveDialog({ expense, onDone }: { expense: Expense; onDone: () => void }) {
  const [comment, setComment] = useState("");
  const submit = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("approve_expense", {
        p_id: expense.id,
        p_comment: comment || undefined,
      });
      if (error) throw error;
      return data as {
        approved: boolean;
        partial?: boolean;
        approvals_so_far?: number;
        required?: number;
      };
    },
    onSuccess: (data) => {
      if (data?.partial) {
        toast.success(
          `Approval recorded — ${data.approvals_so_far}/${data.required} approvers so far`,
        );
      } else {
        toast.success("Expense approved — post it next to finalize");
      }
      logAudit({
        action: "update",
        entity: "expenses",
        entityId: expense.id,
        newValue: { status: "approved" },
      });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Approve Expense</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {expense.description ?? "—"} · {money(Number(expense.amount))}
        </p>
        <p className="text-sm text-muted-foreground">
          This marks the expense reviewed. A post step (by you or someone else) still finalizes it.
        </p>
        <div>
          <Label>Comment (optional)</Label>
          <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
        <ApprovalHistory module="expenses" entityId={expense.id} />
      </div>
      <DialogFooter>
        <Button disabled={submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? "Approving…" : "Approve"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function RejectDialog({ expense, onDone }: { expense: Expense; onDone: () => void }) {
  const [reason, setReason] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("reject_expense", {
        p_id: expense.id,
        p_reason: reason || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Expense rejected");
      logAudit({
        action: "update",
        entity: "expenses",
        entityId: expense.id,
        newValue: { status: "rejected", reason },
      });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Reject Expense</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Reason</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <ApprovalHistory module="expenses" entityId={expense.id} />
      </div>
      <DialogFooter>
        <Button variant="destructive" disabled={submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? "Rejecting…" : "Reject"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function PostDialog({ expense, onDone }: { expense: Expense; onDone: () => void }) {
  const [comment, setComment] = useState("");
  const submit = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("post_expense", {
        p_id: expense.id,
        p_comment: comment || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Expense posted");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Post Expense</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {expense.description ?? "—"} · {money(Number(expense.amount))}
        </p>
        <p className="text-sm text-muted-foreground">
          This finalizes the expense — it will count in Cash Flow and reports.
        </p>
        <div>
          <Label>Comment (optional)</Label>
          <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
        <ApprovalHistory module="expenses" entityId={expense.id} />
      </div>
      <DialogFooter>
        <Button disabled={submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? "Posting…" : "Post"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function CancelDialog({ expense, onDone }: { expense: Expense; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const submit = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("cancel_expense", {
        p_id: expense.id,
        p_reason: reason || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Expense cancelled");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Cancel Expense</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Reason (optional)</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <ApprovalHistory module="expenses" entityId={expense.id} />
      </div>
      <DialogFooter>
        <Button variant="destructive" disabled={submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? "Cancelling…" : "Cancel expense"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ReverseDialog({ expense, onDone }: { expense: Expense; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const submit = useMutation({
    mutationFn: async () => {
      if (!reason.trim()) throw new Error("A reason is required to reverse a posted expense");
      const { error } = await supabase.rpc("reverse_expense", {
        p_id: expense.id,
        p_reason: reason,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Expense reversed");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Reverse Posted Expense</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          This expense has already been posted and counted in reports. Reversing removes it from
          totals going forward but keeps the full history.
        </p>
        <div>
          <Label>Reason</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <ApprovalHistory module="expenses" entityId={expense.id} />
      </div>
      <DialogFooter>
        <Button
          variant="destructive"
          disabled={submit.isPending || !reason.trim()}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? "Reversing…" : "Reverse"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function EntryForm({
  factoryId,
  categories,
  editingExpense,
  editingCashIn,
  defaultType,
  canCashOut,
  canCashIn,
  currentUserName,
  onDone,
}: {
  factoryId: string;
  categories: Category[];
  editingExpense: Expense | null;
  editingCashIn: CashIn | null;
  defaultType: EntryType;
  canCashOut: boolean;
  canCashIn: boolean;
  currentUserName: string;
  onDone: () => void;
}) {
  const isEditing = !!editingExpense || !!editingCashIn;
  const [type, setType] = useState<EntryType>(
    editingExpense ? "cash_out" : editingCashIn ? "cash_in" : defaultType,
  );

  // Cash-out (expense) fields
  const [date, setDate] = useState(
    editingExpense?.expense_date ??
      editingCashIn?.transaction_date ??
      format(new Date(), "yyyy-MM-dd"),
  );
  const [categoryId, setCategoryId] = useState(editingExpense?.category_id ?? "none");
  const [newCategory, setNewCategory] = useState("");
  const [description, setDescription] = useState(
    editingExpense?.description ?? editingCashIn?.description ?? "",
  );
  const [vendor, setVendor] = useState(editingExpense?.vendor ?? "");
  const [receiptNumber, setReceiptNumber] = useState(editingExpense?.receipt_number ?? "");
  const [method, setMethod] = useState<PaymentMethod>(
    ((editingExpense?.payment_method ?? editingCashIn?.payment_method) as PaymentMethod) ?? "cash",
  );
  const [amount, setAmount] = useState(
    editingExpense
      ? Number(editingExpense.amount)
      : editingCashIn
        ? Number(editingCashIn.amount)
        : 0,
  );
  const [requestedBy, setRequestedBy] = useState(editingExpense?.requested_by_name ?? "");
  const [remarks, setRemarks] = useState(editingExpense?.remarks ?? "");
  const [file, setFile] = useState<File | null>(null);

  // Cash-in fields
  const [payerPayee, setPayerPayee] = useState(editingCashIn?.payer_payee ?? "");
  const [recordedBy, setRecordedBy] = useState(editingCashIn?.recorded_by_name ?? currentUserName);

  const save = useMutation({
    mutationFn: async () => {
      if (amount <= 0) throw new Error("Amount must be greater than 0");

      if (type === "cash_in") {
        if (!recordedBy.trim()) throw new Error("Enter who is recording this entry");
        if (editingCashIn) {
          const { error } = await supabase
            .from("cash_transactions")
            .update({
              transaction_date: date,
              description: description || null,
              amount,
              payment_method: method,
              payer_payee: payerPayee || null,
              recorded_by_name: recordedBy.trim(),
            })
            .eq("id", editingCashIn.id);
          if (error) throw error;
          return;
        }
        const { error } = await supabase.rpc("create_cash_transaction", {
          payload: {
            factory_id: factoryId,
            transaction_type: "receipt",
            category: "other_inflow",
            transaction_date: date,
            description: description || null,
            amount,
            payment_method: method,
            payer_payee: payerPayee || null,
            recorded_by_name: recordedBy.trim(),
          } as any,
        });
        if (error) throw error;
        return;
      }

      let finalCategoryId = categoryId === "none" ? null : categoryId;
      if (categoryId === "__new__") {
        if (!newCategory.trim()) throw new Error("Enter a category name");
        const { data, error } = await supabase
          .from("expense_categories")
          .insert({ factory_id: factoryId, name: newCategory.trim() })
          .select("id")
          .single();
        if (error) throw error;
        finalCategoryId = data.id;
      }

      let attachmentPath = editingExpense?.attachment_url ?? null;
      if (file) {
        const { data: userData } = await supabase.auth.getUser();
        const path = `${factoryId}/${userData.user?.id ?? "anon"}-${Date.now()}-${file.name}`;
        const { error: uploadError } = await supabase.storage
          .from("expense-attachments")
          .upload(path, file);
        if (uploadError) throw uploadError;
        attachmentPath = path;
      }

      const payload = {
        expense_date: date,
        category_id: finalCategoryId,
        description: description || null,
        vendor: vendor || null,
        receipt_number: receiptNumber || null,
        payment_method: method,
        amount,
        requested_by_name: requestedBy || null,
        remarks: remarks || null,
        attachment_url: attachmentPath,
      };

      if (editingExpense) {
        const { error } = await supabase
          .from("expenses")
          .update(payload)
          .eq("id", editingExpense.id);
        if (error) throw error;
      } else {
        const { data: userData } = await supabase.auth.getUser();
        const { error } = await supabase.from("expenses").insert({
          ...payload,
          factory_id: factoryId,
          recorded_by: userData.user?.id ?? null,
          submitted_by: userData.user?.id ?? null,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      if (type === "cash_in") {
        toast.success(editingCashIn ? "Cash-in entry updated" : "Cash-in entry recorded");
        logAudit({
          action: editingCashIn ? "update" : "create",
          entity: "cash_transactions",
          entityId: editingCashIn?.id,
          factoryId,
          newValue: { amount, description },
        });
      } else {
        toast.success(editingExpense ? "Expense updated" : "Expense submitted for approval");
        logAudit({
          action: editingExpense ? "update" : "create",
          entity: "expenses",
          entityId: editingExpense?.id,
          factoryId,
          oldValue: editingExpense
            ? { amount: editingExpense.amount, description: editingExpense.description }
            : undefined,
          newValue: { amount, description },
        });
      }
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{isEditing ? "Edit Entry" : "Add Entry"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 max-h-[70vh] overflow-y-auto pr-1">
        {!isEditing && canCashOut && canCashIn && (
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={type === "cash_out" ? "default" : "outline"}
              className="gap-2"
              onClick={() => setType("cash_out")}
            >
              <ArrowUpFromLine className="h-4 w-4" /> Cash Out (Expense)
            </Button>
            <Button
              type="button"
              variant={type === "cash_in" ? "default" : "outline"}
              className="gap-2"
              onClick={() => setType("cash_in")}
            >
              <ArrowDownToLine className="h-4 w-4" /> Cash In
            </Button>
          </div>
        )}

        {type === "cash_out" ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Expense date</Label>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div>
                <Label>Category</Label>
                <Select value={categoryId} onValueChange={setCategoryId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— None —</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                    <SelectItem value="__new__">+ Add new category…</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {categoryId === "__new__" && (
              <div>
                <Label>New category name</Label>
                <Input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} />
              </div>
            )}
            <div>
              <Label>Description</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what this expense is for"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Vendor</Label>
                <Input value={vendor} onChange={(e) => setVendor(e.target.value)} />
              </div>
              <div>
                <Label>Receipt number</Label>
                <Input value={receiptNumber} onChange={(e) => setReceiptNumber(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Payment method</Label>
                <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(
                      ["cash", "transfer", "pos", "card", "cheque", "credit"] as PaymentMethod[]
                    ).map((m) => (
                      <SelectItem key={m} value={m} className="capitalize">
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Amount</Label>
                <MoneyInput value={amount} onChange={setAmount} />
              </div>
            </div>
            <div>
              <Label>Requested by</Label>
              <Input
                value={requestedBy}
                onChange={(e) => setRequestedBy(e.target.value)}
                placeholder="Person requesting this expense"
              />
            </div>
            {editingExpense && editingExpense.status !== "pending_approval" && (
              <p className="text-xs text-muted-foreground">
                Status: {editingExpense.status.replace(/_/g, " ")}
                {editingExpense.approved_at
                  ? ` · ${new Date(editingExpense.approved_at).toLocaleString()}`
                  : ""}
              </p>
            )}
            <div>
              <Label>Attachment</Label>
              <Input
                type="file"
                accept="image/*,.pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {editingExpense?.attachment_url && !file && (
                <p className="mt-1 text-xs text-muted-foreground">
                  A file is already attached. Choose a new one to replace it.
                </p>
              )}
            </div>
            <div>
              <Label>Remarks</Label>
              <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground">
              This entry appears in the ledger immediately, but still needs admin approval to be
              finalized.
            </p>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Date</Label>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div>
                <Label>Amount</Label>
                <MoneyInput value={amount} onChange={setAmount} />
              </div>
            </div>
            <div>
              <Label>Description</Label>
              <Textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Payment method</Label>
                <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["cash", "transfer", "pos", "card", "cheque"] as PaymentMethod[]).map((m) => (
                      <SelectItem key={m} value={m} className="capitalize">
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>From (payer, optional)</Label>
                <Input value={payerPayee} onChange={(e) => setPayerPayee(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>Recorded by</Label>
              <Input value={recordedBy} onChange={(e) => setRecordedBy(e.target.value)} />
            </div>
          </>
        )}
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()} className="gap-2">
          <Receipt className="h-4 w-4" />{" "}
          {save.isPending ? "Saving…" : isEditing ? "Save changes" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
