import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Ban, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import type { Activity } from "@/components/warehouse/activity";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Cancel a wrong Warehouse posting (user, 2026-11-04): to a marketer, the
// Retail Shop or a distributor. The goods go back into the Warehouse as if
// it never left (cancel_warehouse_posting, 20261104110000); Accounts sees it
// as reversed. Refused once the marketer / shop has sold or returned part of
// it, or when it carries another officer's products.
export function useCanCancelPosting() {
  const perms = usePermissions();
  return (a: Pick<Activity, "kind" | "status">) =>
    a.status === "posted" &&
    (a.kind === "distributor"
      ? perms.canWrite("sales")
      : (a.kind === "marketer" || a.kind === "retail") && perms.can("distribution", "create"));
}

export function CancelPostingButton({
  factoryId,
  activity,
}: {
  factoryId: string;
  activity: Pick<Activity, "kind" | "reference" | "party" | "items" | "status">;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const qc = useQueryClient();
  const sale = activity.kind === "distributor";

  const cancel = useMutation({
    mutationFn: async () => {
      const { data: row, error: findError } = sale
        ? await supabase
            .from("sales")
            .select("id")
            .eq("factory_id", factoryId)
            .eq("invoice_number", activity.reference)
            .is("deleted_at", null)
            .maybeSingle()
        : await supabase
            .from("stock_dispatches")
            .select("id")
            .eq("factory_id", factoryId)
            .eq("dispatch_number", activity.reference)
            .maybeSingle();
      if (findError) throw findError;
      if (!row) throw new Error(`${activity.reference} not found`);
      const { error } = await supabase.rpc(
        "cancel_warehouse_posting" as never,
        {
          p_kind: sale ? "sale" : "dispatch",
          p_id: (row as { id: string }).id,
          p_reason: reason.trim() || null,
        } as never,
      );
      if (error) {
        if (/could not find the function/i.test(error.message))
          throw new Error(
            "The cancel update is not in the database yet -- run supabase/migrations/20261104110000_warehouse_cancel_posting_product_carry.sql in the SQL Editor.",
          );
        throw error;
      }
    },
    onSuccess: () => {
      toast.success(`${activity.reference} cancelled — the products are back in the Warehouse`);
      for (const key of [
        "warehouse-transactions",
        "warehouse-party",
        "warehouse-party-holding",
        "dist-products",
        "dispatch-open-returns",
        "accounting-postings",
      ])
        void qc.invalidateQueries({ queryKey: [key] });
      setOpen(false);
      setReason("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="text-destructive hover:text-destructive"
        title="Cancel this posting — products back to the Warehouse"
        aria-label="Cancel posting"
        onClick={() => setOpen(true)}
      >
        <Ban className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={(v) => !cancel.isPending && setOpen(v)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel {activity.reference}?</DialogTitle>
            <DialogDescription>
              Posted to <b>{activity.party ?? "—"}</b>: {activity.items ?? "—"}. The products go
              back into the Warehouse and come off{" "}
              {sale ? "the customer's account (anything paid becomes their credit)" : "their stock"}
              , as if it was never posted. Accounts will see it as reversed.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1">
            <Label htmlFor="cancel-reason">Reason (optional)</Label>
            <Input
              id="cancel-reason"
              placeholder="e.g. posted to the wrong marketer"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={cancel.isPending} onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
              className="gap-2"
            >
              {cancel.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Cancel posting
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
