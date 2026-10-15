import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, Search } from "lucide-react";

type Distributor = { id: string; name: string; phone: string | null; sales_rep_id: string | null };

// Warehouse "Post → Distributors", step 1: pick the distributor (a registered
// customer), or add one on the spot. Step 2 is the sale form preset to them,
// so the goods land on their customer account (purchases, balance, payments).
export function DistributorPicker({
  factoryId,
  onPick,
}: {
  factoryId: string;
  onPick: (customerId: string) => void;
}) {
  const qc = useQueryClient();
  const { canCreate } = usePermissions();
  const canAdd = canCreate("customers");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [repId, setRepId] = useState("none");

  const distributors = useQuery({
    queryKey: ["customers", "distributors", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("id,name,phone,sales_rep_id")
        .eq("factory_id", factoryId)
        .eq("registered", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Distributor[];
    },
  });
  const marketers = useQuery({
    queryKey: ["distributor-picker-reps", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_reps")
        .select("id,full_name,kind,status")
        .eq("factory_id", factoryId)
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string; kind: string; status: string }[];
    },
  });
  const activeMarketers = (marketers.data ?? []).filter(
    (r) => r.kind === "rep" && r.status === "active",
  );
  const marketerName = (id: string | null) =>
    (marketers.data ?? []).find((r) => r.id === id)?.full_name;

  const shown = useMemo(() => {
    const key = q.trim().toLowerCase();
    return (distributors.data ?? []).filter(
      (d) => !key || d.name.toLowerCase().includes(key) || (d.phone ?? "").includes(key),
    );
  }, [distributors.data, q]);

  const add = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Enter the distributor's name");
      const key = name.trim().toLowerCase();
      const twin = (distributors.data ?? []).find((d) => d.name.trim().toLowerCase() === key);
      if (twin)
        throw new Error(`"${twin.name}" is already a distributor — pick them from the list`);
      const { data, error } = await supabase
        .from("customers")
        .insert({
          factory_id: factoryId,
          name: name.trim(),
          phone: phone.trim() || null,
          address: address.trim() || null,
          sales_rep_id: repId === "none" ? null : repId,
          registered: true,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: (id) => {
      toast.success(`Distributor "${name.trim()}" added`);
      logAudit({ action: "create", entity: "customers", entityId: id, factoryId });
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customers-pos"] });
      onPick(id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Post to Distributor</DialogTitle>
      </DialogHeader>

      {!adding ? (
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search distributor…"
              className="pl-8"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {distributors.isLoading && (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {shown.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => onPick(d.id)}
                className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/50"
              >
                <span className="font-medium">{d.name}</span>
                <span className="text-xs text-muted-foreground">
                  {[
                    d.phone,
                    marketerName(d.sales_rep_id) && `under ${marketerName(d.sales_rep_id)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            ))}
            {!distributors.isLoading && shown.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {q ? "No distributor matches." : "No distributors yet."}
              </p>
            )}
          </div>
          {canAdd && (
            <Button variant="outline" className="gap-2" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> New distributor
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-3">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Phone</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div>
              <Label>Under marketer (optional)</Label>
              <Select value={repId} onValueChange={setRepId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  {activeMarketers.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Address / office</Label>
            <Input value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Back
            </Button>
            <Button disabled={add.isPending} onClick={() => add.mutate()}>
              {add.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add &amp; continue
            </Button>
          </DialogFooter>
        </div>
      )}
    </DialogContent>
  );
}
