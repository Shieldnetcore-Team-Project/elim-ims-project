import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Check, MinusCircle, Search, Send, X } from "lucide-react";
import { BagQty, PackOrPiecesInput } from "@/components/shared/bag-quantity";
import { brandDetail } from "@/components/shared/brand-picker";
import { ReportActions } from "@/components/shared/report-actions";
import { detectPack, formatBags, packWord, splitBags } from "@/lib/preform-units";
import { num } from "@/lib/format";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";

// Quality Control → Received from Store: QC's own small store
// (20261023160000_qc_store.sql). What the Store issues to Quality Control
// waits here until QC confirms receiving it; only then is it QC's stock.
// QC records what it uses (out). Available = confirmed received - out, per
// material. Quantities are kept in pieces and shown with their bags.

type MaterialInfo = {
  name: string;
  unit: string;
  pieces_per_bag: number | null;
  brands: { name: string; category: string; grammage: string | null } | null;
};
type ReceiptRow = {
  id: string;
  material_id: string;
  quantity: number;
  status: "pending" | "confirmed" | "rejected" | "moved";
  reject_reason: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  issued_to_user: string | null;
  issued_by: string | null;
  issued_at: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  raw_materials: MaterialInfo | null;
  raw_material_movements: { reference: string | null; reason: string | null } | null;
};
type UsageRow = {
  id: string;
  material_id: string;
  quantity: number;
  reason: string;
  used_by: string | null;
  used_at: string;
  issued_to_department: string | null;
  issued_to_user: string | null;
  raw_materials: MaterialInfo | null;
};
type Balance = {
  material_id: string;
  info: MaterialInfo | null;
  pending: number;
  received: number;
  out: number;
  available: number;
};

const MATERIAL_SELECT = "raw_materials(name,unit,pieces_per_bag,brands(name,category,grammage))";
const packOf = (m: MaterialInfo | null) =>
  detectPack(m?.brands?.category) ?? packWord(m?.name, m?.unit);
const when = (iso: string) => format(new Date(iso), "dd-MM-yyyy HH:mm:ss");

export function ReceivedFromStorePanel({ factoryId }: { factoryId: string }) {
  const qc = useQueryClient();
  const { canSubmit } = usePermissions();
  const canAct = canSubmit("goods-receiving");
  const [day, setDay] = useState("");
  const [q, setQ] = useState("");
  const [useFor, setUseFor] = useState<Balance | null>(null);
  // Issue to Production: the material whose row icon was clicked.
  const [issueFor, setIssueFor] = useState<Balance | null>(null);
  // Reject a Store issue (with a reason): it goes back to the Store.
  const [rejecting, setRejecting] = useState<ReceiptRow | null>(null);
  useRealtimeInvalidate(["qc_store_receipts", "qc_store_usage"], [["qc-store"]]);

  const receipts = useQuery({
    queryKey: ["qc-store", "receipts", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("qc_store_receipts")
        .select(
          `id,material_id,quantity,status,issued_to_user,issued_by,issued_at,confirmed_by,confirmed_at,reject_reason,rejected_by,rejected_at,${MATERIAL_SELECT},raw_material_movements(reference,reason)`,
        )
        .eq("factory_id", factoryId)
        .order("issued_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as unknown as ReceiptRow[];
    },
  });
  const usage = useQuery({
    queryKey: ["qc-store", "usage", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("qc_store_usage")
        .select(
          `id,material_id,quantity,reason,used_by,used_at,issued_to_department,issued_to_user,${MATERIAL_SELECT}`,
        )
        .eq("factory_id", factoryId)
        .order("used_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as unknown as UsageRow[];
    },
  });

  // Names of who collected, issued, confirmed and used.
  const peopleIds = [
    ...new Set(
      [
        ...(receipts.data ?? []).flatMap((r) => [
          r.issued_to_user,
          r.issued_by,
          r.confirmed_by,
          r.rejected_by,
        ]),
        ...(usage.data ?? []).flatMap((u) => [u.used_by, u.issued_to_user]),
      ].filter(Boolean) as string[],
    ),
  ];
  const people = useQuery({
    queryKey: ["qc-store", "people", peopleIds],
    enabled: peopleIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("id,full_name").in("id", peopleIds);
      return new Map((data ?? []).map((p) => [p.id, p.full_name ?? ""]));
    },
  });
  const nameOf = (id: string | null) => (id ? people.data?.get(id) || "—" : null);

  const confirm = useMutation({
    mutationFn: async (id: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
      const { error } = await (supabase as any).rpc("qc_confirm_store_receipt", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Confirmed — added to Quality Control's stock");
      qc.invalidateQueries({ queryKey: ["qc-store"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Balances per material.
  const balances = new Map<string, Balance>();
  const balanceOf = (id: string, info: MaterialInfo | null) => {
    let b = balances.get(id);
    if (!b) {
      b = { material_id: id, info, pending: 0, received: 0, out: 0, available: 0 };
      balances.set(id, b);
    }
    return b;
  };
  for (const r of receipts.data ?? []) {
    const b = balanceOf(r.material_id, r.raw_materials);
    // A rejected issue went back to the Store: never QC's stock.
    if (r.status === "confirmed") b.received += Number(r.quantity);
    else if (r.status === "pending") b.pending += Number(r.quantity);
  }
  for (const u of usage.data ?? [])
    balanceOf(u.material_id, u.raw_materials).out += Number(u.quantity);
  for (const b of balances.values()) b.available = b.received - b.out;
  const stock = [...balances.values()].sort((a, b) =>
    (a.info?.name ?? "").localeCompare(b.info?.name ?? ""),
  );
  const totals = stock.reduce(
    (t, b) => ({
      pending: t.pending + b.pending,
      received: t.received + b.received,
      out: t.out + b.out,
      available: t.available + b.available,
    }),
    { pending: 0, received: 0, out: 0, available: 0 },
  );
  const pendingCount = (receipts.data ?? []).filter((r) => r.status === "pending").length;

  const term = q.trim().toLowerCase();
  const matches = (...values: (string | null | undefined)[]) =>
    !term || values.some((v) => (v ?? "").toLowerCase().includes(term));
  const onDay = (iso: string) => !day || format(new Date(iso), "yyyy-MM-dd") === day;

  const issueRows = (receipts.data ?? [])
    .filter((r) => onDay(r.issued_at))
    .map((r) => ({
      ...r,
      material: r.raw_materials?.name ?? "—",
      brand: brandDetail(r.raw_materials?.brands),
      collectedBy: nameOf(r.issued_to_user) ?? "Quality Control (department)",
      issuedBy: nameOf(r.issued_by) ?? "—",
      confirmedBy: nameOf(r.confirmed_by),
      rejectedBy: nameOf(r.rejected_by),
      note: [r.raw_material_movements?.reference, r.raw_material_movements?.reason]
        .filter(Boolean)
        .join(" — "),
    }))
    .filter((r) => matches(r.material, r.brand, r.collectedBy, r.issuedBy, r.note));
  const usageRows = (usage.data ?? [])
    .filter((u) => onDay(u.used_at))
    .map((u) => ({
      ...u,
      material: u.raw_materials?.name ?? "—",
      brand: brandDetail(u.raw_materials?.brands),
      usedBy: nameOf(u.used_by) ?? "—",
      wentTo:
        u.issued_to_department === "production"
          ? `Production${u.issued_to_user ? ` — ${nameOf(u.issued_to_user)}` : ""}`
          : u.reason.startsWith("Moved to Quality Control → Preforms")
            ? "Moved to Preforms"
            : "Used by QC",
    }))
    .filter((u) => matches(u.material, u.brand, u.usedBy, u.reason, u.wentTo));

  const qtyCell = (value: number, m: MaterialInfo | null) => (
    <BagQty value={value} unit={m?.unit} perBag={m?.pieces_per_bag} pack={packOf(m)} />
  );
  const packsText = (value: number, m: MaterialInfo | null) => {
    const s = splitBags(value, m?.pieces_per_bag);
    return s ? formatBags(s, packOf(m)) : "";
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          label="Awaiting confirmation"
          value={num(totals.pending)}
          hint={`${pendingCount} issue${pendingCount === 1 ? "" : "s"} to confirm`}
          tone={pendingCount > 0 ? "warning" : undefined}
        />
        <SummaryCard label="Qty received" value={num(totals.received)} hint="confirmed, pieces" />
        <SummaryCard
          label="Out"
          value={num(totals.out)}
          hint="used by QC or issued to Production, pieces"
        />
        <SummaryCard
          label="Quantity available"
          value={num(totals.available)}
          hint="received − out, pieces"
        />
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>QC stock by material</CardTitle>
            <CardDescription>
              What Quality Control holds of each material. Only confirmed issues count as received.
            </CardDescription>
          </div>
          <ReportActions
            size="sm"
            title="Quality Control — stock by material"
            fileName="qc-stock"
            columns={[
              { key: "material", label: "Material" },
              { key: "brand", label: "Brand" },
              { key: "pending", label: "Awaiting confirmation (pieces)" },
              { key: "received", label: "Received (pieces)" },
              { key: "out", label: "Out (pieces)" },
              { key: "available", label: "Available (pieces)" },
              { key: "availablePacks", label: "Available in packs" },
            ]}
            rows={stock.map((b) => ({
              material: b.info?.name ?? "",
              brand: brandDetail(b.info?.brands) ?? "",
              pending: num(b.pending),
              received: num(b.received),
              out: num(b.out),
              available: num(b.available),
              availablePacks: packsText(b.available, b.info),
            }))}
          />
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Material</TableHead>
                <TableHead>Brand</TableHead>
                <TableHead className="text-right">Awaiting confirmation</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Out</TableHead>
                <TableHead className="text-right">Available</TableHead>
                {canAct && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {stock.map((b) => (
                <TableRow key={b.material_id}>
                  <TableCell className="font-medium">{b.info?.name ?? "—"}</TableCell>
                  <TableCell>{brandDetail(b.info?.brands) ?? "—"}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {b.pending > 0 ? qtyCell(b.pending, b.info) : "—"}
                  </TableCell>
                  <TableCell className="text-right">{qtyCell(b.received, b.info)}</TableCell>
                  <TableCell className="text-right">{qtyCell(b.out, b.info)}</TableCell>
                  <TableCell className="text-right font-medium">
                    {qtyCell(b.available, b.info)}
                  </TableCell>
                  {canAct && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Issue to a Production person"
                          aria-label="Issue to a Production person"
                          disabled={b.available <= 0}
                          onClick={() => setIssueFor(b)}
                        >
                          <Send className="h-4 w-4 text-primary" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Record use by QC"
                          aria-label="Record use by QC"
                          disabled={b.available <= 0}
                          onClick={() => setUseFor(b)}
                        >
                          <MinusCircle className="h-4 w-4 text-warning" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {stock.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    {receipts.isLoading ? "Loading…" : "Nothing received from the Store yet."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Received from Store</CardTitle>
            <CardDescription>
              Everything the Store issued to Quality Control, newest first. Confirm each one when it
              reaches you.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ReportActions
              size="sm"
              title="Received from Store — Quality Control"
              fileName="qc-received-from-store"
              columns={[
                { key: "sn", label: "S/N" },
                { key: "when", label: "Issued" },
                { key: "material", label: "Material" },
                { key: "brand", label: "Brand" },
                { key: "quantity", label: "Quantity (pieces)" },
                { key: "packs", label: "In packs" },
                { key: "collectedBy", label: "Collected By" },
                { key: "issuedBy", label: "Issued By" },
                { key: "status", label: "Status" },
                { key: "note", label: "Reference / Reason" },
              ]}
              rows={issueRows.map((r, i) => ({
                sn: i + 1,
                when: when(r.issued_at),
                material: r.material,
                brand: r.brand ?? "",
                quantity: num(Number(r.quantity)),
                packs: packsText(Number(r.quantity), r.raw_materials),
                collectedBy: r.collectedBy,
                issuedBy: r.issuedBy,
                status:
                  r.status === "confirmed"
                    ? `Confirmed${r.confirmedBy ? ` by ${r.confirmedBy}` : ""}`
                    : r.status === "rejected"
                      ? `Rejected — back in store: ${r.reject_reason ?? ""}`
                      : r.status === "moved"
                        ? "Moved to Quality Control → Preforms"
                        : "Awaiting confirmation",
                note: r.note,
              }))}
              subtitle={[
                ...(day ? [`Date: ${day}`] : []),
                ...(term ? [`Search: ${q.trim()}`] : []),
              ]}
            />
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search material, person…"
                className="h-9 w-52 pl-8"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Label htmlFor="qc-received-day" className="sr-only">
              Filter by date
            </Label>
            <Input
              id="qc-received-day"
              type="date"
              className="h-9 w-40"
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
            {day && (
              <Button variant="ghost" size="sm" onClick={() => setDay("")}>
                Clear
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">S/N</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead>Material</TableHead>
                <TableHead>Brand</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead>Collected By</TableHead>
                <TableHead>Issued By</TableHead>
                <TableHead>Reference / Reason</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {issueRows.map((r, i) => (
                <TableRow key={r.id}>
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="whitespace-nowrap">{when(r.issued_at)}</TableCell>
                  <TableCell className="font-medium">{r.material}</TableCell>
                  <TableCell>{r.brand ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    {qtyCell(Number(r.quantity), r.raw_materials)}
                  </TableCell>
                  <TableCell>{r.collectedBy}</TableCell>
                  <TableCell>{r.issuedBy}</TableCell>
                  <TableCell className="max-w-64 text-muted-foreground">{r.note || "—"}</TableCell>
                  <TableCell>
                    {r.status === "confirmed" ? (
                      <div>
                        <Badge variant="secondary">Confirmed</Badge>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {r.confirmedBy ?? "—"}
                          {r.confirmed_at ? ` · ${when(r.confirmed_at)}` : ""}
                        </div>
                      </div>
                    ) : r.status === "moved" ? (
                      <Badge variant="secondary">Moved to Preforms</Badge>
                    ) : r.status === "rejected" ? (
                      <div className="max-w-56">
                        <Badge variant="destructive">Rejected — back in store</Badge>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {r.reject_reason ?? "—"}
                          {r.rejectedBy ? ` · ${r.rejectedBy}` : ""}
                          {r.rejected_at ? ` · ${when(r.rejected_at)}` : ""}
                        </div>
                      </div>
                    ) : canAct ? (
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Confirm received"
                          aria-label="Confirm received"
                          disabled={confirm.isPending}
                          onClick={() => confirm.mutate(r.id)}
                        >
                          <Check className="h-4 w-4 text-success" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Reject — back to the Store"
                          aria-label="Reject"
                          onClick={() => setRejecting(r)}
                        >
                          <X className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    ) : (
                      <Badge variant="outline">Awaiting confirmation</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {issueRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                    {receipts.isLoading
                      ? "Loading…"
                      : day || term
                        ? "Nothing received from the Store matches."
                        : "Nothing received from the Store yet."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Out — used or issued to Production</CardTitle>
            <CardDescription>
              What left Quality Control&rsquo;s stock, newest first.
            </CardDescription>
          </div>
          <ReportActions
            size="sm"
            title="Quality Control — out (used or issued to Production)"
            fileName="qc-out"
            columns={[
              { key: "when", label: "Date/Time" },
              { key: "material", label: "Material" },
              { key: "brand", label: "Brand" },
              { key: "quantity", label: "Quantity (pieces)" },
              { key: "packs", label: "In packs" },
              { key: "wentTo", label: "Went to" },
              { key: "reason", label: "Details" },
              { key: "usedBy", label: "Recorded By" },
            ]}
            rows={usageRows.map((u) => ({
              when: when(u.used_at),
              material: u.material,
              brand: u.brand ?? "",
              quantity: num(Number(u.quantity)),
              packs: packsText(Number(u.quantity), u.raw_materials),
              wentTo: u.wentTo,
              reason: u.reason,
              usedBy: u.usedBy,
            }))}
            subtitle={[...(day ? [`Date: ${day}`] : []), ...(term ? [`Search: ${q.trim()}`] : [])]}
          />
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date/Time</TableHead>
                <TableHead>Material</TableHead>
                <TableHead>Brand</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead>Went to</TableHead>
                <TableHead>Details</TableHead>
                <TableHead>Recorded By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usageRows.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="whitespace-nowrap">{when(u.used_at)}</TableCell>
                  <TableCell className="font-medium">{u.material}</TableCell>
                  <TableCell>{u.brand ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    {qtyCell(Number(u.quantity), u.raw_materials)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={u.issued_to_department === "production" ? "secondary" : "outline"}
                    >
                      {u.wentTo}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-64 text-muted-foreground">{u.reason}</TableCell>
                  <TableCell>{u.usedBy}</TableCell>
                </TableRow>
              ))}
              {usageRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                    Nothing used yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!useFor} onOpenChange={(o) => !o && setUseFor(null)}>
        {useFor && (
          <RecordUseDialog
            balance={useFor}
            onDone={() => {
              setUseFor(null);
              qc.invalidateQueries({ queryKey: ["qc-store"] });
            }}
          />
        )}
      </Dialog>

      <Dialog open={!!rejecting} onOpenChange={(o) => !o && setRejecting(null)}>
        {rejecting && (
          <RejectIssueDialog
            receipt={rejecting}
            onDone={() => {
              setRejecting(null);
              qc.invalidateQueries({ queryKey: ["qc-store"] });
            }}
          />
        )}
      </Dialog>

      <Dialog open={!!issueFor} onOpenChange={(o) => !o && setIssueFor(null)}>
        {issueFor && (
          <IssueToProductionDialog
            factoryId={factoryId}
            balance={issueFor}
            onDone={() => {
              setIssueFor(null);
              qc.invalidateQueries({ queryKey: ["qc-store"] });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

// Reject what the Store issued, with a reason: it never becomes QC's stock and
// goes back into the Store (qc_reject_store_receipt, 20261023210000).
function RejectIssueDialog({ receipt, onDone }: { receipt: ReceiptRow; onDone: () => void }) {
  const m = receipt.raw_materials;
  const [reason, setReason] = useState("");
  const save = useMutation({
    mutationFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
      const { error } = await (supabase as any).rpc("qc_reject_store_receipt", {
        p_id: receipt.id,
        p_reason: reason.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Rejected — returned to the Store");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Reject — {m?.name ?? "material"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {m?.brands ? `${brandDetail(m.brands)} · ` : ""}Issued {when(receipt.issued_at)}:{" "}
          <BagQty
            value={Number(receipt.quantity)}
            unit={m?.unit}
            perBag={m?.pieces_per_bag}
            pack={packOf(m)}
          />
          . It goes back into the Store and never counts as Quality Control&rsquo;s stock.
        </p>
        <div>
          <Label>Reason for rejecting *</Label>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. wrong size, damaged on arrival, not what was requested"
          />
        </div>
      </div>
      <DialogFooter>
        <Button
          variant="destructive"
          disabled={save.isPending || reason.trim().length < 3}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Rejecting…" : "Reject and return to Store"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// Quality Control → Production: from QC's available stock of one material, to
// the Production person chosen (Production has several people, so who
// received it is always recorded). Counts as "out" for QC
// (qc_record_store_usage, 20261023170000).
function IssueToProductionDialog({
  factoryId,
  balance,
  onDone,
}: {
  factoryId: string;
  balance: Balance;
  onDone: () => void;
}) {
  const m = balance.info;
  const [toUser, setToUser] = useState("");
  const [quantity, setQuantity] = useState(0);
  const [note, setNote] = useState("");
  // One key per dialog: a double click issues once.
  const [clientRef] = useState(() => crypto.randomUUID());

  const recipients = useQuery({
    queryKey: ["issue-recipients", factoryId],
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
      const { data, error } = await (supabase as any).rpc("issue_recipients", {
        p_factory: factoryId,
      });
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string; department: string }[];
    },
  });
  const production = (recipients.data ?? []).filter((r) => r.department === "production");

  const save = useMutation({
    mutationFn: async () => {
      if (!toUser) throw new Error("Choose who in Production receives it");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
      const { error } = await (supabase as any).rpc("qc_record_store_usage", {
        payload: {
          material_id: balance.material_id,
          quantity,
          issued_to_department: "production",
          issued_to_user: toUser,
          reason: note.trim(),
          client_ref: clientRef,
        },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      const who = production.find((p) => p.id === toUser)?.full_name;
      toast.success(`Issued to ${who ?? "Production"}`);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Issue to Production — {m?.name ?? "material"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {m?.brands ? `${brandDetail(m.brands)} · ` : ""}Available in Quality Control:{" "}
          <BagQty
            value={balance.available}
            unit={m?.unit}
            perBag={m?.pieces_per_bag}
            pack={packOf(m)}
          />
        </p>
        <div>
          <Label>Issue to (Production) *</Label>
          <Select value={toUser} onValueChange={setToUser}>
            <SelectTrigger>
              <SelectValue
                placeholder={
                  recipients.isLoading ? "Loading…" : "Choose who in Production receives it"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {production.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.full_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!recipients.isLoading && production.length === 0 && (
            <p className="mt-1 text-xs text-destructive">
              No one is set up in Production yet. Ask an admin to give the person the Production
              role.
            </p>
          )}
        </div>
        <PackOrPiecesInput
          label="Quantity issued"
          value={quantity}
          onChange={setQuantity}
          perBag={m?.pieces_per_bag}
          pack={packOf(m)}
          unit={m?.unit}
          max={balance.available}
        />
        <div>
          <Label>Note (optional)</Label>
          <Textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. passed QC test, for line 2"
          />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={save.isPending || !toUser || quantity <= 0 || quantity > balance.available}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Issuing…" : "Issue to Production"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function SummaryCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "warning";
}) {
  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-semibold ${tone === "warning" ? "text-warning" : ""}`}>
          {value}
        </div>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function RecordUseDialog({ balance, onDone }: { balance: Balance; onDone: () => void }) {
  const m = balance.info;
  const [quantity, setQuantity] = useState(0);
  const [reason, setReason] = useState("");
  const [purpose, setPurpose] = useState("Quality test");
  // One key per dialog: a double click records once.
  const [clientRef] = useState(() => crypto.randomUUID());
  const fullReason = [purpose, reason.trim()].filter(Boolean).join(": ");

  const save = useMutation({
    mutationFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
      const { error } = await (supabase as any).rpc("qc_record_store_usage", {
        payload: {
          material_id: balance.material_id,
          quantity,
          reason: fullReason,
          client_ref: clientRef,
        },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Use recorded");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Record use — {m?.name ?? "material"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Available in Quality Control:{" "}
          <BagQty
            value={balance.available}
            unit={m?.unit}
            perBag={m?.pieces_per_bag}
            pack={packOf(m)}
          />
        </p>
        <PackOrPiecesInput
          label="Quantity used"
          value={quantity}
          onChange={setQuantity}
          perBag={m?.pieces_per_bag}
          pack={packOf(m)}
          unit={m?.unit}
          max={balance.available}
        />
        <div>
          <Label>Used for</Label>
          <Select value={purpose} onValueChange={setPurpose}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Quality test">Quality test</SelectItem>
              <SelectItem value="Damaged / rejected">Damaged / rejected</SelectItem>
              <SelectItem value="Sample">Sample</SelectItem>
              <SelectItem value="Other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Details {purpose === "Other" ? "*" : "(optional)"}</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={
            save.isPending ||
            quantity <= 0 ||
            quantity > balance.available ||
            (purpose === "Other" && !reason.trim())
          }
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Record use"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
