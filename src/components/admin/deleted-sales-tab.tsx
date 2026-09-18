import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { money } from "@/lib/format";

type DeletedSaleRow = {
  id: string;
  invoice_number: string;
  customer_name: string | null;
  grand_total: number;
  sale_date: string;
  deleted_at: string;
};

const RETENTION_DAYS = 30;

function daysRemaining(deletedAt: string): number {
  const deletedMs = new Date(deletedAt).getTime();
  const purgeMs = deletedMs + RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((purgeMs - Date.now()) / (24 * 60 * 60 * 1000)));
}

// Sales soft-deleted via the Delete Requests flow (20260923130000_sales_
// customer_credit_and_soft_delete.sql) land here instead of vanishing
// outright — visible only to admins (RLS: "sales read deleted" policy),
// restorable, and purged automatically 30 days after deletion. There's no
// scheduled-job mechanism anywhere in this project, so the purge is
// opportunistic: it runs once whenever an admin opens this tab.
export function DeletedSalesTab() {
  const qc = useQueryClient();

  const purge = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("purge_expired_deleted_sales");
      if (error) throw error;
      return data as { purged: number; skipped: number };
    },
    onSuccess: (data) => {
      if (data.purged > 0) qc.invalidateQueries({ queryKey: ["deleted-sales"] });
    },
  });

  useEffect(() => {
    purge.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = useQuery({
    queryKey: ["deleted-sales"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("id,invoice_number,customer_name,grand_total,sale_date,deleted_at")
        .not("deleted_at", "is", null)
        .order("deleted_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as DeletedSaleRow[];
    },
  });

  const restore = useMutation({
    mutationFn: async (row: DeletedSaleRow) => {
      const { error } = await supabase.rpc("restore_sale", { p_id: row.id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Sale restored");
      qc.invalidateQueries({ queryKey: ["deleted-sales"] });
      qc.invalidateQueries({ queryKey: ["sales-list"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const list = rows.data ?? [];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {list.length} deleted sale{list.length === 1 ? "" : "s"} — each is permanently purged{" "}
        {RETENTION_DAYS} days after deletion unless restored first.
      </p>

      <Card className="rounded-2xl">
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Deleted</TableHead>
                <TableHead>Purges in</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => {
                const remaining = daysRemaining(r.deleted_at);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.invoice_number}</TableCell>
                    <TableCell>{r.customer_name ?? "Walk-in"}</TableCell>
                    <TableCell className="text-right">{money(Number(r.grand_total))}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {new Date(r.deleted_at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant={remaining <= 3 ? "destructive" : "outline"}>
                        {remaining} day{remaining === 1 ? "" : "s"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1"
                        disabled={restore.isPending}
                        onClick={() => restore.mutate(r)}
                      >
                        <RotateCcw className="h-4 w-4" /> Restore
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {list.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    No deleted sales.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
