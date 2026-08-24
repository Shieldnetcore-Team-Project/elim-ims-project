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
import { Badge } from "@/components/ui/badge";
import { money } from "@/lib/format";
import { toast } from "sonner";
import { Plus, Printer, FileDown, Wallet, Check, X, Send, Ban, Undo2 } from "lucide-react";
import { generatePayslipPdf } from "@/lib/pdf";

export const Route = createFileRoute("/_app/payroll")({
  head: () => ({ meta: [{ title: "Payroll — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="payroll">
      <PayrollPage />
    </RequireAccess>
  ),
});

type PaymentMethod = "cash" | "transfer" | "pos" | "card" | "cheque" | "credit";
type Employee = {
  id: string; employee_code: string | null; full_name: string; department: string | null; position: string | null;
  basic_salary: number; housing_allowance: number | null; transport_allowance: number | null;
  meal_allowance: number | null; medical_allowance: number | null; other_allowances: number | null;
  bank_name: string | null; account_number: string | null;
};
type PayrollRow = {
  id: string; employee_id: string; period_month: number; period_year: number; basic_salary: number;
  housing_allowance: number; transport_allowance: number; meal_allowance: number; medical_allowance: number;
  other_allowances: number; overtime: number; gross_salary: number; paye: number; pension: number; loans: number;
  advance: number; other_deductions: number; net_salary: number; payment_method: string | null;
  payment_date: string | null; status: string | null; bank_name: string | null; account_number: string | null;
  submitted_by: string | null;
  employees: { full_name: string; employee_code: string | null; department: string | null; position: string | null } | null;
};

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const statusBadge = (s: string | null): "default" | "secondary" | "outline" | "destructive" =>
  s === "posted" ? "secondary" : s === "rejected" || s === "cancelled" || s === "reversed" ? "destructive" : "outline";

function PayrollPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const qc = useQueryClient();
  const { canWrite, canApprove, canReject, canPost, canCancel, canReverse } = usePermissions();
  const write = canWrite("payroll");
  const approve = canApprove("payroll");
  const reject = canReject("payroll");
  const post = canPost("payroll");
  const cancel = canCancel("payroll");
  const reverse = canReverse("payroll");
  const [formOpen, setFormOpen] = useState(false);
  const [approveTarget, setApproveTarget] = useState<PayrollRow | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PayrollRow | null>(null);
  const [postTarget, setPostTarget] = useState<PayrollRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<PayrollRow | null>(null);
  const [reverseTarget, setReverseTarget] = useState<PayrollRow | null>(null);
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());

  const employees = useQuery({
    queryKey: ["employees-for-payroll", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase.from("employees").select("*").eq("factory_id", factoryId!).eq("status", "active").order("full_name");
      if (error) throw error;
      return (data ?? []) as Employee[];
    },
  });

  const list = useQuery({
    queryKey: ["payroll-list", factoryId, month, year],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll")
        .select("*, employees(full_name,employee_code,department,position)")
        .eq("factory_id", factoryId!).eq("period_month", month).eq("period_year", year)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PayrollRow[];
    },
  });

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const totalNet = (list.data ?? []).reduce((s, r) => s + Number(r.net_salary), 0);
  const invalidateAll = () => qc.invalidateQueries({ queryKey: ["payroll-list"] });

  const printPayslip = (r: PayrollRow, action: "print" | "download") => {
    generatePayslipPdf({
      company: { name: settings.data?.company_name ?? "FMIS", address: settings.data?.address, phone: settings.data?.phone },
      employee: {
        code: r.employees?.employee_code ?? null, name: r.employees?.full_name ?? "—",
        department: r.employees?.department, position: r.employees?.position,
        bank_name: r.bank_name, account_number: r.account_number,
      },
      period: `${MONTHS[r.period_month - 1]} ${r.period_year}`,
      payment_date: r.payment_date, payment_method: r.payment_method ?? undefined,
      basic_salary: Number(r.basic_salary), housing_allowance: Number(r.housing_allowance),
      transport_allowance: Number(r.transport_allowance), meal_allowance: Number(r.meal_allowance),
      medical_allowance: Number(r.medical_allowance), other_allowances: Number(r.other_allowances),
      overtime: Number(r.overtime), gross_salary: Number(r.gross_salary), paye: Number(r.paye),
      pension: Number(r.pension), loans: Number(r.loans), advance: Number(r.advance),
      other_deductions: Number(r.other_deductions), net_salary: Number(r.net_salary),
      currency: settings.data?.currency ?? "NGN",
    }, action);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Payroll</h1>
          <p className="text-sm text-muted-foreground">Monthly payroll runs, submitted for approval before payout.</p>
        </div>
        {write && (
        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="h-4 w-4" /> Submit Payroll</Button>
          </DialogTrigger>
          {formOpen && factoryId && (
            <PayrollForm
              factoryId={factoryId} employees={employees.data ?? []} month={month} year={year}
              onDone={() => { setFormOpen(false); invalidateAll(); }}
            />
          )}
        </Dialog>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {MONTHS.map((m, i) => (<SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map((y) => (
              <SelectItem key={y} value={String(y)}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Card className="rounded-xl">
          <CardContent className="flex items-center gap-2 px-4 py-2">
            <Wallet className="h-4 w-4 text-primary" />
            <span className="text-sm text-muted-foreground">Total net this period:</span>
            <span className="font-semibold">{money(totalNet)}</span>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-2xl">
        <CardHeader><CardTitle>{MONTHS[month - 1]} {year} Payroll</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Department</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead className="text-right">Deductions</TableHead>
                <TableHead className="text-right">Net Salary</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div className="font-medium">{r.employees?.full_name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{r.employees?.employee_code ?? "—"}</div>
                  </TableCell>
                  <TableCell>{r.employees?.department ?? "—"}</TableCell>
                  <TableCell className="text-right">{money(Number(r.gross_salary))}</TableCell>
                  <TableCell className="text-right">{money(Number(r.paye) + Number(r.pension) + Number(r.loans) + Number(r.advance) + Number(r.other_deductions))}</TableCell>
                  <TableCell className="text-right font-medium">{money(Number(r.net_salary))}</TableCell>
                  <TableCell><Badge variant={statusBadge(r.status)} className="capitalize">{(r.status ?? "pending_approval").replace(/_/g, " ")}</Badge></TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {r.status === "pending_approval" && approve && r.submitted_by !== currentUser.data && (
                        <Button variant="ghost" size="icon" title="Approve" onClick={() => setApproveTarget(r)}>
                          <Check className="h-4 w-4 text-success" />
                        </Button>
                      )}
                      {r.status === "pending_approval" && reject && r.submitted_by !== currentUser.data && (
                        <Button variant="ghost" size="icon" title="Reject" onClick={() => setRejectTarget(r)}>
                          <X className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                      {r.status === "approved" && post && r.submitted_by !== currentUser.data && (
                        <Button variant="ghost" size="icon" title="Post & mark paid" onClick={() => setPostTarget(r)}>
                          <Send className="h-4 w-4 text-success" />
                        </Button>
                      )}
                      {(r.status === "pending_approval" || r.status === "approved") && cancel && (
                        <Button variant="ghost" size="icon" title="Cancel" onClick={() => setCancelTarget(r)}>
                          <Ban className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      )}
                      {r.status === "posted" && reverse && r.submitted_by !== currentUser.data && (
                        <Button variant="ghost" size="icon" title="Reverse" onClick={() => setReverseTarget(r)}>
                          <Undo2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" title="Print" onClick={() => printPayslip(r, "print")}>
                        <Printer className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" title="Download PDF" onClick={() => printPayslip(r, "download")}>
                        <FileDown className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(list.data ?? []).length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No payroll submitted for this period.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!approveTarget} onOpenChange={(v) => !v && setApproveTarget(null)}>
        {approveTarget && <ApprovePayrollDialog row={approveTarget} onDone={() => { setApproveTarget(null); invalidateAll(); }} />}
      </Dialog>
      <Dialog open={!!rejectTarget} onOpenChange={(v) => !v && setRejectTarget(null)}>
        {rejectTarget && <RejectPayrollDialog row={rejectTarget} onDone={() => { setRejectTarget(null); invalidateAll(); }} />}
      </Dialog>
      <Dialog open={!!postTarget} onOpenChange={(v) => !v && setPostTarget(null)}>
        {postTarget && <PostPayrollDialog row={postTarget} onDone={() => { setPostTarget(null); invalidateAll(); }} />}
      </Dialog>
      <Dialog open={!!cancelTarget} onOpenChange={(v) => !v && setCancelTarget(null)}>
        {cancelTarget && <CancelPayrollDialog row={cancelTarget} onDone={() => { setCancelTarget(null); invalidateAll(); }} />}
      </Dialog>
      <Dialog open={!!reverseTarget} onOpenChange={(v) => !v && setReverseTarget(null)}>
        {reverseTarget && <ReversePayrollDialog row={reverseTarget} onDone={() => { setReverseTarget(null); invalidateAll(); }} />}
      </Dialog>
    </div>
  );
}

function ApprovePayrollDialog({ row, onDone }: { row: PayrollRow; onDone: () => void }) {
  const submit = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("approve_payroll", { p_id: row.id });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Payroll approved — post it next to mark paid"); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Approve Payroll — {row.employees?.full_name}</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">Net salary: {money(Number(row.net_salary))}</p>
        <p className="text-sm text-muted-foreground">This marks the payroll run reviewed. A post step (by you or someone else) still finalizes payment.</p>
      </div>
      <DialogFooter>
        <Button disabled={submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? "Approving…" : "Approve"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function PostPayrollDialog({ row, onDone }: { row: PayrollRow; onDone: () => void }) {
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));

  const submit = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("post_payroll", { p_id: row.id, p_payment_date: paymentDate });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Payroll posted and marked paid"); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Post Payroll — {row.employees?.full_name}</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">Net salary: {money(Number(row.net_salary))}</p>
        <div><Label>Payment date</Label><Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} /></div>
      </div>
      <DialogFooter>
        <Button disabled={submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? "Posting…" : "Post & mark paid"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function CancelPayrollDialog({ row, onDone }: { row: PayrollRow; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const submit = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("cancel_payroll", { p_id: row.id, p_reason: reason || undefined });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Payroll run cancelled"); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Cancel Payroll — {row.employees?.full_name}</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <div><Label>Reason (optional)</Label><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      <DialogFooter>
        <Button variant="destructive" disabled={submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? "Cancelling…" : "Cancel run"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ReversePayrollDialog({ row, onDone }: { row: PayrollRow; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const submit = useMutation({
    mutationFn: async () => {
      if (!reason.trim()) throw new Error("A reason is required to reverse a posted payroll run");
      const { error } = await supabase.rpc("reverse_payroll", { p_id: row.id, p_reason: reason });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Payroll reversed"); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Reverse Payroll — {row.employees?.full_name}</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">This payroll run was already marked paid. Reversing flags it as no longer valid but keeps the full history.</p>
        <div><Label>Reason</Label><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      <DialogFooter>
        <Button variant="destructive" disabled={submit.isPending || !reason.trim()} onClick={() => submit.mutate()}>
          {submit.isPending ? "Reversing…" : "Reverse"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function RejectPayrollDialog({ row, onDone }: { row: PayrollRow; onDone: () => void }) {
  const [reason, setReason] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("reject_payroll", { p_id: row.id, p_reason: reason || undefined });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Payroll rejected"); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Reject Payroll — {row.employees?.full_name}</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <div><Label>Reason</Label><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      <DialogFooter>
        <Button variant="destructive" disabled={submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? "Rejecting…" : "Reject"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function PayrollForm({ factoryId, employees, month, year, onDone }: {
  factoryId: string; employees: Employee[]; month: number; year: number; onDone: () => void;
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [selected, setSelected] = useState<Employee | null>(null);
  const [overtime, setOvertime] = useState(0);
  const [paye, setPaye] = useState(0);
  const [pension, setPension] = useState(0);
  const [loans, setLoans] = useState(0);
  const [advance, setAdvance] = useState(0);
  const [otherDed, setOtherDed] = useState(0);
  const [method, setMethod] = useState<PaymentMethod>("transfer");

  const basic = Number(selected?.basic_salary ?? 0);
  const housing = Number(selected?.housing_allowance ?? 0);
  const transport = Number(selected?.transport_allowance ?? 0);
  const meal = Number(selected?.meal_allowance ?? 0);
  const medical = Number(selected?.medical_allowance ?? 0);
  const otherAllow = Number(selected?.other_allowances ?? 0);

  const gross = useMemo(() => basic + housing + transport + meal + medical + otherAllow + overtime, [basic, housing, transport, meal, medical, otherAllow, overtime]);
  const net = useMemo(() => Math.max(gross - paye - pension - loans - advance - otherDed, 0), [gross, paye, pension, loans, advance, otherDed]);

  const selectEmployee = (id: string) => {
    setEmployeeId(id);
    setSelected(employees.find((e) => e.id === id) ?? null);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!employeeId) throw new Error("Select an employee");
      const { error } = await supabase.rpc("process_payroll", {
        payload: {
          factory_id: factoryId, employee_id: employeeId, period_month: month, period_year: year,
          overtime, paye, pension, loans, advance, other_deductions: otherDed, payment_method: method,
        } as any,
      });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Payroll submitted for approval"); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader><DialogTitle>Submit Payroll</DialogTitle></DialogHeader>
      <div className="grid gap-3 max-h-[70vh] overflow-y-auto pr-1">
        <div>
          <Label>Employee</Label>
          <Select value={employeeId} onValueChange={selectEmployee}>
            <SelectTrigger><SelectValue placeholder="Select employee…" /></SelectTrigger>
            <SelectContent>
              {employees.map((e) => (<SelectItem key={e.id} value={e.id}>{e.full_name} · {e.position ?? "—"}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>

        <p className="text-xs text-muted-foreground">Basic salary and allowances are pulled from the employee record and recomputed on the server — they can't be edited here.</p>
        <div className="grid grid-cols-3 gap-3">
          <div><Label>Basic salary</Label><Input value={money(basic)} disabled /></div>
          <div><Label>Housing</Label><Input value={money(housing)} disabled /></div>
          <div><Label>Transport</Label><Input value={money(transport)} disabled /></div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div><Label>Meal</Label><Input value={money(meal)} disabled /></div>
          <div><Label>Medical</Label><Input value={money(medical)} disabled /></div>
          <div><Label>Other allowances</Label><Input value={money(otherAllow)} disabled /></div>
        </div>
        <div><Label>Overtime</Label><Input type="number" min={0} step="0.01" value={overtime} onChange={(e) => setOvertime(Number(e.target.value))} /></div>

        <div className="rounded-md bg-muted/30 p-2 text-sm flex justify-between font-medium"><span>Gross salary</span><span>{money(gross)}</span></div>

        <div className="grid grid-cols-3 gap-3">
          <div><Label>PAYE</Label><Input type="number" min={0} step="0.01" value={paye} onChange={(e) => setPaye(Number(e.target.value))} /></div>
          <div><Label>Pension</Label><Input type="number" min={0} step="0.01" value={pension} onChange={(e) => setPension(Number(e.target.value))} /></div>
          <div><Label>Loans</Label><Input type="number" min={0} step="0.01" value={loans} onChange={(e) => setLoans(Number(e.target.value))} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Advance</Label><Input type="number" min={0} step="0.01" value={advance} onChange={(e) => setAdvance(Number(e.target.value))} /></div>
          <div><Label>Other deductions</Label><Input type="number" min={0} step="0.01" value={otherDed} onChange={(e) => setOtherDed(Number(e.target.value))} /></div>
        </div>

        <div className="rounded-md bg-primary/10 p-2 text-sm flex justify-between font-semibold text-primary"><span>Net salary</span><span>{money(net)}</span></div>

        <div className="grid grid-cols-2 gap-3">
          <div><Label>Bank name</Label><Input value={selected?.bank_name ?? ""} disabled /></div>
          <div><Label>Account number</Label><Input value={selected?.account_number ?? ""} disabled /></div>
        </div>
        <div>
          <Label>Payment method</Label>
          <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {(["cash","transfer","pos","card","cheque"] as PaymentMethod[]).map((m) => (
                <SelectItem key={m} value={m} className="capitalize">{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">This submits the payroll run for approval — it won't be marked paid until a different, authorized reviewer approves it.</p>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending || !employeeId} onClick={() => save.mutate()}>
          {save.isPending ? "Submitting…" : "Submit for approval"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
