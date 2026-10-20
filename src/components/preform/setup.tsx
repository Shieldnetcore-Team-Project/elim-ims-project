import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Loader2, Settings2 } from "lucide-react";
import { usePermissions } from "@/lib/permissions";
import { formatPieces } from "@/lib/preform-units";
import { db, rpc, usePfAction, usePreformMaterials, type PreformMaterial } from "./api";
import { CountInput } from "./shared";

export function SetupTab({ factoryId }: { factoryId: string }) {
  const { can } = usePermissions();
  const canEdit = can("preform-production", "reverse") || can("settings", "edit");
  const materials = usePreformMaterials(factoryId);
  const [target, setTarget] = useState<PreformMaterial | null>(null);

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Preform setup</CardTitle>
        <p className="text-sm text-muted-foreground">
          Pieces per bag converts bags to pieces when the store issues preforms. Each issue keeps
          the figure it was issued with, so changing it later never changes history. The bottle
          product is the Warehouse stock item good bottles from this preform go into.
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Preform (store material)</TableHead>
              <TableHead className="text-right">In store</TableHead>
              <TableHead className="text-right">Pieces per bag</TableHead>
              <TableHead>Good bottles go into</TableHead>
              <TableHead className="text-right">Bottles in Warehouse</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(materials.data ?? []).map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-medium">{m.name}</TableCell>
                <TableCell className="text-right text-sm">
                  {formatPieces(m.current_stock, m.pieces_per_bag)}
                </TableCell>
                <TableCell className="text-right">
                  {m.pieces_per_bag ?? <span className="text-destructive">Not set</span>}
                </TableCell>
                <TableCell>
                  {m.output_product?.name ?? <span className="text-destructive">Not set</span>}
                </TableCell>
                <TableCell className="text-right">
                  {m.output_product ? m.output_product.current_stock.toLocaleString() : "—"}
                </TableCell>
                <TableCell className="text-right">
                  {canEdit && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1"
                      onClick={() => setTarget(m)}
                    >
                      <Settings2 className="h-3.5 w-3.5" /> Set up
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {(materials.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No preform materials found. Add them on the Raw Materials page (names containing
                  &quot;Preform&quot;).
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
      {target && <SetupDialog factoryId={factoryId} m={target} onClose={() => setTarget(null)} />}
    </Card>
  );
}

function SetupDialog({
  factoryId,
  m,
  onClose,
}: {
  factoryId: string;
  m: PreformMaterial;
  onClose: () => void;
}) {
  const products = useQuery({
    queryKey: ["pf", "products-all", factoryId],
    queryFn: async () => {
      const { data, error } = await db
        .from("products")
        .select("id,name,product_type")
        .eq("factory_id", factoryId)
        .eq("active", true)
        .order("product_type", { ascending: false })
        .order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string; product_type: string }[];
    },
  });
  const [ppb, setPpb] = useState<number | null>(m.pieces_per_bag);
  const [productId, setProductId] = useState(m.output_product_id ?? "");
  const [reason, setReason] = useState("");
  const changing = m.pieces_per_bag != null && ppb != null && ppb !== m.pieces_per_bag;
  const save = usePfAction(
    () =>
      rpc("preform_setup_material", {
        p_material: m.id,
        p_pieces_per_bag: ppb,
        p_output_product: productId || null,
        p_reason: reason || null,
      }),
    "Setup saved",
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Set up {m.name}</DialogTitle>
          <DialogDescription>Recorded in the audit log.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Pieces per bag</Label>
            <CountInput value={ppb} onChange={setPpb} placeholder="e.g. 1152" />
          </div>
          <div className="space-y-1.5">
            <Label>Good bottles go into</Label>
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick the bottle product" />
              </SelectTrigger>
              <SelectContent>
                {(products.data ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.product_type === "semi_finished" ? " (semi-finished)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {changing && (
            <div className="space-y-1.5">
              <Label>Why is pieces per bag changing? (required)</Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. new supplier bag size"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            disabled={save.isPending || !ppb || (changing && !reason.trim())}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
