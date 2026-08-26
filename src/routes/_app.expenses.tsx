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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { money } from "@/lib/format";
import { toast } from "sonner";
import { Plus, Printer, FileDown, Paperclip, Trash2, Pencil, Receipt, Check, X, Send, Ban, Undo2 } from "lucide-react";
import { generateExpenseVoucherPdf } from "@/lib/pdf";
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
type Category = { id: string; name: string };
type Expense = {
  id: string; expense_date: string; category_id: string | null; description: string | null; vendor: string | null;
  receipt_number: string | null; payment_method: string; amount: number; approved_by: string | null;
  requested_by_name: string | null; approval_status: string; approved_at: string | null;
  recorded_by: string | null; attachment_url: string | null; remarks: string | null; created_at: string;
  submitted_by: string | null; status: string;
  expense_categories: { name: string } | null;
};

const statusBadge = (s: string): "default" | "secondary" | "outline" | "destructive" =>
  s === "posted" ? "secondary" : s === "rejected" || s === "cancelled" || s === "reversed" ? "destructive" : "outline";
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

function ExpensesPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const qc = useQueryClient();
  const { canWrite, canApprove, canReject, canPost, canCancel, canReverse } = usePermissions();
  const write = canWrite("expenses");
  const approve = canApprove("expenses");
  const reject = canReject("expenses");
  const post = canPost("expenses");
  const cancel = canCancel("expenses");
  const reverse = canReverse("expenses");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [range, setRange] = useState<RangeKey>("month");
  const [approveTarget, setApproveTarget] = useState<Expense | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Expense | null>(null);
  const [postTarget, setPostTarget] = useState<Expense | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Expense | null>(null);
  const [reverseTarget, setReverseTarget] = useState<Expense | null>(null);

  const categories = useQuery({
    queryKey: ["expense-categories", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase.from("expense_categories").select("id,name").eq("factory_id", factoryId!).order("name");
      if (error) throw error;
      return (data ?? []) as Category[];
    },
  });

  const list = useQuery({
    queryKey: ["expenses-list", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expenses")
        .select("id,expense_date,category_id,description,vendor,receipt_number,payment_method,amount,approved_by,requested_by_name,approval_status,approved_at,recorded_by,attachment_url,remarks,created_at,submitted_by,status,expense_categories(name)")
        .eq("factory_id", factoryId!)
        .order("expense_date", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as Expense[];
    },
  });

  const profiles = useQuery({
    queryKey: ["profiles-map"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id,full_name");
      if (error) throw error;
      const map: Record<string, string> = {};
      (data ?? []).forEach((p) => { map[p.id] = p.full_name ?? "—"; });
      return map;
    },
  });

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const filtered = useMemo(() => {
    const since = rangeStart(range);
    const rows = list.data ?? [];
    if (!since) return rows;
    return rows.filter((e) => new Date(e.expense_date) >= since);
  }, [list.data, range]);

  const total = filtered.filter((e) => e.status === "posted").reduce((s, e) => s + Number(e.amount), 0);

  const byCategory = useMemo(() => {
    const bucket: Record<string, number> = {};
    filtered.filter((e) => e.status === "posted").forEach((e) => {
      const name = e.expense_categories?.name ?? "Uncategorized";
      bucket[name] = (bucket[name] ?? 0) + Number(e.amount);
    });
    return Object.entries(bucket).map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total);
  }, [filtered]);

  const invalidateAll = () => qc.invalidateQueries({ queryKey: ["expenses-list"] });

  const del = useMutation({
    mutationFn: async (e: Expense) => {
      if (e.attachment_url) await supabase.storage.from("expense-attachments").remove([e.attachment_url]);
      const { error } = await supabase.from("expenses").delete().eq("id", e.id);
      if (error) throw error;
      return e;
    },
    onSuccess: (e) => {
      toast.success("Expense deleted");
      logAudit({ action: "delete", entity: "expenses", entityId: e.id, factoryId, oldValue: { amount: e.amount, description: e.description } });
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const printExpense = (e: Expense, action: "print" | "download") => {
    generateExpenseVoucherPdf({
      company: { name: settings.data?.company_name ?? "FMIS", address: settings.data?.address, phone: settings.data?.phone, logo_url: settings.data?.logo_url },
      expense_date: e.expense_date, category: e.expense_categories?.name, description: e.description,
      vendor: e.vendor, receipt_number: e.receipt_number, payment_method: e.payment_method, amount: Number(e.amount),
      requested_by: e.requested_by_name, approval_status: e.status, approved_by: e.approved_by,
      recorded_by: e.recorded_by ? profiles.data?.[e.recorded_by] : undefined,
      remarks: e.remarks, currency: settings.data?.currency ?? "NGN",
    }, action);
  };

  const viewAttachment = async (path: string) => {
    const { data, error } = await supabase.storage.from("expense-attachments").createSignedUrl(path, 60);
    if (error) { toast.error(error.message); return; }
    window.open(data.signedUrl, "_blank");
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Expenses</h1>
          <p className="text-sm text-muted-foreground">Submit → Approve → Post, with cancel/reverse for corrections.</p>
        </div>
        {write && (
        <Dialog open={formOpen} onOpenChange={(v) => { setFormOpen(v); if (!v) setEditing(null); }}>
          <DialogTrigger asChild>
            <Button className="gap-2" onClick={() => setEditing(null)}><Plus className="h-4 w-4" /> Record Expense</Button>
          </DialogTrigger>
          {formOpen && factoryId && (
            <ExpenseForm
              factoryId={factoryId} categories={categories.data ?? []} editing={editing}
              onDone={() => { setFormOpen(false); setEditing(null); invalidateAll(); qc.invalidateQueries({ queryKey: ["expense-categories"] }); }}
            />
          )}
        </Dialog>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <Button key={r.key} size="sm" variant={range === r.key ? "default" : "outline"} onClick={() => setRange(r.key)}>
            {r.label}
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="rounded-2xl">
          <CardContent className="p-5">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Posted Total ({RANGES.find((r) => r.key === range)?.label})</div>
            <div className="mt-2 text-3xl font-semibold">{money(total)}</div>
            <div className="mt-1 text-xs text-muted-foreground">{filtered.length} expense{filtered.length === 1 ? "" : "s"}</div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl lg:col-span-2">
          <CardHeader><CardTitle>By Category (posted only)</CardTitle></CardHeader>
          <CardContent className="h-56">
            {byCategory.length === 0 ? (
              <p className="text-sm text-muted-foreground">No posted expenses in this range.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byCategory} layout="vertical" margin={{ left: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis type="number" stroke="var(--color-muted-foreground)" fontSize={12} />
                  <YAxis type="category" dataKey="name" width={110} stroke="var(--color-muted-foreground)" fontSize={12} />
                  <Tooltip
                    contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 8 }}
                    formatter={(v: number) => money(v)}
                  />
                  <Bar dataKey="total" fill="var(--color-warning)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-2xl">
        <CardHeader><CardTitle>Expense Records</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Method</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Requested By</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((e) => {
                const isSelf = e.submitted_by === currentUser.data;
                return (
                <TableRow key={e.id}>
                  <TableCell>{e.expense_date}</TableCell>
                  <TableCell>{e.expense_categories?.name ?? "—"}</TableCell>
                  <TableCell className="max-w-[200px] truncate">{e.description ?? "—"}</TableCell>
                  <TableCell>{e.vendor ?? "—"}</TableCell>
                  <TableCell><Badge variant="outline" className="capitalize">{e.payment_method}</Badge></TableCell>
                  <TableCell className="text-right font-medium">{money(Number(e.amount))}</TableCell>
                  <TableCell>{e.requested_by_name ?? "—"}</TableCell>
                  <TableCell><Badge variant={statusBadge(e.status)} className="capitalize">{e.status.replace(/_/g, " ")}</Badge></TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {e.status === "pending_approval" && approve && !isSelf && (
                        <Button variant="ghost" size="icon" title="Approve" onClick={() => setApproveTarget(e)}>
                          <Check className="h-4 w-4 text-success" />
                        </Button>
                      )}
                      {e.status === "pending_approval" && reject && !isSelf && (
                        <Button variant="ghost" size="icon" title="Reject" onClick={() => setRejectTarget(e)}>
                          <X className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                      {e.status === "approved" && post && !isSelf && (
                        <Button variant="ghost" size="icon" title="Post" onClick={() => setPostTarget(e)}>
                          <Send className="h-4 w-4 text-success" />
                        </Button>
                      )}
                      {(e.status === "pending_approval" || e.status === "approved") && cancel && (
                        <Button variant="ghost" size="icon" title="Cancel" onClick={() => setCancelTarget(e)}>
                          <Ban className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      )}
                      {e.status === "posted" && reverse && !isSelf && (
                        <Button variant="ghost" size="icon" title="Reverse" onClick={() => setReverseTarget(e)}>
                          <Undo2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                      {e.attachment_url && (
                        <Button variant="ghost" size="icon" title="View attachment" onClick={() => viewAttachment(e.attachment_url!)}>
                          <Paperclip className="h-4 w-4" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" title="Print" onClick={() => printExpense(e, "print")}>
                        <Printer className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" title="Download PDF" onClick={() => printExpense(e, "download")}>
                        <FileDown className="h-4 w-4" />
                      </Button>
                      {e.status === "pending_approval" && (
                        <>
                          <Button variant="ghost" size="icon" title="Edit" onClick={() => { setEditing(e); setFormOpen(true); }}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="icon" title="Delete"><Trash2 className="h-4 w-4 text-destructive" /></Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete this expense?</AlertDialogTitle>
                                <AlertDialogDescription>This permanently removes the record{e.attachment_url ? " and its attachment" : ""}.</AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => del.mutate(e)}>Delete</AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
                );
              })}
              {filtered.length === 0 && (
                <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No expenses in this range.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!approveTarget} onOpenChange={(v) => !v && setApproveTarget(null)}>
        {approveTarget && <ApproveDialog expense={approveTarget} onDone={() => { setApproveTarget(null); invalidateAll(); }} />}
      </Dialog>
      <Dialog open={!!rejectTarget} onOpenChange={(v) => !v && setRejectTarget(null)}>
        {rejectTarget && <RejectDialog expense={rejectTarget} onDone={() => { setRejectTarget(null); invalidateAll(); }} />}
      </Dialog>
      <Dialog open={!!postTarget} onOpenChange={(v) => !v && setPostTarget(null)}>
        {postTarget && <PostDialog expense={postTarget} onDone={() => { setPostTarget(null); invalidateAll(); }} />}
      </Dialog>
      <Dialog open={!!cancelTarget} onOpenChange={(v) => !v && setCancelTarget(null)}>
        {cancelTarget && <CancelDialog expense={cancelTarget} onDone={() => { setCancelTarget(null); invalidateAll(); }} />}
      </Dialog>
      <Dialog open={!!reverseTarget} onOpenChange={(v) => !v && setReverseTarget(null)}>
        {reverseTarget && <ReverseDialog expense={reverseTarget} onDone={() => { setReverseTarget(null); invalidateAll(); }} />}
      </Dialog>
    </div>
  );
}

function ApproveDialog({ expense, onDone }: { expense: Expense; onDone: () => void }) {
  const [comment, setComment] = useState("");
  const submit = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("approve_expense", { p_id: expense.id, p_comment: comment || undefined });
      if (error) throw error;
      return data as { approved: boolean; partial?: boolean; approvals_so_far?: number; required?: number };
    },
    onSuccess: (data) => {
      if (data?.partial) {
        toast.success(`Approval recorded — ${data.approvals_so_far}/${data.required} approvers so far`);
      } else {
        toast.success("Expense approved — post it next to finalize");
      }
      logAudit({ action: "update", entity: "expenses", entityId: expense.id, newValue: { status: "approved" } });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Approve Expense</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">{expense.description ?? "—"} · {money(Number(expense.amount))}</p>
        <p className="text-sm text-muted-foreground">This marks the expense reviewed. A post step (by you or someone else) still finalizes it.</p>
        <div><Label>Comment (optional)</Label><Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></div>
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
      const { error } = await supabase.rpc("reject_expense", { p_id: expense.id, p_reason: reason || undefined });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Expense rejected");
      logAudit({ action: "update", entity: "expenses", entityId: expense.id, newValue: { status: "rejected", reason } });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Reject Expense</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <div><Label>Reason</Label><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
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
      const { error } = await supabase.rpc("post_expense", { p_id: expense.id, p_comment: comment || undefined });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Expense posted"); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Post Expense</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">{expense.description ?? "—"} · {money(Number(expense.amount))}</p>
        <p className="text-sm text-muted-foreground">This finalizes the expense — it will count in Cash Flow and reports.</p>
        <div><Label>Comment (optional)</Label><Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></div>
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
      const { error } = await supabase.rpc("cancel_expense", { p_id: expense.id, p_reason: reason || undefined });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Expense cancelled"); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Cancel Expense</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <div><Label>Reason (optional)</Label><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
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
      const { error } = await supabase.rpc("reverse_expense", { p_id: expense.id, p_reason: reason });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Expense reversed"); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Reverse Posted Expense</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">This expense has already been posted and counted in reports. Reversing removes it from totals going forward but keeps the full history.</p>
        <div><Label>Reason</Label><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <ApprovalHistory module="expenses" entityId={expense.id} />
      </div>
      <DialogFooter>
        <Button variant="destructive" disabled={submit.isPending || !reason.trim()} onClick={() => submit.mutate()}>
          {submit.isPending ? "Reversing…" : "Reverse"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ExpenseForm({ factoryId, categories, editing, onDone }: {
  factoryId: string; categories: Category[]; editing: Expense | null; onDone: () => void;
}) {
  const [date, setDate] = useState(editing?.expense_date ?? format(new Date(), "yyyy-MM-dd"));
  const [categoryId, setCategoryId] = useState(editing?.category_id ?? "none");
  const [newCategory, setNewCategory] = useState("");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [vendor, setVendor] = useState(editing?.vendor ?? "");
  const [receiptNumber, setReceiptNumber] = useState(editing?.receipt_number ?? "");
  const [method, setMethod] = useState<PaymentMethod>((editing?.payment_method as PaymentMethod) ?? "cash");
  const [amount, setAmount] = useState(editing ? Number(editing.amount) : 0);
  const [requestedBy, setRequestedBy] = useState(editing?.requested_by_name ?? "");
  const [remarks, setRemarks] = useState(editing?.remarks ?? "");
  const [file, setFile] = useState<File | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (amount <= 0) throw new Error("Amount must be greater than 0");

      let finalCategoryId = categoryId === "none" ? null : categoryId;
      if (categoryId === "__new__") {
        if (!newCategory.trim()) throw new Error("Enter a category name");
        const { data, error } = await supabase.from("expense_categories").insert({ factory_id: factoryId, name: newCategory.trim() }).select("id").single();
        if (error) throw error;
        finalCategoryId = data.id;
      }

      let attachmentPath = editing?.attachment_url ?? null;
      if (file) {
        const { data: userData } = await supabase.auth.getUser();
        const path = `${factoryId}/${userData.user?.id ?? "anon"}-${Date.now()}-${file.name}`;
        const { error: uploadError } = await supabase.storage.from("expense-attachments").upload(path, file);
        if (uploadError) throw uploadError;
        attachmentPath = path;
      }

      const payload = {
        expense_date: date, category_id: finalCategoryId, description: description || null, vendor: vendor || null,
        receipt_number: receiptNumber || null, payment_method: method, amount, requested_by_name: requestedBy || null,
        remarks: remarks || null, attachment_url: attachmentPath,
      };

      if (editing) {
        const { error } = await supabase.from("expenses").update(payload).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { data: userData } = await supabase.auth.getUser();
        const { error } = await supabase.from("expenses").insert({
          ...payload, factory_id: factoryId, recorded_by: userData.user?.id ?? null, submitted_by: userData.user?.id ?? null,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editing ? "Expense updated" : "Expense submitted for approval");
      logAudit({
        action: editing ? "update" : "create", entity: "expenses", entityId: editing?.id, factoryId,
        oldValue: editing ? { amount: editing.amount, description: editing.description } : undefined,
        newValue: { amount, description },
      });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>{editing ? "Edit Expense" : "Record Expense"}</DialogTitle></DialogHeader>
      <div className="grid gap-3 max-h-[70vh] overflow-y-auto pr-1">
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Expense date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div>
            <Label>Category</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {categories.map((c) => (<SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>))}
                <SelectItem value="__new__">+ Add new category…</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {categoryId === "__new__" && (
          <div><Label>New category name</Label><Input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} /></div>
        )}
        <div><Label>Description</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Vendor</Label><Input value={vendor} onChange={(e) => setVendor(e.target.value)} /></div>
          <div><Label>Receipt number</Label><Input value={receiptNumber} onChange={(e) => setReceiptNumber(e.target.value)} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Payment method</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["cash","transfer","pos","card","cheque","credit"] as PaymentMethod[]).map((m) => (
                  <SelectItem key={m} value={m} className="capitalize">{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div><Label>Amount</Label><Input type="number" min={0.01} step="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></div>
        </div>
        <div><Label>Requested by</Label><Input value={requestedBy} onChange={(e) => setRequestedBy(e.target.value)} placeholder="Person requesting this expense" /></div>
        {editing && editing.status !== "pending_approval" && (
          <p className="text-xs text-muted-foreground">
            Status: {editing.status.replace(/_/g, " ")}
            {editing.approved_at ? ` · ${new Date(editing.approved_at).toLocaleString()}` : ""}
          </p>
        )}
        <div>
          <Label>Attachment</Label>
          <Input type="file" accept="image/*,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          {editing?.attachment_url && !file && <p className="mt-1 text-xs text-muted-foreground">A file is already attached. Choose a new one to replace it.</p>}
        </div>
        <div><Label>Remarks</Label><Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()} className="gap-2">
          <Receipt className="h-4 w-4" /> {save.isPending ? "Saving…" : editing ? "Save changes" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
