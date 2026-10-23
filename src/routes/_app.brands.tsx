import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Plus, Search, Pencil, Trash2 } from "lucide-react";
import { num } from "@/lib/format";
import { toast } from "sonner";
import { ReportActions } from "@/components/shared/report-actions";
import { SupplierPicker } from "@/components/shared/supplier-picker";

// Store → Brands: the supplier brands the Store buys, each with its dealer
// (supplier), how it is packed and how many pieces/rolls/packs come in one.
// Table and the old system's list: 20261023100000_brands.sql.

export const Route = createFileRoute("/_app/brands")({
  head: () => ({
    meta: [{ title: "Brands — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <>
      <SectionTabs section="Store" />
      <RequireAccess module="raw-materials">
        <BrandsPage />
      </RequireAccess>
    </>
  ),
});

const CATEGORIES = ["Bag", "Carton", "Piece", "Roll"] as const;

type Brand = {
  id: string;
  name: string;
  supplier_id: string | null;
  category: string;
  grammage: string | null;
  pack_quantity: number;
  created_by: string | null;
  created_at: string;
  suppliers: { name: string } | null;
};
type BrandForm = {
  name: string;
  supplier_id: string | null;
  category: string;
  grammage: string | null;
  pack_quantity: number;
};

const addedOn = (iso: string) => format(new Date(iso), "dd-MM-yyyy HH:mm:ss");

function BrandsPage() {
  const { data: factoryId } = useFactoryId();
  const qc = useQueryClient();
  const { canCreate, canEdit, canDelete } = usePermissions();
  const create = canCreate("raw-materials");
  const edit = canEdit("raw-materials");
  const remove = canDelete("raw-materials");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Brand | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Brand | null>(null);

  const list = useQuery({
    queryKey: ["brands", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("brands")
        .select(
          "id,name,supplier_id,category,grammage,pack_quantity,created_by,created_at,suppliers(name)",
        )
        .eq("factory_id", factoryId!)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as Brand[];
    },
  });

  const suppliers = useQuery({
    queryKey: ["suppliers-brief", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("suppliers")
        .select("id,name")
        .eq("factory_id", factoryId!)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const creatorIds = [
    ...new Set((list.data ?? []).flatMap((b) => (b.created_by ? [b.created_by] : []))),
  ];
  const creators = useQuery({
    queryKey: ["brand-creators", creatorIds],
    enabled: creatorIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("id,full_name").in("id", creatorIds);
      return new Map((data ?? []).map((p) => [p.id, p.full_name ?? ""]));
    },
  });
  // Brands brought over from the old system have no creator here.
  const createdBy = (b: Brand) =>
    b.created_by ? creators.data?.get(b.created_by) || "—" : "Old system";

  const save = useMutation({
    mutationFn: async (form: BrandForm) => {
      if (!factoryId) throw new Error("No factory");
      if (editing) {
        const { error } = await supabase.from("brands").update(form).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("brands").insert({ ...form, factory_id: factoryId });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editing ? "Brand updated" : "Brand added");
      qc.invalidateQueries({ queryKey: ["brands"] });
      qc.invalidateQueries({ queryKey: ["brands-brief"] });
      setOpen(false);
      setEditing(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: async (brand: Brand) => {
      const { error } = await supabase.from("brands").delete().eq("id", brand.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Brand deleted");
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["brands"] });
      qc.invalidateQueries({ queryKey: ["brands-brief"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const term = q.trim().toLowerCase();
  const rows = (list.data ?? []).filter(
    (b) =>
      !term ||
      [b.name, b.suppliers?.name, b.category, b.grammage].some((v) =>
        (v ?? "").toLowerCase().includes(term),
      ),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Store — Brands</h1>
          <p className="text-sm text-muted-foreground">
            Supplier brands, their dealers and how each is packed.
          </p>
        </div>
        {create && (
          <Button
            className="gap-2"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            <Plus className="h-4 w-4" /> Add New Brand
          </Button>
        )}
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>All Brands</CardTitle>
            <CardDescription>List of all brands</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <ReportActions
              size="sm"
              title="Brands"
              fileName="brands"
              columns={[
                { key: "sn", label: "S/N" },
                { key: "brand", label: "Brand" },
                { key: "dealer", label: "Dealer" },
                { key: "category", label: "Category" },
                { key: "grammage", label: "Grammage" },
                { key: "qty", label: "Pieces/Rolls/Packs" },
                { key: "by", label: "Created By" },
                { key: "on", label: "On" },
              ]}
              rows={rows.map((b, i) => ({
                sn: i + 1,
                brand: b.name,
                dealer: b.suppliers?.name ?? "",
                category: b.category,
                grammage: b.grammage ?? "",
                qty: num(b.pack_quantity),
                by: createdBy(b),
                on: addedOn(b.created_at),
              }))}
              subtitle={q.trim() ? [`Search: ${q.trim()}`] : []}
            />
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search…"
                className="pl-8 h-9"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">S/N</TableHead>
                <TableHead>Brand</TableHead>
                <TableHead>Dealer</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Grammage</TableHead>
                <TableHead className="text-right">Pieces/Rolls/Packs</TableHead>
                <TableHead>Created By</TableHead>
                <TableHead>On</TableHead>
                {(edit || remove) && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((b, i) => (
                <TableRow key={b.id}>
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="font-medium">{b.name}</TableCell>
                  <TableCell>{b.suppliers?.name ?? "—"}</TableCell>
                  <TableCell>{b.category}</TableCell>
                  <TableCell>{b.grammage ?? "—"}</TableCell>
                  <TableCell className="text-right">{num(b.pack_quantity)}</TableCell>
                  <TableCell>{createdBy(b)}</TableCell>
                  <TableCell className="whitespace-nowrap">{addedOn(b.created_at)}</TableCell>
                  {(edit || remove) && (
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {edit && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Edit"
                            onClick={() => {
                              setEditing(b);
                              setOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                        {remove && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Delete"
                            onClick={() => setDeleteTarget(b)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    {list.isLoading ? "Loading…" : "No brands yet."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setEditing(null);
        }}
      >
        {open && (
          <BrandDialog
            key={editing?.id ?? "new"}
            editing={editing}
            factoryId={factoryId}
            suppliers={suppliers.data ?? []}
            onSubmit={(f) => save.mutate(f)}
            saving={save.isPending}
          />
        )}
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the brand
              {deleteTarget?.grammage
                ? ` (${deleteTarget.grammage}, ${deleteTarget.category})`
                : ""}{" "}
              from the list. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={del.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) del.mutate(deleteTarget);
              }}
            >
              {del.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function BrandDialog({
  editing,
  factoryId,
  suppliers,
  onSubmit,
  saving,
}: {
  editing: Brand | null;
  factoryId: string | null | undefined;
  suppliers: { id: string; name: string }[];
  onSubmit: (f: BrandForm) => void;
  saving: boolean;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [supplierId, setSupplierId] = useState(editing?.supplier_id ?? "none");
  const [category, setCategory] = useState(editing?.category ?? "Bag");
  const [grammage, setGrammage] = useState(editing?.grammage ?? "");
  const [qty, setQty] = useState(editing ? String(editing.pack_quantity) : "");
  const qtyNum = qty.trim() === "" ? 0 : Number(qty);
  const qtyOk = Number.isInteger(qtyNum) && qtyNum >= 0;

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{editing ? "Edit Brand" : "Add New Brand"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Brand *</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Dealer</Label>
          <SupplierPicker
            factoryId={factoryId}
            suppliers={suppliers}
            value={supplierId}
            onChange={setSupplierId}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Category *</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Grammage</Label>
            <Input
              value={grammage}
              onChange={(e) => setGrammage(e.target.value)}
              placeholder="e.g. 14.8g or 30mm"
            />
          </div>
        </div>
        <div>
          <Label>Pieces/Rolls/Packs</Label>
          <Input
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="How many in one bag, carton or roll"
          />
          {!qtyOk && <p className="mt-1 text-xs text-destructive">Enter a whole number.</p>}
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={!name.trim() || !qtyOk || saving}
          onClick={() =>
            onSubmit({
              name: name.trim(),
              supplier_id: supplierId === "none" ? null : supplierId,
              category,
              grammage: grammage.trim() || null,
              pack_quantity: qtyNum,
            })
          }
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
