import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { num } from "@/lib/format";
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

// Postings from Warehouse, full width on Retail › All activity (moved off the
// Retail Outlet page, 2026-11-02). Each Warehouse posting to the shop in the
// period, from the shop's own stock ledger (dispatch_in lines, one reference
// per posting): when, who posted it and what was on it. A posting the
// Warehouse reversed has 'reversal' lines under the same reference.

type Movement = {
  id: string;
  created_at: string;
  movement_type: string;
  quantity: number;
  reference: string | null;
  user_id: string | null;
  products: { name: string; unit: string } | null;
};

// Lagos is UTC+1 all year.
const startOf = (d: string) => new Date(`${d}T00:00:00+01:00`);

export function RetailWarehousePostings({
  outletId,
  from,
  to,
}: {
  outletId: string;
  from: string;
  to: string;
}) {
  useRealtimeInvalidate(["rep_stock_movements"], [["retail-warehouse-postings"]]);

  const movements = useQuery({
    queryKey: ["retail-warehouse-postings", outletId, from, to],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rep_stock_movements")
        .select("id,created_at,movement_type,quantity,reference,user_id,products(name,unit)")
        .eq("sales_rep_id", outletId)
        .in("movement_type", ["dispatch_in", "reversal"])
        .gte("created_at", startOf(from).toISOString())
        .lt("created_at", new Date(startOf(to).getTime() + 86_400_000).toISOString())
        .order("created_at", { ascending: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as unknown as Movement[];
    },
  });

  const postings = useMemo(() => {
    const byRef = new Map<
      string,
      {
        reference: string;
        at: string;
        userId: string | null;
        items: { name: string; unit: string; qty: number }[];
        reversed: boolean;
      }
    >();
    for (const m of movements.data ?? []) {
      if (m.movement_type !== "dispatch_in") continue;
      const ref = m.reference ?? m.id;
      const p = byRef.get(ref) ?? {
        reference: ref,
        at: m.created_at,
        userId: m.user_id,
        items: [],
        reversed: false,
      };
      if (m.created_at < p.at) p.at = m.created_at;
      p.items.push({
        name: m.products?.name ?? "—",
        unit: m.products?.unit ?? "",
        qty: Number(m.quantity),
      });
      byRef.set(ref, p);
    }
    for (const m of movements.data ?? [])
      if (
        m.movement_type === "reversal" &&
        Number(m.quantity) < 0 &&
        m.reference &&
        byRef.has(m.reference)
      )
        byRef.get(m.reference)!.reversed = true;
    return [...byRef.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
  }, [movements.data]);

  const posterIds = [...new Set(postings.map((p) => p.userId).filter(Boolean))] as string[];
  const posters = useQuery({
    queryKey: ["outlet-posters", posterIds.join(",")],
    enabled: posterIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id,full_name,email")
        .in("id", posterIds);
      return new Map((data ?? []).map((p) => [p.id, p.full_name || p.email || "—"]));
    },
  });

  const period =
    from === to
      ? new Date(from).toLocaleDateString()
      : `${new Date(from).toLocaleDateString()} – ${new Date(to).toLocaleDateString()}`;

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Postings from Warehouse</CardTitle>
        <p className="text-sm text-muted-foreground">
          Every posting the Warehouse sent to the shop ({period}): when, who posted it and what was
          on it.
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Posting</TableHead>
              <TableHead>Posted by</TableHead>
              <TableHead>Products</TableHead>
              <TableHead className="text-right">Packs</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {postings.map((p) => (
              <TableRow
                key={p.reference}
                className={p.reversed ? "text-muted-foreground" : undefined}
              >
                <TableCell className="whitespace-nowrap">
                  {new Date(p.at).toLocaleString()}
                </TableCell>
                <TableCell className="whitespace-nowrap font-mono text-xs">{p.reference}</TableCell>
                <TableCell>{(p.userId && posters.data?.get(p.userId)) || "—"}</TableCell>
                <TableCell className="text-sm">
                  {p.items.map((it, i) => (
                    <div key={i}>
                      {it.name} × {num(it.qty)} {it.unit}
                    </div>
                  ))}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {num(p.items.reduce((t, it) => t + it.qty, 0))}
                </TableCell>
                <TableCell>
                  {p.reversed ? (
                    <Badge variant="destructive">Reversed</Badge>
                  ) : (
                    <Badge variant="secondary">Posted</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {postings.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                  {movements.isLoading
                    ? "Loading…"
                    : movements.isError
                      ? (movements.error as Error).message
                      : "No postings from the Warehouse in this period."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
