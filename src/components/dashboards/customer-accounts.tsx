import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { fetchAll, sum } from "@/lib/metrics";
import { exportCsv } from "@/lib/export";
import { money } from "@/lib/format";
import type { AccountSummary } from "@/lib/customer-account";
import { AccountStatusBadge } from "@/components/sales/account-ledger";
import { CustomerAccountDialog } from "@/components/sales/customer-account-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
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
import { FileDown, FileText } from "lucide-react";

type Row = Pick<
  AccountSummary,
  | "customer_id"
  | "available_advance"
  | "outstanding_debt"
  | "account_status"
  | "goods_collected"
  | "total_advance_paid"
  | "last_transaction_at"
> & { customer_name: string };

type Filter = "all" | "advance" | "debt" | "balanced";

// Every customer's advance / debt position, straight from the account ledger —
// the Finance view of what the Sales screens show per customer. "Statement"
// opens the same account dialog (with print / PDF / CSV) used in Sales.
export function CustomerAccountsCard({ factoryId }: { factoryId: string }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);

  useRealtimeInvalidate(["customer_account_transactions"], [["fin-customer-accounts"]]);

  const accounts = useQuery({
    queryKey: ["fin-customer-accounts", factoryId],
    queryFn: async () => {
      const rows = await fetchAll<Row>(
        (a, b) =>
          (supabase as any)
            .from("customer_account_summary")
            .select(
              "customer_id,customer_name,available_advance,outstanding_debt,account_status,goods_collected,total_advance_paid,last_transaction_at",
            )
            .eq("factory_id", factoryId)
            .order("customer_name")
            .range(a, b) as any,
      );
      return rows.map((r) => ({
        ...r,
        available_advance: Number(r.available_advance),
        outstanding_debt: Number(r.outstanding_debt),
        goods_collected: Number(r.goods_collected),
        total_advance_paid: Number(r.total_advance_paid),
      }));
    },
  });

  const all = useMemo(() => accounts.data ?? [], [accounts.data]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((r) => {
      if (q && !r.customer_name.toLowerCase().includes(q)) return false;
      if (filter === "advance") return r.available_advance > 0;
      if (filter === "debt") return r.outstanding_debt > 0;
      if (filter === "balanced") return r.available_advance === 0 && r.outstanding_debt === 0;
      return true;
    });
  }, [all, filter, search]);

  const totalAdvance = sum(all, (r) => r.available_advance);
  const totalDebt = sum(all, (r) => r.outstanding_debt);
  const withAdvance = all.filter((r) => r.available_advance > 0).length;
  const withDebt = all.filter((r) => r.outstanding_debt > 0).length;

  const exportBalances = () =>
    exportCsv(
      "customer-account-balances",
      [
        { key: "customer", label: "Customer" },
        { key: "advance", label: "Available advance" },
        { key: "debt", label: "Outstanding debt" },
        { key: "status", label: "Status" },
        { key: "goods", label: "Goods collected" },
        { key: "advance_paid", label: "Total advance paid" },
        { key: "last", label: "Last transaction" },
      ],
      visible.map((r) => ({
        customer: r.customer_name,
        advance: r.available_advance.toFixed(2),
        debt: r.outstanding_debt.toFixed(2),
        status: r.account_status,
        goods: r.goods_collected.toFixed(2),
        advance_paid: r.total_advance_paid.toFixed(2),
        last: r.last_transaction_at
          ? new Date(r.last_transaction_at).toLocaleDateString("en-GB")
          : "",
      })),
    );

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Customer accounts</CardTitle>
        <p className="text-sm text-muted-foreground">
          Advance held for customers and debt owed by them, from the account ledger. Open a customer
          to see their statement, or print / download it.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/30 p-3 text-sm sm:grid-cols-4">
          <div>
            <span className="block text-xs text-muted-foreground">Advance held</span>
            <span className="font-semibold text-success">{money(totalAdvance)}</span>
          </div>
          <div>
            <span className="block text-xs text-muted-foreground">Customers with advance</span>
            <span className="font-semibold">{withAdvance}</span>
          </div>
          <div>
            <span className="block text-xs text-muted-foreground">Owed by customers</span>
            <span className="font-semibold text-destructive">{money(totalDebt)}</span>
          </div>
          <div>
            <span className="block text-xs text-muted-foreground">Customers owing</span>
            <span className="font-semibold">{withDebt}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="w-52">
            <Label className="text-xs">Show</Label>
            <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All customers</SelectItem>
                <SelectItem value="advance">With available advance</SelectItem>
                <SelectItem value="debt">With outstanding debt</SelectItem>
                <SelectItem value="balanced">Balanced (no advance or debt)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-56">
            <Label className="text-xs">Search</Label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Customer name"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto gap-2"
            disabled={visible.length === 0}
            onClick={exportBalances}
          >
            <FileDown className="h-4 w-4" /> CSV
          </Button>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead className="text-right">Available advance</TableHead>
              <TableHead className="text-right">Outstanding debt</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last activity</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No customers match.
                </TableCell>
              </TableRow>
            ) : (
              visible.map((r) => (
                <TableRow key={r.customer_id}>
                  <TableCell className="font-medium">{r.customer_name}</TableCell>
                  <TableCell
                    className={`text-right ${r.available_advance > 0 ? "font-medium text-success" : ""}`}
                  >
                    {money(r.available_advance)}
                  </TableCell>
                  <TableCell
                    className={`text-right ${r.outstanding_debt > 0 ? "font-medium text-destructive" : ""}`}
                  >
                    {money(r.outstanding_debt)}
                  </TableCell>
                  <TableCell>
                    <AccountStatusBadge status={r.account_status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {r.last_transaction_at
                      ? new Date(r.last_transaction_at).toLocaleDateString()
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setOpen({ id: r.customer_id, name: r.customer_name })}
                    >
                      <FileText className="h-4 w-4" /> Statement
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={!!open} onOpenChange={(v) => !v && setOpen(null)}>
        {open && <CustomerAccountDialog customerId={open.id} customerName={open.name} />}
      </Dialog>
    </Card>
  );
}
