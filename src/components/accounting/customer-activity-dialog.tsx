import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { money } from "@/lib/format";
import { printSaleInvoice } from "@/lib/invoice";
import { printMonthlySales } from "@/lib/monthly-sales-pdf";
import type { Database } from "@/integrations/supabase/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FileText, Printer } from "lucide-react";

type Settings = Database["public"]["Tables"]["settings"]["Row"] | null | undefined;

type Sale = {
  id: string;
  invoice_number: string;
  sale_date: string;
  created_at: string | null;
  customer_id: string | null;
  grand_total: number;
  amount_paid: number;
  balance: number;
  status: string;
  is_pr: boolean;
  sale_items:
    | {
        quantity: number;
        unit_price: number;
        products: { name: string; unit: string } | null;
      }[]
    | null;
};

type Payment = {
  id: string;
  receipt_number: string;
  payment_date: string;
  amount: number;
  payment_method: string;
  status: string;
  sales: { invoice_number: string } | null;
};

// The Accountant's view of one customer: every supply (invoice) with the
// products and prices on it, and every payment against them. Opens on the
// day the row was for; "All history" widens it to everything on record.
// Walk-ins have no name to follow, so they show only the row's own invoices.
export function CustomerActivityDialog({
  open,
  onOpenChange,
  factoryId,
  customer,
  date,
  saleIds,
  currency,
  settings,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  factoryId: string;
  customer: string | null;
  date: string;
  saleIds: string[];
  currency: string;
  settings: Settings;
}) {
  const [range, setRange] = useState<"day" | "all">("day");
  const day = date.slice(0, 10);

  const sales = useQuery({
    queryKey: ["acct-customer-sales", factoryId, customer, saleIds],
    enabled: open,
    queryFn: async () => {
      let q = supabase
        .from("sales")
        .select(
          "id,invoice_number,sale_date,created_at,customer_id,grand_total,amount_paid,balance,status,is_pr,sale_items(quantity,unit_price,products(name,unit))",
        )
        .eq("factory_id", factoryId)
        .is("deleted_at", null);
      q = customer
        ? q.ilike(
            "customer_name",
            customer.replace(/[\\%_]/g, (c) => `\\${c}`),
          )
        : q.in("id", saleIds);
      const { data, error } = await q.order("created_at", { ascending: false }).limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as Sale[];
    },
  });

  const allSales = sales.data ?? [];
  const customerIds = [...new Set(allSales.map((s) => s.customer_id).filter(Boolean))];
  const payments = useQuery({
    queryKey: ["acct-customer-payments", factoryId, customerIds, allSales.map((s) => s.id)],
    enabled: open && allSales.length > 0,
    queryFn: async () => {
      const filters = [
        customerIds.length && `customer_id.in.(${customerIds.join(",")})`,
        `sale_id.in.(${allSales.map((s) => s.id).join(",")})`,
      ].filter(Boolean);
      const { data, error } = await supabase
        .from("payments_received")
        .select("id,receipt_number,payment_date,amount,payment_method,status,sales(invoice_number)")
        .eq("factory_id", factoryId)
        .or(filters.join(","))
        .order("payment_date", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as Payment[];
    },
  });

  const inRange = (d: string) => range === "all" || d.slice(0, 10) === day;
  const shownSales = allSales.filter((s) => inRange(s.sale_date));
  const shownPayments = (payments.data ?? []).filter((p) => inRange(p.payment_date));
  const live = shownSales.filter((s) => !["cancelled", "void", "reversed"].includes(s.status));
  const invoiced = live.reduce((t, s) => t + Number(s.grand_total), 0);
  const paid = live.reduce((t, s) => t + Number(s.amount_paid), 0);
  const balance = live.reduce((t, s) => t + Number(s.balance), 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{customer ?? "Walk-in"}</DialogTitle>
          <DialogDescription>
            All supplies and payments{" "}
            {range === "day" ? `on ${new Date(day).toLocaleDateString()}` : "on record"}.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={range === "day" ? "default" : "outline"}
              onClick={() => setRange("day")}
            >
              This day
            </Button>
            {customer && (
              <Button
                size="sm"
                variant={range === "all" ? "default" : "outline"}
                onClick={() => setRange("all")}
              >
                All history
              </Button>
            )}
            {customer && (
              <Button
                size="sm"
                variant="outline"
                className="gap-2"
                title="Print this customer's sales for the whole month"
                onClick={() =>
                  printMonthlySales(factoryId, day.slice(0, 7), settings, "print", customer)
                }
              >
                <FileText className="h-4 w-4" />
                {new Date(day).toLocaleDateString("en-GB", {
                  month: "short",
                  year: "numeric",
                })}{" "}
                statement
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <span>
              Invoiced: <b>{money(invoiced, currency)}</b>
            </span>
            <span>
              Paid: <b>{money(paid, currency)}</b>
            </span>
            <span>
              Balance: <b>{money(balance, currency)}</b>
            </span>
          </div>
        </div>

        <h3 className="mt-2 text-sm font-semibold">Supplies ({shownSales.length})</h3>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date / time</TableHead>
                <TableHead>Invoice #</TableHead>
                <TableHead>Products</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownSales.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(s.created_at ?? s.sale_date).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{s.invoice_number}</TableCell>
                  <TableCell className="text-xs">
                    {(s.sale_items ?? []).map((it, i) => (
                      <div key={i}>
                        {it.products?.name ?? "Item"} × {Number(it.quantity).toLocaleString()}
                        {it.products?.unit ? ` ${it.products.unit}` : ""}{" "}
                        <span className="text-muted-foreground">
                          @ {money(it.unit_price, currency)}
                        </span>
                      </div>
                    ))}
                  </TableCell>
                  <TableCell className="text-right">{money(s.grand_total, currency)}</TableCell>
                  <TableCell className="text-right">{money(s.amount_paid, currency)}</TableCell>
                  <TableCell className="text-right font-medium">
                    {money(s.balance, currency)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {s.is_pr ? "PR" : s.status.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Print this invoice"
                      onClick={() => printSaleInvoice(s.id, settings, "print")}
                    >
                      <Printer className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {shownSales.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                    {sales.isLoading ? "Loading…" : "No supplies."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <h3 className="mt-2 text-sm font-semibold">Payments ({shownPayments.length})</h3>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Receipt #</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Method</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownPayments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(p.payment_date).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{p.receipt_number}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {p.sales?.invoice_number ?? "—"}
                  </TableCell>
                  <TableCell className="capitalize">
                    {p.payment_method.replace(/_/g, " ")}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {money(p.amount, currency)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {p.status.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
              {shownPayments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    {payments.isLoading ? "Loading…" : "No payments."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
