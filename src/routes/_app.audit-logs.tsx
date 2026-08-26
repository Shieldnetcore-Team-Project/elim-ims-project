import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { RequireAccess } from "@/components/layout/require-access";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Search, Eye, ScrollText } from "lucide-react";

export const Route = createFileRoute("/_app/audit-logs")({
  head: () => ({ meta: [{ title: "Audit Logs — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="audit-logs">
      <AuditLogsPage />
    </RequireAccess>
  ),
});

type LogRow = {
  id: string;
  user_id: string | null;
  factory_id: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  old_value: unknown;
  new_value: unknown;
  ip_address: string | null;
  created_at: string;
};

const actionTone: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  create: "secondary",
  update: "outline",
  delete: "destructive",
  login: "secondary",
  logout: "outline",
  payment: "secondary",
  production: "secondary",
  sale: "secondary",
  print: "outline",
  export: "outline",
};

function AuditLogsPage() {
  const [q, setQ] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [detail, setDetail] = useState<LogRow | null>(null);

  const logs = useQuery({
    queryKey: ["audit-logs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("audit_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as LogRow[];
    },
  });

  const profiles = useQuery({
    queryKey: ["profiles-map"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id,full_name,email");
      if (error) throw error;
      const map: Record<string, string> = {};
      (data ?? []).forEach((p) => {
        map[p.id] = p.full_name || p.email || p.id;
      });
      return map;
    },
  });

  const factories = useQuery({
    queryKey: ["factories-name-map"],
    queryFn: async () => {
      const { data, error } = await supabase.from("factories").select("id,name");
      if (error) throw error;
      const map: Record<string, string> = {};
      (data ?? []).forEach((f) => {
        map[f.id] = f.name;
      });
      return map;
    },
  });

  const actions = useMemo(
    () => Array.from(new Set((logs.data ?? []).map((l) => l.action))).sort(),
    [logs.data],
  );

  const filtered = useMemo(() => {
    let rows = logs.data ?? [];
    if (actionFilter !== "all") rows = rows.filter((r) => r.action === actionFilter);
    const query = q.trim().toLowerCase();
    if (query) {
      rows = rows.filter(
        (r) =>
          (r.entity ?? "").toLowerCase().includes(query) ||
          (r.entity_id ?? "").toLowerCase().includes(query) ||
          (profiles.data?.[r.user_id ?? ""] ?? "").toLowerCase().includes(query),
      );
    }
    return rows;
  }, [logs.data, actionFilter, q, profiles.data]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit Logs</h1>
        <p className="text-sm text-muted-foreground">
          System-wide trail of sensitive actions: who, when, from where, and what changed.
        </p>
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="h-4 w-4" /> Activity ({filtered.length})
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search entity or user…"
                className="pl-8 h-9 w-56"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger className="h-9 w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actions</SelectItem>
                {actions.map((a) => (
                  <SelectItem key={a} value={a} className="capitalize">
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Factory</TableHead>
                <TableHead>IP</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(l.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {l.user_id ? (
                      (profiles.data?.[l.user_id] ?? "—")
                    ) : (
                      <span className="text-muted-foreground">Anonymous</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={actionTone[l.action] ?? "outline"} className="capitalize">
                      {l.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {l.entity ?? "—"}
                    {l.entity_id ? ` · ${l.entity_id.slice(0, 8)}` : ""}
                  </TableCell>
                  <TableCell>
                    {l.factory_id ? (factories.data?.[l.factory_id] ?? "—") : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {l.ip_address ?? "—"}
                  </TableCell>
                  <TableCell>
                    {(l.old_value != null || l.new_value != null) && (
                      <Button variant="ghost" size="icon" onClick={() => setDetail(l)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    No activity recorded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        {detail && (
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle className="capitalize">
                {detail.action} — {detail.entity ?? "record"}
              </DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="mb-1 font-medium text-muted-foreground">Old value</div>
                <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 p-2 text-xs">
                  {JSON.stringify(detail.old_value, null, 2) ?? "—"}
                </pre>
              </div>
              <div>
                <div className="mb-1 font-medium text-muted-foreground">New value</div>
                <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 p-2 text-xs">
                  {JSON.stringify(detail.new_value, null, 2) ?? "—"}
                </pre>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
