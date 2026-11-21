import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Eye, Plus, Printer, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { logAudit } from "@/lib/audit";
import { money } from "@/lib/format";
import { useMyRoles } from "@/lib/permissions";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { useCurrentUserName } from "@/lib/use-current-user";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { db } from "./shared";
import {
  blankItem,
  canDecide,
  draftLineTotal,
  printCashRequisition,
  REQUEST_CATEGORY_LABELS,
  REQUEST_STATUS_LABELS,
  usedItems,
  useRequestItems,
  useRequisitionRole,
  type DraftItem,
  type ReqItem,
  type RequisitionRow,
} from "./requisition";

const qtyText = (n: number) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 3 });

// Item name, description, qty, amount; each line's total and the total cost.
export function RequisitionItemsEditor({
  items,
  onChange,
}: {
  items: DraftItem[];
  onChange: (items: DraftItem[]) => void;
}) {
  const set = (key: number, patch: Partial<DraftItem>) =>
    onChange(items.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const total = usedItems(items).reduce((s, i) => s + draftLineTotal(i), 0);
  return (
    <div className="space-y-2">
      <Label>Items</Label>
      {items.map((i, idx) => (
        <div key={i.key} className="space-y-2 rounded-md border p-2">
          <div className="grid grid-cols-12 items-end gap-2">
            <div className="col-span-12 space-y-1 sm:col-span-5">
              <Label className="text-xs">Item {idx + 1}</Label>
              <Input
                value={i.item_name}
                placeholder="Item name"
                onChange={(e) => set(i.key, { item_name: e.target.value })}
              />
            </div>
            <div className="col-span-3 space-y-1 sm:col-span-2">
              <Label className="text-xs">Qty</Label>
              <Input
                type="number"
                min={0}
                value={i.quantity}
                onChange={(e) => set(i.key, { quantity: e.target.value })}
              />
            </div>
            <div className="col-span-5 space-y-1 sm:col-span-2">
              <Label className="text-xs">Amount (₦)</Label>
              <MoneyInput value={i.unit_amount} onChange={(v) => set(i.key, { unit_amount: v })} />
            </div>
            <div className="col-span-3 space-y-1 text-right sm:col-span-2">
              <Label className="text-xs">Total</Label>
              <div className="h-9 pt-2 text-sm font-medium whitespace-nowrap">
                {money(draftLineTotal(i))}
              </div>
            </div>
            <div className="col-span-1 text-right">
              <Button
                size="icon"
                variant="ghost"
                title="Remove item"
                disabled={items.length === 1}
                onClick={() => onChange(items.filter((x) => x.key !== i.key))}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <Input
            value={i.description}
            placeholder="Description (optional)"
            onChange={(e) => set(i.key, { description: e.target.value })}
          />
        </div>
      ))}
      <div className="flex items-center justify-between">
        <Button size="sm" variant="outline" onClick={() => onChange([...items, blankItem()])}>
          <Plus className="mr-1 h-4 w-4" /> Add item
        </Button>
        <div className="text-base font-bold">Total cost: {money(total)}</div>
      </div>
    </div>
  );
}

export function RequisitionItemsTable({ items }: { items: ReqItem[] }) {
  const total = items.reduce((s, i) => s + Number(i.amount), 0);
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">S/N</TableHead>
            <TableHead>Item</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((i, k) => (
            <TableRow key={i.id}>
              <TableCell>{k + 1}</TableCell>
              <TableCell className="font-medium">{i.item_name}</TableCell>
              <TableCell>{i.description ?? "—"}</TableCell>
              <TableCell className="text-right">{qtyText(i.quantity)}</TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {money(Number(i.unit_amount))}
              </TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {money(Number(i.amount))}
              </TableCell>
            </TableRow>
          ))}
          {items.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-4 text-center text-muted-foreground">
                No items listed on this request.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
        {items.length > 0 && (
          <TableFooter>
            <TableRow>
              <TableCell colSpan={5} className="text-right font-bold">
                Total cost
              </TableCell>
              <TableCell className="text-right font-bold whitespace-nowrap">
                {money(total)}
              </TableCell>
            </TableRow>
          </TableFooter>
        )}
      </Table>
    </div>
  );
}

// Accounts' and the Chairman's decisions, as far as they have gone.
export function RequisitionTrail({ r }: { r: RequisitionRow }) {
  const rejectedByAccounts = r.status === "rejected" && !!r.accounts_by_name && !r.chairman_by_name;
  const rejectedByChairman = r.status === "rejected" && !!r.chairman_by_name;
  const line = (
    who: string,
    by: string | null | undefined,
    at: string | null | undefined,
    note: string | null | undefined,
    verb: string,
    waiting: boolean,
  ) => (
    <div>
      <span className="text-muted-foreground">{who}: </span>
      {by ? (
        <>
          <span className="font-medium">{verb}</span> by {by}
          {at && ` on ${new Date(at).toLocaleString()}`}
          {note && <span className="text-muted-foreground"> — “{note}”</span>}
        </>
      ) : waiting ? (
        <span className="text-amber-600">waiting</span>
      ) : who === "Accounts" && r.chairman_by_name ? (
        <span className="text-muted-foreground">not reviewed — the Chairman decided directly</span>
      ) : (
        "—"
      )}
    </div>
  );
  return (
    <div className="space-y-1 rounded-md border p-3">
      {line(
        "Accounts",
        r.accounts_by_name,
        r.accounts_at,
        r.accounts_note,
        rejectedByAccounts ? "Rejected" : "Accepted",
        r.status === "pending_approval",
      )}
      {line(
        "Chairman",
        r.chairman_by_name,
        r.chairman_at,
        r.chairman_note,
        rejectedByChairman ? "Rejected" : "Approved",
        r.status === "accounts_approved",
      )}
    </div>
  );
}

// The Print button for one request (loads its items).
export function PrintRequisitionButton({
  r,
  items,
  size = "sm",
}: {
  r: RequisitionRow;
  items: ReqItem[] | undefined;
  size?: "sm" | "default";
}) {
  const settings = useFactorySettings(useFactoryId().data);
  const me = useCurrentUserName();
  return (
    <Button
      variant="outline"
      size={size}
      disabled={!items}
      onClick={() => items && printCashRequisition(r, items, settings.data, me.data)}
    >
      <Printer className="mr-2 h-4 w-4" /> Print requisition
    </Button>
  );
}

const statusVariant = (s: string): "default" | "secondary" | "outline" | "destructive" =>
  s === "completed"
    ? "secondary"
    : s === "rejected" || s === "cancelled"
      ? "destructive"
      : s === "approved"
        ? "default"
        : "outline";

// Accountant page › Cash requisitions: what Maintenance asked money for.
// Accounts accept or reject (reason); the Chairman then approves or rejects.
export function CashRequisitionsTab({ factoryId }: { factoryId: string | null | undefined }) {
  useRealtimeInvalidate(
    ["maintenance_requests", "maintenance_request_items"],
    [["cash-requisitions"], ["maintenance-request-items"]],
  );
  const qc = useQueryClient();
  const role = useRequisitionRole();
  const isAdmin = (useMyRoles().data ?? []).includes("super_admin");
  const [filter, setFilter] = useState("waiting");
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [action, setAction] = useState<"approve" | "reject" | null>(null);
  const [note, setNote] = useState("");

  const { data: me } = useQuery({
    queryKey: ["auth-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
  });

  const requests = useQuery({
    queryKey: ["cash-requisitions", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await db
        .from("maintenance_requests")
        .select("*, vehicles(plate_number)")
        .eq("factory_id", factoryId)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as RequisitionRow[];
    },
  });

  const all = requests.data ?? [];
  const waitingForMe = (r: RequisitionRow) =>
    (r.status === "pending_approval" && role.isAccounts) ||
    ((r.status === "accounts_approved" || r.status === "pending_approval") && role.isChairman);
  const rows = all.filter((r) =>
    filter === "all" ? true : filter === "waiting" ? waitingForMe(r) : r.status === filter,
  );
  const viewing = all.find((r) => r.id === viewingId) ?? null;
  const items = useRequestItems(viewingId);
  const stage = viewing ? canDecide(viewing, role, me, isAdmin) : null;

  const decide = useMutation({
    mutationFn: async () => {
      if (!viewing || !action) throw new Error("No request selected");
      const { error } = await db.rpc("decide_maintenance_request", {
        p_id: viewing.id,
        p_approve: action === "approve",
        p_note: note.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(
        action === "reject"
          ? "Requisition rejected"
          : stage === "accounts"
            ? "Accepted — sent to the Chairman"
            : "Requisition approved",
      );
      logAudit({
        action: "update",
        entity: "maintenance_requests",
        entityId: viewing?.id,
        factoryId,
        newValue: { stage, action, note: note.trim() || null },
      });
      qc.invalidateQueries({ queryKey: ["cash-requisitions"] });
      qc.invalidateQueries({ queryKey: ["maintenance-requests"] });
      setAction(null);
      setNote("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="waiting">Waiting for my decision</SelectItem>
            <SelectItem value="all">All requisitions</SelectItem>
            {Object.entries(REQUEST_STATUS_LABELS).map(([k, label]) => (
              <SelectItem key={k} value={k}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Card className="rounded-2xl">
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Request #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Requested by</TableHead>
                <TableHead className="text-right">Total cost</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium whitespace-nowrap">
                    {r.request_number}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {new Date(r.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>{r.title}</TableCell>
                  <TableCell>{r.requested_by_name ?? "—"}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {r.estimated_cost != null ? money(Number(r.estimated_cost)) : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(r.status)}>
                      {REQUEST_STATUS_LABELS[r.status] ?? r.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => setViewingId(r.id)}>
                      <Eye className="mr-1 h-4 w-4" /> View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    {requests.isLoading
                      ? "Loading…"
                      : filter === "waiting"
                        ? "Nothing waiting for your decision"
                        : "No requisitions"}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewingId(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  Cash requisition {viewing.request_number}
                  <Badge variant={statusVariant(viewing.status)}>
                    {REQUEST_STATUS_LABELS[viewing.status] ?? viewing.status}
                  </Badge>
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <div>
                  <div className="text-base font-medium">{viewing.title}</div>
                  <div className="text-muted-foreground">
                    {REQUEST_CATEGORY_LABELS[viewing.category] ?? viewing.category}
                    {(viewing.vehicles?.plate_number ?? viewing.asset_name) &&
                      ` · ${viewing.vehicles?.plate_number ?? viewing.asset_name}`}
                    {` · ${viewing.priority} priority`}
                  </div>
                  <div className="mt-1">
                    <span className="text-muted-foreground">Requested by: </span>
                    {viewing.requested_by_name ?? "—"} on{" "}
                    {new Date(viewing.created_at).toLocaleString()}
                  </div>
                  {viewing.description && (
                    <p className="mt-2 whitespace-pre-wrap">{viewing.description}</p>
                  )}
                </div>
                <RequisitionItemsTable items={items.data ?? []} />
                <RequisitionTrail r={viewing} />
              </div>
              <DialogFooter className="flex-wrap gap-2">
                <PrintRequisitionButton r={viewing} items={items.data} />
                {stage && (
                  <>
                    <Button variant="destructive" onClick={() => setAction("reject")}>
                      <X className="mr-2 h-4 w-4" /> Reject
                    </Button>
                    <Button onClick={() => setAction("approve")}>
                      <Check className="mr-2 h-4 w-4" />
                      {stage === "accounts" ? "Accept (Accounts)" : "Approve (Chairman)"}
                    </Button>
                  </>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!action}
        onOpenChange={(o) => {
          if (!o) {
            setAction(null);
            setNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action === "reject"
                ? "Reject requisition"
                : stage === "accounts"
                  ? "Accept and send to the Chairman"
                  : "Approve requisition"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>{action === "reject" ? "Reason" : "Remark (optional)"}</Label>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <DialogFooter>
            <Button
              variant={action === "reject" ? "destructive" : "default"}
              disabled={(action === "reject" && !note.trim()) || decide.isPending}
              onClick={() => decide.mutate()}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
