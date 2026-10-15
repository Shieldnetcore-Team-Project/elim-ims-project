import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Activity = {
  kind: "received" | "refused" | "marketer" | "retail" | "distributor";
  reference: string;
  at: string;
  party: string | null;
  items: string | null;
  quantity: number;
  status: string;
};

const KIND: Record<
  Activity["kind"],
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  received: { label: "Received from Production", variant: "default" },
  refused: { label: "Refused to Production", variant: "destructive" },
  marketer: { label: "Posted to Marketer", variant: "secondary" },
  retail: { label: "Posted to Retail Shop", variant: "secondary" },
  distributor: { label: "Posted to Distributor", variant: "secondary" },
};

// What has moved through the Warehouse lately, newest first: releases received
// from (or refused to) Production, and postings to marketers, the Company
// Retail Shop and distributors (warehouse_recent_activity). Goods only.
export function WarehouseRecentActivity({ factoryId }: { factoryId: string }) {
  useRealtimeInvalidate(
    ["production_releases", "stock_dispatches", "sales"],
    [["warehouse-activity"]],
  );
  const activity = useQuery({
    queryKey: ["warehouse-activity", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "warehouse_recent_activity" as never,
        {
          p_factory: factoryId,
          p_limit: 30,
        } as never,
      );
      if (error) throw error;
      return (data ?? []) as unknown as Activity[];
    },
  });
  const rows = activity.data ?? [];

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Recent activity</CardTitle>
        <p className="text-sm text-muted-foreground">
          The latest goods received from Production and posted to marketers, distributors and the
          Company Retail Shop.
        </p>
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
                  <TableCell className="font-medium">{a.party ?? "—"}</TableCell>
                  <TableCell className="text-xs">{a.items ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {a.status.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  {activity.isLoading
                    ? "Loading…"
                    : activity.isError
                      ? "Recent activity isn't available yet."
                      : "Nothing yet. Received releases and postings will show here."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
