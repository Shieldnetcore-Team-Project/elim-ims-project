import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FileDown, Printer, Sheet } from "lucide-react";
import { money, num } from "@/lib/format";
import { exportCsv } from "@/lib/export";
import { generateCustomerStatementPdf, type PdfAction } from "@/lib/pdf";
import { logAudit } from "@/lib/audit";
import {
  STATEMENT_COLUMNS,
  buildStatement,
  periodLabel,
  salePaymentStatus,
  statementCsvRows,
  useCustomerAccount,
} from "@/lib/customer-account";
import {
  AccountLedgerTable,
  AccountStatusBadge,
  AccountSummaryCards,
  summariseItems,
} from "@/components/sales/account-ledger";
import { AccountAdjustmentsCard } from "@/components/customers/account-adjustments";

type CustomerSaleRow = {
  id: string;
  invoice_number: string;
  sale_date: string;
  created_at: string;
  status: string;
  is_pr: boolean;
  grand_total: number;
  amount_paid: number;
  credit_applied: number;
  balance: number;
  payment_method: string;
};
type CustomerItemRow = {
  sale_id: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  products: { name: string; unit: string } | null;
};
type CustomerPaymentRow = {
  id: string;
  receipt_number: string;
  payment_date: string;
  created_at: string;
  amount: number;
  payment_method: string;
  sale_id: string | null;
};

// A customer's whole account in one dialog: position cards, the ledger as a
// statement (optionally for a date range), products, invoices and payments —
// with print / PDF / CSV of that statement. Used from Sales and from Finance
// so both show identical figures.
export function CustomerAccountDialog({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const account = useCustomerAccount(customerId);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const customer = useQuery({
    queryKey: ["customer-contact", customerId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("name,phone,address")
        .eq("id", customerId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const invoices = useQuery({
    queryKey: ["customer-sales-full", customerId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select(
          "id,invoice_number,sale_date,created_at,status,is_pr,grand_total,amount_paid,credit_applied,balance,payment_method",
        )
        .eq("customer_id", customerId)
        .order("sale_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as CustomerSaleRow[];
    },
  });

  const saleIds = (invoices.data ?? []).map((s) => s.id);
  const items = useQuery({
    queryKey: ["customer-items-full", customerId, saleIds.join(",")],
    enabled: saleIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sale_items")
        .select("sale_id,quantity,unit_price,line_total,products(name,unit)")
        .in("sale_id", saleIds);
      if (error) throw error;
      return (data ?? []) as unknown as CustomerItemRow[];
    },
  });

  const payments = useQuery({
    queryKey: ["customer-payments-full", customerId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments_received")
        .select("id,receipt_number,payment_date,created_at,amount,payment_method,sale_id")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as CustomerPaymentRow[];
    },
  });

  const invoiceById = useMemo(
    () => new Map((invoices.data ?? []).map((s) => [s.id, s])),
    [invoices.data],
  );
  const lookups = useMemo(() => {
    const grouped = new Map<string, CustomerItemRow[]>();
    (items.data ?? []).forEach((it) =>
      grouped.set(it.sale_id, [...(grouped.get(it.sale_id) ?? []), it]),
    );
    const itemsBySale = new Map<string, string>();
    grouped.forEach((rows, saleId) => itemsBySale.set(saleId, summariseItems(rows)));
    return {
      invoiceById,
      paymentById: new Map((payments.data ?? []).map((p) => [p.id, p])),
      itemsBySale,
    };
  }, [invoiceById, payments.data, items.data]);

  const summary = account.data?.summary;
  const pendingSales = account.data?.pendingSales ?? [];
  const hasRange = !!from || !!to;
  const rangeInvalid = !!from && !!to && from > to;
  const statement = useMemo(
    () => buildStatement(account.data?.ledger ?? [], rangeInvalid ? {} : { from, to }, lookups),
    [account.data?.ledger, from, to, rangeInvalid, lookups],
  );
  // Sales awaiting approval belong to "now", so they only appear on an
  // unfiltered statement.
  const shownPending = hasRange ? [] : pendingSales;

  const exportStatement = async (kind: PdfAction | "csv") => {
    const name = customer.data?.name ?? customerName;
    if (kind === "csv") {
      exportCsv(
        `statement-${name.replace(/\s+/g, "-")}`,
        [...STATEMENT_COLUMNS],
        statementCsvRows(statement),
      );
    } else {
      await generateCustomerStatementPdf(
        {
          company: {
            name: settings.data?.company_name ?? "FMIS",
            address: settings.data?.address,
            phone: settings.data?.phone,
            logo_url: settings.data?.logo_url,
          },
          customer: { name, phone: customer.data?.phone, address: customer.data?.address },
          statement,
          periodLabel: periodLabel(statement.range),
          pendingSales: shownPending,
          currency: settings.data?.currency ?? "NGN",
        },
        kind,
      );
    }
    logAudit({
      action: kind === "print" ? "print" : "export",
      entity: "customer_statement",
      entityId: customerId,
      factoryId,
      newValue: { format: kind, period: periodLabel(statement.range) },
    });
  };

  return (
    <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-3">
          {customerName} — Account
          {summary && <AccountStatusBadge status={summary.account_status} />}
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        {summary && <AccountSummaryCards summary={summary} />}

        {summary && summary.available_advance > 0 && summary.outstanding_debt > 0 && (
          <p className="rounded-md bg-warning/15 px-3 py-2 text-xs text-warning">
            This customer has both an advance and a debt on record. They are shown separately and
            are not netted against each other.
          </p>
        )}
        {pendingSales.length > 0 && (
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {pendingSales.length} sale{pendingSales.length === 1 ? " is" : "s are"} awaiting
            approval ({money(pendingSales.reduce((s, p) => s + p.grand_total, 0))}). They are listed
            below but only change the balances once a manager approves them.
          </p>
        )}

        <Tabs defaultValue="ledger">
          <TabsList>
            <TabsTrigger value="ledger">Account Ledger</TabsTrigger>
            <TabsTrigger value="products">Products Purchased</TabsTrigger>
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
            <TabsTrigger value="payments">Payment History</TabsTrigger>
            <TabsTrigger value="adjustments">Adjustments</TabsTrigger>
          </TabsList>

          <TabsContent value="ledger" className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label className="text-xs">From</Label>
                <Input
                  type="date"
                  value={from}
                  max={to || undefined}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">To</Label>
                <Input
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>
              {hasRange && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFrom("");
                    setTo("");
                  }}
                >
                  All activity
                </Button>
              )}
              <div className="ml-auto flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={account.isLoading || rangeInvalid}
                  onClick={() => exportStatement("print")}
                >
                  <Printer className="h-4 w-4" /> Print statement
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={account.isLoading || rangeInvalid}
                  onClick={() => exportStatement("download")}
                >
                  <FileDown className="h-4 w-4" /> PDF
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={account.isLoading || rangeInvalid}
                  onClick={() => exportStatement("csv")}
                >
                  <Sheet className="h-4 w-4" /> CSV
                </Button>
              </div>
            </div>
            {rangeInvalid && (
              <p className="text-xs text-destructive">“From” must be on or before “To”.</p>
            )}

            {account.isLoading ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Loading account…</p>
            ) : (
              <>
                <AccountLedgerTable
                  ledger={statement.ledger}
                  pendingSales={shownPending}
                  lookups={lookups}
                  broughtForward={from && !rangeInvalid ? statement.opening : undefined}
                />
                <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/30 p-3 text-sm sm:grid-cols-4">
                  <div>
                    <span className="block text-xs text-muted-foreground">
                      {hasRange ? "Advance received" : "Total advance received"}
                    </span>
                    <span className="font-medium">{money(statement.totals.advanceReceived)}</span>
                  </div>
                  <div>
                    <span className="block text-xs text-muted-foreground">Goods collected</span>
                    <span className="font-medium">{money(statement.totals.goodsCollected)}</span>
                  </div>
                  <div>
                    <span className="block text-xs text-muted-foreground">Closing advance</span>
                    <span
                      className={`font-semibold ${statement.closing.credit > 0 ? "text-success" : ""}`}
                    >
                      {money(statement.closing.credit)}
                    </span>
                  </div>
                  <div>
                    <span className="block text-xs text-muted-foreground">Closing debt</span>
                    <span
                      className={`font-semibold ${statement.closing.debt > 0 ? "text-destructive" : ""}`}
                    >
                      {money(statement.closing.debt)}
                    </span>
                  </div>
                </div>
              </>
            )}
            <p className="text-xs text-muted-foreground">
              Every advance, sale, payment and reversal is recorded as its own line and never
              edited; a correction is a new line.
            </p>
          </TabsContent>

          <TabsContent value="products">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit Price</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(items.data ?? []).map((it, idx) => {
                  const inv = invoiceById.get(it.sale_id);
                  return (
                    <TableRow key={`${it.sale_id}-${idx}`}>
                      <TableCell className="font-mono text-xs">
                        {inv?.invoice_number ?? "—"}
                      </TableCell>
                      <TableCell>{inv?.sale_date ?? "—"}</TableCell>
                      <TableCell>
                        {it.products?.name ?? "—"}
                        {it.products?.unit ? ` (${it.products.unit})` : ""}
                      </TableCell>
                      <TableCell className="text-right">{num(Number(it.quantity))}</TableCell>
                      <TableCell className="text-right">{money(Number(it.unit_price))}</TableCell>
                      <TableCell className="text-right">{money(Number(it.line_total))}</TableCell>
                      <TableCell className="capitalize text-xs text-muted-foreground">
                        {inv ? inv.status.replace(/_/g, " ") : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {(items.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                      No products purchased yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TabsContent>

          <TabsContent value="invoices">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Advance used</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Payment status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(invoices.data ?? []).map((inv) => {
                  const st = salePaymentStatus(inv);
                  return (
                    <TableRow key={inv.id}>
                      <TableCell className="font-mono text-xs">{inv.invoice_number}</TableCell>
                      <TableCell>{inv.sale_date}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">
                          {inv.payment_method}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{money(Number(inv.grand_total))}</TableCell>
                      <TableCell className="text-right">{money(Number(inv.amount_paid))}</TableCell>
                      <TableCell className="text-right">
                        {Number(inv.credit_applied) > 0 ? money(Number(inv.credit_applied)) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {inv.status === "posted" && Number(inv.balance) > 0 ? (
                          <Badge variant="destructive">{money(Number(inv.balance))}</Badge>
                        ) : (
                          money(inv.status === "posted" ? Number(inv.balance) : 0)
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={st.variant} className="capitalize">
                          {st.label}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {(invoices.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                      No purchases yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TabsContent>

          <TabsContent value="payments">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Receipt</TableHead>
                  <TableHead>Date & Time</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(payments.data ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">{p.receipt_number}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {new Date(p.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {p.payment_method}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{money(Number(p.amount))}</TableCell>
                  </TableRow>
                ))}
                {(payments.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                      No payments yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TabsContent>
          <TabsContent value="adjustments">
            {factoryId && (
              <AccountAdjustmentsCard
                factoryId={factoryId}
                customerId={customerId}
                title="Adjustments for this customer"
              />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </DialogContent>
  );
}
