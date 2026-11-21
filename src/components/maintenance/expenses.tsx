import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { logAudit } from "@/lib/audit";
import { money } from "@/lib/format";
import { localDay } from "@/lib/production-shift";
import { matchesSearch, useSearchQuery } from "@/lib/search";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchBox } from "@/components/shared/search-box";
import { ReportActions } from "@/components/shared/report-actions";
import { db } from "./shared";

// The factory's expense heads, as on its expense sheet (user, 2026-11-20).
// Saved by name, so adding or renaming one here needs no migration.
export const MAINTENANCE_EXPENSE_CATEGORIES = [
  "TRANSPORTATION",
  "FUEL",
  "GAS",
  "ENGINE OIL",
  "TELEPHONE",
  "CEO & MD EXP",
  "ACCOMODATION",
  "LABOUR",
  "SALARY & LOAN",
  "STATIONERY",
  "MACHINE TOOLS",
  "MACHINE REPAIR",
  "GENERATOR",
  "AGENCYS",
  "BUILDING MAINT.",
  "COMMISSION",
  "CLEANING EXP.",
  "VEHICLE MAINT.",
  "TRYCYCLE",
  "VEHICLE TOOLS & PAPER.",
  "OVERTIME",
  "FEEDING",
  "DRIVER ISSUES",
  "KUBWA PROJECT",
  "LUGBE PROJECT",
  "HOSPITAL",
  "MATERIALS RAW",
  "NEPA",
  "PAINTING OF CAR",
  "GIFT",
] as const;

const PAYMENT_METHODS = ["Cash", "Transfer", "POS", "Cheque"];

type ExpenseRow = {
  id: string;
  expense_number: string;
  expense_date: string;
  category: string;
  description: string | null;
  amount: number;
  paid_to: string | null;
  payment_method: string | null;
  receipt_ref: string | null;
  recorded_by_name: string | null;
  updated_by_name: string | null;
  created_at: string;
  vehicles?: { plate_number: string } | null;
};

const monthStart = () => localDay().slice(0, 8) + "01";

const emptyForm = () => ({
  id: "",
  expense_date: localDay(),
  category: "",
  description: "",
  amount: 0,
  paid_to: "",
  payment_method: "Cash",
  receipt_ref: "",
});

const fmtDate = (d: string) => new Date(d + "T00:00:00").toLocaleDateString();

export function MaintenanceExpensesTab({
  factoryId,
  canCreate,
  canEdit,
  canDelete,
}: {
  factoryId: string | null | undefined;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const qc = useQueryClient();
  const [q, setQ] = useSearchQuery();
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(localDay);
  const [category, setCategory] = useState("all");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [deleting, setDeleting] = useState<ExpenseRow | null>(null);

  const expenses = useQuery({
    queryKey: ["maintenance-expenses", factoryId, from, to],
    enabled: !!factoryId,
    queryFn: async () => {
      let query = db
        .from("maintenance_expenses")
        .select(
          "id,expense_number,expense_date,category,description,amount,paid_to,payment_method,receipt_ref,recorded_by_name,updated_by_name,created_at,vehicles(plate_number)",
        )
        .eq("factory_id", factoryId)
        .order("expense_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (from) query = query.gte("expense_date", from);
      if (to) query = query.lte("expense_date", to);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as ExpenseRow[];
    },
  });

  const rows = (expenses.data ?? [])
    .filter((e) => category === "all" || e.category === category)
    .filter((e) => matchesSearch(q, e));
  const total = rows.reduce((s, e) => s + Number(e.amount), 0);

  // Totals per head for the period, in the sheet's order (heads no longer on
  // the list, if any, at the end).
  const byCategory = useMemo(() => {
    const sums = new Map<string, { amount: number; count: number }>();
    for (const e of rows) {
      const s = sums.get(e.category) ?? { amount: 0, count: 0 };
      s.amount += Number(e.amount);
      s.count += 1;
      sums.set(e.category, s);
    }
    const order = [
      ...MAINTENANCE_EXPENSE_CATEGORIES,
      ...[...sums.keys()].filter(
        (k) => !(MAINTENANCE_EXPENSE_CATEGORIES as readonly string[]).includes(k),
      ),
    ];
    return order.filter((k) => sums.has(k)).map((k) => ({ category: k, ...sums.get(k)! }));
  }, [rows]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["maintenance-expenses"] });

  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await db.rpc("save_maintenance_expense", {
        payload: {
          id: form.id || null,
          factory_id: factoryId,
          expense_date: form.expense_date,
          category: form.category,
          description: form.description,
          amount: form.amount,
          paid_to: form.paid_to,
          payment_method: form.payment_method,
          receipt_ref: form.receipt_ref,
        },
      });
      if (error) throw error;
      return data as { id: string; expense_number: string };
    },
    onSuccess: (res) => {
      toast.success(`Expense ${res.expense_number} ${form.id ? "updated" : "recorded"}`);
      logAudit({
        action: form.id ? "update" : "create",
        entity: "maintenance_expenses",
        entityId: res.id,
        factoryId,
        newValue: { ...form, id: res.id },
      });
      invalidate();
      setOpen(false);
      setForm(emptyForm());
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (e: ExpenseRow) => {
      const { error } = await db.rpc("delete_maintenance_expense", { p_id: e.id });
      if (error) throw error;
      return e;
    },
    onSuccess: (e) => {
      toast.success(`Expense ${e.expense_number} removed`);
      logAudit({
        action: "delete",
        entity: "maintenance_expenses",
        entityId: e.id,
        factoryId,
        oldValue: e,
      });
      invalidate();
      setDeleting(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openNew = () => {
    setForm(emptyForm());
    setOpen(true);
  };
  const openEdit = (e: ExpenseRow) => {
    setForm({
      id: e.id,
      expense_date: e.expense_date,
      category: e.category,
      description: e.description ?? "",
      amount: Number(e.amount),
      paid_to: e.paid_to ?? "",
      payment_method: e.payment_method ?? "",
      receipt_ref: e.receipt_ref ?? "",
    });
    setOpen(true);
  };

  const period = `${from ? fmtDate(from) : "start"} to ${to ? fmtDate(to) : "today"}`;
  const reportColumns = [
    { key: "date", label: "Date" },
    { key: "number", label: "Expense #" },
    { key: "category", label: "Category" },
    { key: "description", label: "Description" },
    { key: "paid_to", label: "Paid to" },
    { key: "method", label: "Paid by" },
    { key: "amount", label: "Amount" },
  ];
  const reportRows: Record<string, unknown>[] = [
    ...rows.map((e) => ({
      date: fmtDate(e.expense_date),
      number: e.expense_number,
      category: e.category,
      description: [e.description, e.vehicles && `Vehicle ${e.vehicles.plate_number}`]
        .filter(Boolean)
        .join(" — "),
      paid_to: e.paid_to ?? "",
      method: e.payment_method ?? "",
      amount: money(e.amount),
    })),
    ...(rows.length
      ? [{ date: "Total", kind: "total", amount: money(total) } as Record<string, unknown>]
      : []),
  ];
  const summaryRows: Record<string, unknown>[] = [
    ...byCategory.map((c) => ({
      category: c.category,
      count: c.count,
      amount: money(c.amount),
    })),
    ...(byCategory.length
      ? [{ category: "Total", kind: "total", count: rows.length, amount: money(total) }]
      : []),
  ];

  const valid = !!form.category && form.amount > 0 && !!form.expense_date;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <Input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              className="w-40"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To</Label>
            <Input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              className="w-40"
            />
          </div>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {MAINTENANCE_EXPENSE_CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {canCreate && (
          <Button onClick={openNew}>
            <Plus className="mr-2 h-4 w-4" /> Record Expense
          </Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total spent ({period})
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {money(total)}
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              {rows.length} expense{rows.length === 1 ? "" : "s"}
            </span>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Biggest category
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {byCategory.length
              ? (() => {
                  const top = [...byCategory].sort((a, b) => b.amount - a.amount)[0];
                  return (
                    <>
                      {money(top.amount)}
                      <span className="ml-1 text-sm font-normal text-muted-foreground">
                        {top.category}
                      </span>
                    </>
                  );
                })()
              : "—"}
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
          <CardTitle className="text-base">Expenses</CardTitle>
          <ReportActions
            title="Maintenance Expenses"
            fileName={`maintenance-expenses-${from || "start"}-to-${to || "today"}`}
            columns={reportColumns}
            rows={reportRows}
            subtitle={[
              `Period: ${period}`,
              ...(category === "all" ? [] : [`Category: ${category}`]),
            ]}
            size="sm"
          />
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <SearchBox value={q} onChange={setQ} className="mb-3" />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Expense #</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Paid to</TableHead>
                <TableHead>Paid by</TableHead>
                <TableHead>Receipt</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Recorded by</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap">{fmtDate(e.expense_date)}</TableCell>
                  <TableCell className="font-medium whitespace-nowrap">
                    {e.expense_number}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{e.category}</TableCell>
                  <TableCell>
                    {e.description ?? (e.vehicles ? "" : "—")}
                    {e.vehicles && (
                      <div className="text-xs text-muted-foreground">
                        Vehicle {e.vehicles.plate_number}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{e.paid_to ?? "—"}</TableCell>
                  <TableCell>{e.payment_method ?? "—"}</TableCell>
                  <TableCell>{e.receipt_ref ?? "—"}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">{money(e.amount)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {e.recorded_by_name ?? "—"}
                    {e.updated_by_name && (
                      <div className="text-xs text-muted-foreground">
                        edited by {e.updated_by_name}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    {canEdit && (
                      <Button size="icon" variant="ghost" title="Edit" onClick={() => openEdit(e)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Delete"
                        onClick={() => setDeleting(e)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                    {expenses.isLoading ? "Loading…" : "No expenses in this period"}
                  </TableCell>
                </TableRow>
              )}
              {rows.length > 0 && (
                <TableRow className="bg-muted/50 font-semibold">
                  <TableCell colSpan={7}>Total</TableCell>
                  <TableCell className="text-right whitespace-nowrap">{money(total)}</TableCell>
                  <TableCell colSpan={2}></TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
          <CardTitle className="text-base">By category</CardTitle>
          <ReportActions
            title="Maintenance Expenses by Category"
            fileName={`maintenance-expenses-by-category-${from || "start"}-to-${to || "today"}`}
            columns={[
              { key: "category", label: "Category" },
              { key: "count", label: "Entries" },
              { key: "amount", label: "Amount" },
            ]}
            rows={summaryRows}
            subtitle={[`Period: ${period}`]}
            size="sm"
          />
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Entries</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byCategory.map((c) => (
                <TableRow key={c.category}>
                  <TableCell>{c.category}</TableCell>
                  <TableCell className="text-right">{c.count}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">{money(c.amount)}</TableCell>
                </TableRow>
              ))}
              {byCategory.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                    Nothing recorded in this period
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow className="bg-muted/50 font-semibold">
                  <TableCell>Total</TableCell>
                  <TableCell className="text-right">{rows.length}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">{money(total)}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setForm(emptyForm());
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit expense" : "Record expense"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Date</Label>
              <Input
                type="date"
                value={form.expense_date}
                max={localDay()}
                onChange={(e) => setForm({ ...form, expense_date: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>Category</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm({ ...form, category: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose category" />
                </SelectTrigger>
                <SelectContent>
                  {MAINTENANCE_EXPENSE_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                  {form.category &&
                    !(MAINTENANCE_EXPENSE_CATEGORIES as readonly string[]).includes(
                      form.category,
                    ) && <SelectItem value={form.category}>{form.category}</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Amount (₦)</Label>
              <MoneyInput value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} />
            </div>
            <div className="space-y-1">
              <Label>Paid by</Label>
              <Select
                value={form.payment_method}
                onValueChange={(v) => setForm({ ...form, payment_method: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose" />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Paid to (optional)</Label>
              <Input
                value={form.paid_to}
                onChange={(e) => setForm({ ...form, paid_to: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>Receipt no. (optional)</Label>
              <Input
                value={form.receipt_ref}
                onChange={(e) => setForm({ ...form, receipt_ref: e.target.value })}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Description</Label>
              <Textarea
                rows={2}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="What the money was spent on"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!valid || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : form.id ? "Save changes" : "Record expense"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete expense?</DialogTitle>
          </DialogHeader>
          {deleting && (
            <p className="text-sm">
              {deleting.expense_number} — {deleting.category}, {money(deleting.amount)} on{" "}
              {fmtDate(deleting.expense_date)}. This cannot be undone.
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
