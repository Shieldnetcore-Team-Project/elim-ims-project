import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { SectionTabs } from "@/components/layout/section-tabs";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { fmtDate, useMarketerDirectory, type MarketerRow } from "@/lib/marketer-accounts";
import { money, num } from "@/lib/format";
import { exportCsv } from "@/lib/export";
import { generateReportPdf } from "@/lib/pdf";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FileDown, Loader2, Printer, Search, ShieldAlert } from "lucide-react";

// Marketer Management: every marketer (and the company retail outlet) with
// their headline figures. Clicking a name opens that marketer's profile —
// customers, daily sales, stock accountability, debts, payments and
// statements (/marketer-accounts/$repId).
export const Route = createFileRoute("/_app/marketer-accounts")({
  head: () => ({
    meta: [
      { title: "Marketer & Retail Accounts — Elim Table Water" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (
    <>
      <SectionTabs section="Marketer & Retail Accounts" />
      <MarketerAccountsPage />
    </>
  ),
});

function MarketerAccountsPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const perms = usePermissions();
  const canAll = perms.can("marketer-accounts") || perms.canSeeMoney || perms.can("distribution");
  const dir = useMarketerDirectory(canAll ? factoryId : undefined);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  const rows = useMemo(() => {
    const k = search.trim().toLowerCase();
    return (dir.data ?? []).filter(
      (r) =>
        (showInactive || r.status === "active") &&
        (!k ||
          r.full_name.toLowerCase().includes(k) ||
          (r.code ?? "").toLowerCase().includes(k) ||
          (r.phone ?? "").includes(k) ||
          (r.territory ?? "").toLowerCase().includes(k)),
    );
  }, [dir.data, search, showInactive]);

  if (perms.loading) return null;
  if (!canAll) {
    return (
      <Card className="rounded-2xl border-dashed">
        <CardContent className="flex items-center gap-2 pt-6 text-sm text-muted-foreground">
          <ShieldAlert className="h-5 w-5 text-destructive" /> You don&apos;t have access to
          marketer accounts.
        </CardContent>
      </Card>
    );
  }
  if (!factoryId) return null;

  const showMoney = perms.can("marketer-accounts") || perms.canSeeMoney;
  const totals = rows.reduce(
    (t, r) => ({
      customers: t.customers + r.customers,
      sales: t.sales + r.sales_value,
      collected: t.collected + r.collected,
      outstanding: t.outstanding + r.outstanding,
      remitted: t.remitted + r.remitted,
      unremitted: t.unremitted + r.unremitted,
    }),
    { customers: 0, sales: 0, collected: 0, outstanding: 0, remitted: 0, unremitted: 0 },
  );

  const columns = [
    { key: "name", label: "Marketer" },
    { key: "code", label: "ID" },
    { key: "territory", label: "Territory" },
    { key: "status", label: "Status" },
    { key: "customers", label: "Customers" },
    ...(showMoney
      ? [
          { key: "sales", label: "Total sales" },
          { key: "collected", label: "Collected" },
          { key: "outstanding", label: "Customer debt" },
          { key: "remitted", label: "Remitted" },
          { key: "unremitted", label: "Unremitted" },
        ]
      : []),
    { key: "stock", label: "Stock held (units)" },
    { key: "last", label: "Last sale" },
  ];
  const exportRows = (r: MarketerRow) => ({
    name: r.full_name,
    code: r.code ?? "",
    territory: r.territory ?? "",
    status: r.status,
    customers: r.customers,
    sales: r.sales_value,
    collected: r.collected,
    outstanding: r.outstanding,
    remitted: r.remitted,
    unremitted: r.unremitted,
    stock: r.stock_units,
    last: r.last_sale ?? "",
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Marketer Management</h1>
          <p className="text-sm text-muted-foreground">
            Click a marketer to open their account: customers, daily sales, stock, debts, payments,
            remittances and statements.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => exportCsv("marketers", columns, rows.map(exportRows))}
          >
            <FileDown className="h-4 w-4" /> CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() =>
              generateReportPdf(
                "Marketers",
                columns,
                rows.map((r) => {
                  const e = exportRows(r);
                  return showMoney
                    ? {
                        ...e,
                        sales: money(e.sales),
                        collected: money(e.collected),
                        outstanding: money(e.outstanding),
                        remitted: money(e.remitted),
                        unremitted: money(e.unremitted),
                      }
                    : e;
                }),
                "print",
                { name: settings.data?.company_name, logo_url: settings.data?.logo_url },
              )
            }
          >
            <Printer className="h-4 w-4" /> Print
          </Button>
        </div>
      </div>

      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-center gap-3 pt-6">
          <div className="relative min-w-60 flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search name, ID, phone or territory…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant={showInactive ? "default" : "outline"}
            onClick={() => setShowInactive((v) => !v)}
          >
            Include inactive
          </Button>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Marketer</TableHead>
                <TableHead>Territory</TableHead>
                <TableHead className="text-right">Customers</TableHead>
                {showMoney && (
                  <>
                    <TableHead className="text-right">Total sales</TableHead>
                    <TableHead className="text-right">Collected</TableHead>
                    <TableHead className="text-right">Customer debt</TableHead>
                    <TableHead className="text-right">Remitted</TableHead>
                    <TableHead className="text-right">Unremitted</TableHead>
                  </>
                )}
                <TableHead className="text-right">Stock held</TableHead>
                <TableHead>Last sale</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link
                      to="/marketer-accounts/$repId"
                      params={{ repId: r.id }}
                      className="font-medium text-primary hover:underline"
                    >
                      {r.full_name}
                    </Link>
                    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      {r.code && <span className="font-mono">{r.code}</span>}
                      {r.phone && <span>· {r.phone}</span>}
                      {r.kind === "outlet" && (
                        <Badge variant="outline" className="h-4 px-1 text-[10px]">
                          Retail outlet
                        </Badge>
                      )}
                      {r.status !== "active" && (
                        <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                          {r.status}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{r.territory ?? "—"}</TableCell>
                  <TableCell className="text-right">{r.customers}</TableCell>
                  {showMoney && (
                    <>
                      <TableCell className="text-right">{money(r.sales_value)}</TableCell>
                      <TableCell className="text-right">{money(r.collected)}</TableCell>
                      <TableCell
                        className={`text-right font-medium ${r.outstanding > 0 ? "text-destructive" : ""}`}
                      >
                        {r.outstanding > 0 ? money(r.outstanding) : "—"}
                      </TableCell>
                      <TableCell className="text-right">{money(r.remitted)}</TableCell>
                      <TableCell
                        className={`text-right ${r.unremitted > 0 ? "font-medium text-amber-600" : ""}`}
                      >
                        {Math.abs(r.unremitted) > 0.005 ? money(r.unremitted) : "—"}
                      </TableCell>
                    </>
                  )}
                  <TableCell className="text-right">{num(r.stock_units)}</TableCell>
                  <TableCell className="whitespace-nowrap">{fmtDate(r.last_sale)}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={showMoney ? 10 : 5}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {dir.isLoading ? (
                      <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                    ) : dir.isError ? (
                      `Couldn't load marketers: ${(dir.error as Error).message}`
                    ) : (
                      "No marketers match."
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            {showMoney && rows.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={2}>Total ({rows.length})</TableCell>
                  <TableCell className="text-right">{totals.customers}</TableCell>
                  <TableCell className="text-right">{money(totals.sales)}</TableCell>
                  <TableCell className="text-right">{money(totals.collected)}</TableCell>
                  <TableCell className="text-right">{money(totals.outstanding)}</TableCell>
                  <TableCell className="text-right">{money(totals.remitted)}</TableCell>
                  <TableCell className="text-right">{money(totals.unremitted)}</TableCell>
                  <TableCell colSpan={2} />
                </TableRow>
              </TableFooter>
            )}
          </Table>
          {showMoney && (
            <p className="mt-3 text-xs text-muted-foreground">
              Customer debt is what this marketer&apos;s customers still owe on invoices that belong
              to the marketer. Unremitted is money collected at the marketer&apos;s own sales that
              has not yet been handed in to the factory.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
