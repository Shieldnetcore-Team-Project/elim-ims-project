import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { logAudit } from "@/lib/audit";
import { money } from "@/lib/format";
import { useFactorySettings } from "@/lib/use-factory";
import { printSaleInvoice } from "@/lib/invoice";
import { printDispatchSlip } from "@/lib/dispatch-slip";
import { Link } from "@tanstack/react-router";
import { RemittanceDialog, type Rep } from "@/routes/_app.distribution";
import { CustomerPaymentDialog } from "./customer-payment-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CheckCircle2, HandCoins, Loader2, Printer, Search, X } from "lucide-react";

export type Posting = {
  kind: "marketer" | "retail" | "distributor" | "chairmans_gift";
  posting_kind: "dispatch" | "sale" | "gift";
  posting_id: string;
  reference: string;
  at: string;
  party_id: string;
  party: string;
  items: string | null;
  value: number;
  paid: number | null;
  balance: number | null;
  status: string;
  assessed_at: string | null;
  assessed_by: string | null;
  assessment_remarks: string | null;
};

const KIND: Record<Posting["kind"], string> = {
  marketer: "Marketer",
  retail: "Retail shop",
  distributor: "Distributor",
  chairmans_gift: "Chairman's gift",
};

const statusVariant = (s: string): "default" | "secondary" | "outline" | "destructive" => {
  if (s === "posted") return "default";
  if (["rejected", "cancelled", "reversed"].includes(s)) return "destructive";
  return "secondary";
};

// Warehouse postings to marketers and distributors land here for Accounts to
// confirm, print the receipt and enter payment against (accounting_postings).
//   distributor  posted when the Warehouse saves it, stock out at once
//                (20261029140000); Confirm marks it checked (assess_posting)
//                and prints the receipt; payment is a receipt on the invoice,
//                any time. An older one still pending is posted by Confirm
//                (confirm_warehouse_posting) or sent back by Reject.
//   marketer     Confirm marks the dispatch checked (assess_posting) and
//                prints its slip; payment is a remittance to the account
// Postings to the Company Retail Shop are settled on Retail cash-up instead
// (what was posted, sold, left and the money handed over), so they aren't
// listed here. A chairman's gift is reviewed for the record only.
// Distributor postings are posted at once from this day; older posted ones
// were approved on the Sales page and aren't waiting on Accounts.
const POSTED_AT_ONCE_FROM = new Date("2026-10-29T00:00:00+01:00");

export function PostingsTab({ factoryId, currency }: { factoryId: string; currency: string }) {
  const qc = useQueryClient();
  const perms = usePermissions();
  const canAssess =
    perms.canWrite("payments") || perms.canWrite("debts") || perms.canPost("distribution");
  const canPayInvoice = perms.canWrite("payments") || perms.canWrite("debts");
  const canRemit = perms.canPost("distribution");
  // confirm_warehouse_posting / reject_warehouse_posting: finance + payments
  // or debts write.
  const canConfirmSale = canPayInvoice;
  const settings = useFactorySettings(factoryId);
  const printReceipt = (p: Posting) =>
    p.posting_kind === "sale"
      ? printSaleInvoice(p.posting_id, settings.data, "print")
      : printDispatchSlip({ id: p.posting_id }, settings.data, "print");

  const [kind, setKind] = useState<"all" | Posting["kind"]>("all");
  const [state, setState] = useState<"to_assess" | "assessed" | "all">("to_assess");
  const [q, setQ] = useState("");
  const [assessing, setAssessing] = useState<Posting | null>(null);
  const [paying, setPaying] = useState<Posting | null>(null);

  useRealtimeInvalidate(
    [
      "stock_dispatches",
      "sales",
      "payments_received",
      "rep_remittances",
      "chairmans_gifts",
      "posting_assessments",
    ],
    [["acct-postings"], ["pending-attention"]],
  );

  const postings = useQuery({
    queryKey: ["acct-postings", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "accounting_postings" as never,
        { p_factory: factoryId, p_limit: 500 } as never,
      );
      if (error) throw error;
      // The shop's postings are settled on Retail cash-up.
      return ((data ?? []) as unknown as Posting[]).filter((p) => p.kind !== "retail");
    },
    // Realtime refreshes this the moment something changes; this only catches
    // an event the browser missed.
    refetchInterval: 30_000,
  });

  // Marketers and the shop, for the remittance dialog's picker. Readable with
  // distribution view, which whoever can record a remittance holds.
  const reps = useQuery({
    queryKey: ["dist-reps", factoryId],
    enabled: canRemit,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_reps")
        .select("id,code,full_name,phone,status,employee_id,remarks,kind")
        .eq("factory_id", factoryId)
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as Rep[];
    },
  });

  const all = useMemo(() => postings.data ?? [], [postings.data]);
  // Still waiting on Accounts: any posting not yet confirmed. A distributor
  // sale is posted (stock out) when the Warehouse saves it (20261029140000);
  // an older one may still be pending.
  const waiting = (p: Posting) =>
    p.posting_kind === "sale"
      ? p.status === "pending_approval" ||
        (p.status === "posted" && !p.assessed_at && new Date(p.at) >= POSTED_AT_ONCE_FROM)
      : !p.assessed_at && p.status !== "reversed";
  const toAssess = all.filter(waiting);
  const shown = useMemo(() => {
    const key = q.trim().toLowerCase();
    return all.filter(
      (p) =>
        (kind === "all" || p.kind === kind) &&
        (state === "all" || (state === "assessed" ? !waiting(p) : waiting(p))) &&
        (!key ||
          p.reference.toLowerCase().includes(key) ||
          p.party.toLowerCase().includes(key) ||
          (p.items ?? "").toLowerCase().includes(key)),
    );
  }, [all, kind, state, q]);

  const payable = (p: Posting) =>
    p.posting_kind === "gift"
      ? false
      : p.posting_kind === "sale"
        ? canPayInvoice && p.status === "posted" && Number(p.balance ?? 0) > 0
        : canRemit && p.status === "posted";
  const payHint = (p: Posting) => {
    if (p.posting_kind === "gift") return "Chairman's gift — nothing to pay, record only";
    if (p.posting_kind === "sale" && p.status === "pending_approval")
      return "Confirm the sale first";
    if (p.posting_kind === "sale" && p.status !== "posted")
      return `Sale ${p.status.replace(/_/g, " ")}`;
    if (p.posting_kind === "sale" && Number(p.balance ?? 0) <= 0) return "Fully paid";
    if (p.status === "reversed") return "Dispatch reversed";
    return "You don't have the right to record this payment";
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="To confirm" value={String(toAssess.length)} warn={toAssess.length > 0} />
        <Stat
          label="Value to confirm"
          value={money(
            toAssess.reduce((t, p) => t + Number(p.value), 0),
            currency,
          )}
        />
        <Stat
          label="Unpaid on distributor invoices"
          value={money(
            all
              .filter((p) => p.posting_kind === "sale" && p.status === "posted")
              .reduce((t, p) => t + Math.max(0, Number(p.balance ?? 0)), 0),
            currency,
          )}
        />
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Postings from the Warehouse</CardTitle>
            <p className="text-sm text-muted-foreground">
              Goods posted to marketers and distributors. Confirm each one and print its receipt,
              then enter the payment against it. Chairman's gifts are reviewed for the record only.
              Postings to the Company Retail Shop are on{" "}
              <Link to="/accountant" search={{ tab: "retail-cashup" }} className="underline">
                Retail cash-up
              </Link>
              .
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={state} onValueChange={(v) => setState(v as typeof state)}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="to_assess">To confirm</SelectItem>
                <SelectItem value="assessed">Confirmed</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All postings</SelectItem>
                <SelectItem value="marketer">Marketers</SelectItem>
                <SelectItem value="distributor">Distributors</SelectItem>
                <SelectItem value="chairmans_gift">Chairman's gifts</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative w-full sm:w-56">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Reference, name…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Products</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Assessment</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((p) => (
                <TableRow key={`${p.posting_kind}-${p.posting_id}`}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(p.at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{KIND[p.kind] ?? p.kind}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{p.reference}</TableCell>
                  <TableCell className="font-medium">{p.party}</TableCell>
                  <TableCell className="max-w-64 text-xs">{p.items ?? "—"}</TableCell>
                  <TableCell className="text-right">{money(Number(p.value), currency)}</TableCell>
                  <TableCell className="text-right">
                    {p.paid == null ? "—" : money(Number(p.paid), currency)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {p.balance == null ? "—" : money(Number(p.balance), currency)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(p.status)} className="capitalize">
                      {p.status.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {p.assessed_at ? (
                      <span title={p.assessment_remarks ?? undefined}>
                        <Badge variant="secondary" className="gap-1">
                          <CheckCircle2 className="h-3 w-3" />{" "}
                          {p.posting_kind === "gift" ? "Reviewed" : "Confirmed"}
                        </Badge>
                        <div className="mt-1 text-muted-foreground">
                          {p.assessed_by ?? "—"} · {new Date(p.assessed_at).toLocaleDateString()}
                        </div>
                      </span>
                    ) : (
                      <Badge variant="outline">To confirm</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {(p.posting_kind === "sale" && p.status === "pending_approval"
                        ? canConfirmSale
                        : canAssess && !p.assessed_at && p.status !== "reversed") && (
                        <Button size="sm" variant="outline" onClick={() => setAssessing(p)}>
                          {p.posting_kind === "gift" ? "Review" : "Confirm"}
                        </Button>
                      )}
                      {p.posting_kind !== "gift" && (
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Print receipt"
                          aria-label="Print receipt"
                          onClick={() => void printReceipt(p)}
                        >
                          <Printer className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        className="gap-1"
                        disabled={!payable(p)}
                        title={payable(p) ? "Enter payment" : payHint(p)}
                        onClick={() => setPaying(p)}
                      >
                        <HandCoins className="h-4 w-4" /> Payment
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {shown.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
                    {postings.isLoading
                      ? "Loading…"
                      : postings.isError
                        ? "Postings aren't available yet."
                        : state === "to_assess"
                          ? "Nothing waiting to be confirmed."
                          : "No postings."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!assessing} onOpenChange={(v) => !v && setAssessing(null)}>
        {assessing && (
          <AssessDialog
            posting={assessing}
            currency={currency}
            factoryId={factoryId}
            onDone={(payNext) => {
              const p = assessing;
              setAssessing(null);
              // A confirmed sale is posted now, so it can take payment.
              const next = p.posting_kind === "sale" ? { ...p, status: "posted" } : p;
              if (payNext && payable(next)) setPaying(next);
            }}
            onPrint={() => printReceipt(assessing)}
            canPay={
              assessing.posting_kind === "sale" && assessing.status === "pending_approval"
                ? canPayInvoice && Number(assessing.value) > Number(assessing.paid ?? 0)
                : payable(assessing)
            }
          />
        )}
      </Dialog>

      <Dialog open={!!paying} onOpenChange={(v) => !v && setPaying(null)}>
        {paying?.posting_kind === "sale" && (
          <CustomerPaymentDialog
            factoryId={factoryId}
            customerId={paying.party_id}
            customerName={paying.party}
            owed={Number(paying.balance ?? 0)}
            sale={{ id: paying.posting_id, invoice_number: paying.reference }}
            adjustable={paying.status === "posted"}
            onDone={() => setPaying(null)}
          />
        )}
        {paying?.posting_kind === "dispatch" && (
          <RemittanceDialog
            factoryId={factoryId}
            reps={(reps.data ?? []).filter(
              (r) => r.status === "active" || r.id === paying.party_id,
            )}
            presetRepId={paying.party_id}
            presetRemarks={`For dispatch ${paying.reference}`}
            onDone={() => {
              setPaying(null);
              for (const key of ["acct-postings", "dist-remittances", "dist-account"])
                qc.invalidateQueries({ queryKey: [key] });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

// Confirm a posting. A distributor sale still pending is posted now
// (confirm_warehouse_posting) or rejected with a reason; any other posting is
// marked checked (assess_posting). Either way the receipt can print straight
// after, and payment can follow.
function AssessDialog({
  posting: p,
  currency,
  factoryId,
  canPay,
  onPrint,
  onDone,
}: {
  posting: Posting;
  currency: string;
  factoryId: string;
  canPay: boolean;
  onPrint: () => void;
  onDone: (payNext: boolean) => void;
}) {
  const qc = useQueryClient();
  const [remarks, setRemarks] = useState("");
  const [print, setPrint] = useState(p.posting_kind !== "gift");
  const pendingSale = p.posting_kind === "sale" && p.status === "pending_approval";

  const refresh = () => {
    for (const key of ["acct-postings", "pending-attention", "sales-list", "acct-sales"])
      qc.invalidateQueries({ queryKey: [key] });
  };

  const assess = useMutation({
    mutationFn: async (payNext: boolean) => {
      if (pendingSale) {
        const { error } = await supabase.rpc(
          "confirm_warehouse_posting" as never,
          { p_id: p.posting_id, p_comment: remarks || null } as never,
        );
        if (error) throw error;
        return { id: p.posting_id, payNext };
      }
      const { data, error } = await supabase.rpc(
        "assess_posting" as never,
        { p_kind: p.posting_kind, p_id: p.posting_id, p_remarks: remarks || null } as never,
      );
      if (error) throw error;
      return { id: data as unknown as string, payNext };
    },
    onSuccess: ({ id, payNext }) => {
      toast.success(
        pendingSale ? `${p.reference} confirmed and posted` : `${p.reference} confirmed`,
      );
      logAudit({
        action: pendingSale ? "approve" : "update",
        entity: pendingSale ? "sales" : "posting_assessments",
        entityId: id,
        factoryId,
      });
      refresh();
      if (print) onPrint();
      onDone(payNext);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reject = useMutation({
    mutationFn: async () => {
      if (!remarks.trim()) throw new Error("Write the reason for rejecting it in Remarks");
      const { error } = await supabase.rpc(
        "reject_warehouse_posting" as never,
        { p_id: p.posting_id, p_reason: remarks.trim() } as never,
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${p.reference} rejected — sent back to the Warehouse`);
      logAudit({ action: "reject", entity: "sales", entityId: p.posting_id, factoryId });
      refresh();
      onDone(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const busy = assess.isPending || reject.isPending;

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>
          {p.posting_kind === "gift" ? "Review" : "Confirm"} {p.reference}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Posted to</dt>
          <dd>
            {KIND[p.kind]} — <span className="font-medium">{p.party}</span>
          </dd>
          <dt className="text-muted-foreground">Date</dt>
          <dd>{new Date(p.at).toLocaleString()}</dd>
          <dt className="text-muted-foreground">Products</dt>
          <dd>{p.items ?? "—"}</dd>
          <dt className="text-muted-foreground">Value</dt>
          <dd className="font-medium">{money(Number(p.value), currency)}</dd>
          {p.balance != null && (
            <>
              <dt className="text-muted-foreground">Paid / balance</dt>
              <dd>
                {money(Number(p.paid ?? 0), currency)} / {money(Number(p.balance), currency)}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">Status</dt>
          <dd className="capitalize">{p.status.replace(/_/g, " ")}</dd>
        </dl>
        {pendingSale && (
          <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
            Confirming posts the sale: the goods leave Warehouse stock and the invoice goes on the
            distributor's account.
          </p>
        )}
        <div>
          <Label>{pendingSale ? "Remarks (required to reject)" : "Remarks (optional)"}</Label>
          <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
        {p.posting_kind !== "gift" && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={print} onChange={(e) => setPrint(e.target.checked)} />
            Print the receipt after confirming
          </label>
        )}
      </div>
      <DialogFooter className="gap-2">
        {pendingSale && (
          <Button
            variant="outline"
            className="gap-1 text-destructive"
            disabled={busy}
            onClick={() => reject.mutate()}
          >
            <X className="h-4 w-4" /> Reject
          </Button>
        )}
        <Button variant="outline" disabled={busy} onClick={() => assess.mutate(false)}>
          {p.posting_kind === "gift" ? "Review & record" : "Confirm"}
        </Button>
        {canPay && (
          <Button disabled={busy} onClick={() => assess.mutate(true)}>
            {assess.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Confirm &amp; enter payment
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
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
