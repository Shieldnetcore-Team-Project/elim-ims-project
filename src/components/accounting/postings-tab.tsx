import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { logAudit } from "@/lib/audit";
import { money } from "@/lib/format";
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
import { CheckCircle2, HandCoins, Loader2, Search } from "lucide-react";

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

// Every Warehouse posting -- to a marketer, the Company Retail Shop or a
// distributor -- lands here for Accounting to assess and enter payment
// against (accounting_postings). A marketer's or the shop's payment is a
// remittance to their account; a distributor's is a receipt on the invoice.
// A chairman's gift is assessed for the record only: there is no payment.
export function PostingsTab({ factoryId, currency }: { factoryId: string; currency: string }) {
  const qc = useQueryClient();
  const perms = usePermissions();
  const canAssess =
    perms.canWrite("payments") || perms.canWrite("debts") || perms.canPost("distribution");
  const canPayInvoice = perms.canWrite("payments") || perms.canWrite("debts");
  const canRemit = perms.canPost("distribution");

  const [kind, setKind] = useState<"all" | Posting["kind"]>("all");
  const [state, setState] = useState<"to_assess" | "assessed" | "all">("to_assess");
  const [q, setQ] = useState("");
  const [assessing, setAssessing] = useState<Posting | null>(null);
  const [paying, setPaying] = useState<Posting | null>(null);

  useRealtimeInvalidate(
    ["stock_dispatches", "sales", "payments_received", "rep_remittances", "chairmans_gifts"],
    [["acct-postings"]],
  );

  const postings = useQuery({
    queryKey: ["acct-postings", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "accounting_postings" as never,
        { p_factory: factoryId, p_limit: 500 } as never,
      );
      if (error) throw error;
      return (data ?? []) as unknown as Posting[];
    },
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
  const toAssess = all.filter((p) => !p.assessed_at && p.status !== "reversed");
  const shown = useMemo(() => {
    const key = q.trim().toLowerCase();
    return all.filter(
      (p) =>
        (kind === "all" || p.kind === kind) &&
        (state === "all" || (state === "assessed" ? !!p.assessed_at : !p.assessed_at)) &&
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
    if (p.posting_kind === "sale" && p.status !== "posted") return "Awaiting sale approval";
    if (p.posting_kind === "sale" && Number(p.balance ?? 0) <= 0) return "Fully paid";
    if (p.status === "reversed") return "Dispatch reversed";
    return "You don't have the right to record this payment";
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="To assess" value={String(toAssess.length)} warn={toAssess.length > 0} />
        <Stat
          label="Value to assess"
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
              Goods posted to marketers, the Company Retail Shop and distributors. Assess each one,
              then enter the payment against it. Chairman's gifts are assessed for the record only.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={state} onValueChange={(v) => setState(v as typeof state)}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="to_assess">To assess</SelectItem>
                <SelectItem value="assessed">Assessed</SelectItem>
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
                <SelectItem value="retail">Retail shop</SelectItem>
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
                          <CheckCircle2 className="h-3 w-3" /> Assessed
                        </Badge>
                        <div className="mt-1 text-muted-foreground">
                          {p.assessed_by ?? "—"} · {new Date(p.assessed_at).toLocaleDateString()}
                        </div>
                      </span>
                    ) : (
                      <Badge variant="outline">To assess</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {canAssess && !p.assessed_at && (
                        <Button size="sm" variant="outline" onClick={() => setAssessing(p)}>
                          Assess
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
                          ? "Nothing waiting to be assessed."
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
              if (payNext && payable(p)) setPaying(p);
            }}
            canPay={payable(assessing)}
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

function AssessDialog({
  posting: p,
  currency,
  factoryId,
  canPay,
  onDone,
}: {
  posting: Posting;
  currency: string;
  factoryId: string;
  canPay: boolean;
  onDone: (payNext: boolean) => void;
}) {
  const qc = useQueryClient();
  const [remarks, setRemarks] = useState("");

  const assess = useMutation({
    mutationFn: async (payNext: boolean) => {
      const { data, error } = await supabase.rpc(
        "assess_posting" as never,
        { p_kind: p.posting_kind, p_id: p.posting_id, p_remarks: remarks || null } as never,
      );
      if (error) throw error;
      return { id: data as unknown as string, payNext };
    },
    onSuccess: ({ id, payNext }) => {
      toast.success(`${p.reference} assessed`);
      logAudit({ action: "update", entity: "posting_assessments", entityId: id, factoryId });
      qc.invalidateQueries({ queryKey: ["acct-postings"] });
      onDone(payNext);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Assess {p.reference}</DialogTitle>
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
        <div>
          <Label>Remarks (optional)</Label>
          <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>
      <DialogFooter className="gap-2">
        <Button variant="outline" disabled={assess.isPending} onClick={() => assess.mutate(false)}>
          {p.posting_kind === "gift" ? "Review & record" : "Mark assessed"}
        </Button>
        {canPay && (
          <Button disabled={assess.isPending} onClick={() => assess.mutate(true)}>
            {assess.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Assess &amp; enter payment
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
