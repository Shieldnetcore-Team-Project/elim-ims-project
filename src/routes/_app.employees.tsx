import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { money } from "@/lib/format";
import { requestDelete } from "@/lib/request-delete";
import { RequestDeleteDialog } from "@/components/shared/request-delete-dialog";
import { toast } from "sonner";
import {
  Plus,
  Search,
  Pencil,
  FileText,
  Trash2,
  Upload,
  Download,
  HandCoins,
  Check,
  X,
  Ban,
  Loader2,
} from "lucide-react";

export const Route = createFileRoute("/_app/employees")({
  head: () => ({ meta: [{ title: "Employees — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="employees">
      <EmployeesPage />
    </RequireAccess>
  ),
});

type Employee = {
  id: string;
  employee_code: string | null;
  full_name: string;
  phone: string | null;
  email: string | null;
  gender: string | null;
  dob: string | null;
  department: string | null;
  position: string | null;
  basic_salary: number;
  housing_allowance: number | null;
  transport_allowance: number | null;
  meal_allowance: number | null;
  medical_allowance: number | null;
  other_allowances: number | null;
  employment_date: string | null;
  status: string | null;
  bank_name: string | null;
  account_number: string | null;
  emergency_contact: string | null;
  photo_url: string | null;
};
type EmployeeDoc = { id: string; file_name: string; file_path: string; created_at: string };

function useSignedUrl(path: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!path) {
      setUrl(null);
      return;
    }
    supabase.storage
      .from("employee-files")
      .createSignedUrl(path, 3600)
      .then(({ data }) => {
        if (active) setUrl(data?.signedUrl ?? null);
      });
    return () => {
      active = false;
    };
  }, [path]);
  return url;
}

function EmployeePhoto({ path, name }: { path: string | null; name: string }) {
  const url = useSignedUrl(path);
  return (
    <Avatar className="h-9 w-9">
      {url && <AvatarImage src={url} alt={name} />}
      <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

function EmployeesPage() {
  const { data: factoryId } = useFactoryId();
  const qc = useQueryClient();
  const { canWrite } = usePermissions();
  const write = canWrite("employees");
  const [q, setQ] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [docsTarget, setDocsTarget] = useState<Employee | null>(null);
  const [loansTarget, setLoansTarget] = useState<Employee | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Employee | null>(null);

  const list = useQuery({
    queryKey: ["employees-list", factoryId, q],
    enabled: !!factoryId,
    queryFn: async () => {
      let query = supabase
        .from("employees")
        .select("*")
        .eq("factory_id", factoryId!)
        .order("full_name");
      if (q.trim()) query = query.ilike("full_name", `%${q.trim()}%`);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as Employee[];
    },
  });

  const invalidateAll = () => qc.invalidateQueries({ queryKey: ["employees-list"] });

  const del = useMutation({
    mutationFn: async ({ emp, reason }: { emp: Employee; reason: string }) => {
      await requestDelete("employees", emp.id, reason);
    },
    onSuccess: () => {
      toast.success("Deletion requested — pending admin approval");
      setDeleteTarget(null);
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
          <p className="text-sm text-muted-foreground">
            Records, documents, and compensation profile.
          </p>
        </div>
        {write && (
          <Dialog
            open={formOpen}
            onOpenChange={(v) => {
              setFormOpen(v);
              if (!v) setEditing(null);
            }}
          >
            <DialogTrigger asChild>
              <Button className="gap-2" onClick={() => setEditing(null)}>
                <Plus className="h-4 w-4" /> New Employee
              </Button>
            </DialogTrigger>
            {formOpen && factoryId && (
              <EmployeeForm
                factoryId={factoryId}
                editing={editing}
                onDone={() => {
                  setFormOpen(false);
                  setEditing(null);
                  invalidateAll();
                }}
              />
            )}
          </Dialog>
        )}
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle>All Employees</CardTitle>
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="pl-8 h-9"
            />
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead></TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Position</TableHead>
                <TableHead className="text-right">Basic Salary</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <EmployeePhoto path={e.photo_url} name={e.full_name} />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{e.full_name}</div>
                    <div className="text-xs text-muted-foreground">{e.employee_code ?? "—"}</div>
                  </TableCell>
                  <TableCell>{e.department ?? "—"}</TableCell>
                  <TableCell>{e.position ?? "—"}</TableCell>
                  <TableCell className="text-right">{money(Number(e.basic_salary))}</TableCell>
                  <TableCell>
                    <Badge
                      variant={e.status === "active" ? "secondary" : "outline"}
                      className="capitalize"
                    >
                      {e.status ?? "active"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Documents"
                        onClick={() => setDocsTarget(e)}
                      >
                        <FileText className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Loans & Deductions"
                        onClick={() => setLoansTarget(e)}
                      >
                        <HandCoins className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Edit"
                        onClick={() => {
                          setEditing(e);
                          setFormOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Remove"
                        onClick={() => setDeleteTarget(e)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(list.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    No employees yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!docsTarget} onOpenChange={(v) => !v && setDocsTarget(null)}>
        {docsTarget && factoryId && <DocumentsDialog employee={docsTarget} factoryId={factoryId} />}
      </Dialog>

      <Dialog open={!!loansTarget} onOpenChange={(v) => !v && setLoansTarget(null)}>
        {loansTarget && factoryId && (
          <LoansDeductionsDialog employee={loansTarget} factoryId={factoryId} />
        )}
      </Dialog>

      <RequestDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        isPending={del.isPending}
        title={deleteTarget ? `Request deletion — ${deleteTarget.full_name}` : "Request deletion"}
        onConfirm={(reason) => deleteTarget && del.mutate({ emp: deleteTarget, reason })}
      />
    </div>
  );
}

function EmployeeForm({
  factoryId,
  editing,
  onDone,
}: {
  factoryId: string;
  editing: Employee | null;
  onDone: () => void;
}) {
  // Auto-generated by a DB trigger on insert (employees_set_code) — never
  // user-editable, so this is read from `editing` only, not state.
  const code = editing?.employee_code ?? "";
  const [name, setName] = useState(editing?.full_name ?? "");
  const [phone, setPhone] = useState(editing?.phone ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  const [gender, setGender] = useState(editing?.gender ?? "");
  const [dob, setDob] = useState(editing?.dob ?? "");
  const [department, setDepartment] = useState(editing?.department ?? "");
  const [position, setPosition] = useState(editing?.position ?? "");
  const [basicSalary, setBasicSalary] = useState(editing ? Number(editing.basic_salary) : 0);
  const [housing, setHousing] = useState(editing ? Number(editing.housing_allowance ?? 0) : 0);
  const [transport, setTransport] = useState(
    editing ? Number(editing.transport_allowance ?? 0) : 0,
  );
  const [meal, setMeal] = useState(editing ? Number(editing.meal_allowance ?? 0) : 0);
  const [medical, setMedical] = useState(editing ? Number(editing.medical_allowance ?? 0) : 0);
  const [otherAllow, setOtherAllow] = useState(editing ? Number(editing.other_allowances ?? 0) : 0);
  const [employmentDate, setEmploymentDate] = useState(editing?.employment_date ?? "");
  const [status, setStatus] = useState(editing?.status ?? "active");
  const [bankName, setBankName] = useState(editing?.bank_name ?? "");
  const [accountNumber, setAccountNumber] = useState(editing?.account_number ?? "");
  const [emergencyContact, setEmergencyContact] = useState(editing?.emergency_contact ?? "");
  const [photoFile, setPhotoFile] = useState<File | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Full name is required");

      let photoPath = editing?.photo_url ?? null;
      if (photoFile) {
        const path = `${factoryId}/photos/${Date.now()}-${photoFile.name}`;
        const { error } = await supabase.storage.from("employee-files").upload(path, photoFile);
        if (error) throw error;
        photoPath = path;
      }

      const payload = {
        employee_code: code || null,
        full_name: name.trim(),
        phone: phone || null,
        email: email || null,
        gender: gender || null,
        dob: dob || null,
        department: department || null,
        position: position || null,
        basic_salary: basicSalary,
        housing_allowance: housing,
        transport_allowance: transport,
        meal_allowance: meal,
        medical_allowance: medical,
        other_allowances: otherAllow,
        employment_date: employmentDate || null,
        status,
        bank_name: bankName || null,
        account_number: accountNumber || null,
        emergency_contact: emergencyContact || null,
        photo_url: photoPath,
      };

      if (editing) {
        const { error } = await supabase.from("employees").update(payload).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("employees")
          .insert({ ...payload, factory_id: factoryId });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editing ? "Employee updated" : "Employee added");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{editing ? "Edit Employee" : "New Employee"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 max-h-[70vh] overflow-y-auto pr-1">
        <div>
          <Label>Employee photo</Label>
          <Input
            type="file"
            accept="image/*"
            onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Employee ID</Label>
            <Input value={editing ? code : "Auto-generated on save"} disabled />
          </div>
          <div>
            <Label>Full name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Phone</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div>
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Gender</Label>
            <Select
              value={gender || "unspecified"}
              onValueChange={(v) => setGender(v === "unspecified" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unspecified">— Unspecified —</SelectItem>
                <SelectItem value="male">Male</SelectItem>
                <SelectItem value="female">Female</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Date of birth</Label>
            <Input type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Department</Label>
            <Input value={department} onChange={(e) => setDepartment(e.target.value)} />
          </div>
          <div>
            <Label>Position</Label>
            <Input value={position} onChange={(e) => setPosition(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>Basic salary</Label>
            <MoneyInput value={basicSalary} onChange={setBasicSalary} />
          </div>
          <div>
            <Label>Housing</Label>
            <MoneyInput value={housing} onChange={setHousing} />
          </div>
          <div>
            <Label>Transport</Label>
            <MoneyInput value={transport} onChange={setTransport} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>Meal</Label>
            <MoneyInput value={meal} onChange={setMeal} />
          </div>
          <div>
            <Label>Medical</Label>
            <MoneyInput value={medical} onChange={setMedical} />
          </div>
          <div>
            <Label>Other</Label>
            <MoneyInput value={otherAllow} onChange={setOtherAllow} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Employment date</Label>
            <Input
              type="date"
              value={employmentDate}
              onChange={(e) => setEmploymentDate(e.target.value)}
            />
          </div>
          <div>
            <Label>Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="on_leave">On leave</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
                <SelectItem value="terminated">Terminated</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Bank name</Label>
            <Input value={bankName} onChange={(e) => setBankName(e.target.value)} />
          </div>
          <div>
            <Label>Account number</Label>
            <Input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} />
          </div>
        </div>
        <div>
          <Label>Emergency contact</Label>
          <Textarea
            rows={2}
            value={emergencyContact}
            onChange={(e) => setEmergencyContact(e.target.value)}
          />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : editing ? "Save changes" : "Add employee"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function DocumentsDialog({ employee, factoryId }: { employee: Employee; factoryId: string }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EmployeeDoc | null>(null);

  const docs = useQuery({
    queryKey: ["employee-documents", employee.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employee_documents")
        .select("id,file_name,file_path,created_at")
        .eq("employee_id", employee.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as EmployeeDoc[];
    },
  });

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a file first");
      const path = `${factoryId}/documents/${employee.id}/${Date.now()}-${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from("employee-files")
        .upload(path, file);
      if (uploadError) throw uploadError;
      const { data: userData } = await supabase.auth.getUser();
      const { error } = await supabase.from("employee_documents").insert({
        employee_id: employee.id,
        factory_id: factoryId,
        file_name: file.name,
        file_path: path,
        uploaded_by: userData.user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Document uploaded");
      setFile(null);
      qc.invalidateQueries({ queryKey: ["employee-documents", employee.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async ({ doc, reason }: { doc: EmployeeDoc; reason: string }) => {
      await requestDelete("employee_documents", doc.id, reason);
    },
    onSuccess: () => {
      toast.success("Deletion requested — pending admin approval");
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["employee-documents", employee.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const view = async (doc: EmployeeDoc) => {
    const { data, error } = await supabase.storage
      .from("employee-files")
      .createSignedUrl(doc.file_path, 60);
    if (error) {
      toast.error(error.message);
      return;
    }
    window.open(data.signedUrl, "_blank");
  };

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Documents — {employee.full_name}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div className="flex gap-2">
          <Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <Button
            disabled={!file || upload.isPending}
            onClick={() => upload.mutate()}
            className="gap-2 shrink-0"
          >
            <Upload className="h-4 w-4" /> Upload
          </Button>
        </div>
        <div className="space-y-2">
          {(docs.data ?? []).map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between rounded-md border p-2 text-sm"
            >
              <button
                onClick={() => view(d)}
                className="flex items-center gap-2 hover:underline text-left"
              >
                <Download className="h-4 w-4" /> {d.file_name}
              </button>
              <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(d)}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
          {(docs.data ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No documents uploaded yet.
            </p>
          )}
        </div>
      </div>

      <RequestDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        isPending={remove.isPending}
        title={deleteTarget ? `Request deletion — ${deleteTarget.file_name}` : "Request deletion"}
        onConfirm={(reason) => deleteTarget && remove.mutate({ doc: deleteTarget, reason })}
      />
    </DialogContent>
  );
}

const DED_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

type LoanRow = {
  id: string;
  loan_number: string;
  principal: number;
  repayment_type: string;
  installment_mode: string | null;
  installment_amount: number | null;
  installment_months: number | null;
  amount_repaid: number;
  outstanding: number;
  status: string;
  submitted_by: string | null;
  reason: string | null;
};
type DeductionRow = {
  id: string;
  reference_number: string;
  kind: string;
  label: string;
  amount: number;
  period_month: number;
  period_year: number;
  status: string;
  submitted_by: string | null;
};

const loanBadge = (s: string): "default" | "secondary" | "outline" | "destructive" =>
  s === "settled"
    ? "default"
    : s === "active"
      ? "secondary"
      : s === "pending"
        ? "outline"
        : "destructive";

function LoansDeductionsDialog({ employee, factoryId }: { employee: Employee; factoryId: string }) {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canCreate = can("payroll", "create");
  const canApprove = can("payroll", "approve");
  const canReject = can("payroll", "reject");
  const canCancel = can("payroll", "cancel");

  const me = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const loans = useQuery({
    queryKey: ["staff-loans", employee.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_loans")
        .select(
          "id,loan_number,principal,repayment_type,installment_mode,installment_amount,installment_months,amount_repaid,outstanding,status,submitted_by,reason",
        )
        .eq("employee_id", employee.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as LoanRow[];
    },
  });
  const deductions = useQuery({
    queryKey: ["staff-deductions", employee.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_deductions")
        .select(
          "id,reference_number,kind,label,amount,period_month,period_year,status,submitted_by",
        )
        .eq("employee_id", employee.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as DeductionRow[];
    },
  });

  const refreshLoans = () => qc.invalidateQueries({ queryKey: ["staff-loans", employee.id] });
  const refreshDed = () => qc.invalidateQueries({ queryKey: ["staff-deductions", employee.id] });

  // ---- loan form ----
  const [principal, setPrincipal] = useState(0);
  const [disbursedOn, setDisbursedOn] = useState(new Date().toISOString().slice(0, 10));
  const [repayType, setRepayType] = useState<"one_time" | "installment">("one_time");
  const [instMode, setInstMode] = useState<"amount" | "months">("amount");
  const [instAmount, setInstAmount] = useState(0);
  const [instMonths, setInstMonths] = useState(0);
  const [loanReason, setLoanReason] = useState("");

  const addLoan = useMutation({
    mutationFn: async () => {
      if (principal <= 0) throw new Error("Principal must be greater than 0");
      const payload: Record<string, unknown> = {
        factory_id: factoryId,
        employee_id: employee.id,
        principal,
        disbursed_on: disbursedOn,
        repayment_type: repayType,
        reason: loanReason || undefined,
      };
      if (repayType === "installment") {
        payload.installment_mode = instMode;
        if (instMode === "amount") payload.installment_amount = instAmount;
        else payload.installment_months = instMonths;
      }
      const { error } = await supabase.rpc("create_staff_loan", { payload: payload as never });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Loan recorded — awaiting approval");
      setPrincipal(0);
      setInstAmount(0);
      setInstMonths(0);
      setLoanReason("");
      refreshLoans();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const runLoan = async (
    action: "approve_staff_loan" | "reject_staff_loan" | "cancel_staff_loan",
    id: string,
  ) => {
    let reason: string | undefined;
    if (action !== "approve_staff_loan") {
      reason =
        window.prompt(
          action === "reject_staff_loan" ? "Reason for rejecting:" : "Reason for cancelling:",
        ) ?? undefined;
      if (action === "reject_staff_loan" && !reason?.trim()) return;
    }
    const { error } =
      action === "approve_staff_loan"
        ? await supabase.rpc("approve_staff_loan", { p_id: id })
        : action === "reject_staff_loan"
          ? await supabase.rpc("reject_staff_loan", { p_id: id, p_reason: reason ?? "" })
          : await supabase.rpc("cancel_staff_loan", { p_id: id, p_reason: reason });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Loan updated");
    refreshLoans();
  };

  // ---- deduction form ----
  const now = new Date();
  const [kind, setKind] = useState<"fine" | "contribution" | "other">("fine");
  const [dedLabel, setDedLabel] = useState("");
  const [dedAmount, setDedAmount] = useState(0);
  const [pMonth, setPMonth] = useState(now.getMonth() + 1);
  const [pYear, setPYear] = useState(now.getFullYear());
  const [dedReason, setDedReason] = useState("");

  const addDed = useMutation({
    mutationFn: async () => {
      if (!dedLabel.trim()) throw new Error("A label is required");
      if (dedAmount <= 0) throw new Error("Amount must be greater than 0");
      const { error } = await supabase.rpc("create_staff_deduction", {
        payload: {
          factory_id: factoryId,
          employee_id: employee.id,
          kind,
          label: dedLabel.trim(),
          amount: dedAmount,
          period_month: pMonth,
          period_year: pYear,
          reason: dedReason || undefined,
        } as never,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Recorded — awaiting approval");
      setDedLabel("");
      setDedAmount(0);
      setDedReason("");
      refreshDed();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const runDed = async (
    action: "approve_staff_deduction" | "reject_staff_deduction",
    id: string,
  ) => {
    let reason: string | undefined;
    if (action === "reject_staff_deduction") {
      reason = window.prompt("Reason for rejecting:") ?? undefined;
      if (!reason?.trim()) return;
    }
    const { error } =
      action === "approve_staff_deduction"
        ? await supabase.rpc("approve_staff_deduction", { p_id: id })
        : await supabase.rpc("reject_staff_deduction", { p_id: id, p_reason: reason ?? "" });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Updated");
    refreshDed();
  };

  const schedule = (l: LoanRow) =>
    l.repayment_type === "one_time"
      ? "One-time"
      : l.installment_mode === "amount"
        ? `${money(Number(l.installment_amount ?? 0))}/mo`
        : `${l.installment_months} months`;

  return (
    <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Loans &amp; Deductions — {employee.full_name}</DialogTitle>
      </DialogHeader>

      <div className="space-y-6">
        {/* ---------------- Staff loans ---------------- */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Staff loans</h3>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Loan #</TableHead>
                  <TableHead className="text-right">Principal</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead className="text-right">Repaid</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(loans.data ?? []).map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-mono text-xs">{l.loan_number}</TableCell>
                    <TableCell className="text-right">{money(Number(l.principal))}</TableCell>
                    <TableCell className="text-xs">{schedule(l)}</TableCell>
                    <TableCell className="text-right">{money(Number(l.amount_repaid))}</TableCell>
                    <TableCell className="text-right">{money(Number(l.outstanding))}</TableCell>
                    <TableCell>
                      <Badge variant={loanBadge(l.status)} className="capitalize">
                        {l.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {l.status === "pending" && canApprove && l.submitted_by !== me.data && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Approve"
                            onClick={() => runLoan("approve_staff_loan", l.id)}
                          >
                            <Check className="h-4 w-4 text-success" />
                          </Button>
                        )}
                        {l.status === "pending" && canReject && l.submitted_by !== me.data && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Reject"
                            onClick={() => runLoan("reject_staff_loan", l.id)}
                          >
                            <X className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                        {l.status === "active" && canCancel && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Cancel"
                            onClick={() => runLoan("cancel_staff_loan", l.id)}
                          >
                            <Ban className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {(loans.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                      No loans recorded.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {canCreate && (
            <div className="grid gap-3 rounded-lg border p-3">
              <p className="text-xs font-medium text-muted-foreground">Record a new loan</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Principal</Label>
                  <MoneyInput value={principal} onChange={setPrincipal} />
                </div>
                <div>
                  <Label className="text-xs">Disbursed on</Label>
                  <Input
                    type="date"
                    value={disbursedOn}
                    onChange={(e) => setDisbursedOn(e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Repayment</Label>
                  <Select
                    value={repayType}
                    onValueChange={(v) => setRepayType(v as "one_time" | "installment")}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="one_time">One-time (next payday)</SelectItem>
                      <SelectItem value="installment">Installment</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {repayType === "installment" && (
                  <div>
                    <Label className="text-xs">Sized by</Label>
                    <Select
                      value={instMode}
                      onValueChange={(v) => setInstMode(v as "amount" | "months")}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="amount">Amount per month</SelectItem>
                        <SelectItem value="months">Number of months</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              {repayType === "installment" && (
                <div>
                  {instMode === "amount" ? (
                    <>
                      <Label className="text-xs">Deduct per month</Label>
                      <MoneyInput value={instAmount} onChange={setInstAmount} />
                    </>
                  ) : (
                    <>
                      <Label className="text-xs">Number of months</Label>
                      <MoneyInput
                        min={1}
                        value={instMonths}
                        onChange={setInstMonths}
                      />
                    </>
                  )}
                </div>
              )}
              <div>
                <Label className="text-xs">Reason / note</Label>
                <Input value={loanReason} onChange={(e) => setLoanReason(e.target.value)} />
              </div>
              <div className="flex justify-end">
                <Button size="sm" disabled={addLoan.isPending} onClick={() => addLoan.mutate()}>
                  {addLoan.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Record loan
                </Button>
              </div>
            </div>
          )}
        </section>

        {/* ---------------- Fines & contributions ---------------- */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Fines &amp; contributions</h3>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ref</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(deductions.data ?? []).map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-mono text-xs">{d.reference_number}</TableCell>
                    <TableCell className="capitalize">{d.kind}</TableCell>
                    <TableCell>{d.label}</TableCell>
                    <TableCell className="text-xs">
                      {DED_MONTHS[d.period_month - 1]} {d.period_year}
                    </TableCell>
                    <TableCell className="text-right">{money(Number(d.amount))}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          d.status === "rejected" || d.status === "void"
                            ? "destructive"
                            : d.status === "pending"
                              ? "outline"
                              : "secondary"
                        }
                        className="capitalize"
                      >
                        {d.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {d.status === "pending" && canApprove && d.submitted_by !== me.data && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Approve"
                            onClick={() => runDed("approve_staff_deduction", d.id)}
                          >
                            <Check className="h-4 w-4 text-success" />
                          </Button>
                        )}
                        {d.status === "pending" && canReject && d.submitted_by !== me.data && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Reject"
                            onClick={() => runDed("reject_staff_deduction", d.id)}
                          >
                            <X className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {(deductions.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                      Nothing recorded.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {canCreate && (
            <div className="grid gap-3 rounded-lg border p-3">
              <p className="text-xs font-medium text-muted-foreground">
                Record a fine or contribution
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Type</Label>
                  <Select
                    value={kind}
                    onValueChange={(v) => setKind(v as "fine" | "contribution" | "other")}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fine">Fine (rule violation)</SelectItem>
                      <SelectItem value="contribution">Contribution</SelectItem>
                      <SelectItem value="other">Other deduction</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Amount</Label>
                  <MoneyInput value={dedAmount} onChange={setDedAmount} />
                </div>
              </div>
              <div>
                <Label className="text-xs">Label</Label>
                <Input
                  value={dedLabel}
                  onChange={(e) => setDedLabel(e.target.value)}
                  placeholder="e.g. Late to work — March"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Applies to month</Label>
                  <Select value={String(pMonth)} onValueChange={(v) => setPMonth(Number(v))}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DED_MONTHS.map((m, i) => (
                        <SelectItem key={m} value={String(i + 1)}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Year</Label>
                  <MoneyInput
                    groupThousands={false}
                    value={pYear}
                    onChange={setPYear}
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs">Reason / note</Label>
                <Input value={dedReason} onChange={(e) => setDedReason(e.target.value)} />
              </div>
              <div className="flex justify-end">
                <Button size="sm" disabled={addDed.isPending} onClick={() => addDed.mutate()}>
                  {addDed.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Record
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>
    </DialogContent>
  );
}
