import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePermissions } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Send, Store, UserRound, Users } from "lucide-react";
import { PosDialog } from "@/routes/_app.sales";
import { MarketerPostDialog, PostToHolderDialog } from "@/routes/_app.distribution";

type Target = "marketer" | "distributor" | "outlet";

// The Warehouse's "Post" menu: where finished products leave the Warehouse.
//   Marketers            dispatch to the marketer's van stock; the dialog shows
//                        the marketer's account and customers too
//   Distributors         a sale to a registered customer (normal sale approval)
//   Company Retail Shop  dispatch to the retail outlet's stock
// Each option shows only for whoever holds its right: distribution:create for
// dispatches, sales create for distributor sales.
export function WarehousePostMenu({ factoryId }: { factoryId: string }) {
  const qc = useQueryClient();
  const { canCreate, canWrite } = usePermissions();
  const canDispatch = canCreate("distribution");
  const canSell = canWrite("sales");
  const [target, setTarget] = useState<Target | null>(null);

  if (!canDispatch && !canSell) return null;

  const done = () => {
    setTarget(null);
    for (const key of [
      "finished-goods",
      "products-active",
      "inventory-overview-products",
      "sales-list",
      "dist-dispatches",
      "dist-products",
      "dist-rep-stock",
      "dist-account",
    ])
      qc.invalidateQueries({ queryKey: [key] });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="gap-2">
            <Send className="h-4 w-4" /> Post <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canDispatch && (
            <DropdownMenuItem onSelect={() => setTarget("marketer")}>
              <UserRound className="mr-2 h-4 w-4" /> Marketers
            </DropdownMenuItem>
          )}
          {canSell && (
            <DropdownMenuItem onSelect={() => setTarget("distributor")}>
              <Users className="mr-2 h-4 w-4" /> Distributors
            </DropdownMenuItem>
          )}
          {canDispatch && (
            <DropdownMenuItem onSelect={() => setTarget("outlet")}>
              <Store className="mr-2 h-4 w-4" /> Company Retail Shop
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={!!target} onOpenChange={(v) => !v && setTarget(null)}>
        {target === "marketer" && <MarketerPostDialog factoryId={factoryId} onDone={done} />}
        {target === "distributor" && <PosDialog factoryId={factoryId} onDone={done} />}
        {target === "outlet" && (
          <PostToHolderDialog factoryId={factoryId} kind="outlet" onDone={done} />
        )}
      </Dialog>
    </>
  );
}
