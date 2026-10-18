import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SectionTabs } from "@/components/layout/section-tabs";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { printSaleInvoice } from "@/lib/invoice";
import { money, num } from "@/lib/format";
import { exportCsv } from "@/lib/export";
import {
  fmtDate,
  lineCharged,
  lineCredited,
  marketerRpc,
  periodLabel,
  useCustomerFollowups,
  useCustomerStatement,
  type StatementInvoice,
} from "@/lib/marketer-accounts";
import { companyOf, generateCustomerAccountPdf } from "@/lib/marketer-pdf";
import {
  InvoicePaymentDialog,
  LoadError,
  Loading,
  PeriodPicker,
  StatTile,
  invalidateMarketerData,
  usePeriod,
} from "@/components/marketers/shared";
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
import { ArrowLeft, Check, FileDown, Pencil, Printer, Repeat, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

// Marketer Profile → Customer Accounts → Customer Details: one customer's
// whole account from their first recorded transaction — what they bought (at
// the prices charged), what they paid and how each payment was applied, what
// they still owe, and a printable statement for any period.
const TABS = [
  { key: "info", label: "Customer information" },
  { key: "purchases", label: "Purchase history" },
  { key: "outstanding", label: "Outstanding invoices" },
  { key: "payments", label: "Payments" },
  { key: "statement", label: "Account statement" },
  { key: "notes", label: "Notes & follow-ups" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export const Route = createFileRoute("/_app/marketer-accounts_/$repId_/customers/$customerId")({
  head: () => ({
    meta: [
      { title: "Customer Account — Elim Table Water" },
      { name: "robots", content: "noindex" },
    ],
  }),
  validateSearch: (s: Record<string, unknown>): { tab?: TabKey } => ({
    tab: TABS.some((t) => t.key === s.tab) ? (s.tab as TabKey) : undefined,
  }),
  component: () => (
    <>
      <SectionTabs section="Marketer & Retail Accounts" />
      <CustomerPage />
    </>
  ),
});

function CustomerPage() {
  const { repId, customerId } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: factoryId } = useFactoryId();
  const perms = usePermissions();
  // The whole account (all history) drives the header and most tabs.
  const all = useCustomerStatement(customerId, null, null);
  const [paying, setPaying] = useState<StatementInvoice | "account" | null>(null);

  if (perms.loading) return <Loading />;
  if (all.isError)
    return (
      <Card className="rounded-2xl border-dashed">
        <CardContent className="flex items-center gap-2 pt-6 text-sm text-muted-foreground">
          <ShieldAlert className="h-5 w-5 text-destructive" /> {(all.error as Error).message}
        </CardContent>
      </Card>
    );
  if (all.isLoading || !all.data || !factoryId) return <Loading />;

  const s = all.data;
  const c = s.customer;
  const canCollect = perms.canWrite("payments") || perms.canWrite("debts");
  const canEdit = perms.can("customers", "edit") || perms.can("marketer-accounts", "edit");
  const owingInvoices = s.invoices.filter((i) => i.outstanding > 0);
  const totalPurchases = s.invoices.reduce((t, i) => t + i.grand_total, 0);
  const totalPaid = s.invoices.reduce((t, i) => t + i.paid, 0);
  const setTab = (v: string) =>
    navigate({ search: { tab: v === "info" ? undefined : (v as TabKey) }, replace: true });
  const owningRep = s.marketer?.id ?? repId;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            to="/marketer-accounts/$repId"
            params={{ repId }}
            search={{ tab: "customers" }}
            className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" /> Back to marketer
          </Link>
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
            {c.name}
            <Badge variant={c.status === "active" ? "secondary" : "outline"}>{c.status}</Badge>
            {!c.registered && <Badge variant="outline">walk-in record</Badge>}
          </h1>
          <p className="text-sm text-muted-foreground">
            {[
              c.phone,
              c.address,
              s.marketer ? `Marketer: ${s.marketer.name}` : "No marketer assigned",
              `Customer since ${fmtDate(s.first_purchase ?? c.registered_at)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="gap-1" onClick={() => setTab("statement")}>
            <Printer className="h-4 w-4" /> Print customer statement
          </Button>
          {canCollect && s.closing.debt > 0 && (
            <Button size="sm" onClick={() => setPaying("account")}>
              Record payment
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label="Total purchases"
          value={money(totalPurchases)}
          hint={`${s.invoices.length} invoices`}
        />
        <StatTile label="Total paid" value={money(totalPaid)} tone="ok" />
        <StatTile
          label="Outstanding balance"
          value={money(s.closing.debt)}
          hint={`${owingInvoices.length} unpaid invoice(s)`}
          tone={s.closing.debt > 0 ? "debt" : "ok"}
        />
        <StatTile label="Advance held" value={money(s.closing.advance)} />
        <StatTile
          label="Credit limit"
          value={c.credit_limit == null ? "No limit" : money(Number(c.credit_limit))}
          hint={c.credit_days ? `${c.credit_days} days to pay` : undefined}
        />
      </div>

      <Tabs value={tab ?? "info"} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap">
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="info" className="mt-4">
          <InfoTab factoryId={factoryId} customerId={customerId} statement={s} canEdit={canEdit} />
        </TabsContent>
        <TabsContent value="purchases" className="mt-4">
          <PurchasesTab factoryId={factoryId} customerId={customerId} />
        </TabsContent>
        <TabsContent value="outstanding" className="mt-4">
          <Card className="rounded-2xl">
            <CardContent className="pt-6">
              <InvoicesTable
                factoryId={factoryId}
                rows={owingInvoices}
                onPay={canCollect ? (i) => setPaying(i) : undefined}
                empty="Nothing outstanding — every invoice is paid."
              />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="payments" className="mt-4">
          <PaymentsCard statement={s} />
        </TabsContent>
        <TabsContent value="statement" className="mt-4">
          <StatementTab factoryId={factoryId} customerId={customerId} />
        </TabsContent>
        <TabsContent value="notes" className="mt-4">
          <NotesTab customerId={customerId} />
        </TabsContent>
      </Tabs>

      <Dialog open={!!paying} onOpenChange={(v) => !v && setPaying(null)}>
        {paying && (
          <InvoicePaymentDialog
            factoryId={factoryId}
            customerId={customerId}
            customerName={c.name}
            saleId={paying === "account" ? undefined : paying.sale_id}
            invoiceNumber={paying === "account" ? undefined : paying.invoice_number}
            owed={paying === "account" ? s.closing.debt : paying.outstanding}
            repId={owningRep}
            repName={s.marketer?.name ?? null}
            onDone={() => setPaying(null)}
          />
        )}
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------- Info */

function InfoTab({
  factoryId,
  customerId,
  statement: s,
  canEdit,
}: {
  factoryId: string;
  customerId: string;
  statement: NonNullable<ReturnType<typeof useCustomerStatement>["data"]>;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const c = s.customer;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Details</CardTitle>
          {canEdit && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="gap-1" onClick={() => setMoving(true)}>
                <Repeat className="h-4 w-4" /> Change marketer
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1"
                onClick={() => setEditing(true)}
              >
                <Pencil className="h-4 w-4" /> Edit
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{c.name}</dd>
            <dt className="text-muted-foreground">Phone</dt>
            <dd>{c.phone ?? "—"}</dd>
            <dt className="text-muted-foreground">Address / market</dt>
            <dd>{c.address ?? "—"}</dd>
            <dt className="text-muted-foreground">Other contact</dt>
            <dd>{c.email ?? "—"}</dd>
            <dt className="text-muted-foreground">Assigned marketer</dt>
            <dd>
              {s.marketer
                ? `${s.marketer.name}${s.marketer.code ? ` (${s.marketer.code})` : ""}`
                : "Unassigned"}
            </dd>
            <dt className="text-muted-foreground">Status</dt>
            <dd className="capitalize">{c.status}</dd>
            <dt className="text-muted-foreground">Registered</dt>
            <dd>{fmtDate(c.registered_at)}</dd>
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="whitespace-pre-wrap">{c.notes ?? "—"}</dd>
          </dl>
        </CardContent>
      </Card>
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base">Marketer history</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableBody>
              {s.marketer_history.map((h, i) => (
                <TableRow key={i}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(h.changed_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-sm">
                    {h.from ? `${h.from} → ` : ""}
                    {h.to ?? "Unassigned"}
                    {h.reason && (
                      <span className="block text-xs text-muted-foreground">{h.reason}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {s.marketer_history.length === 0 && (
                <TableRow>
                  <TableCell className="py-4 text-center text-muted-foreground">
                    No assignment recorded.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <p className="mt-2 text-xs text-muted-foreground">
            Moving a customer to another marketer does not move their past invoices or payments;
            those stay with the marketer who made them.
          </p>
        </CardContent>
      </Card>
      <Dialog open={editing} onOpenChange={setEditing}>
        {editing && (
          <EditCustomerDialog
            customerId={customerId}
            statement={s}
            onDone={() => setEditing(false)}
          />
        )}
      </Dialog>
      <Dialog open={moving} onOpenChange={setMoving}>
        {moving && (
          <ReassignDialog
            factoryId={factoryId}
            customerId={customerId}
            current={s.marketer?.id ?? null}
            onDone={() => setMoving(false)}
          />
        )}
      </Dialog>
    </div>
  );
}

function EditCustomerDialog({
  customerId,
  statement: s,
  onDone,
}: {
  customerId: string;
  statement: NonNullable<ReturnType<typeof useCustomerStatement>["data"]>;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: s.customer.name,
    phone: s.customer.phone ?? "",
    address: s.customer.address ?? "",
    email: s.customer.email ?? "",
    status: s.customer.status,
    notes: s.customer.notes ?? "",
  });
  const save = useMutation({
    mutationFn: () => marketerRpc.updateCustomer(customerId, f),
    onSuccess: () => {
      toast.success("Customer updated");
      invalidateMarketerData(qc);
      qc.invalidateQueries({ queryKey: ["customers"] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Edit customer</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Name</Label>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Phone</Label>
            <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </div>
          <div>
            <Label>Status</Label>
            <Select
              value={f.status}
              onValueChange={(v) => setF({ ...f, status: v as typeof f.status })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="dormant">Dormant</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label>Address / market location</Label>
          <Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </div>
        <div>
          <Label>Email / other contact</Label>
          <Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </div>
        <div>
          <Label>Notes</Label>
          <Textarea
            rows={2}
            value={f.notes}
            onChange={(e) => setF({ ...f, notes: e.target.value })}
          />
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

function ReassignDialog({
  factoryId,
  customerId,
  current,
  onDone,
}: {
  factoryId: string;
  customerId: string;
  current: string | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [to, setTo] = useState<string>("");
  const [reason, setReason] = useState("");
  const reps = useQuery({
    queryKey: ["dist-reps", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_reps")
        .select("id,full_name,status,kind")
        .eq("factory_id", factoryId)
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const save = useMutation({
    mutationFn: () => marketerRpc.reassign(customerId, to === "none" ? null : to, reason.trim()),
    onSuccess: () => {
      toast.success("Marketer changed. Past transactions stay with the original marketer.");
      invalidateMarketerData(qc);
      onDone();
      if (to && to !== "none")
        navigate({
          to: "/marketer-accounts/$repId/customers/$customerId",
          params: { repId: to, customerId },
        });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Change marketer</DialogTitle>
        <DialogDescription>
          New sales will belong to the new marketer. Earlier invoices, payments and debts stay with
          the marketer who made them. The change is recorded with your name and reason.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>New marketer</Label>
          <Select value={to} onValueChange={setTo}>
            <SelectTrigger>
              <SelectValue placeholder="Choose…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Unassigned</SelectItem>
              {(reps.data ?? [])
                .filter((r) => r.id !== current && r.status === "active")
                .map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.full_name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Reason *</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={!to || reason.trim().length < 3 || save.isPending}
          onClick={() => save.mutate()}
        >
          Change marketer
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/* --------------------------------------------------------------- Invoices */

function InvoicesTable({
  factoryId,
  rows,
  onPay,
  empty,
}: {
  factoryId: string;
  rows: StatementInvoice[];
  onPay?: (i: StatementInvoice) => void;
  empty: string;
}) {
  const settings = useFactorySettings(factoryId);
  const t = rows.reduce(
    (a, r) => ({ v: a.v + r.grand_total, p: a.p + r.paid, o: a.o + r.outstanding }),
    { v: 0, p: 0, o: 0 },
  );
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Invoice</TableHead>
            <TableHead>Products (qty @ price charged)</TableHead>
            <TableHead className="text-right">Invoice value</TableHead>
            <TableHead>Payments</TableHead>
            <TableHead className="text-right">Paid</TableHead>
            <TableHead className="text-right">Outstanding</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((i) => (
            <TableRow key={i.sale_id}>
              <TableCell className="whitespace-nowrap">{fmtDate(i.sale_date)}</TableCell>
              <TableCell className="font-mono text-xs">
                {i.invoice_number}
                {i.marketer && (
                  <span className="block font-sans text-[10px] text-muted-foreground">
                    {i.marketer}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-xs">
                {i.items.map((x, k) => (
                  <div key={k}>
                    {x.product} × {num(x.quantity)} @ {money(x.unit_price)} = {money(x.line_total)}
                  </div>
                ))}
              </TableCell>
              <TableCell className="text-right">{money(i.grand_total)}</TableCell>
              <TableCell className="text-xs">
                {i.payments.map((p, k) => (
                  <div key={k}>
                    {fmtDate(p.date)} {p.receipt ?? (p.kind === "advance" ? "from advance" : "")}{" "}
                    {p.method && (
                      <span className="capitalize text-muted-foreground">({p.method})</span>
                    )}{" "}
                    {money(p.amount)}
                  </div>
                ))}
                {i.written_off > 0 && (
                  <div className="text-muted-foreground">written off {money(i.written_off)}</div>
                )}
              </TableCell>
              <TableCell className="text-right">{money(i.paid)}</TableCell>
              <TableCell
                className={`text-right font-medium ${i.outstanding > 0 ? "text-destructive" : ""}`}
              >
                {i.outstanding > 0 ? money(i.outstanding) : <Badge variant="secondary">Paid</Badge>}
                {i.due_date && i.outstanding > 0 && (
                  <span className="block text-[10px] font-normal text-muted-foreground">
                    due {fmtDate(i.due_date)}
                  </span>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Button
                  size="sm"
                  variant="ghost"
                  title="Print invoice"
                  onClick={() => printSaleInvoice(i.sale_id, settings.data, "print")}
                >
                  <Printer className="h-4 w-4" />
                </Button>
                {onPay && i.outstanding > 0 && (
                  <Button size="sm" variant="outline" onClick={() => onPay(i)}>
                    Record payment
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                {empty}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
        {rows.length > 0 && (
          <TableFooter>
            <TableRow>
              <TableCell colSpan={3}>Total ({rows.length})</TableCell>
              <TableCell className="text-right">{money(t.v)}</TableCell>
              <TableCell />
              <TableCell className="text-right">{money(t.p)}</TableCell>
              <TableCell className="text-right">{money(t.o)}</TableCell>
              <TableCell />
            </TableRow>
          </TableFooter>
        )}
      </Table>
    </div>
  );
}

function PurchasesTab({ factoryId, customerId }: { factoryId: string; customerId: string }) {
  const p = usePeriod("all");
  const q = useCustomerStatement(customerId, p.range.from, p.range.to);
  const rows = (q.data?.invoices ?? []).filter((i) => i.in_period);
  const products = useMemo(() => {
    const m = new Map<string, { qty: number; value: number; unit: string }>();
    for (const i of rows)
      for (const x of i.items) {
        const e = m.get(x.product) ?? { qty: 0, value: 0, unit: x.unit };
        e.qty += x.quantity;
        e.value += x.line_total;
        m.set(x.product, e);
      }
    return [...m.entries()];
  }, [rows]);
  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end justify-between gap-3 pt-6">
          <PeriodPicker value={p.state} onChange={p.setState} />
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={!rows.length}
            onClick={() =>
              exportCsv(
                `purchases-${q.data?.customer.name ?? "customer"}`,
                [
                  { key: "date", label: "Date" },
                  { key: "invoice", label: "Invoice" },
                  { key: "product", label: "Product" },
                  { key: "quantity", label: "Quantity" },
                  { key: "unit_price", label: "Unit price" },
                  { key: "line_total", label: "Line total" },
                ],
                rows.flatMap((i) =>
                  i.items.map((x) => ({ date: i.sale_date, invoice: i.invoice_number, ...x })),
                ),
              )
            }
          >
            <FileDown className="h-4 w-4" /> CSV
          </Button>
        </CardContent>
      </Card>
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <LoadError error={q.error} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label={`Purchases — ${periodLabel(p.range)}`}
              value={money(rows.reduce((t, i) => t + i.grand_total, 0))}
              hint={`${rows.length} invoices`}
            />
            <StatTile
              label="Paid on these"
              value={money(rows.reduce((t, i) => t + i.paid, 0))}
              tone="ok"
            />
            <StatTile
              label="Still owing on these"
              value={money(rows.reduce((t, i) => t + i.outstanding, 0))}
              tone={rows.some((i) => i.outstanding > 0) ? "debt" : "ok"}
            />
            <StatTile
              label="Part-paid invoices"
              value={String(rows.filter((i) => i.paid > 0 && i.outstanding > 0).length)}
            />
          </div>
          {products.length > 0 && (
            <Card className="rounded-2xl">
              <CardHeader>
                <CardTitle className="text-base">By product</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Units</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {products.map(([name, v]) => (
                      <TableRow key={name}>
                        <TableCell>{name}</TableCell>
                        <TableCell className="text-right">
                          {num(v.qty)} {v.unit}
                        </TableCell>
                        <TableCell className="text-right">{money(v.value)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
          <Card className="rounded-2xl">
            <CardContent className="pt-6">
              <InvoicesTable
                factoryId={factoryId}
                rows={rows}
                empty="No purchases in this period."
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- Payments */

function PaymentsCard({
  statement: s,
}: {
  statement: NonNullable<ReturnType<typeof useCustomerStatement>["data"]>;
}) {
  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle className="text-base">Payments and how they were applied</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Receipt</TableHead>
              <TableHead>Method</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Applied to</TableHead>
              <TableHead>Collected by</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.payments.map((p) => {
              const void_ = p.status === "reversed" || p.status === "rejected";
              return (
                <TableRow key={p.payment_id} className={void_ ? "opacity-50" : ""}>
                  <TableCell className="whitespace-nowrap">{fmtDate(p.date)}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {p.receipt}
                    {p.remarks && (
                      <span className="block font-sans text-[10px] text-muted-foreground">
                        {p.remarks}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="capitalize">{p.method}</TableCell>
                  <TableCell className="text-right">{money(p.amount)}</TableCell>
                  <TableCell className="text-xs">
                    {p.allocations.map((a, i) => (
                      <div key={i}>
                        {a.invoice}: {money(a.amount)}
                      </div>
                    ))}
                  </TableCell>
                  <TableCell className="text-xs">
                    {p.at_point_of_sale ? "At sale" : (p.collected_by ?? "Factory")}
                  </TableCell>
                  <TableCell>
                    {void_ ? (
                      <Badge variant="destructive">{p.status}</Badge>
                    ) : (
                      <Badge variant="secondary">recorded</Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {s.payments.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  No payments recorded.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------- Statement */

function StatementTab({ factoryId, customerId }: { factoryId: string; customerId: string }) {
  const settings = useFactorySettings(factoryId);
  const p = usePeriod("this_month");
  const q = useCustomerStatement(customerId, p.range.from, p.range.to);
  const label = periodLabel(p.range);
  const s = q.data;
  const pdf = (action: "print" | "download") =>
    s &&
    generateCustomerAccountPdf(
      {
        company: companyOf(settings.data),
        statement: s,
        periodLabel: label,
        currency: settings.data?.currency ?? "NGN",
      },
      action,
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
              <Printer className="h-4 w-4" /> Print (A4)
            </Button>
          </div>
        </CardContent>
      </Card>
      {q.isLoading && <Loading />}
      {q.isError && <LoadError error={q.error} />}
      {s && (
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="text-base">
              {s.customer.name} — {label}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Opening balance {money(s.opening.debt)} · closing balance{" "}
              <span className={s.closing.debt > 0 ? "font-medium text-destructive" : ""}>
                {money(s.closing.debt)}
              </span>
              {s.closing.advance > 0 && ` · advance held ${money(s.closing.advance)}`}
            </p>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Invoice / receipt</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Charged</TableHead>
                  <TableHead className="text-right">Paid / credited</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.from && (
                  <TableRow>
                    <TableCell>{fmtDate(s.from)}</TableCell>
                    <TableCell />
                    <TableCell className="font-medium">Balance brought forward</TableCell>
                    <TableCell />
                    <TableCell />
                    <TableCell className="text-right font-medium">
                      {money(s.opening.debt)}
                    </TableCell>
                  </TableRow>
                )}
                {s.lines.map((l) => {
                  const ch = lineCharged(l);
                  const cr = lineCredited(l);
                  return (
                    <TableRow key={l.seq}>
                      <TableCell className="whitespace-nowrap">{fmtDate(l.date)}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {l.invoice ?? l.receipt ?? ""}
                      </TableCell>
                      <TableCell className="text-sm">
                        {l.description ?? l.type}
                        {l.method && l.type !== "SALE" && (
                          <span className="capitalize text-muted-foreground"> ({l.method})</span>
                        )}
                        {l.items?.map((x, k) => (
                          <span key={k} className="block text-xs text-muted-foreground">
                            {x.product} × {num(x.quantity)} @ {money(x.unit_price)}
                          </span>
                        ))}
                      </TableCell>
                      <TableCell className="text-right">{ch ? money(ch) : ""}</TableCell>
                      <TableCell className="text-right">{cr ? money(cr) : ""}</TableCell>
                      <TableCell className="text-right">{money(l.debt_after)}</TableCell>
                    </TableRow>
                  );
                })}
                {s.lines.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                      No transactions in this period.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={5}>Closing balance</TableCell>
                  <TableCell className="text-right">{money(s.closing.debt)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
            {s.returns.length > 0 && (
              <div className="mt-4">
                <p className="mb-1 text-sm font-medium">Goods returned</p>
                {s.returns.map((r) => (
                  <p key={r.return_number + r.product} className="text-xs text-muted-foreground">
                    {fmtDate(r.date)} {r.return_number}: {r.product} × {num(Number(r.quantity))} (
                    {r.status}){r.invoice && ` on ${r.invoice}`}
                  </p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ Notes */

function NotesTab({ customerId }: { customerId: string }) {
  const qc = useQueryClient();
  const q = useCustomerFollowups(customerId);
  const [note, setNote] = useState("");
  const [date, setDate] = useState("");
  const add = useMutation({
    mutationFn: () => marketerRpc.addFollowup(customerId, note.trim(), date || null),
    onSuccess: () => {
      setNote("");
      setDate("");
      qc.invalidateQueries({ queryKey: ["cust-followups", customerId] });
      qc.invalidateQueries({ queryKey: ["mkt-customers"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const done = useMutation({
    mutationFn: (id: string) => marketerRpc.completeFollowup(id, null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cust-followups", customerId] });
      qc.invalidateQueries({ queryKey: ["mkt-customers"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base">Add a note or follow-up</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Promised to pay the balance on Friday"
          />
          <div>
            <Label className="text-xs">Follow up on (optional)</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <Button disabled={!note.trim() || add.isPending} onClick={() => add.mutate()}>
            Save
          </Button>
        </CardContent>
      </Card>
      <Card className="rounded-2xl">
        <CardContent className="space-y-3 pt-6">
          {q.isLoading && <Loading />}
          {(q.data ?? []).map((f) => (
            <div key={f.id} className="rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="whitespace-pre-wrap text-sm">{f.note}</p>
                {f.status === "open" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1"
                    onClick={() => done.mutate(f.id)}
                  >
                    <Check className="h-4 w-4" /> Done
                  </Button>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {new Date(f.created_at).toLocaleString()}
                {f.follow_up_date && (
                  <>
                    {" · follow up "}
                    <span
                      className={
                        f.status === "open" && f.follow_up_date < today
                          ? "font-medium text-destructive"
                          : ""
                      }
                    >
                      {fmtDate(f.follow_up_date)}
                    </span>
                  </>
                )}
                {f.status === "done" &&
                  ` · done ${f.done_at ? new Date(f.done_at).toLocaleDateString() : ""}`}
              </p>
            </div>
          ))}
          {!q.isLoading && (q.data ?? []).length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No notes yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
