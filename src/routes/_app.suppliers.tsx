import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
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
import { Badge } from "@/components/ui/badge";
import { Plus, Search, Pencil, Eye } from "lucide-react";
import { money, num } from "@/lib/format";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/suppliers")({
  head: () => ({ meta: [{ title: "Suppliers — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="suppliers">
      <SuppliersPage />
    </RequireAccess>
  ),
});

type Supplier = {
  id: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  category: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_account_name: string | null;
  status: string;
  notes: string | null;
  materials_supplied: string | null;
  outstanding_balance: number;
};
type SupplierMaterial = {
  id: string;
  name: string;
  unit: string;
  current_stock: number;
  unit_cost: number;
  category: string | null;
  material_categories: { name: string } | null;
};
type PurchaseRecord = {
  id: string;
  quantity: number;
  unit_cost: number | null;
  reference: string | null;
  created_at: string;
  raw_materials: { name: string; unit: string } | null;
};

function SuppliersPage() {
  const { data: factoryId } = useFactoryId();
  const qc = useQueryClient();
  const { canWrite } = usePermissions();
  const write = canWrite("suppliers");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [viewing, setViewing] = useState<Supplier | null>(null);

  const list = useQuery({
    queryKey: ["suppliers", factoryId, q],
    enabled: !!factoryId,
    queryFn: async () => {
      let query = supabase.from("suppliers").select("*").eq("factory_id", factoryId!).order("name");
      if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as Supplier[];
    },
  });

  const save = useMutation({
    mutationFn: async (form: Partial<Supplier>) => {
      if (!factoryId) throw new Error("No factory");
      const payload = {
        name: form.name!,
        contact_person: form.contact_person ?? null,
        phone: form.phone ?? null,
        email: form.email ?? null,
        address: form.address ?? null,
        category: form.category ?? null,
        bank_name: form.bank_name ?? null,
        bank_account_number: form.bank_account_number ?? null,
        bank_account_name: form.bank_account_name ?? null,
        status: form.status ?? "active",
        notes: form.notes ?? null,
        materials_supplied: form.materials_supplied ?? null,
        outstanding_balance: form.outstanding_balance ?? 0,
      };
      if (editing) {
        const { error } = await supabase.from("suppliers").update(payload).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("suppliers")
          .insert({ ...payload, factory_id: factoryId });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editing ? "Supplier updated" : "Supplier created");
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      setOpen(false);
      setEditing(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Suppliers</h1>
          <p className="text-sm text-muted-foreground">
            Supplier profiles, materials supplied, and purchase history.
          </p>
        </div>
        {write && (
          <Dialog
            open={open}
            onOpenChange={(v) => {
              setOpen(v);
              if (!v) setEditing(null);
            }}
          >
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" /> New Supplier
              </Button>
            </DialogTrigger>
            <SupplierDialog
              key={editing?.id ?? "new"}
              editing={editing}
              onSubmit={(f) => save.mutate(f)}
              saving={save.isPending}
            />
          </Dialog>
        )}
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle>All Suppliers</CardTitle>
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="pl-8 h-9"
            />
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Contact Person</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Materials Supplied</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Outstanding Balance</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>{s.category ?? "—"}</TableCell>
                  <TableCell>{s.contact_person ?? "—"}</TableCell>
                  <TableCell>{s.phone ?? "—"}</TableCell>
                  <TableCell className="max-w-60 truncate">{s.materials_supplied ?? "—"}</TableCell>
                  <TableCell>
                    <Badge
                      variant={s.status === "active" ? "secondary" : "outline"}
                      className="capitalize"
                    >
                      {s.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <span
                      className={
                        Number(s.outstanding_balance) > 0 ? "text-destructive font-medium" : ""
                      }
                    >
                      {money(Number(s.outstanding_balance))}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="View profile"
                        onClick={() => setViewing(s)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Edit"
                        onClick={() => {
                          setEditing(s);
                          setOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(list.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    No suppliers yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)}>
        {viewing && <SupplierProfileDialog supplier={viewing} />}
      </Dialog>
    </div>
  );
}

function SupplierProfileDialog({ supplier }: { supplier: Supplier }) {
  const materials = useQuery({
    queryKey: ["supplier-materials", supplier.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_materials")
        .select("id,name,unit,current_stock,unit_cost,category,material_categories(name)")
        .eq("supplier_id", supplier.id)
        .order("name");
      if (error) throw error;
      return (data ?? []) as SupplierMaterial[];
    },
  });

  const purchases = useQuery({
    queryKey: ["supplier-purchases", supplier.id],
    queryFn: async () => {
      const materialIds =
        (
          await supabase.from("raw_materials").select("id").eq("supplier_id", supplier.id)
        ).data?.map((m) => m.id) ?? [];
      if (materialIds.length === 0) return [];
      const { data, error } = await supabase
        .from("raw_material_movements")
        .select("id,quantity,unit_cost,reference,created_at,raw_materials(name,unit)")
        .in("material_id", materialIds)
        .eq("movement_type", "received")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as unknown as PurchaseRecord[];
    },
  });

  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{supplier.name}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/30 p-3 text-sm">
          <div>
            <span className="text-muted-foreground">Category:</span> {supplier.category ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Status:</span>{" "}
            <Badge
              variant={supplier.status === "active" ? "secondary" : "outline"}
              className="capitalize"
            >
              {supplier.status}
            </Badge>
          </div>
          <div>
            <span className="text-muted-foreground">Contact person:</span>{" "}
            {supplier.contact_person ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Phone:</span> {supplier.phone ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Email:</span> {supplier.email ?? "—"}
          </div>
          <div className="col-span-2">
            <span className="text-muted-foreground">Address:</span> {supplier.address ?? "—"}
          </div>
          <div className="col-span-2">
            <span className="text-muted-foreground">Bank details:</span>{" "}
            {supplier.bank_name
              ? `${supplier.bank_name} · ${supplier.bank_account_name ?? "—"} · ${supplier.bank_account_number ?? "—"}`
              : "—"}
          </div>
          <div className="col-span-2">
            <span className="text-muted-foreground">Materials supplied:</span>{" "}
            {supplier.materials_supplied ?? "—"}
          </div>
          {supplier.notes && (
            <div className="col-span-2">
              <span className="text-muted-foreground">Notes:</span> {supplier.notes}
            </div>
          )}
          <div>
            <span className="text-muted-foreground">Outstanding balance:</span>{" "}
            <span
              className={
                Number(supplier.outstanding_balance) > 0 ? "text-destructive font-medium" : ""
              }
            >
              {money(Number(supplier.outstanding_balance))}
            </span>
          </div>
        </div>

        <div>
          <div className="mb-2 text-sm font-medium">Materials on file</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Material</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Current Stock</TableHead>
                <TableHead className="text-right">Unit Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(materials.data ?? []).map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{m.name}</TableCell>
                  <TableCell>{m.material_categories?.name ?? m.category ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    {num(Number(m.current_stock))} {m.unit}
                  </TableCell>
                  <TableCell className="text-right">{money(Number(m.unit_cost))}</TableCell>
                </TableRow>
              ))}
              {(materials.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-4">
                    No materials linked to this supplier yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div>
          <div className="mb-2 text-sm font-medium">Purchase history</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Material</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(purchases.data ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{new Date(p.created_at).toLocaleDateString()}</TableCell>
                  <TableCell>{p.raw_materials?.name ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    {num(Number(p.quantity))} {p.raw_materials?.unit ?? ""}
                  </TableCell>
                  <TableCell className="text-right">
                    {p.unit_cost != null ? money(Number(p.unit_cost)) : "—"}
                  </TableCell>
                </TableRow>
              ))}
              {(purchases.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-4">
                    No purchases recorded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </DialogContent>
  );
}

function SupplierDialog({
  editing,
  onSubmit,
  saving,
}: {
  editing: Supplier | null;
  onSubmit: (f: Partial<Supplier>) => void;
  saving: boolean;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [contactPerson, setContactPerson] = useState(editing?.contact_person ?? "");
  const [phone, setPhone] = useState(editing?.phone ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  const [address, setAddress] = useState(editing?.address ?? "");
  const [category, setCategory] = useState(editing?.category ?? "");
  const [bankName, setBankName] = useState(editing?.bank_name ?? "");
  const [bankAccountName, setBankAccountName] = useState(editing?.bank_account_name ?? "");
  const [bankAccountNumber, setBankAccountNumber] = useState(editing?.bank_account_number ?? "");
  const [status, setStatus] = useState(editing?.status ?? "active");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [materials, setMaterials] = useState(editing?.materials_supplied ?? "");
  const [balance, setBalance] = useState(editing ? Number(editing.outstanding_balance) : 0);

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{editing ? "Edit Supplier" : "New Supplier"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 max-h-[75vh] overflow-y-auto pr-1">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>Contact person</Label>
            <Input value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Phone</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div>
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>
        <div>
          <Label>Address</Label>
          <Textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Supplier category</Label>
            <Input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. Packaging"
            />
          </div>
          <div>
            <Label>Status</Label>
            <Select value={status} onValueChange={setStatus}>
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
        <div>
          <Label>Materials supplied</Label>
          <Textarea
            rows={2}
            value={materials}
            onChange={(e) => setMaterials(e.target.value)}
            placeholder="e.g. PET preforms, caps, labels"
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>Bank name</Label>
            <Input value={bankName} onChange={(e) => setBankName(e.target.value)} />
          </div>
          <div>
            <Label>Account name</Label>
            <Input value={bankAccountName} onChange={(e) => setBankAccountName(e.target.value)} />
          </div>
          <div>
            <Label>Account number</Label>
            <Input
              value={bankAccountNumber}
              onChange={(e) => setBankAccountNumber(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label>Outstanding balance</Label>
          <MoneyInput value={balance} onChange={setBalance} />
        </div>
        <div>
          <Label>Notes</Label>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={!name.trim() || saving}
          onClick={() =>
            onSubmit({
              name: name.trim(),
              contact_person: contactPerson || null,
              phone: phone || null,
              email: email || null,
              address: address || null,
              category: category || null,
              bank_name: bankName || null,
              bank_account_name: bankAccountName || null,
              bank_account_number: bankAccountNumber || null,
              status,
              notes: notes || null,
              materials_supplied: materials || null,
              outstanding_balance: balance,
            })
          }
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
