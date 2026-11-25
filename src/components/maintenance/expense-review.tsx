import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Printer, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { generateMaintenanceExpenseReceiptPdf } from "@/lib/distributor-invoice";
import { logAudit } from "@/lib/audit";
import { money } from "@/lib/format";
import { useMyRoles } from "@/lib/permissions";
import { useFactorySettings } from "@/lib/use-factory";
import { useCurrentUserName } from "@/lib/use-current-user";
import { db } from "./shared";

type ReviewExpense = {
  id: string;
  expense_number: string;
  expense_date: string;
  category: string;
  description: string | null;
  amount: number;
  paid_to: string | null;
  payment_method: string | null;
  receipt_ref: string | null;
  recorded_by: string | null;
  recorded_by_name: string | null;
  approval_status: "pending_review" | "approved" | "rejected";
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  tire_type: string | null;
  tire_size: string | null;
  vehicles: { plate_number: string } | null;
};

type Decision = "approve" | "reject";

const fmtDate = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString();

export function MaintenanceExpenseReviewTab({
  factoryId,
  canReview,
}: {
  factoryId: string | null | undefined;
  canReview: boolean;
}) {
  const qc = useQueryClient();
  const isAdmin = (useMyRoles().data ?? []).includes("super_admin");
  const settings = useFactorySettings(factoryId ?? undefined);
  const printedBy = useCurrentUserName();
  const [status, setStatus] = useState("pending_review");
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<ReviewExpense | null>(null);
  const [decision, setDecision] = useState<Decision>("approve");
  const [note, setNote] = useState("");

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => {
      const { data, error } = await supabase.auth.getUser();
      if (error) throw error;
      return data.user?.id ?? null;
    },
    staleTime: Infinity,
  });

  const expenses = useQuery({
    queryKey: ["acct-maintenance-expenses", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await db
        .from("maintenance_expenses")
        .select(
          "id,expense_number,expense_date,category,description,amount,paid_to,payment_method,receipt_ref,recorded_by,recorded_by_name,approval_status,reviewed_by_name,reviewed_at,review_note,tire_type,tire_size,vehicles(plate_number)",
        )
        .eq("factory_id", factoryId)
        .order("expense_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ReviewExpense[];
    },
  });

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (expenses.data ?? []).filter((expense) => {
      const matchesStatus = status === "all" || expense.approval_status === status;
      const haystack = [
        expense.expense_number,
        expense.category,
        expense.description,
        expense.paid_to,
        expense.recorded_by_name,
        expense.vehicles?.plate_number,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return matchesStatus && (!needle || haystack.includes(needle));
    });
  }, [expenses.data, search, status]);

  const review = useMutation({
    mutationFn: async ({
      expense,
      outcome,
      reviewNote,
    }: {
      expense: ReviewExpense;
      outcome: Decision;
      reviewNote: string;
    }) => {
      const { data, error } = await db.rpc("decide_maintenance_expense", {
        p_id: expense.id,
        p_approve: outcome === "approve",
        p_note: reviewNote || null,
      });
      if (error) throw error;
      return { expense, outcome, reviewNote, data };
    },
    onSuccess: ({ expense, outcome, reviewNote }) => {
      toast.success(
        outcome === "approve" ? "Maintenance expense approved" : "Maintenance expense rejected",
      );
      logAudit({
        action: outcome === "approve" ? "approve" : "reject",
        entity: "maintenance_expenses",
        entityId: expense.id,
        factoryId,
        oldValue: { approval_status: expense.approval_status },
        newValue: {
          approval_status: outcome === "approve" ? "approved" : "rejected",
          review_note: reviewNote || null,
        },
      });
      qc.invalidateQueries({ queryKey: ["acct-maintenance-expenses", factoryId] });
      qc.invalidateQueries({ queryKey: ["maintenance-expenses", factoryId] });
      setTarget(null);
      setNote("");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const printExpense = (expense: ReviewExpense) => {
    const description = [
      expense.description,
      expense.vehicles?.plate_number && `Vehicle ${expense.vehicles.plate_number}`,
      expense.tire_type && `Tire type: ${expense.tire_type}`,
      expense.tire_size && `Tire size: ${expense.tire_size}`,
    ]
      .filter(Boolean)
      .join(" — ");
    void generateMaintenanceExpenseReceiptPdf(
      {
        company: {
          name: settings.data?.company_name ?? "Elim Table Water",
          address: settings.data?.address,
          phone: settings.data?.phone,
          email: settings.data?.email,
          website: settings.data?.website,
          logo_url: settings.data?.logo_url,
        },
        expense_number: expense.expense_number,
        expense_date: expense.expense_date,
        category: expense.category,
        description,
        paid_to: expense.paid_to,
        payment_method: expense.payment_method ?? "—",
        amount: Number(expense.amount),
        receipt_ref: expense.receipt_ref,
        recorded_by: expense.recorded_by_name,
        approval_status: expense.approval_status,
        reviewer: expense.reviewed_by_name,
        reviewed_at: expense.reviewed_at,
        review_note: expense.review_note,
        printed_by: printedBy.data,
      },
      "print",
    ).catch((error: Error) => toast.error(error.message));
  };

  const beginDecision = (expense: ReviewExpense, outcome: Decision) => {
    setTarget(expense);
    setDecision(outcome);
    setNote("");
  };

  const canDecide = (expense: ReviewExpense) =>
    canReview &&
    expense.approval_status === "pending_review" &&
    !currentUser.isLoading &&
    !currentUser.isError &&
    (isAdmin || expense.recorded_by !== currentUser.data);

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Maintenance expense review</CardTitle>
            <p className="text-sm text-muted-foreground">
              All maintenance expenses, with approval decisions and print-ready review slips.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending_review">Pending review</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value="all">All statuses</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="absolute top-2.5 left-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="w-56 pl-8"
                placeholder="Search expenses…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {currentUser.isError && (
            <p className="mb-3 text-sm text-destructive">
              Could not verify your account, so approval actions are disabled.
            </p>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Expense #</TableHead>
                <TableHead>Category / description</TableHead>
                <TableHead>Paid to</TableHead>
                <TableHead>Recorded by</TableHead>
                <TableHead>Status / reviewed by</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((expense) => (
                <TableRow key={expense.id}>
                  <TableCell className="whitespace-nowrap">
                    {fmtDate(expense.expense_date)}
                  </TableCell>
                  <TableCell className="font-medium whitespace-nowrap">
                    {expense.expense_number}
                  </TableCell>
                  <TableCell>
                    <div>{expense.category}</div>
                    {expense.description && (
                      <div className="text-xs text-muted-foreground">{expense.description}</div>
                    )}
                    {expense.vehicles && (
                      <div className="text-xs text-muted-foreground">
                        Vehicle {expense.vehicles.plate_number}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{expense.paid_to ?? "—"}</TableCell>
                  <TableCell>{expense.recorded_by_name ?? "—"}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        expense.approval_status === "approved"
                          ? "default"
                          : expense.approval_status === "rejected"
                            ? "destructive"
                            : "outline"
                      }
                      className="capitalize"
                    >
                      {expense.approval_status.replace("_", " ")}
                    </Badge>
                    {expense.reviewed_by_name && (
                      <div className="text-xs text-muted-foreground">
                        {expense.reviewed_by_name}
                        {expense.reviewed_at &&
                          ` · ${new Date(expense.reviewed_at).toLocaleDateString()}`}
                      </div>
                    )}
                    {expense.review_note && (
                      <div className="max-w-56 text-xs text-muted-foreground">
                        {expense.review_note}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {money(expense.amount)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    <div className="flex justify-end gap-1">
                      {canDecide(expense) && (
                        <>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Approve"
                            onClick={() => beginDecision(expense, "approve")}
                          >
                            <Check className="h-4 w-4 text-success" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Reject"
                            onClick={() => beginDecision(expense, "reject")}
                          >
                            <X className="h-4 w-4 text-destructive" />
                          </Button>
                        </>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Print expense approval"
                        onClick={() => printExpense(expense)}
                      >
                        <Printer className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                    {expenses.isLoading
                      ? "Loading maintenance expenses…"
                      : expenses.isError
                        ? "Could not load maintenance expenses."
                        : "No maintenance expenses match this filter."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={!!target}
        onOpenChange={(open) => {
          if (!open) {
            setTarget(null);
            setNote("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {decision === "approve" ? "Approve expense?" : "Reject expense?"}
            </DialogTitle>
          </DialogHeader>
          {target && (
            <div className="space-y-3">
              <p className="text-sm">
                {target.expense_number} · {target.category} · {money(target.amount)}
              </p>
              {target.description && (
                <p className="text-sm text-muted-foreground">{target.description}</p>
              )}
              <div className="space-y-1">
                <Label htmlFor="maintenance-expense-review-note">
                  Review note{decision === "reject" ? " (required)" : " (optional)"}
                </Label>
                <Textarea
                  id="maintenance-expense-review-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={3}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button
              variant={decision === "reject" ? "destructive" : "default"}
              disabled={review.isPending || !target || (decision === "reject" && !note.trim())}
              onClick={() =>
                target &&
                review.mutate({
                  expense: target,
                  outcome: decision,
                  reviewNote: note.trim(),
                })
              }
            >
              {review.isPending
                ? "Saving…"
                : decision === "approve"
                  ? "Approve expense"
                  : "Reject expense"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
