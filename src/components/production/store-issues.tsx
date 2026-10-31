import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { num } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ReportActions } from "@/components/shared/report-actions";

// Production -> From Store (user request 2026-10-31): the materials the Store
// issued to Production -- what, how much, when, who issued it and who
// received it -- read through production_store_issues (Production staff
// can't read the Store's tables). Totals per material for the period on
// top. Read only: the Store records issues on Store -> Issue Stock.

type Issue = {
  id: string;
  issued_at: string;
  material: string;
  unit: string | null;
  quantity: number;
  issued_by: string | null;
  received_by: string | null;
  reference: string | null;
  reason: string | null;
};

const lagosDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
const monthStart = () => `${lagosDay().slice(0, 8)}01`;

export function ProductionStoreIssues({ factoryId }: { factoryId: string }) {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(lagosDay());
  const [search, setSearch] = useState("");

  useRealtimeInvalidate(["raw_material_movements"], [["production-store-issues"]]);

  const issues = useQuery({
    queryKey: ["production-store-issues", factoryId, from, to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "production_store_issues" as never,
        { p_factory: factoryId, p_from: from, p_to: to } as never,
      );
      if (error) throw error;
      return (data ?? []) as unknown as Issue[];
    },
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (issues.data ?? []).filter(
      (r) =>
        !q ||
        [r.material, r.received_by, r.issued_by, r.reference, r.reason]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [issues.data, search]);

  // Totals per material (and unit) in the period.
  const totals = useMemo(() => {
    const m = new Map<string, { material: string; unit: string; qty: number; count: number }>();
    for (const r of rows) {
      const key = `${r.material}|${r.unit ?? ""}`;
      const t = m.get(key) ?? { material: r.material, unit: r.unit ?? "", qty: 0, count: 0 };
      t.qty += Number(r.quantity);
      t.count += 1;
      m.set(key, t);
    }
    return [...m.values()].sort((a, b) => a.material.localeCompare(b.material));
  }, [rows]);

  return (
    <div className="space-y-6">
      <Card className="rounded-2xl">
        <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle className="text-base">Materials issued from the Store</CardTitle>
            <p className="text-sm text-muted-foreground">
              Everything the Store issued to Production: what, how much, when, and who received it.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label className="text-xs">From</Label>
              <Input
                type="date"
                className="w-40"
                value={from}
                max={to}
                onChange={(e) => e.target.value && setFrom(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">To</Label>
              <Input
                type="date"
                className="w-40"
                value={to}
                min={from}
                max={lagosDay()}
                onChange={(e) => e.target.value && setTo(e.target.value)}
              />
            </div>
            <Input
              className="w-56"
              placeholder="Material, person, reference"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <ReportActions
              size="sm"
              title="Materials issued from the Store to Production"
              fileName="production-store-issues"
              subtitle={[`${from} to ${to}`]}
              columns={[
                { key: "when", label: "Date/Time" },
                { key: "material", label: "Material" },
                { key: "quantity", label: "Quantity" },
                { key: "received_by", label: "Received by" },
                { key: "issued_by", label: "Issued by" },
                { key: "reference", label: "Reference" },
              ]}
              rows={rows.map((r) => ({
                when: new Date(r.issued_at).toLocaleString(),
                material: r.material,
                quantity: `${num(Number(r.quantity))} ${r.unit ?? ""}`.trim(),
                received_by: r.received_by ?? "—",
                issued_by: r.issued_by ?? "—",
                reference: r.reference ?? "",
              }))}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {totals.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {totals.map((t) => (
                <Badge
                  key={`${t.material}|${t.unit}`}
                  variant="secondary"
                  className="text-sm font-normal"
                >
                  {t.material}: <span className="ml-1 font-semibold">{num(t.qty)}</span>
                  {t.unit ? ` ${t.unit}` : ""} ({t.count}×)
                </Badge>
              ))}
            </div>
          )}
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Material</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead>Received by</TableHead>
                  <TableHead>Issued by</TableHead>
                  <TableHead>Reference / note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {new Date(r.issued_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-medium">{r.material}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {num(Number(r.quantity))} {r.unit}
                    </TableCell>
                    <TableCell>{r.received_by ?? "—"}</TableCell>
                    <TableCell>{r.issued_by ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {[r.reference, r.reason].filter(Boolean).join(" · ") || "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                      {issues.isLoading
                        ? "Loading…"
                        : issues.isError
                          ? `Couldn't load the issues: ${(issues.error as Error).message}`
                          : "Nothing issued to Production in this period."}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
