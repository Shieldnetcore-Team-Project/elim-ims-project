import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, PackageOpen, Undo2, Truck, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { KPI } from "@/lib/dashboard-kit";
import { money, num } from "@/lib/format";
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

// Retail -> Jars (Transaction Summary ?tab=jars): the shop's dispenser jars
// (user decisions 2026-10-31, see
// supabase/migrations/20261031160000_retail_jar_sale_modes.sql):
//   Figures       per jug type: filled on the shelf, empties at the shop,
//                 still owed by customers, sent to the Warehouse and not yet
//                 confirmed; and for the day: received, sold by jar choice,
//                 empties back from customers, sent / confirmed.
//   Owed          the shop's Return-later sales still owing empties; Record
//                 return settles them (partial returns allowed). Empties
//                 beyond what is owed wait for a manager (Extra empties).
//   Send empties  the existing two-step jug return: the shop records what it
//                 sends, the Warehouse confirms what arrived (Jug
//                 accountability page); a shortfall stays on the shop.
//   Jar prices    per jug type, set by an administrator.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPCs newer than the generated types
const db = supabase as any;

type Summary = {
  container_type_id: string;
  container_name: string;
  jar_price: number | null;
  with_jar_price: number | null;
  filled_on_hand: number;
  empties_at_shop: number;
  owed_by_customers: number;
  excess_pending: number;
  sent_unconfirmed: number;
  filled_received: number;
  sold_swap: number;
  sold_return_later: number;
  sold_permanent: number;
  returned_good: number;
  returned_damaged: number;
  sent_to_warehouse: number;
  confirmed_by_warehouse: number;
};
type Owed = {
  sale_id: string;
  invoice_number: string;
  sale_date: string;
  customer_name: string;
  customer_phone: string | null;
  container_type_id: string;
  container_name: string;
  quantity_out: number;
  quantity_returned: number;
  outstanding: number;
};
type Extra = {
  id: string;
  return_number: string;
  customer_name: string | null;
  excess_quantity: number;
  recorded_at: string;
  recorded_by: string | null;
  container_types: { name: string } | null;
};

const n = (v: unknown) => Number(v ?? 0);
const newRef = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

export function RetailJars({ outletId, date }: { outletId: string; date: string }) {
  const qc = useQueryClient();
  const perms = usePermissions();
  const canRecord = perms.can("sales", "create") || perms.can("sales", "edit");
  const canDecide = perms.canApprove("sales");
  const canPrice = perms.canEdit("settings");
  const [search, setSearch] = useState("");
  const [returnFor, setReturnFor] = useState<Owed | "unlinked" | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [priceFor, setPriceFor] = useState<Summary | null>(null);

  useRealtimeInvalidate(
    ["sales", "container_movements", "jar_customer_returns", "jug_returns"],
    [["retail-jars"]],
  );
  const refresh = () => qc.invalidateQueries({ queryKey: ["retail-jars"] });

  const summary = useQuery({
    queryKey: ["retail-jars", "summary", outletId, date],
    queryFn: async () => {
      const { data, error } = await db.rpc("shop_jar_summary", {
        p_outlet: outletId,
        p_from: date,
        p_to: date,
      });
      if (error) throw error;
      return (data ?? []) as Summary[];
    },
  });
  const owed = useQuery({
    queryKey: ["retail-jars", "owed", outletId, search],
    queryFn: async () => {
      const { data, error } = await db.rpc("shop_jar_obligations", {
        p_outlet: outletId,
        p_search: search || null,
      });
      if (error) throw error;
      return (data ?? []) as Owed[];
    },
  });
  const extras = useQuery({
    queryKey: ["retail-jars", "extras", outletId],
    queryFn: async () => {
      const { data, error } = await db
        .from("jar_customer_returns")
        .select(
          "id,return_number,customer_name,excess_quantity,recorded_at,recorded_by,container_types(name)",
        )
        .eq("outlet_id", outletId)
        .eq("excess_status", "pending")
        .order("recorded_at");
      if (error) throw error;
      return (data ?? []) as Extra[];
    },
  });

  const types = summary.data ?? [];
  const total = (k: keyof Summary) => types.reduce((t, r) => t + n(r[k]), 0);

  if (summary.isError)
    return (
      <Card className="rounded-2xl border-dashed">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Couldn&apos;t load the jars: {(summary.error as Error).message}
        </CardContent>
      </Card>
    );

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPI
          icon={PackageOpen}
          label="Filled jars on the shelf"
          value={num(total("filled_on_hand"))}
        />
        <KPI
          icon={Undo2}
          label="Empties at the shop"
          value={num(total("empties_at_shop"))}
          hint="Physically here, not yet sent to the Warehouse"
        />
        <KPI
          icon={Users}
          label="Empties owed by customers"
          value={num(total("owed_by_customers"))}
          tone="warning"
        />
        <KPI
          icon={Truck}
          label="Sent, awaiting Warehouse"
          value={num(total("sent_unconfirmed"))}
          hint={
            total("excess_pending")
              ? `${num(total("excess_pending"))} extra empties await a decision`
              : undefined
          }
        />
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Jars on {date}</CardTitle>
          {canRecord && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setReturnFor("unlinked")}>
                Empties with no sale
              </Button>
              <Button size="sm" onClick={() => setSendOpen(true)}>
                <Truck className="mr-1 h-4 w-4" /> Send empties to Warehouse
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Jug</TableHead>
                <TableHead className="text-right">Filled received</TableHead>
                <TableHead className="text-right">Sold: swap</TableHead>
                <TableHead className="text-right">Sold: return later</TableHead>
                <TableHead className="text-right">Sold: permanent</TableHead>
                <TableHead className="text-right">Back: good</TableHead>
                <TableHead className="text-right">Back: damaged</TableHead>
                <TableHead className="text-right">Sent to WH</TableHead>
                <TableHead className="text-right">WH confirmed</TableHead>
                <TableHead className="text-right">Jar price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {types.map((r) => (
                <TableRow key={r.container_type_id}>
                  <TableCell className="font-medium">{r.container_name}</TableCell>
                  <TableCell className="text-right">{num(n(r.filled_received))}</TableCell>
                  <TableCell className="text-right">{num(n(r.sold_swap))}</TableCell>
                  <TableCell className="text-right">{num(n(r.sold_return_later))}</TableCell>
                  <TableCell className="text-right">{num(n(r.sold_permanent))}</TableCell>
                  <TableCell className="text-right">{num(n(r.returned_good))}</TableCell>
                  <TableCell className="text-right">{num(n(r.returned_damaged))}</TableCell>
                  <TableCell className="text-right">{num(n(r.sent_to_warehouse))}</TableCell>
                  <TableCell
                    className={`text-right ${n(r.confirmed_by_warehouse) < n(r.sent_to_warehouse) && !n(r.sent_unconfirmed) ? "text-destructive" : ""}`}
                  >
                    {num(n(r.confirmed_by_warehouse))}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {r.jar_price == null ? (
                      <span className="text-muted-foreground">not set</span>
                    ) : (
                      <span title={`Jar + water ${money(n(r.with_jar_price))}`}>
                        {money(n(r.jar_price))}
                      </span>
                    )}
                    {canPrice && (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto px-1"
                        onClick={() => setPriceFor(r)}
                      >
                        Edit
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {types.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="py-6 text-center text-muted-foreground">
                    {summary.isLoading ? "Loading…" : "No jug types set up."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Empties owed by customers</CardTitle>
          <Input
            className="w-64"
            placeholder="Invoice, customer or phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sale</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Jug</TableHead>
                <TableHead className="text-right">Taken</TableHead>
                <TableHead className="text-right">Returned</TableHead>
                <TableHead className="text-right">Still owed</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(owed.data ?? []).map((o) => (
                <TableRow key={`${o.sale_id}-${o.container_type_id}`}>
                  <TableCell>
                    <div className="font-mono text-xs">{o.invoice_number}</div>
                    <div className="text-xs text-muted-foreground">{o.sale_date}</div>
                  </TableCell>
                  <TableCell>
                    {o.customer_name}
                    {o.customer_phone && (
                      <div className="text-xs text-muted-foreground">{o.customer_phone}</div>
                    )}
                  </TableCell>
                  <TableCell>{o.container_name}</TableCell>
                  <TableCell className="text-right">{num(n(o.quantity_out))}</TableCell>
                  <TableCell className="text-right">{num(n(o.quantity_returned))}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {num(n(o.outstanding))}
                  </TableCell>
                  <TableCell className="text-right">
                    {canRecord && (
                      <Button variant="outline" size="sm" onClick={() => setReturnFor(o)}>
                        Record return
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {(owed.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                    {owed.isLoading ? "Loading…" : "No customer owes an empty jar."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {(extras.data ?? []).length > 0 && (
        <Card className="rounded-2xl border-amber-500/50">
          <CardHeader>
            <CardTitle className="text-base">Extra empties waiting for a decision</CardTitle>
            <p className="text-sm text-muted-foreground">
              More empties came back than the customer owed. A manager other than the person who
              recorded them accepts them into the shop&apos;s jars or refuses them.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {(extras.data ?? []).map((x) => (
              <ExtraRow key={x.id} row={x} canDecide={canDecide} onDone={refresh} />
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={!!returnFor} onOpenChange={(v) => !v && setReturnFor(null)}>
        {returnFor && (
          <ReturnDialog
            outletId={outletId}
            owed={returnFor === "unlinked" ? null : returnFor}
            types={types}
            onDone={() => {
              setReturnFor(null);
              refresh();
            }}
          />
        )}
      </Dialog>
      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        {sendOpen && (
          <SendDialog
            outletId={outletId}
            types={types}
            onDone={() => {
              setSendOpen(false);
              refresh();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!priceFor} onOpenChange={(v) => !v && setPriceFor(null)}>
        {priceFor && (
          <PriceDialog
            row={priceFor}
            onDone={() => {
              setPriceFor(null);
              refresh();
              qc.invalidateQueries({ queryKey: ["jug-products"] });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

// Empties a customer brought back: against a sale (Record return) or with no
// sale (all of it waits for a manager).
function ReturnDialog({
  outletId,
  owed,
  types,
  onDone,
}: {
  outletId: string;
  owed: Owed | null;
  types: Summary[];
  onDone: () => void;
}) {
  const [typeId, setTypeId] = useState(
    owed?.container_type_id ?? types[0]?.container_type_id ?? "",
  );
  const [good, setGood] = useState(owed ? n(owed.outstanding) : 0);
  const [damaged, setDamaged] = useState(0);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [ref] = useState(newRef);
  const save = useMutation({
    mutationFn: async () => {
      if (!typeId) throw new Error("Choose the jug type");
      if (good + damaged <= 0) throw new Error("Enter how many empties came back");
      const { data, error } = await db.rpc("record_customer_jar_return", {
        payload: {
          outlet_id: outletId,
          container_type_id: typeId,
          sale_id: owed?.sale_id ?? null,
          customer_name: owed ? undefined : name || null,
          quantity_good: good,
          quantity_damaged: damaged,
          notes: notes || null,
          client_ref: ref,
        },
      });
      if (error) throw error;
      return data as { return_number: string; applied: number; excess: number };
    },
    onSuccess: (r) => {
      toast.success(
        r.excess > 0
          ? `${r.return_number}: ${num(r.applied)} settled; ${num(r.excess)} extra await a manager`
          : `${r.return_number}: ${num(r.applied)} empty jar(s) received`,
      );
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>
          {owed ? `Empties back — ${owed.invoice_number}` : "Empties with no sale"}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 text-sm">
        {owed ? (
          <p className="text-muted-foreground">
            {owed.customer_name} took {num(n(owed.quantity_out))}, returned{" "}
            {num(n(owed.quantity_returned))}, still owes <b>{num(n(owed.outstanding))}</b>. Anything
            above that waits for a manager.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground">
              Not owed on any sale here, so none of it is credited until a manager accepts it.
            </p>
            <div>
              <Label>Customer (optional)</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label>Jug</Label>
              <Select value={typeId} onValueChange={setTypeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Jug type" />
                </SelectTrigger>
                <SelectContent>
                  {types.map((t) => (
                    <SelectItem key={t.container_type_id} value={t.container_type_id}>
                      {t.container_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Good</Label>
            <Input
              type="number"
              min={0}
              value={good}
              onChange={(e) => setGood(Math.max(0, Math.floor(+e.target.value || 0)))}
            />
          </div>
          <div>
            <Label>Damaged</Label>
            <Input
              type="number"
              min={0}
              value={damaged}
              onChange={(e) => setDamaged(Math.max(0, Math.floor(+e.target.value || 0)))}
            />
          </div>
        </div>
        <div>
          <Label>Notes</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Record
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// The shop sends empties to the Warehouse (record_jug_return): they stay on
// the shop until the Warehouse confirms the count on Jug accountability.
function SendDialog({
  outletId,
  types,
  onDone,
}: {
  outletId: string;
  types: Summary[];
  onDone: () => void;
}) {
  const [typeId, setTypeId] = useState(types[0]?.container_type_id ?? "");
  const row = types.find((t) => t.container_type_id === typeId);
  const [qty, setQty] = useState(0);
  const [notes, setNotes] = useState("");
  const [ref] = useState(newRef);
  const send = useMutation({
    mutationFn: async () => {
      if (qty <= 0) throw new Error("Enter how many empties are going");
      const { data, error } = await db.rpc("record_jug_return", {
        payload: {
          sales_rep_id: outletId,
          container_type_id: typeId,
          quantity: qty,
          notes: notes || null,
          client_ref: ref,
        },
      });
      if (error) throw error;
      return data as { reference: string };
    },
    onSuccess: (r) => {
      toast.success(`${r.reference}: sent — the Warehouse confirms the count`);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Send empties to the Warehouse</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 text-sm">
        <div>
          <Label>Jug</Label>
          <Select value={typeId} onValueChange={setTypeId}>
            <SelectTrigger>
              <SelectValue placeholder="Jug type" />
            </SelectTrigger>
            <SelectContent>
              {types.map((t) => (
                <SelectItem key={t.container_type_id} value={t.container_type_id}>
                  {t.container_name} ({num(n(t.empties_at_shop))} at the shop)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Quantity</Label>
          <Input
            type="number"
            min={0}
            max={row ? n(row.empties_at_shop) : undefined}
            value={qty}
            onChange={(e) => setQty(Math.max(0, Math.floor(+e.target.value || 0)))}
          />
        </div>
        <div>
          <Label>Condition / notes</Label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. 2 cracked"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          They stay on the shop until the Warehouse counts them. If fewer arrive, the difference
          stays on the shop as a shortfall.
        </p>
      </div>
      <DialogFooter>
        <Button onClick={() => send.mutate()} disabled={send.isPending || !typeId}>
          {send.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Send
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ExtraRow({
  row,
  canDecide,
  onDone,
}: {
  row: Extra;
  canDecide: boolean;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const decide = useMutation({
    mutationFn: async (approve: boolean) => {
      const { error } = await db.rpc("decide_jar_return_excess", {
        p_id: row.id,
        p_approve: approve,
        p_reason: reason,
      });
      if (error) throw error;
      return approve;
    },
    onSuccess: (approve) => {
      toast.success(approve ? "Accepted into the shop's jars" : "Refused");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
      <span className="font-mono text-xs">{row.return_number}</span>
      <span>{row.customer_name ?? "Walk-in"}</span>
      <Badge variant="outline">
        {num(n(row.excess_quantity))} × {row.container_types?.name ?? "jug"}
      </Badge>
      {canDecide && (
        <>
          <Input
            className="h-8 w-56"
            placeholder="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button size="sm" onClick={() => decide.mutate(true)} disabled={decide.isPending}>
            Accept
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => decide.mutate(false)}
            disabled={decide.isPending}
          >
            Refuse
          </Button>
        </>
      )}
    </div>
  );
}

function PriceDialog({ row, onDone }: { row: Summary; onDone: () => void }) {
  const [jar, setJar] = useState(n(row.jar_price));
  const [withJar, setWithJar] = useState(n(row.with_jar_price));
  const save = useMutation({
    mutationFn: async () => {
      const { error } = await db.rpc("set_jar_prices", {
        p_container_type: row.container_type_id,
        p_jar_price: jar,
        p_with_jar_price: withJar,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Jar prices saved");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <DialogContent className="max-w-sm">
      <DialogHeader>
        <DialogTitle>Jar prices — {row.container_name}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 text-sm">
        <div>
          <Label>Jar alone</Label>
          <Input type="number" min={0} value={jar} onChange={(e) => setJar(+e.target.value || 0)} />
        </div>
        <div>
          <Label>Jar + water (Permanent sale price)</Label>
          <Input
            type="number"
            min={0}
            value={withJar}
            onChange={(e) => setWithJar(+e.target.value || 0)}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Water part: {money(Math.max(withJar - jar, 0))}. Used for new sales only.
        </p>
      </div>
      <DialogFooter>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
