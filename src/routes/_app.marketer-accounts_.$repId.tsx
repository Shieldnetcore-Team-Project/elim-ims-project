import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SectionTabs } from "@/components/layout/section-tabs";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { printSaleInvoice } from "@/lib/invoice";
import { money, num } from "@/lib/format";
import { exportCsv } from "@/lib/export";
import {
  INVOICE_STATUS,
  fmtDate,
  itemsSummary,
  marketerRpc,
  periodLabel,
  todayYmd,
  useDayCloses,
  useMarketerCustomers,
  useMarketerDirectory,
  useMarketerDays,
  useMarketerInvoices,
  useMarketerMonths,
  useMarketerPayments,
  useMarketerRemittances,
  useMarketerStatement,
  useMarketerStock,
  type CustomerReportRow,
  type DayRow,
  type Figures,
  type MarketerInvoice,
} from "@/lib/marketer-accounts";
import {
  companyOf,
  generateMarketerCustomersPdf,
  generateMarketerStatementPdf,
} from "@/lib/marketer-pdf";
import {
  AddCustomerDialog,
  InvoicePaymentDialog,
  LoadError,
  Loading,
  PeriodPicker,
  StatTile,
  invalidateMarketerData,
  usePeriod,
} from "@/components/marketers/shared";
import { RemittanceDialog, RepActivityCard, type Rep } from "@/routes/_app.distribution";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FileDown,
  HandCoins,
  Lock,
  Pencil,
  Plus,
  Printer,
  Search,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

// One marketer's account: Marketer Management → Marketer Profile. Every figure
// is read live from the marketer RPCs (see lib/marketer-accounts.ts).
const TABS = [
  { key: "overview", label: "Overview" },
  { key: "customers", label: "Registered customers" },
  { key: "sales", label: "Daily sales" },
  { key: "stock", label: "Product accountability" },
  { key: "debts", label: "Customer debts" },
  { key: "payments", label: "Payments & remittances" },
  { key: "statement", label: "Marketer statement" },
  { key: "reports", label: "Reports & history" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export const Route = createFileRoute("/_app/marketer-accounts_/$repId")({
  head: () => ({
    meta: [
      { title: "Marketer Account — Elim Table Water" },
      { name: "robots", content: "noindex" },
    ],
  }),
  validateSearch: (s: Record<string, unknown>): { tab?: TabKey } => ({
    tab: TABS.some((t) => t.key === s.tab) ? (s.tab as TabKey) : undefined,
  }),
  component: () => (
    <>
      <SectionTabs section="Marketer & Retail Accounts" />
      <MarketerProfilePage />
    </>
  ),
});

type Access = {
  money: boolean;
  stock: boolean;
  addCustomer: boolean;
  collect: boolean;
  remit: boolean;
  closeDay: boolean;
  editProfile: boolean;
  remove: boolean;
};

function useAccess(): Access & { loading: boolean } {
  const perms = usePermissions();
  const money = perms.can("marketer-accounts") || perms.canSeeMoney;
  return {
    loading: perms.loading,
    money,
    stock: money || perms.can("distribution"),
    addCustomer: perms.can("customers", "create") || perms.can("marketer-accounts", "create"),
    collect: perms.canWrite("payments") || perms.canWrite("debts"),
    remit: perms.canPost("distribution"),
    closeDay:
      perms.can("marketer-accounts", "confirm") ||
      perms.canPost("distribution") ||
      perms.canPost("finance"),
    editProfile: perms.canEdit("distribution") || perms.can("marketer-accounts", "edit"),
    remove: perms.can("distribution", "delete"),
  };
}

function MarketerProfilePage() {
  const { repId } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: factoryId } = useFactoryId();
  const access = useAccess();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);

  const rep = useQuery({
    queryKey: ["mkt-rep", repId],
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- territory is newer than the generated types
      const { data, error } = await (supabase as any)
        .from("sales_reps")
        .select("id,code,full_name,phone,status,kind,territory,created_at,employee_id,remarks")
        .eq("id", repId)
        .maybeSingle();
      if (error) throw error;
      return data as (Rep & { territory: string | null; created_at: string }) | null;
    },
  });
  // Cumulative figures for the header (all recorded history).
  const all = useMarketerStatement(repId, null, null, access.money);
  const enabledAll = access.money;

  if (access.loading) return <Loading />;
  if (!access.stock)
    return (
      <Card className="rounded-2xl border-dashed">
        <CardContent className="flex items-center gap-2 pt-6 text-sm text-muted-foreground">
          <ShieldAlert className="h-5 w-5 text-destructive" /> You don&apos;t have access to this
          marketer&apos;s account.
        </CardContent>
      </Card>
    );
  if (!factoryId) return null;

  const info = all.data?.marketer;
  const name = rep.data?.full_name ?? info?.name ?? "Marketer";
  const c = enabledAll ? all.data?.cumulative : undefined;
  const setTab = (v: string) =>
    navigate({ search: { tab: v === "overview" ? undefined : (v as TabKey) }, replace: true });
  const visibleTabs = TABS.filter(
    (t) => access.money || t.key === "overview" || t.key === "stock" || t.key === "reports",
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            to="/marketer-accounts"
            className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" /> Marketer Management
          </Link>
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
            {name}
            {(rep.data?.code ?? info?.code) && (
              <span className="font-mono text-sm text-muted-foreground">
                {rep.data?.code ?? info?.code}
              </span>
            )}
            <Badge
              variant={(rep.data?.status ?? info?.status) === "active" ? "secondary" : "outline"}
            >
              {rep.data?.status ?? info?.status ?? "—"}
            </Badge>
            {(rep.data?.kind ?? info?.kind) === "outlet" && (
              <Badge variant="outline">Retail outlet</Badge>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            {[
              rep.data?.phone ?? info?.phone,
              (rep.data?.territory ?? info?.territory) &&
                `Territory: ${rep.data?.territory ?? info?.territory}`,
              `Registered ${fmtDate(rep.data?.created_at ?? info?.registered)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {access.editProfile && (
            <Button variant="outline" size="sm" className="gap-1" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" /> Edit profile
            </Button>
          )}
          {access.remove && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1 text-destructive"
              onClick={() => setRemoving(true)}
            >
              <Trash2 className="h-4 w-4" /> Remove / merge
            </Button>
          )}
          {access.money && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={() => setTab("statement")}
            >
              <Printer className="h-4 w-4" /> Generate marketer statement
            </Button>
          )}
          {access.addCustomer && (
            <Button size="sm" className="gap-1" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> Add new customer
            </Button>
          )}
        </div>
      </div>

      {c && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <StatTile
            label="Total sales"
            value={money(c.sales.value)}
            hint={`${c.sales.count} invoices`}
          />
          <StatTile
            label="Collected"
            value={money(c.collections.total)}
            hint={`cash ${money(c.collections.cash)} · other ${money(c.collections.other)}`}
          />
          <StatTile
            label="Customer debt outstanding"
            value={money(c.debt.outstanding)}
            hint={`${c.debt.customers_owing} customer(s)${c.debt.overdue > 0 ? ` · ${money(c.debt.overdue)} overdue` : ""}`}
            tone={c.debt.outstanding > 0 ? "debt" : "ok"}
          />
          <StatTile label="Remitted to factory" value={money(c.remittances.total)} tone="ok" />
          <StatTile
            label="Unremitted collections"
            value={money(c.unremitted)}
            hint="collected at their sales, not handed in"
            tone={c.unremitted > 0.005 ? "pending" : c.unremitted < -0.005 ? "muted" : "ok"}
          />
          <StatTile
            label="Products"
            value={`${num(c.stock.closing)} held`}
            hint={`issued ${num(c.stock.issued)} · sold ${num(c.stock.sold)} · returned ${num(c.stock.returned)}`}
          />
        </div>
      )}

      <Tabs value={tab ?? "overview"} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap">
          {visibleTabs.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <OverviewTab repId={repId} figures={c} statementLoading={all.isLoading} access={access} />
        </TabsContent>
        {access.money && (
          <>
            <TabsContent value="customers" className="mt-4">
              <CustomersTab
                factoryId={factoryId}
                repId={repId}
                repName={name}
                access={access}
                onAdd={() => setAdding(true)}
              />
            </TabsContent>
            <TabsContent value="sales" className="mt-4">
              <SalesTab factoryId={factoryId} repId={repId} repName={name} />
            </TabsContent>
            <TabsContent value="debts" className="mt-4">
              <DebtsTab factoryId={factoryId} repId={repId} repName={name} access={access} />
            </TabsContent>
            <TabsContent value="payments" className="mt-4">
              <PaymentsTab factoryId={factoryId} repId={repId} repName={name} access={access} />
            </TabsContent>
            <TabsContent value="statement" className="mt-4">
              <StatementTab factoryId={factoryId} repId={repId} />
            </TabsContent>
          </>
        )}
        <TabsContent value="stock" className="mt-4">
          <StockTab repId={repId} access={access} />
        </TabsContent>
        <TabsContent value="reports" className="mt-4">
          <ReportsTab factoryId={factoryId} repId={repId} repName={name} access={access} />
        </TabsContent>
      </Tabs>

      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && (
          <AddCustomerDialog
            repId={repId}
            repName={name}
            onDone={(id) => {
              setAdding(false);
              navigate({
                to: "/marketer-accounts/$repId/customers/$customerId",
                params: { repId, customerId: id },
              });
            }}
          />
        )}
      </Dialog>
      <Dialog open={removing} onOpenChange={setRemoving}>
        {removing && (
          <RemoveMarketerDialog
            factoryId={factoryId}
            repId={repId}
            repName={name}
            kind={rep.data?.kind ?? "rep"}
            onDone={(mergedInto) => {
              setRemoving(false);
              if (mergedInto)
                navigate({ to: "/marketer-accounts/$repId", params: { repId: mergedInto } });
              else navigate({ to: "/marketer-accounts" });
            }}
          />
        )}
      </Dialog>
      <Dialog open={editing} onOpenChange={setEditing}>
        {editing && rep.data && (
          <EditProfileDialog
            repId={repId}
            initial={{
              phone: rep.data.phone ?? "",
              territory: rep.data.territory ?? "",
              status: rep.data.status,
            }}
            onDone={() => setEditing(false)}
          />
        )}
      </Dialog>
    </div>
  );
}

function EditProfileDialog({
  repId,
  initial,
  onDone,
}: {
  repId: string;
  initial: { phone: string; territory: string; status: string };
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState(initial);
  const save = useMutation({
    mutationFn: () => marketerRpc.updateProfile(repId, f),
    onSuccess: () => {
      toast.success("Profile updated");
      qc.invalidateQueries({ queryKey: ["mkt-rep", repId] });
      qc.invalidateQueries({ queryKey: ["dist-reps"] });
      invalidateMarketerData(qc);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Edit marketer profile</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Phone</Label>
          <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </div>
        <div>
          <Label>Territory / market</Label>
          <Input value={f.territory} onChange={(e) => setF({ ...f, territory: e.target.value })} />
        </div>
        <div>
          <Label>Employment status</Label>
          <Select value={f.status} onValueChange={(v) => setF({ ...f, status: v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/* ---------------------------------------------------------------- Overview */

function OverviewTab({
  repId,
  figures,
  statementLoading,
  access,
}: {
  repId: string;
  figures: Figures | undefined;
  statementLoading: boolean;
  access: Access;
}) {
  const stock = useMarketerStock(repId, null, null);
  if (access.money && statementLoading) return <Loading />;
  const f = figures;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {f && (
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="text-base">Cumulative performance</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableBody>
                {(
                  [
                    ["Invoices", String(f.sales.count)],
                    ["Total sales value", money(f.sales.value)],
                    ["  sold from the marketer's stock", money(f.sales.van_value)],
                    ["  sold direct to their customers", money(f.sales.direct_value)],
                    ["Paid at the time of sale", money(f.sales.paid_at_sale)],
                    ["Credit sales (left owing)", money(f.sales.credit_sales)],
                    ["Customer payments received", money(f.collections.total)],
                    ["  cash", money(f.collections.cash)],
                    ["  transfers and other methods", money(f.collections.other)],
                    ["  on earlier debts", money(f.collections.on_debts)],
                    ["Collected by marketer at their sales", money(f.collections.held_by_marketer)],
                    ["Remitted to factory", money(f.remittances.total)],
                    ["Unremitted collections", money(f.unremitted)],
                    ["Customer debt outstanding", money(f.debt.outstanding)],
                    ["Debt written off", money(f.debt.written_off)],
                  ] as const
                ).map(([l, v]) => (
                  <TableRow key={l}>
                    <TableCell className={l.startsWith("  ") ? "pl-6 text-muted-foreground" : ""}>
                      {l.trim()}
                    </TableCell>
                    <TableCell className="text-right">{v}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base">Products (all recorded history, units)</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {stock.isLoading ? (
            <Loading />
          ) : stock.isError ? (
            <LoadError error={stock.error} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Issued</TableHead>
                  <TableHead className="text-right">Sold</TableHead>
                  <TableHead className="text-right">Returned</TableHead>
                  <TableHead className="text-right">Damaged</TableHead>
                  <TableHead className="text-right">Held now</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(stock.data?.products ?? []).map((p) => (
                  <TableRow key={p.product_id}>
                    <TableCell>
                      {p.name} <span className="text-xs text-muted-foreground">({p.unit})</span>
                    </TableCell>
                    <TableCell className="text-right">{num(p.issued)}</TableCell>
                    <TableCell className="text-right">{num(p.sold)}</TableCell>
                    <TableCell className="text-right">{num(p.returned)}</TableCell>
                    <TableCell className="text-right">{num(p.damaged)}</TableCell>
                    <TableCell className="text-right font-medium">{num(p.closing)}</TableCell>
                  </TableRow>
                ))}
                {(stock.data?.products ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                      No products issued yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- Customers */

type SortKey = "debt" | "purchases" | "name" | "last";

function CustomersTab({
  factoryId,
  repId,
  repName,
  access,
  onAdd,
}: {
  factoryId: string;
  repId: string;
  repName: string;
  access: Access;
  onAdd: () => void;
}) {
  const settings = useFactorySettings(factoryId);
  const q = useMarketerCustomers(repId);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "dormant">("all");
  const [owing, setOwing] = useState(false);
  const [sort, setSort] = useState<SortKey>("debt");

  const rows = useMemo(() => {
    const k = search.trim().toLowerCase();
    const digits = k.replace(/\D/g, "");
    const out = (q.data ?? []).filter(
      (r) =>
        (status === "all" || r.status === status) &&
        (!owing || r.outstanding > 0) &&
        (!k ||
          r.name.toLowerCase().includes(k) ||
          (digits.length > 2 && (r.phone ?? "").replace(/\D/g, "").includes(digits))),
    );
    const by: Record<SortKey, (a: CustomerReportRow, b: CustomerReportRow) => number> = {
      debt: (a, b) => b.outstanding - a.outstanding || b.total_purchases - a.total_purchases,
      purchases: (a, b) => b.total_purchases - a.total_purchases,
      name: (a, b) => a.name.localeCompare(b.name),
      last: (a, b) => (b.last_purchase ?? "").localeCompare(a.last_purchase ?? ""),
    };
    return out.sort(by[sort]);
  }, [q.data, search, status, owing, sort]);

  const t = rows.reduce(
    (a, r) => ({ p: a.p + r.total_purchases, pd: a.pd + r.total_paid, o: a.o + r.outstanding }),
    { p: 0, pd: 0, o: 0 },
  );
  const filterLabel = [
    status !== "all" ? `${status} customers` : "All customers",
    owing ? "with outstanding debt" : "",
    search ? `matching "${search}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">Customers of {repName}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {rows.length} customer(s) · purchases {money(t.p)} · paid {money(t.pd)} ·{" "}
            <span className={t.o > 0 ? "font-medium text-destructive" : ""}>
              outstanding {money(t.o)}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={!rows.length}
            onClick={() =>
              exportCsv(
                `customers-${repName}`,
                [
                  { key: "name", label: "Customer" },
                  { key: "phone", label: "Phone" },
                  { key: "status", label: "Status" },
                  { key: "invoices", label: "Invoices" },
                  { key: "total_purchases", label: "Total purchases" },
                  { key: "total_paid", label: "Total paid" },
                  { key: "outstanding", label: "Outstanding" },
                  { key: "overdue", label: "Overdue" },
                  { key: "last_purchase", label: "Last purchase" },
                ],
                rows,
              )
            }
          >
            <FileDown className="h-4 w-4" /> CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={!rows.length}
            onClick={() =>
              generateMarketerCustomersPdf(
                {
                  company: companyOf(settings.data),
                  marketer: repName,
                  rows,
                  filterLabel,
                  currency: settings.data?.currency ?? "NGN",
                },
                "print",
              )
            }
          >
            <Printer className="h-4 w-4" /> Print / PDF
          </Button>
          {access.addCustomer && (
            <Button size="sm" className="gap-1" onClick={onAdd}>
              <Plus className="h-4 w-4" /> Add new customer
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search name or phone…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="dormant">Dormant</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="debt">Highest debt first</SelectItem>
              <SelectItem value="purchases">Highest purchases first</SelectItem>
              <SelectItem value="last">Most recent purchase</SelectItem>
              <SelectItem value="name">Name A–Z</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant={owing ? "default" : "outline"}
            onClick={() => setOwing((v) => !v)}
          >
            Owing only
          </Button>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead className="text-right">Invoices</TableHead>
                <TableHead className="text-right">Total purchases</TableHead>
                <TableHead className="text-right">Total paid</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead className="text-right">Overdue</TableHead>
                <TableHead>Last purchase</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.isLoading && (
                <TableRow>
                  <TableCell colSpan={8}>
                    <Loading />
                  </TableCell>
                </TableRow>
              )}
              {q.isError && (
                <TableRow>
                  <TableCell colSpan={8}>
                    <LoadError error={q.error} />
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.customer_id ?? "walk-in"}>
                  <TableCell>
                    {r.customer_id ? (
                      <Link
                        to="/marketer-accounts/$repId/customers/$customerId"
                        params={{ repId, customerId: r.customer_id }}
                        className="font-medium text-primary hover:underline"
                      >
                        {r.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{r.name}</span>
                    )}
                    <div className="flex flex-wrap gap-1">
                      {r.status === "dormant" && (
                        <Badge variant="outline" className="h-4 px-1 text-[10px]">
                          dormant
                        </Badge>
                      )}
                      {r.customer_id && !r.registered && (
                        <Badge
                          variant="outline"
                          className="h-4 px-1 text-[10px] text-muted-foreground"
                        >
                          walk-in record
                        </Badge>
                      )}
                      {r.customer_id && !r.assigned && (
                        <Badge
                          variant="outline"
                          className="h-4 px-1 text-[10px] text-muted-foreground"
                        >
                          assigned elsewhere
                        </Badge>
                      )}
                      {r.open_followups > 0 && (
                        <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                          {r.open_followups} follow-up
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{r.phone ?? "—"}</TableCell>
                  <TableCell className="text-right">{r.invoices}</TableCell>
                  <TableCell className="text-right">{money(r.total_purchases)}</TableCell>
                  <TableCell className="text-right">{money(r.total_paid)}</TableCell>
                  <TableCell
                    className={`text-right font-semibold ${r.outstanding > 0 ? "text-destructive" : ""}`}
                  >
                    {r.outstanding > 0 ? money(r.outstanding) : "—"}
                  </TableCell>
                  <TableCell className="text-right text-destructive">
                    {r.overdue > 0 ? money(r.overdue) : ""}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{fmtDate(r.last_purchase)}</TableCell>
                </TableRow>
              ))}
              {!q.isLoading && !q.isError && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                    {q.data?.length
                      ? "No customers match."
                      : "No customers registered under this marketer yet."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            {rows.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={3}>Total</TableCell>
                  <TableCell className="text-right">{money(t.p)}</TableCell>
                  <TableCell className="text-right">{money(t.pd)}</TableCell>
                  <TableCell className="text-right">{money(t.o)}</TableCell>
                  <TableCell colSpan={2} />
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">
          Money columns count only invoices that belong to {repName}, so the total outstanding is
          exactly {repName}&apos;s customer debt — no invoice is counted twice. A customer moved to
          another marketer keeps their earlier invoices here.
        </p>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------- Daily sales */

function InvoiceTable({
  rows,
  factoryId,
  showCustomer = true,
  onPay,
}: {
  rows: MarketerInvoice[];
  factoryId: string;
  showCustomer?: boolean;
  onPay?: (r: MarketerInvoice) => void;
}) {
  const settings = useFactorySettings(factoryId);
  const t = rows.reduce(
    (a, r) => ({
      v: a.v + r.grand_total,
      p: a.p + r.paid_at_sale + r.paid_later + r.advance_applied,
      o: a.o + r.outstanding,
    }),
    { v: 0, p: 0, o: 0 },
  );
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Invoice</TableHead>
            {showCustomer && <TableHead>Customer</TableHead>}
            <TableHead>Products</TableHead>
            <TableHead className="text-right">Invoice value</TableHead>
            <TableHead className="text-right">Paid at sale</TableHead>
            <TableHead className="text-right">Paid later</TableHead>
            <TableHead className="text-right">Outstanding</TableHead>
            <TableHead>Status</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const s = INVOICE_STATUS[r.status];
            return (
              <TableRow key={r.sale_id}>
                <TableCell className="whitespace-nowrap">{fmtDate(r.sale_date)}</TableCell>
                <TableCell className="font-mono text-xs">
                  {r.invoice_number}
                  {!r.van_sale && (
                    <span className="block font-sans text-[10px] text-muted-foreground">
                      sold direct
                    </span>
                  )}
                </TableCell>
                {showCustomer && <TableCell>{r.customer_name}</TableCell>}
                <TableCell className="max-w-64 text-xs">
                  {r.items.map((i, k) => (
                    <div key={k}>
                      {i.product} × {num(i.quantity)} @ {money(i.unit_price)}
                    </div>
                  ))}
                </TableCell>
                <TableCell className="text-right">{money(r.grand_total)}</TableCell>
                <TableCell className="text-right">
                  {money(r.paid_at_sale)}
                  {r.advance_applied > 0 && (
                    <span className="block text-[10px] text-muted-foreground">
                      +{money(r.advance_applied)} advance
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {r.paid_later > 0 ? money(r.paid_later) : "—"}
                </TableCell>
                <TableCell
                  className={`text-right font-medium ${r.outstanding > 0 ? "text-destructive" : ""}`}
                >
                  {r.outstanding > 0 ? money(r.outstanding) : "—"}
                </TableCell>
                <TableCell>
                  <Badge variant={s.variant}>{s.label}</Badge>
                  {r.due_date && r.outstanding > 0 && (
                    <span className="block text-[10px] text-muted-foreground">
                      due {fmtDate(r.due_date)}
                    </span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Print invoice"
                    onClick={() => printSaleInvoice(r.sale_id, settings.data, "print")}
                  >
                    <Printer className="h-4 w-4" />
                  </Button>
                  {onPay && r.outstanding > 0 && r.customer_id && (
                    <Button size="sm" variant="outline" onClick={() => onPay(r)}>
                      Record payment
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
          {rows.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={showCustomer ? 10 : 9}
                className="py-8 text-center text-muted-foreground"
              >
                No invoices.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
        {rows.length > 0 && (
          <TableFooter>
            <TableRow>
              <TableCell colSpan={showCustomer ? 4 : 3}>Total ({rows.length})</TableCell>
              <TableCell className="text-right">{money(t.v)}</TableCell>
              <TableCell colSpan={2} className="text-right">
                paid {money(t.p)}
              </TableCell>
              <TableCell className="text-right">{money(t.o)}</TableCell>
              <TableCell colSpan={2} />
            </TableRow>
          </TableFooter>
        )}
      </Table>
    </div>
  );
}

function SalesTab({
  factoryId,
  repId,
  repName,
}: {
  factoryId: string;
  repId: string;
  repName: string;
}) {
  const p = usePeriod("today");
  const q = useMarketerInvoices(repId, p.range.from, p.range.to);
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const byProduct = useMemo(() => {
    const m = new Map<string, { qty: number; value: number; unit: string }>();
    for (const r of rows)
      for (const i of r.items) {
        const e = m.get(i.product) ?? { qty: 0, value: 0, unit: i.unit };
        e.qty += i.quantity;
        e.value += i.line_total;
        m.set(i.product, e);
      }
    return [...m.entries()];
  }, [rows]);
  const credit = rows.reduce(
    (t, r) => t + Math.max(r.grand_total - r.paid_at_sale - r.advance_applied, 0),
    0,
  );
  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end justify-between gap-3 pt-6">
          <PeriodPicker value={p.state} onChange={p.setState} />
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={!rows.length}
              onClick={() =>
                exportCsv(
                  `sales-${repName}-${p.range.from ?? "all"}`,
                  [
                    { key: "sale_date", label: "Date" },
                    { key: "invoice_number", label: "Invoice" },
                    { key: "customer_name", label: "Customer" },
                    { key: "products", label: "Products" },
                    { key: "grand_total", label: "Invoice value" },
                    { key: "paid_at_sale", label: "Paid at sale" },
                    { key: "paid_later", label: "Paid later" },
                    { key: "outstanding", label: "Outstanding" },
                    { key: "payment_method", label: "Method" },
                    { key: "status", label: "Status" },
                  ],
                  rows.map((r) => ({ ...r, products: itemsSummary(r.items) })),
                )
              }
            >
              <FileDown className="h-4 w-4" /> CSV
            </Button>
            <Button asChild size="sm" className="gap-1">
              <Link to="/sales">
                <Plus className="h-4 w-4" /> Record a sale
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={`Sales — ${periodLabel(p.range)}`}
          value={money(rows.reduce((t, r) => t + r.grand_total, 0))}
          hint={`${rows.length} invoices`}
        />
        <StatTile
          label="Paid at sale"
          value={money(rows.reduce((t, r) => t + r.paid_at_sale, 0))}
          tone="ok"
        />
        <StatTile
          label="Credit sales"
          value={money(credit)}
          tone={credit > 0 ? "debt" : undefined}
        />
        <StatTile
          label="Still outstanding on these"
          value={money(rows.reduce((t, r) => t + r.outstanding, 0))}
          tone={rows.some((r) => r.outstanding > 0) ? "debt" : "ok"}
        />
      </div>
      {byProduct.length > 0 && (
        <Card className="rounded-2xl">
          <CardContent className="flex flex-wrap gap-x-6 gap-y-1 pt-5 text-sm">
            {byProduct.map(([name, v]) => (
              <span key={name}>
                <span className="font-medium">{name}</span>: {num(v.qty)} {v.unit} ·{" "}
                {money(v.value)}
              </span>
            ))}
          </CardContent>
        </Card>
      )}
      <Card className="rounded-2xl">
        <CardContent className="pt-6">
          {q.isLoading ? (
            <Loading />
          ) : q.isError ? (
            <LoadError error={q.error} />
          ) : (
            <InvoiceTable rows={rows} factoryId={factoryId} />
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Sales are recorded and approved in Sales; each invoice keeps the prices charged on the
            day. Only approved invoices appear here.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/* --------------------------------------------------- Product accountability */

function StockTab({ repId, access }: { repId: string; access: Access }) {
  const qc = useQueryClient();
  const today = todayYmd();
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 13);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(today);
  const days = useMarketerDays(repId, from, to);
  const closes = useDayCloses(repId);
  const [open, setOpen] = useState<string | null>(null);
  const [closing, setClosing] = useState<DayRow | null>(null);
  const m = access.money;
  const cols = m ? 16 : 10;

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div>
            <Label className="text-xs">From</Label>
            <Input
              type="date"
              className="h-9"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <Input
              type="date"
              className="h-9"
              value={to}
              max={today}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <p className="max-w-xl text-xs text-muted-foreground">
            Stock is counted in units by the day each movement was recorded; money by the date on
            the invoice, receipt or remittance. Products sold on credit count as sold — the unpaid
            amount is customer debt, not stock.
          </p>
        </CardContent>
      </Card>
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base">Daily accountability</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {days.isLoading ? (
            <Loading />
          ) : days.isError ? (
            <LoadError error={days.error} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-6" />
                  <TableHead>Day</TableHead>
                  <TableHead className="text-right">Opening</TableHead>
                  <TableHead className="text-right">Issued</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                  <TableHead className="text-right">Sold</TableHead>
                  <TableHead className="text-right">Returned</TableHead>
                  <TableHead className="text-right">Damaged</TableHead>
                  <TableHead className="text-right">Closing</TableHead>
                  {m && (
                    <>
                      <TableHead className="text-right">Sales value</TableHead>
                      <TableHead className="text-right">Cash</TableHead>
                      <TableHead className="text-right">Transfer/other</TableHead>
                      <TableHead className="text-right">Credit sales</TableHead>
                      <TableHead className="text-right">Remitted</TableHead>
                      <TableHead className="text-right">Unremitted</TableHead>
                      <TableHead className="text-right">Debt at day end</TableHead>
                    </>
                  )}
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(days.data ?? []).map((d) => {
                  const expanded = open === d.day;
                  return (
                    <Fragment key={d.day}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => setOpen(expanded ? null : d.day)}
                      >
                        <TableCell>
                          {expanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-medium">
                          {fmtDate(d.day)}
                          {d.variances.length > 0 && (
                            <span className="block text-[10px] font-normal text-amber-600">
                              {d.variances.length} item(s) to check
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">{num(d.opening_qty)}</TableCell>
                        <TableCell className="text-right">{num(d.issued_qty)}</TableCell>
                        <TableCell className="text-right">{num(d.available_qty)}</TableCell>
                        <TableCell className="text-right">{num(d.sold_qty)}</TableCell>
                        <TableCell className="text-right">{num(d.returned_qty)}</TableCell>
                        <TableCell className="text-right">{num(d.damaged_qty)}</TableCell>
                        <TableCell className="text-right font-medium">
                          {num(d.closing_qty)}
                        </TableCell>
                        {m && (
                          <>
                            <TableCell className="text-right">{money(d.sales_value)}</TableCell>
                            <TableCell className="text-right">{money(d.cash_collected)}</TableCell>
                            <TableCell className="text-right">{money(d.other_collected)}</TableCell>
                            <TableCell className="text-right text-destructive">
                              {d.credit_sales ? money(d.credit_sales) : "—"}
                            </TableCell>
                            <TableCell className="text-right">{money(d.remitted)}</TableCell>
                            <TableCell
                              className={`text-right ${Number(d.unremitted) > 0.005 ? "font-medium text-amber-600" : ""}`}
                            >
                              {money(d.unremitted)}
                            </TableCell>
                            <TableCell className="text-right">
                              {money(d.debt_outstanding)}
                            </TableCell>
                          </>
                        )}
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          {d.closed ? (
                            <Badge variant="secondary" className="gap-1">
                              <Lock className="h-3 w-3" /> Closed
                            </Badge>
                          ) : (
                            access.closeDay && (
                              <Button size="sm" variant="outline" onClick={() => setClosing(d)}>
                                Close day
                              </Button>
                            )
                          )}
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableCell />
                          <TableCell colSpan={cols}>
                            <DayDetail repId={repId} day={d} money={m} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base">Closed days</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead className="text-right">Closing stock</TableHead>
                {m && <TableHead className="text-right">Unremitted</TableHead>}
                <TableHead>Note</TableHead>
                <TableHead>Closed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(closes.data ?? []).map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{fmtDate(c.close_date)}</TableCell>
                  <TableCell className="text-right">
                    {num(Number(c.figures.closing_qty ?? 0))}
                  </TableCell>
                  {m && (
                    <TableCell className="text-right">
                      {money(Number(c.figures.unremitted ?? 0))}
                    </TableCell>
                  )}
                  <TableCell className="text-sm">{c.notes ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(c.closed_at).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
              {(closes.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={m ? 5 : 4} className="py-6 text-center text-muted-foreground">
                    No days closed yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <p className="mt-2 text-xs text-muted-foreground">
            Closing a day keeps a permanent snapshot of its figures. A day with items to check needs
            a note explaining them before it can be closed.
          </p>
        </CardContent>
      </Card>

      <Dialog open={!!closing} onOpenChange={(v) => !v && setClosing(null)}>
        {closing && (
          <CloseDayDialog
            repId={repId}
            day={closing}
            onDone={() => {
              setClosing(null);
              invalidateMarketerData(qc);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

function DayDetail({
  repId,
  day,
  money: showMoney,
}: {
  repId: string;
  day: DayRow;
  money: boolean;
}) {
  const s = useMarketerStock(repId, day.day, day.day);
  return (
    <div className="space-y-2">
      {day.variances.length > 0 && (
        <ul className="list-inside list-disc text-xs text-amber-700">
          {day.variances.map((v) => (
            <li key={v}>{v}</li>
          ))}
        </ul>
      )}
      {showMoney && (
        <p className="text-xs text-muted-foreground">
          {day.sales_count} invoice(s) · collected at their sales {money(day.held_by_marketer)} ·
          paid on earlier debts {money(day.debt_collections)}
        </p>
      )}
      {s.isLoading ? (
        <Loading />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Opening</TableHead>
              <TableHead className="text-right">Issued</TableHead>
              <TableHead className="text-right">Sold</TableHead>
              <TableHead className="text-right">Returned</TableHead>
              <TableHead className="text-right">Damaged</TableHead>
              <TableHead className="text-right">Corrections</TableHead>
              <TableHead className="text-right">Closing</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(s.data?.products ?? [])
              .filter(
                (p) =>
                  p.opening ||
                  p.issued ||
                  p.sold ||
                  p.returned ||
                  p.damaged ||
                  p.corrections ||
                  p.closing,
              )
              .map((p) => (
                <TableRow key={p.product_id}>
                  <TableCell>{p.name}</TableCell>
                  <TableCell className="text-right">{num(p.opening)}</TableCell>
                  <TableCell className="text-right">{num(p.issued)}</TableCell>
                  <TableCell className="text-right">{num(p.sold)}</TableCell>
                  <TableCell className="text-right">{num(p.returned)}</TableCell>
                  <TableCell className="text-right">{num(p.damaged)}</TableCell>
                  <TableCell className="text-right">{num(p.corrections)}</TableCell>
                  <TableCell className="text-right font-medium">{num(p.closing)}</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function CloseDayDialog({
  repId,
  day,
  onDone,
}: {
  repId: string;
  day: DayRow;
  onDone: () => void;
}) {
  const [notes, setNotes] = useState("");
  const save = useMutation({
    mutationFn: () => marketerRpc.closeDay(repId, day.day, notes.trim() || null),
    onSuccess: () => {
      toast.success(`${fmtDate(day.day)} closed`);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Close {fmtDate(day.day)}</DialogTitle>
        <DialogDescription>
          Closing stock {num(day.closing_qty)} units
          {day.unremitted != null && ` · unremitted ${money(day.unremitted)}`}. The day&apos;s
          figures are saved as they stand now.
        </DialogDescription>
      </DialogHeader>
      {day.variances.length > 0 && (
        <ul className="list-inside list-disc text-sm text-amber-700">
          {day.variances.map((v) => (
            <li key={v}>{v}</li>
          ))}
        </ul>
      )}
      <div>
        <Label>Reconciliation note {day.variances.length > 0 && "*"}</Label>
        <Textarea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Explain any differences…"
        />
      </div>
      <DialogFooter>
        <Button
          disabled={save.isPending || (day.variances.length > 0 && !notes.trim())}
          onClick={() => save.mutate()}
        >
          Close day
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/* ----------------------------------------------------------- Customer debts */

function DebtsTab({
  factoryId,
  repId,
  repName,
  access,
}: {
  factoryId: string;
  repId: string;
  repName: string;
  access: Access;
}) {
  const q = useMarketerInvoices(repId, null, null, true);
  const [paying, setPaying] = useState<MarketerInvoice | null>(null);
  const rows = q.data ?? [];
  const today = new Date();
  const age = (d: string) =>
    Math.floor((today.getTime() - new Date(`${d}T00:00:00`).getTime()) / 86400000);
  const buckets = [
    { label: "0–30 days", test: (a: number) => a <= 30 },
    { label: "31–60 days", test: (a: number) => a > 30 && a <= 60 },
    { label: "61–90 days", test: (a: number) => a > 60 && a <= 90 },
    { label: "Over 90 days", test: (a: number) => a > 90 },
  ].map((b) => ({
    ...b,
    total: rows.filter((r) => b.test(age(r.sale_date))).reduce((t, r) => t + r.outstanding, 0),
  }));
  const total = rows.reduce((t, r) => t + r.outstanding, 0);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label="Total customer debt"
          value={money(total)}
          hint={`${rows.length} unpaid invoice(s)`}
          tone={total > 0 ? "debt" : "ok"}
        />
        {buckets.map((b) => (
          <StatTile
            key={b.label}
            label={b.label}
            value={money(b.total)}
            tone={b.total > 0 && b.label !== "0–30 days" ? "debt" : undefined}
          />
        ))}
      </div>
      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row items-center flex-wrap justify-between gap-2">
          <CardTitle className="text-base">Unpaid invoices</CardTitle>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={!rows.length}
            onClick={() =>
              exportCsv(
                `debts-${repName}`,
                [
                  { key: "customer_name", label: "Customer" },
                  { key: "customer_phone", label: "Phone" },
                  { key: "invoice_number", label: "Invoice" },
                  { key: "sale_date", label: "Date" },
                  { key: "grand_total", label: "Invoice value" },
                  { key: "outstanding", label: "Outstanding" },
                  { key: "due_date", label: "Due" },
                ],
                rows,
              )
            }
          >
            <FileDown className="h-4 w-4" /> CSV
          </Button>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <Loading />
          ) : q.isError ? (
            <LoadError error={q.error} />
          ) : (
            <InvoiceTable
              rows={rows}
              factoryId={factoryId}
              onPay={access.collect ? setPaying : undefined}
            />
          )}
        </CardContent>
      </Card>
      <Dialog open={!!paying} onOpenChange={(v) => !v && setPaying(null)}>
        {paying?.customer_id && (
          <InvoicePaymentDialog
            factoryId={factoryId}
            customerId={paying.customer_id}
            customerName={paying.customer_name}
            saleId={paying.sale_id}
            invoiceNumber={paying.invoice_number}
            owed={paying.outstanding}
            repId={repId}
            repName={repName}
            onDone={() => setPaying(null)}
          />
        )}
      </Dialog>
    </div>
  );
}

/* --------------------------------------------------- Payments & remittances */

function PaymentsTab({
  factoryId,
  repId,
  repName,
  access,
}: {
  factoryId: string;
  repId: string;
  repName: string;
  access: Access;
}) {
  const qc = useQueryClient();
  const p = usePeriod("this_month");
  const pays = useMarketerPayments(repId, p.range.from, p.range.to);
  const rem = useMarketerRemittances(repId, p.range.from, p.range.to);
  const st = useMarketerStatement(repId, p.range.from, p.range.to);
  const [remitting, setRemitting] = useState(false);
  const f = st.data?.period;

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end justify-between gap-3 pt-6">
          <PeriodPicker value={p.state} onChange={p.setState} />
          {access.remit && (
            <Button size="sm" className="gap-1" onClick={() => setRemitting(true)}>
              <HandCoins className="h-4 w-4" /> Record remittance
            </Button>
          )}
        </CardContent>
      </Card>
      {f && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatTile
            label="Customer payments"
            value={money(f.collections.total)}
            hint={`cash ${money(f.collections.cash)} · other ${money(f.collections.other)}`}
          />
          <StatTile
            label="Collected by marketer at sales"
            value={money(f.collections.held_by_marketer)}
            hint="money they hold until remitted"
          />
          <StatTile label="Remitted to factory" value={money(f.remittances.total)} tone="ok" />
          <StatTile
            label="Unremitted at period end"
            value={money(f.unremitted)}
            tone={f.unremitted > 0.005 ? "pending" : "ok"}
            hint="running figure, all history"
          />
        </div>
      )}
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base">Customer payments</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {pays.isLoading ? (
            <Loading />
          ) : pays.isError ? (
            <LoadError error={pays.error} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Receipt</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Applied to</TableHead>
                  <TableHead>Held by</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(pays.data ?? []).map((r) => {
                  const void_ = r.status === "reversed" || r.status === "rejected";
                  return (
                    <TableRow key={r.payment_id} className={void_ ? "opacity-50" : ""}>
                      <TableCell className="whitespace-nowrap">{fmtDate(r.payment_date)}</TableCell>
                      <TableCell className="font-mono text-xs">{r.receipt_number}</TableCell>
                      <TableCell>{r.customer_name}</TableCell>
                      <TableCell className="capitalize">{r.payment_method}</TableCell>
                      <TableCell className="text-right">{money(r.amount)}</TableCell>
                      <TableCell className="text-xs">
                        {r.allocations.map((a, i) => (
                          <div key={i}>
                            {a.invoice ?? "—"}: {money(a.amount)}
                          </div>
                        ))}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.held_by_marketer ? (
                          <Badge variant="outline" className="border-amber-500 text-amber-700">
                            marketer (to remit)
                          </Badge>
                        ) : r.collected_by_marketer ? (
                          <Badge variant="outline">brought in by marketer</Badge>
                        ) : (
                          <Badge variant="outline">factory</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {void_ ? (
                          <Badge variant="destructive">{r.status}</Badge>
                        ) : (
                          <Badge variant="secondary">recorded</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {(pays.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                      No payments in this period.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base">Remittances to the factory</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Method</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Remarks</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(rem.data ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{fmtDate(r.remittance_date)}</TableCell>
                  <TableCell className="font-mono text-xs">{r.remittance_number}</TableCell>
                  <TableCell className="capitalize">{r.payment_method}</TableCell>
                  <TableCell className="text-right">{money(r.amount)}</TableCell>
                  <TableCell className="text-sm">{r.remarks ?? "—"}</TableCell>
                </TableRow>
              ))}
              {(rem.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                    No remittances in this period.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Dialog open={remitting} onOpenChange={setRemitting}>
        {remitting && (
          <RemittanceDialog
            factoryId={factoryId}
            reps={[{ id: repId, full_name: repName, status: "active" } as Rep]}
            presetRepId={repId}
            presetRemarks={`Remittance from ${repName}`}
            onDone={() => {
              setRemitting(false);
              invalidateMarketerData(qc);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------- Marketer statement */

function StatementTab({ factoryId, repId }: { factoryId: string; repId: string }) {
  const settings = useFactorySettings(factoryId);
  const p = usePeriod("this_month");
  const st = useMarketerStatement(repId, p.range.from, p.range.to);
  const label = periodLabel(p.range);
  const s = st.data;
  const pdf = (action: "print" | "download") =>
    s &&
    generateMarketerStatementPdf(
      {
        company: companyOf(settings.data),
        statement: s,
        periodLabel: label,
        currency: settings.data?.currency ?? "NGN",
      },
      action,
    );
  const line = (l: string, f: (x: Figures) => number, sub = false) =>
    s && (
      <TableRow key={l}>
        <TableCell className={sub ? "pl-6 text-muted-foreground" : ""}>{l}</TableCell>
        <TableCell className="text-right">{money(f(s.period))}</TableCell>
        <TableCell className="text-right text-muted-foreground">{money(f(s.cumulative))}</TableCell>
      </TableRow>
    );
  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end justify-between gap-3 pt-6">
          <PeriodPicker value={p.state} onChange={p.setState} />
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={!s}
              onClick={() => pdf("download")}
            >
              <FileDown className="h-4 w-4" /> PDF
            </Button>
            <Button size="sm" className="gap-1" disabled={!s} onClick={() => pdf("print")}>
              <Printer className="h-4 w-4" /> Print statement
            </Button>
          </div>
        </CardContent>
      </Card>
      {st.isLoading && <Loading />}
      {st.isError && <LoadError error={st.error} />}
      {s && (
        <>
          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle className="text-base">
                {s.marketer.name} — {label}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Records from {fmtDate(s.first_activity)}. The right-hand column is everything up to
                the end of the period.
              </p>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead />
                    <TableHead className="text-right">This period</TableHead>
                    <TableHead className="text-right">Cumulative</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell>Invoices</TableCell>
                    <TableCell className="text-right">{s.period.sales.count}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {s.cumulative.sales.count}
                    </TableCell>
                  </TableRow>
                  {line("Total sales value", (x) => x.sales.value)}
                  {line("Paid at the time of sale", (x) => x.sales.paid_at_sale, true)}
                  {line("Customer advance applied", (x) => x.sales.advance_applied, true)}
                  {line("Credit sales", (x) => x.sales.credit_sales, true)}
                  {line("Customer payments received", (x) => x.collections.total)}
                  {line("Cash", (x) => x.collections.cash, true)}
                  {line("Transfer / POS / other", (x) => x.collections.other, true)}
                  {line("On earlier debts", (x) => x.collections.on_debts, true)}
                  {line("Collected by marketer at sales", (x) => x.collections.held_by_marketer)}
                  {line("Remitted to factory", (x) => x.remittances.total)}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell>Unremitted collections at period end</TableCell>
                    <TableCell />
                    <TableCell className="text-right">{money(s.period.unremitted)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Customer debt outstanding (now)</TableCell>
                    <TableCell className="text-right text-xs font-normal text-muted-foreground">
                      {money(s.period.debt.from_period)} from this period&apos;s invoices
                    </TableCell>
                    <TableCell className="text-right">
                      {money(s.cumulative.debt.outstanding)}
                    </TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </CardContent>
          </Card>

          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle className="text-base">Stock accountability by product (units)</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Opening</TableHead>
                    <TableHead className="text-right">Issued</TableHead>
                    <TableHead className="text-right">Sold</TableHead>
                    <TableHead className="text-right">Returned</TableHead>
                    <TableHead className="text-right">Damaged</TableHead>
                    <TableHead className="text-right">Corrections</TableHead>
                    <TableHead className="text-right">Closing</TableHead>
                    <TableHead className="text-right">Invoiced qty</TableHead>
                    <TableHead className="text-right">Invoiced value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.period.products.map((r) => (
                    <TableRow key={r.product_id}>
                      <TableCell>{r.name}</TableCell>
                      <TableCell className="text-right">{num(r.opening)}</TableCell>
                      <TableCell className="text-right">{num(r.issued)}</TableCell>
                      <TableCell className="text-right">{num(r.sold)}</TableCell>
                      <TableCell className="text-right">{num(r.returned)}</TableCell>
                      <TableCell className="text-right">{num(r.damaged)}</TableCell>
                      <TableCell className="text-right">{num(r.corrections)}</TableCell>
                      <TableCell className="text-right font-medium">{num(r.closing)}</TableCell>
                      <TableCell className="text-right">{num(r.qty_invoiced)}</TableCell>
                      <TableCell className="text-right">{money(r.value_invoiced)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell>Total</TableCell>
                    <TableCell className="text-right">{num(s.period.stock.opening)}</TableCell>
                    <TableCell className="text-right">{num(s.period.stock.issued)}</TableCell>
                    <TableCell className="text-right">{num(s.period.stock.sold)}</TableCell>
                    <TableCell className="text-right">{num(s.period.stock.returned)}</TableCell>
                    <TableCell className="text-right">{num(s.period.stock.damaged)}</TableCell>
                    <TableCell className="text-right">{num(s.period.stock.corrections)}</TableCell>
                    <TableCell className="text-right">{num(s.period.stock.closing)}</TableCell>
                    <TableCell />
                    <TableCell className="text-right">{money(s.period.sales.value)}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="rounded-2xl">
              <CardHeader>
                <CardTitle className="text-base">Customers owing</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableBody>
                    {s.debtors.map((d) => (
                      <TableRow key={d.customer + d.phone}>
                        <TableCell>{d.customer}</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">
                          {d.invoices} inv.
                        </TableCell>
                        <TableCell className="text-right text-destructive">
                          {money(d.outstanding)}
                        </TableCell>
                      </TableRow>
                    ))}
                    {s.debtors.length === 0 && (
                      <TableRow>
                        <TableCell className="py-4 text-center text-muted-foreground">
                          Nobody owes anything.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card className="rounded-2xl">
              <CardHeader>
                <CardTitle className="text-base">Outstanding reconciliation items</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {s.period.unremitted > 0.005 && (
                  <p className="text-amber-700">
                    Collections not yet remitted: {money(s.period.unremitted)}
                  </p>
                )}
                {s.reconciliation.pending_sales.map((x) => (
                  <p key={x.invoice}>
                    Sale awaiting approval: {x.invoice} ({money(Number(x.amount))})
                  </p>
                ))}
                {s.reconciliation.overdue_debts.map((x) => (
                  <p key={(x.invoice ?? "") + x.customer} className="text-destructive">
                    Overdue: {x.customer} {x.invoice} — {money(Number(x.outstanding))} (due{" "}
                    {fmtDate(x.due)})
                  </p>
                ))}
                {s.reconciliation.stock_drift.map((x) => (
                  <p key={x.product} className="text-destructive">
                    Stock record mismatch on {x.product}: trail {num(Number(x.trail))} vs on record{" "}
                    {num(Number(x.on_record))}
                  </p>
                ))}
                {s.period.unremitted <= 0.005 &&
                  !s.reconciliation.pending_sales.length &&
                  !s.reconciliation.overdue_debts.length &&
                  !s.reconciliation.stock_drift.length && (
                    <p className="text-muted-foreground">Nothing outstanding.</p>
                  )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- Reports & history */

function ReportsTab({
  factoryId,
  repId,
  repName,
  access,
}: {
  factoryId: string;
  repId: string;
  repName: string;
  access: Access;
}) {
  const months = useMarketerMonths(repId, 12);
  return (
    <div className="space-y-4">
      {access.money && (
        <Card className="rounded-2xl">
          <CardHeader className="flex flex-row items-start flex-wrap justify-between gap-2">
            <div>
              <CardTitle className="text-base">Monthly performance (last 12 months)</CardTitle>
              <p className="text-xs text-muted-foreground">
                The figures commission will be worked out from once management sets the rules. No
                commission is calculated here; credit sales and unpaid debt are shown apart from
                money collected.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={!months.data?.length}
              onClick={() =>
                exportCsv(
                  `performance-${repName}`,
                  [
                    { key: "month", label: "Month" },
                    { key: "sales_count", label: "Invoices" },
                    { key: "units", label: "Units sold" },
                    { key: "sales_value", label: "Sales value" },
                    { key: "credit_sales", label: "Credit sales" },
                    { key: "collected", label: "Collected" },
                    { key: "cash", label: "Cash" },
                    { key: "other", label: "Transfer/other" },
                    { key: "remitted", label: "Remitted" },
                  ],
                  months.data ?? [],
                )
              }
            >
              <FileDown className="h-4 w-4" /> CSV
            </Button>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {months.isLoading ? (
              <Loading />
            ) : months.isError ? (
              <LoadError error={months.error} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Invoices</TableHead>
                    <TableHead className="text-right">Units sold</TableHead>
                    <TableHead className="text-right">Sales value</TableHead>
                    <TableHead className="text-right">Credit sales</TableHead>
                    <TableHead className="text-right">Collected</TableHead>
                    <TableHead className="text-right">Cash</TableHead>
                    <TableHead className="text-right">Transfer/other</TableHead>
                    <TableHead className="text-right">Remitted</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(months.data ?? []).map((m) => (
                    <TableRow key={m.month}>
                      <TableCell>
                        {new Date(`${m.month}T00:00:00`).toLocaleDateString("en-GB", {
                          month: "short",
                          year: "numeric",
                        })}
                      </TableCell>
                      <TableCell className="text-right">{m.sales_count}</TableCell>
                      <TableCell className="text-right">{num(m.units)}</TableCell>
                      <TableCell className="text-right">{money(m.sales_value)}</TableCell>
                      <TableCell className="text-right">{money(m.credit_sales)}</TableCell>
                      <TableCell className="text-right">{money(m.collected)}</TableCell>
                      <TableCell className="text-right">{money(m.cash)}</TableCell>
                      <TableCell className="text-right">{money(m.other)}</TableCell>
                      <TableCell className="text-right">{money(m.remitted)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
      <RepActivityCard
        factoryId={factoryId}
        repId={repId}
        repName={repName}
        showValues={access.money}
      />
    </div>
  );
}

// A marketer entered twice is merged into the real one: their stock, sales,
// payments, remittances, customers and containers move across and the
// duplicate is deleted. One with no records at all can simply be deleted.
// Anyone else with history is kept (set them inactive under Edit profile).
function RemoveMarketerDialog({
  factoryId,
  repId,
  repName,
  kind,
  onDone,
}: {
  factoryId: string;
  repId: string;
  repName: string;
  kind: string;
  onDone: (mergedInto: string | null) => void;
}) {
  const qc = useQueryClient();
  const dir = useMarketerDirectory(factoryId);
  const [into, setInto] = useState("none");
  const [reason, setReason] = useState("");
  const others = (dir.data ?? []).filter((r) => r.id !== repId && r.kind === kind);
  const target = others.find((r) => r.id === into);
  const save = useMutation({
    mutationFn: () =>
      marketerRpc.removeMarketer(repId, reason.trim(), into === "none" ? null : into),
    onSuccess: () => {
      toast.success(target ? `${repName} merged into ${target.full_name}` : `${repName} deleted`);
      invalidateMarketerData(qc);
      qc.invalidateQueries({ queryKey: ["dist-reps"] });
      onDone(target ? target.id : null);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Remove {repName}</DialogTitle>
        <DialogDescription>
          If {repName} was entered twice, merge this record into the real one: everything recorded
          here moves across and this record is deleted. A marketer with no records can be deleted
          outright. A real marketer who has left should be set inactive instead (Edit profile), so
          their history stays.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Merge into</Label>
          <Select value={into} onValueChange={setInto}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                Don&apos;t merge — just delete (only if no records)
              </SelectItem>
              {others.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.full_name}
                  {r.code ? ` (${r.code})` : ""}
                  {r.status !== "active" ? " — inactive" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Reason *</Label>
          <Textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={target ? "e.g. Same person entered twice" : "e.g. Created by mistake"}
          />
        </div>
      </div>
      <DialogFooter>
        <Button
          variant="destructive"
          disabled={reason.trim().length < 3 || save.isPending}
          onClick={() => save.mutate()}
        >
          {target ? `Merge into ${target.full_name}` : "Delete marketer"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
