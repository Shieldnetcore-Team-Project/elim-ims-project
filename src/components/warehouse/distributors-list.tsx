import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { money, num } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Loader2, Pencil, Plus, Search, Send } from "lucide-react";
import { CustomerProfileDialog, type Customer } from "@/routes/_app.customers";
import { PosDialog } from "@/routes/_app.sales";

type Marketer = { id: string; full_name: string; kind: string; status: string };

// Distribution → Distributors: the registered customers the Warehouse sells
// to directly, listed the way Reps & Outlets lists marketers. Add or edit a
// distributor, post products to one (a sale onto their account), or click a
// row for their profile and purchases. Amounts show only to whoever may see
// distributor accounts.
export function DistributorsListTab({ factoryId }: { factoryId: string }) {
  const qc = useQueryClient();
  const perms = usePermissions();
  const canAdd = perms.canCreate("customers");
  const canEdit = perms.canEdit("customers") || canAdd;
  const canPost = perms.canWrite("sales");
  const showValues = perms.canSeeMoney || perms.can("distributor-accounts");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Customer | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [viewing, setViewing] = useState<Customer | null>(null);
  const [posting, setPosting] = useState<Customer | null>(null);

  const distributors = useQuery({
    queryKey: ["customers", "distributors-list", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("*")
        .eq("factory_id", factoryId)
        .eq("registered", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Customer[];
    },
  });
  const marketers = useQuery({
    queryKey: ["dist-reps-brief", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_reps")
        .select("id,full_name,kind,status")
        .eq("factory_id", factoryId)
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as Marketer[];
    },
  });
  const marketerName = (id: string | null) =>
    (marketers.data ?? []).find((m) => m.id === id)?.full_name;

  const shown = useMemo(() => {
    const key = q.trim().toLowerCase();
    return (distributors.data ?? []).filter(
      (d) =>
        !key ||
        d.name.toLowerCase().includes(key) ||
        (d.phone ?? "").toLowerCase().includes(key) ||
        (marketerName(d.sales_rep_id) ?? "").toLowerCase().includes(key),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distributors.data, marketers.data, q]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["customers"] });
    qc.invalidateQueries({ queryKey: ["global-search"] });
  };

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>Distributors</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="h-9 pl-8"
              placeholder="Search name, phone, marketer…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {canAdd && (
            <Button
              size="sm"
              className="gap-2"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> Add Distributor
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Marketer</TableHead>
              <TableHead className="text-right">Sales</TableHead>
              {showValues && (
                <>
                  <TableHead className="text-right">Total goods</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </>
              )}
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((d) => (
              <TableRow
                key={d.id}
                className="cursor-pointer"
                title="Click to see this distributor's profile and purchases"
                onClick={() => setViewing(d)}
              >
                <TableCell className="font-medium text-primary">{d.name}</TableCell>
                <TableCell>{d.phone ?? "—"}</TableCell>
                <TableCell className="max-w-56 truncate text-xs">{d.address ?? "—"}</TableCell>
                <TableCell>{marketerName(d.sales_rep_id) ?? "—"}</TableCell>
                <TableCell className="text-right">
                  {num(Number(d.total_transactions ?? 0))}
                </TableCell>
                {showValues && (
                  <>
                    <TableCell className="text-right">
                      {money(Number(d.total_purchases ?? 0))}
                    </TableCell>
                    <TableCell className="text-right">
                      <span
                        className={
                          Number(d.outstanding_balance) > 0 ? "font-medium text-destructive" : ""
                        }
                      >
                        {Number(d.outstanding_balance) > 0
                          ? money(Number(d.outstanding_balance))
                          : "—"}
                      </span>
                    </TableCell>
                  </>
                )}
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <div className="flex justify-end gap-1">
                    {canPost && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1"
                        title={`Post products to ${d.name}`}
                        onClick={() => setPosting(d)}
                      >
                        <Send className="h-4 w-4" /> Post
                      </Button>
                    )}
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Edit"
                        onClick={() => {
                          setEditing(d);
                          setFormOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {shown.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={showValues ? 8 : 6}
                  className="py-8 text-center text-muted-foreground"
                >
                  {distributors.isLoading
                    ? "Loading…"
                    : q.trim()
                      ? "No distributor matches your search."
                      : "No distributors yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        {formOpen && (
          <DistributorDialog
            factoryId={factoryId}
            distributor={editing}
            marketers={(marketers.data ?? []).filter(
              (m) => m.kind === "rep" && (m.status === "active" || m.id === editing?.sales_rep_id),
            )}
            onDone={() => {
              setFormOpen(false);
              refresh();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)}>
        {viewing && <CustomerProfileDialog customer={viewing} />}
      </Dialog>
      <Dialog open={!!posting} onOpenChange={(v) => !v && setPosting(null)}>
        {posting && (
          <PosDialog
            factoryId={factoryId}
            presetCustomerId={posting.id}
            defaultDiscountType="per_pack"
            onDone={() => {
              setPosting(null);
              refresh();
              for (const key of [
                "sales-list",
                "finished-goods",
                "products-active",
                "acct-postings",
              ])
                qc.invalidateQueries({ queryKey: [key] });
            }}
          />
        )}
      </Dialog>
    </Card>
  );
}

function DistributorDialog({
  factoryId,
  distributor,
  marketers,
  onDone,
}: {
  factoryId: string;
  distributor: Customer | null;
  marketers: Marketer[];
  onDone: () => void;
}) {
  const [name, setName] = useState(distributor?.name ?? "");
  const [phone, setPhone] = useState(distributor?.phone ?? "");
  const [address, setAddress] = useState(distributor?.address ?? "");
  const [repId, setRepId] = useState(distributor?.sales_rep_id ?? "none");

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Name is required");
      const body = {
        name: name.trim(),
        phone: phone.trim() || null,
        address: address.trim() || null,
        sales_rep_id: repId === "none" ? null : repId,
        registered: true,
      };
      if (distributor) {
        const { error } = await supabase.from("customers").update(body).eq("id", distributor.id);
        if (error) throw error;
        return distributor.id;
      }
      const { data, error } = await supabase
        .from("customers")
        .insert({ factory_id: factoryId, ...body })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: (id) => {
      toast.success(distributor ? "Distributor updated" : "Distributor added");
      logAudit({
        action: distributor ? "update" : "create",
        entity: "customers",
        entityId: id,
        factoryId,
      });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>{distributor ? `Edit ${distributor.name}` : "Add Distributor"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Name *</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Phone</Label>
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div>
          <Label>Address</Label>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div>
          <Label>Under marketer (optional)</Label>
          <Select value={repId} onValueChange={setRepId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— None —</SelectItem>
              {marketers.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.full_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <DialogFooter>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {distributor ? "Save" : "Add Distributor"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
