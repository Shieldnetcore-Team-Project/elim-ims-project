import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileDown, FileText, Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useFactorySettings } from "@/lib/use-factory";
import { localDay } from "@/lib/production-shift";
import { num } from "@/lib/format";
import { generateWarehouseProductsReportPdf, type WarehouseReportRow } from "@/lib/pdf";
import { FINISHED_PRODUCT_NAMES } from "@/components/shared/product-name-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Warehouse → Products report: per product for a date range, Opening,
// Quantity In, Total, Quantity Out, Gift/Sample, Quantity Returned, Quantity
// Sold, Empty Jug Sold and Balance (warehouse_products_report), shown here
// and printed in the factory's report layout.
export function WarehouseProductsReportButton({ factoryId }: { factoryId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" className="gap-2" onClick={() => setOpen(true)}>
        <FileText className="h-4 w-4" /> Products report
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && <ReportDialog factoryId={factoryId} />}
      </Dialog>
    </>
  );
}

function ReportDialog({ factoryId }: { factoryId: string }) {
  const settings = useFactorySettings(factoryId);
  const today = localDay();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);

  const report = useQuery({
    queryKey: ["warehouse-products-report", factoryId, from, to],
    enabled: !!from && !!to && from <= to,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "warehouse_products_report" as never,
        { p_factory: factoryId, p_from: from, p_to: to } as never,
      );
      if (error) throw error;
      const rank = (name: string) => {
        const i = (FINISHED_PRODUCT_NAMES as readonly string[]).findIndex(
          (n) => n.toLowerCase() === name.trim().toLowerCase(),
        );
        return i < 0 ? FINISHED_PRODUCT_NAMES.length : i;
      };
      return ((data ?? []) as unknown as WarehouseReportRow[])
        .map((r) => ({
          ...r,
          opening: Number(r.opening),
          qty_in: Number(r.qty_in),
          qty_out: Number(r.qty_out),
          gift: Number(r.gift),
          returned: Number(r.returned),
          sold: Number(r.sold),
          empty_jug_sold: Number(r.empty_jug_sold),
          balance: Number(r.balance),
        }))
        .sort((a, b) => rank(a.product_name) - rank(b.product_name));
    },
  });
  const rows = report.data ?? [];

  const print = (action: "print" | "download") =>
    generateWarehouseProductsReportPdf(
      {
        company: {
          name: settings.data?.company_name ?? "Elim Table Water",
          address: settings.data?.address,
          phone: settings.data?.phone,
          email: settings.data?.email,
          website: settings.data?.website,
          logo_url: settings.data?.logo_url,
        },
        from,
        to,
        rows,
      },
      action,
    );

  return (
    <DialogContent className="max-h-[90vh] max-w-6xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Warehouse: Products report</DialogTitle>
      </DialogHeader>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label>From</Label>
          <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <Label>To</Label>
          <Input
            type="date"
            value={to}
            min={from}
            max={today}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            className="gap-2"
            disabled={!rows.length}
            onClick={() => void print("download")}
          >
            <FileDown className="h-4 w-4" /> Download
          </Button>
          <Button className="gap-2" disabled={!rows.length} onClick={() => void print("print")}>
            <Printer className="h-4 w-4" /> Print
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>S/N</TableHead>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Opening</TableHead>
              <TableHead className="text-right">Quantity In</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Quantity Out</TableHead>
              <TableHead className="text-right">Gift/Sample</TableHead>
              <TableHead className="text-right">Quantity Returned</TableHead>
              <TableHead className="text-right">Quantity Sold</TableHead>
              <TableHead className="text-right">Empty Jug Sold</TableHead>
              <TableHead className="text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={r.product_name}>
                <TableCell>{i + 1}</TableCell>
                <TableCell className="font-medium">{r.product_name}</TableCell>
                <TableCell className="text-right">{num(r.opening)}</TableCell>
                <TableCell className="text-right">{num(r.qty_in)}</TableCell>
                <TableCell className="text-right">{num(r.opening + r.qty_in)}</TableCell>
                <TableCell className="text-right">{num(r.qty_out)}</TableCell>
                <TableCell className="text-right">{num(r.gift)}</TableCell>
                <TableCell className="text-right">{num(r.returned)}</TableCell>
                <TableCell className="text-right">{num(r.sold)}</TableCell>
                <TableCell className="text-right">
                  {r.empty_jug_sold ? num(r.empty_jug_sold) : ""}
                </TableCell>
                <TableCell className="text-right font-semibold">{num(r.balance)}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
                  {report.isLoading
                    ? "Loading…"
                    : report.isError
                      ? (report.error as Error).message
                      : "No stock or movement in this period."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </DialogContent>
  );
}
