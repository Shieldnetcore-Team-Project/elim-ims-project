import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, Pencil } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { useFactorySettings } from "@/lib/use-factory";
import { PrintCopiesButton } from "@/components/shared/print-copies-button";
import {
  type Activity,
  hasSlip,
  KIND,
  printWarehouseActivity,
} from "@/components/warehouse/activity";
import {
  CorrectDispatchPostingDialog,
  CorrectDistributorPostingDialog,
} from "@/components/warehouse/correct-posting";
import { usePermissions } from "@/lib/permissions";
import { type Party, WarehousePartyDialog } from "@/components/warehouse/party-dialog";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// All transactions (user, 2026-11-02; was "Recent activity"): everything that
// moved through the Warehouse, newest first (warehouse_transactions) -- one
// row per marketer, the Retail Shop and each Distributor/Office Delivery
// customer, standing on their latest activity; clicking it opens their
// window (WarehousePartyDialog) to see all of it and return products or empty
// jugs. Production releases and walk-in sales stay one row each. Goods only.
type Row = Activity & { count?: number };
function groupByParty(list: Activity[]): Row[] {
  const out: Row[] = [];
  const at = new Map<string, number>();
  for (const a of list) {
    const key =
      a.party_id &&
      (a.party_type === "marketer" || a.party_type === "retail" || a.party_type === "distributor")
        ? a.party_id
        : null;
    if (!key) {
      out.push(a);
      continue;
    }
    const i = at.get(key);
    if (i === undefined) {
      at.set(key, out.length);
      out.push({ ...a, count: 1 });
    } else out[i].count = (out[i].count ?? 1) + 1;
  }
  return out;
}

export function WarehouseRecentActivity({ factoryId }: { factoryId: string }) {
  useRealtimeInvalidate(
    [
      "production_releases",
      "stock_dispatches",
      "sales",
      "rep_returns",
      "sales_returns",
      "jug_returns",
    ],
    [["warehouse-transactions"], ["warehouse-party"]],
  );
  const activity = useQuery({
    queryKey: ["warehouse-transactions", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "warehouse_transactions" as never,
        { p_factory: factoryId, p_limit: 1000 } as never,
      );
      if (error) throw error;
      return (data ?? []) as unknown as Activity[];
    },
  });
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Party | null>(null);
  const term = q.trim().toLowerCase();
  const rows = groupByParty(
    (activity.data ?? []).filter(
      (a) =>
        !term ||
        [a.party, a.reference, a.items].some((f) => (f ?? "").toLowerCase().includes(term)),
    ),
  ).slice(0, 200);
  const partyOf = (a: Activity): Party | null =>
    a.party_id &&
    (a.party_type === "marketer" || a.party_type === "retail" || a.party_type === "distributor")
      ? { type: a.party_type, id: a.party_id, name: a.party ?? "—" }
      : null;
  const settings = useFactorySettings(factoryId);
  // Correct and repost a posting: to a distributor (correct_warehouse_posting,
  // sales write) or to a marketer / the Retail Shop (correct_stock_dispatch,
  // distribution create).
  const perms = usePermissions();
  const canCorrect = (a: Activity) =>
    a.status === "posted" &&
    (a.kind === "distributor"
      ? perms.canWrite("sales")
      : (a.kind === "marketer" || a.kind === "retail") && perms.can("distribution", "create"));
  const [correcting, setCorrecting] = useState<Activity | null>(null);
  const print = (a: Activity, copies: number) =>
    printWarehouseActivity(a, factoryId, settings.data, copies);

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>All transactions</CardTitle>
          <p className="text-sm text-muted-foreground">
            One row per marketer, the Retail Shop and each Distributor/Office Delivery customer, on
            their latest activity. Click a name to see everything with them and to return products
            or empty jugs.
          </p>
        </div>
        <Input
          className="w-full sm:w-64"
          placeholder="Search name, number, product…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Activity</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>To / from</TableHead>
              <TableHead>Products</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((a) => {
              const k = KIND[a.kind] ?? { label: a.kind, variant: "outline" as const };
              return (
                <TableRow key={`${a.kind}-${a.reference}`}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(a.at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Badge variant={k.variant}>{k.label}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{a.reference}</TableCell>
                  <TableCell className="font-medium">
                    {partyOf(a) ? (
                      <button
                        type="button"
                        className="text-left text-primary hover:underline"
                        onClick={() => setOpen(partyOf(a))}
                      >
                        {a.party ?? "—"}
                      </button>
                    ) : (
                      (a.party ?? "—")
                    )}
                    {(a.count ?? 1) > 1 && (
                      <div className="text-xs font-normal text-muted-foreground">
                        Latest of {a.count} — click to see all
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{a.items ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {a.status.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    {partyOf(a) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title={`Open ${a.party ?? ""}`}
                        onClick={() => setOpen(partyOf(a))}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                    )}
                    {hasSlip(a) && <PrintCopiesButton onPrint={(copies) => print(a, copies)} />}
                    {canCorrect(a) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Correct and repost"
                        aria-label="Correct and repost"
                        onClick={() => setCorrecting(a)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  {activity.isLoading
                    ? "Loading…"
                    : activity.isError
                      ? "Transactions aren't available yet."
                      : "Nothing yet. Received releases and postings will show here."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
      <Dialog open={!!correcting} onOpenChange={(v) => !v && setCorrecting(null)}>
        {correcting?.kind === "distributor" && (
          <CorrectDistributorPostingDialog
            factoryId={factoryId}
            invoiceNumber={correcting.reference}
            onDone={() => setCorrecting(null)}
          />
        )}
        {(correcting?.kind === "marketer" || correcting?.kind === "retail") && (
          <CorrectDispatchPostingDialog
            factoryId={factoryId}
            dispatchNumber={correcting.reference}
            onDone={() => setCorrecting(null)}
          />
        )}
      </Dialog>
      {open && (
        <WarehousePartyDialog factoryId={factoryId} party={open} onClose={() => setOpen(null)} />
      )}
    </Card>
  );
}
