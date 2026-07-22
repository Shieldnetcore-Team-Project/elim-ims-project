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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Plus, FileDown } from "lucide-react";
import { money } from "@/lib/format";
import { toast } from "sonner";
import { generateReceiptPdf } from "@/lib/pdf";

export const Route = createFileRoute("/_app/payments")({
  head: () => ({ meta: [{ title: "Payments Received — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: PaymentsPage,
});

type PaymentMethod = "cash" | "transfer" | "pos" | "card" | "cheque" | "credit";
type Customer = { id: string; name: string };

function PaymentsPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const list = useQuery({
    queryKey: ["payments", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments_received")
        .select("id,receipt_number,payment_date,amount,payment_method,remarks,customers(name)")
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return data ?? [];
    },
  });

  const customers = useQuery({
    queryKey: ["customers-brief-p", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase.from("customers").select("id,name").eq("factory_id", factoryId!).order("name");
      if (error) throw error;
      return (data ?? []) as Customer[];
    },
  });

  const create = useMutation({
    mutationFn: async (input: { customer_id: string | null; amount: number; method: PaymentMethod; remarks: string; date: string; customer_name: string }) => {
      const { data, error } = await supabase.rpc("record_payment", {
        payload: {
          factory_id: factoryId, customer_id: input.customer_id,
          amount: input.amount, payment_method: input.method, remarks: input.remarks, payment_date: input.date,
        } as any,
      });
      if (error) throw error;
      return { res: data as any, input };
    },
    onSuccess: ({ res, input }) => {
      toast.success(`Receipt ${res.receipt_number}`);
      generateReceiptPdf({
        company: { name: settings.data?.company_name ?? "FMIS", address: settings.data?.address, phone: settings.data?.phone },
        receipt_number: res.receipt_number, payment_date: input.date,
        customer_name: input.customer_name, amount: input.amount,
        payment_method: input.method, remarks: input.remarks,
        currency: settings.data?.currency ?? "NGN",
      });
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reprint = (r: any) => {
    generateReceiptPdf({
      company: { name: settings.data?.company_name ?? "FMIS", address: settings.data?.address, phone: settings.data?.phone },
      receipt_number: r.receipt_number, payment_date: r.payment_date,
      customer_name: r.customers?.name, amount: Number(r.amount),
      payment_method: r.payment_method, remarks: r.remarks,
      currency: settings.data?.currency ?? "NGN",
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Payments Received</h1>
          <p className="text-sm text-muted-foreground">Receipts and cash-collection tracking.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="h-4 w-4" /> Record Payment</Button>
          </DialogTrigger>
          {open && (
            <NewPaymentDialog
              customers={customers.data ?? []}
              saving={create.isPending}
              onSubmit={(v) => create.mutate(v)}
            />
          )}
        </Dialog>
      </div>

      <Card className="rounded-2xl">
        <CardHeader><CardTitle>Receipts</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Receipt</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Method</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.receipt_number}</TableCell>
                  <TableCell>{r.payment_date}</TableCell>
                  <TableCell>{r.customers?.name ?? "—"}</TableCell>
                  <TableCell><Badge variant="outline" className="capitalize">{r.payment_method}</Badge></TableCell>
                  <TableCell className="text-right">{money(Number(r.amount))}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" className="gap-2" onClick={() => reprint(r)}>
                      <FileDown className="h-4 w-4" /> PDF
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(list.data ?? []).length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No payments yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function NewPaymentDialog({ customers, onSubmit, saving }: {
  customers: Customer[];
  onSubmit: (v: { customer_id: string | null; amount: number; method: PaymentMethod; remarks: string; date: string; customer_name: string }) => void;
  saving: boolean;
}) {
  const [customerId, setCustomerId] = useState<string>("none");
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [remarks, setRemarks] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Record Payment</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Customer</Label>
          <Select value={customerId} onValueChange={setCustomerId}>
            <SelectTrigger><SelectValue placeholder="Select customer…" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— None —</SelectItem>
              {customers.map((c) => (<SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div><Label>Amount</Label><Input type="number" min={0.01} step="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></div>
        </div>
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
        <Button
          disabled={saving || amount <= 0}
          onClick={() => onSubmit({
            customer_id: customerId === "none" ? null : customerId,
            customer_name: customers.find((c) => c.id === customerId)?.name ?? "",
            amount, method, remarks, date,
          })}
        >
          {saving ? "Saving…" : "Record & Print Receipt"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
