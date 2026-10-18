import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { money } from "@/lib/format";
import { exportCsv } from "@/lib/export";
import { useFactorySettings } from "@/lib/use-factory";
import { printSaleInvoice } from "@/lib/invoice";
import { generateReceiptPdf } from "@/lib/pdf";
import { CustomerPaymentDialog } from "./customer-payment-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronDown, ChevronRight, FileDown, HandCoins, Printer, Search } from "lucide-react";

type DistributorAccount = {
  customer_id: string;
  name: string;
  phone: string | null;
  marketer: string | null;
  invoices: number;
  invoiced: number;
  paid: number;
  outstanding: number;
  advance: number;
  last_sale: string | null;
};

type Paying = {
  id: string;
  name: string;
  owed: number;
  sale?: { id: string; invoice_number: string };
};

// Distributors' records for Accounting: every registered customer the
// Warehouse posts to, with what they've been invoiced, paid and still owe
// (distributor_accounts). Open one to see their invoices and payments and to
// enter a payment.
export function DistributorsTab({ factoryId, currency }: { factoryId: string; currency: string }) {
  const perms = usePermissions();
  const canPay = perms.canWrite("payments") || perms.canWrite("debts");
  const [q, setQ] = useState("");
  const [owingOnly, setOwingOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [paying, setPaying] = useState<Paying | null>(null);

  useRealtimeInvalidate(
    ["sales", "payments_received", "customers"],
    [["acct-distributors"], ["acct-distributor-invoices"], ["acct-distributor-payments"]],
  );

  const accounts = useQuery({
    queryKey: ["acct-distributors", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "distributor_accounts" as never,
        { p_factory: factoryId } as never,
      );
      if (error) throw error;
      return (data ?? []) as unknown as DistributorAccount[];
    },
  });

  const all = useMemo(() => accounts.data ?? [], [accounts.data]);
  const shown = useMemo(() => {
    const key = q.trim().toLowerCase();
    return all.filter(
      (a) =>
        (!owingOnly || Number(a.outstanding) > 0) &&
        (!key ||
          a.name.toLowerCase().includes(key) ||
          (a.phone ?? "").includes(key) ||
          (a.marketer ?? "").toLowerCase().includes(key)),
    );
  }, [all, q, owingOnly]);
  const totals = all.reduce(
    (t, a) => ({
      invoiced: t.invoiced + Number(a.invoiced),
      paid: t.paid + Number(a.paid),
      outstanding: t.outstanding + Number(a.outstanding),
      owing: t.owing + (Number(a.outstanding) > 0 ? 1 : 0),
    }),
    { invoiced: 0, paid: 0, outstanding: 0, owing: 0 },
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Distributors" value={`${all.length} · ${totals.owing} owing`} />
        <Stat label="Invoiced" value={money(totals.invoiced, currency)} />
        <Stat label="Paid" value={money(totals.paid, currency)} />
        <Stat
          label="Outstanding"
          value={money(totals.outstanding, currency)}
          warn={totals.outstanding > 0}
        />
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Distributor accounts</CardTitle>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={owingOnly} onCheckedChange={(v) => setOwingOnly(v === true)} />
              Owing only
            </label>
            <div className="relative w-full sm:w-56">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Name, phone, marketer…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() =>
                exportCsv(
                  "distributor-accounts",
                  [
                    { key: "name", label: "Distributor" },
                    { key: "phone", label: "Phone" },
                    { key: "marketer", label: "Marketer" },
                    { key: "invoices", label: "Invoices" },
                    { key: "invoiced", label: "Invoiced" },
                    { key: "paid", label: "Paid" },
                    { key: "outstanding", label: "Outstanding" },
                    { key: "advance", label: "Advance" },
                    { key: "last_sale", label: "Last sale" },
                  ],
                  shown,
                )
              }
            >
              <FileDown className="h-4 w-4" /> CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead>Distributor</TableHead>
                <TableHead>Marketer</TableHead>
                <TableHead className="text-right">Invoices</TableHead>
                <TableHead className="text-right">Invoiced</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead className="text-right">Advance</TableHead>
                <TableHead>Last sale</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((a) => {
                const isOpen = open === a.customer_id;
                return (
                  <Fragment key={a.customer_id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => setOpen(isOpen ? null : a.customer_id)}
                    >
                      <TableCell>
                        {isOpen ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{a.name}</div>
                        {a.phone && <div className="text-xs text-muted-foreground">{a.phone}</div>}
                      </TableCell>
                      <TableCell>{a.marketer ?? "—"}</TableCell>
                      <TableCell className="text-right">{a.invoices}</TableCell>
                      <TableCell className="text-right">
                        {money(Number(a.invoiced), currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        {money(Number(a.paid), currency)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-medium ${Number(a.outstanding) > 0 ? "text-amber-600" : ""}`}
                      >
                        {money(Number(a.outstanding), currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        {Number(a.advance) > 0 ? money(Number(a.advance), currency) : "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {a.last_sale ? new Date(a.last_sale).toLocaleDateString() : "—"}
                      </TableCell>
                      <TableCell>
                        {canPay && (
                          <Button
                            size="sm"
                            className="gap-1"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPaying({
                                id: a.customer_id,
                                name: a.name,
                                owed: Number(a.outstanding),
                              });
                            }}
                          >
                            <HandCoins className="h-4 w-4" /> Payment
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow>
                        <TableCell colSpan={10} className="bg-muted/30">
                          <DistributorRecord
                            factoryId={factoryId}
                            customerId={a.customer_id}
                            customerName={a.name}
                            currency={currency}
                            canPay={canPay}
                            owed={Number(a.outstanding)}
                            onPay={() =>
                              setPaying({
                                id: a.customer_id,
                                name: a.name,
                                owed: Number(a.outstanding),
                              })
                            }
                            onPayInvoice={(sale, owed) =>
                              setPaying({ id: a.customer_id, name: a.name, owed, sale })
                            }
                          />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
              {shown.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                    {accounts.isLoading
                      ? "Loading…"
                      : accounts.isError
                        ? "Distributor accounts aren't available yet."
                        : owingOnly
                          ? "No distributor owes anything."
                          : "No distributors yet."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!paying} onOpenChange={(v) => !v && setPaying(null)}>
        {paying && (
          <CustomerPaymentDialog
            factoryId={factoryId}
            customerId={paying.id}
            customerName={paying.name}
            owed={paying.owed}
            sale={paying.sale}
            onDone={() => setPaying(null)}
          />
        )}
      </Dialog>
    </div>
  );
}

type Invoice = {
  id: string;
  invoice_number: string;
  sale_date: string;
  grand_total: number;
  amount_paid: number;
  balance: number;
  status: string;
};
type Receipt = {
  id: string;
  receipt_number: string;
  payment_date: string;
  amount: number;
  payment_method: string;
  status: string;
  remarks: string | null;
  sales: { invoice_number: string } | null;
};

// One distributor's invoices and payments.
function DistributorRecord({
  factoryId,
  customerId,
  customerName,
  currency,
  canPay,
  owed,
  onPay,
  onPayInvoice,
}: {
  factoryId: string;
  customerId: string;
  customerName: string;
  currency: string;
  canPay: boolean;
  owed: number;
  // A payment on the account as a whole: for goods collected earlier and
  // paid for later. Settles the oldest unpaid invoices first; anything over
  // what is owed is kept as the distributor's advance.
  onPay: () => void;
  onPayInvoice: (sale: { id: string; invoice_number: string }, owed: number) => void;
}) {
  const invoices = useQuery({
    queryKey: ["acct-distributor-invoices", customerId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("id,invoice_number,sale_date,grand_total,amount_paid,balance,status")
        .eq("factory_id", factoryId)
        .eq("customer_id", customerId)
        .is("deleted_at", null)
        .order("sale_date", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as Invoice[];
    },
  });
  const receipts = useQuery({
    queryKey: ["acct-distributor-payments", customerId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments_received")
        .select(
          "id,receipt_number,payment_date,amount,payment_method,status,remarks,sales(invoice_number)",
        )
        .eq("factory_id", factoryId)
        .eq("customer_id", customerId)
        .order("payment_date", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as Receipt[];
    },
  });

  // Print a voucher for one transaction, to hand to the distributor there and
  // then: the invoice for goods taken, the receipt for a payment.
  const settings = useFactorySettings(factoryId);
  const printReceipt = (r: Receipt) =>
    generateReceiptPdf(
      {
        company: {
          name: settings.data?.company_name ?? "Elim Table Water",
          address: settings.data?.address,
          phone: settings.data?.phone,
          logo_url: settings.data?.logo_url,
        },
        receipt_number: r.receipt_number,
        payment_date: r.payment_date,
        customer_name: customerName,
        invoice_number: r.sales?.invoice_number,
        amount: Number(r.amount),
        payment_method: r.payment_method,
        remarks: r.remarks,
        currency,
      },
      "print",
    );

  return (
    <div className="space-y-3 py-2">
      {canPay && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background p-3">
          <div className="text-sm">
            {owed > 0 ? (
              <>
                Owes <span className="font-semibold text-amber-600">{money(owed, currency)}</span>.
                A payment settles the oldest unpaid invoices first.
              </>
            ) : (
              "Nothing owed. A payment now is kept as the distributor's advance."
            )}
          </div>
          <Button size="sm" className="gap-1" onClick={onPay}>
            <HandCoins className="h-4 w-4" /> Add payment
          </Button>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-sm font-medium">Invoices</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(invoices.data ?? []).map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-xs">{s.invoice_number}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(s.sale_date).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {money(Number(s.grand_total), currency)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {money(Number(s.balance), currency)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {s.status.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1"
                        title="Print this invoice for the distributor"
                        onClick={() => printSaleInvoice(s.id, settings.data, "print")}
                      >
                        <Printer className="h-4 w-4" /> Print
                      </Button>
                      {canPay && s.status === "posted" && Number(s.balance) > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            onPayInvoice(
                              { id: s.id, invoice_number: s.invoice_number },
                              Number(s.balance),
                            )
                          }
                        >
                          Pay
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(invoices.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-4 text-center text-sm text-muted-foreground">
                    {invoices.isLoading ? "Loading…" : "No invoices yet."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium">Payments</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Receipt #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Method</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(receipts.data ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono text-xs">{p.receipt_number}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(p.payment_date).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {p.sales?.invoice_number ?? "—"}
                  </TableCell>
                  <TableCell className="capitalize">
                    {p.payment_method.replace(/_/g, " ")}
                  </TableCell>
                  <TableCell className="text-right">{money(Number(p.amount), currency)}</TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1"
                      title="Print this receipt for the distributor"
                      onClick={() => printReceipt(p)}
                    >
                      <Printer className="h-4 w-4" /> Print
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(receipts.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-4 text-center text-sm text-muted-foreground">
                    {receipts.isLoading ? "Loading…" : "No payments yet."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="pt-6">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-xl font-semibold ${warn ? "text-amber-600" : ""}`}>{value}</div>
      </CardContent>
    </Card>
  );
}
