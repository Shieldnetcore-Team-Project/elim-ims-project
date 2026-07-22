import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Search, Pencil } from "lucide-react";
import { money } from "@/lib/format";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/customers")({
  head: () => ({ meta: [{ title: "Customers — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: CustomersPage,
});

type Customer = {
  id: string; name: string; phone: string | null; email: string | null;
  address: string | null; outstanding_balance: number; total_purchases: number;
};

function CustomersPage() {
  const { data: factoryId } = useFactoryId();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);

  const list = useQuery({
    queryKey: ["customers", factoryId, q],
    enabled: !!factoryId,
    queryFn: async () => {
      let query = supabase.from("customers").select("*").eq("factory_id", factoryId!).order("name");
      if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as Customer[];
    },
  });

  const save = useMutation({
    mutationFn: async (form: Partial<Customer>) => {
      if (!factoryId) throw new Error("No factory");
      if (editing) {
        const { error } = await supabase.from("customers").update({
          name: form.name!, phone: form.phone, email: form.email, address: form.address,
        }).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("customers").insert({
          factory_id: factoryId, name: form.name!, phone: form.phone, email: form.email, address: form.address,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editing ? "Customer updated" : "Customer created");
      qc.invalidateQueries({ queryKey: ["customers"] });
      setOpen(false); setEditing(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="text-sm text-muted-foreground">Manage customer profiles and outstanding balances.</p>
        </div>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditing(null); }}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="h-4 w-4" /> New Customer</Button>
          </DialogTrigger>
          <CustomerDialog
            key={editing?.id ?? "new"}
            editing={editing}
            onSubmit={(f) => save.mutate(f)}
            saving={save.isPending}
          />
        </Dialog>
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle>All Customers</CardTitle>
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="pl-8 h-9" />
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Email</TableHead>
                <TableHead className="text-right">Total Purchases</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead className="w-16"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>{c.phone ?? "—"}</TableCell>
                  <TableCell>{c.email ?? "—"}</TableCell>
                  <TableCell className="text-right">{money(Number(c.total_purchases))}</TableCell>
                  <TableCell className="text-right">
                    <span className={Number(c.outstanding_balance) > 0 ? "text-destructive font-medium" : ""}>
                      {money(Number(c.outstanding_balance))}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => { setEditing(c); setOpen(true); }}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(list.data ?? []).length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No customers yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function CustomerDialog({ editing, onSubmit, saving }: {
  editing: Customer | null; onSubmit: (f: Partial<Customer>) => void; saving: boolean;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [phone, setPhone] = useState(editing?.phone ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  const [address, setAddress] = useState(editing?.address ?? "");
  return (
    <DialogContent>
      <DialogHeader><DialogTitle>{editing ? "Edit Customer" : "New Customer"}</DialogTitle></DialogHeader>
      <div className="grid gap-3">
        <div><Label>Name *</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Phone</Label><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div><Label>Email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        </div>
        <div><Label>Address</Label><Textarea value={address} onChange={(e) => setAddress(e.target.value)} /></div>
      </div>
      <DialogFooter>
        <Button
          disabled={!name.trim() || saving}
          onClick={() => onSubmit({ name: name.trim(), phone: phone || null, email: email || null, address: address || null })}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
