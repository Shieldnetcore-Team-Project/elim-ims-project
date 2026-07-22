import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { money } from "@/lib/format";
import { toast } from "sonner";
import { HandCoins } from "lucide-react";
import { generateReceiptPdf } from "@/lib/pdf";

export const Route = createFileRoute("/_app/debts")({
  head: () => ({ meta: [{ title: "Debt Management — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: DebtsPage,
});

type PaymentMethod = "cash" | "transfer" | "pos" | "card" | "cheque" | "credit";
type Debt = {
  id: string; total_amount: number; amount_paid: number; outstanding: number;
  status: "paid" | "partial" | "unpaid"; customer_id: string | null; sale_id: string | null;
  created_at: string;
  customers: { name: string } | null;
  sales: { invoice_number: string } | null;
};

function DebtsPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const qc = useQueryClient();
  const [target, setTarget] = useState<Debt | null>(null);

  const list = useQuery({
    queryKey: ["debts", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("debts")
        .select("id,total_amount,amount_paid,outstanding,status,customer_id,sale_id,created_at,customers(name),sales(invoice_number)")
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Debt[];
    },
  });

  const pay = useMutation({
    mutationFn: async (input: { debt: Debt; amount: number; method: PaymentMethod; remarks: string }) => {
      const { data, error } = await supabase.rpc("record_payment", {
        payload: {
          factory_id: factoryId, customer_id: input.debt.customer_id,
          debt_id: input.debt.id, sale_id: input.debt.sale_id,
          amount: input.amount, payment_method: input.method, remarks: input.remarks,
        } as any,
      });
      if (error) throw error;
      return { res: data as any, input };
    },
    onSuccess: ({ res, input }) => {
      toast.success(`Receipt ${res.receipt_number}`);
      generateReceiptPdf({
        company: { name: settings.data?.company_name ?? "FMIS", address: settings.data?.address, phone: settings.data?.phone },
        receipt_number: res.receipt_number, payment_date: new Date().toISOString().slice(0, 10),
        customer_name: input.debt.customers?.name, amount: input.amount,
        payment_method: input.method, remarks: input.remarks,
        currency: settings.data?.currency ?? "NGN",
      });
      qc.invalidateQueries({ queryKey: ["debts"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      setTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Debt Management</h1>
        <p className="text-sm text-muted-foreground">Track outstanding debts and record repayments.</p>
      </div>

      <Card className="rounded-2xl">
        <CardHeader><CardTitle>Debts</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{new Date(d.created_at).toLocaleDateString()}</TableCell>
                  <TableCell>{d.customers?.name ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{d.sales?.invoice_number ?? "—"}</TableCell>
                  <TableCell>
                    <Badge className="capitalize" variant={d.status === "paid" ? "secondary" : d.status === "partial" ? "outline" : "destructive"}>
                      {d.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{money(Number(d.total_amount))}</TableCell>
                  <TableCell className="text-right">{money(Number(d.amount_paid))}</TableCell>
                  <TableCell className="text-right font-medium">{money(Number(d.outstanding))}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" className="gap-2" disabled={d.status === "paid"} onClick={() => setTarget(d)}>
                      <HandCoins className="h-4 w-4" /> Pay
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(list.data ?? []).length === 0 && (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No debts.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!target} onOpenChange={(v) => !v && setTarget(null)}>
        {target && (
          <PayDialog
            debt={target}
            onSubmit={(amount, method, remarks) => pay.mutate({ debt: target, amount, method, remarks })}
            saving={pay.isPending}
          />
        )}
      </Dialog>
    </div>
  );
}

function PayDialog({ debt, onSubmit, saving }: {
  debt: Debt; onSubmit: (amount: number, method: PaymentMethod, remarks: string) => void; saving: boolean;
}) {
  const [amount, setAmount] = useState(Number(debt.outstanding));
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [remarks, setRemarks] = useState("");
  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Record Payment</DialogTitle></DialogHeader>
      <div className="space-y-3">
        <div className="rounded-md bg-muted/30 p-3 text-sm">
          <div className="flex justify-between"><span>Customer</span><span>{debt.customers?.name ?? "—"}</span></div>
          <div className="flex justify-between"><span>Invoice</span><span className="font-mono">{debt.sales?.invoice_number ?? "—"}</span></div>
          <div className="flex justify-between"><span>Outstanding</span><span className="font-medium">{money(Number(debt.outstanding))}</span></div>
        </div>
        <div><Label>Amount</Label><Input type="number" min={0.01} step="0.01" max={Number(debt.outstanding)} value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></div>
        <div>
          <Label>Method</Label>
          <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {(["cash","transfer","pos","card","cheque"] as PaymentMethod[]).map((m) => (
                <SelectItem key={m} value={m} className="capitalize">{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div><Label>Remarks</Label><Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
      </div>
      <DialogFooter>
        <Button disabled={saving || amount <= 0 || amount > Number(debt.outstanding)} onClick={() => onSubmit(amount, method, remarks)}>
          {saving ? "Saving…" : "Record & Print Receipt"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
