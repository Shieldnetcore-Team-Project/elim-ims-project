import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Factory } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAccountsAdmin } from "@/lib/use-accounts-admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type AccessRow = { user_id: string; factory_id: string };

// Two factories (2026-11-21): Kubwa (code "water") and Lugbe. Every account
// works in Kubwa. The Chairman and Admin open every factory; anyone else
// opens Lugbe only once allowed here (factory_access / set_factory_access).
export function FactoryTab() {
  const qc = useQueryClient();
  const { accounts, factories } = useAccountsAdmin();
  const [search, setSearch] = useState("");

  const factoryCodes = useQuery({
    queryKey: ["factories-with-codes"],
    queryFn: async () => {
      const { data, error } = await supabase.from("factories").select("id,code,name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const others = (factoryCodes.data ?? []).filter((f) => f.code !== "water");

  const access = useQuery({
    queryKey: ["factory-access"],
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table added in 20261121140000, not in generated types yet
      const { data, error } = await (supabase.from as any)("factory_access").select(
        "user_id,factory_id",
      );
      if (error) throw error;
      return (data ?? []) as AccessRow[];
    },
  });

  const roles = useQuery({
    queryKey: ["factory-tab-switcher-roles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("user_id,role")
        .in("role", ["super_admin", "chairman"]);
      if (error) throw error;
      return new Set((data ?? []).map((r) => r.user_id));
    },
  });

  const toggle = useMutation({
    mutationFn: async (v: { userId: string; factoryId: string; granted: boolean }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC added in 20261121140000
      const { error } = await (supabase.rpc as any)("set_factory_access", {
        _user_id: v.userId,
        _factory_id: v.factoryId,
        _granted: v.granted,
      });
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      toast.success(v.granted ? "Access allowed" : "Access removed");
      qc.invalidateQueries({ queryKey: ["factory-access"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (accounts.data ?? [])
      .filter((a) => a.status !== "pending" && a.status !== "rejected")
      .filter(
        (a) =>
          !q ||
          (a.full_name ?? "").toLowerCase().includes(q) ||
          (a.email ?? "").toLowerCase().includes(q) ||
          (a.department ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => (a.full_name ?? a.email ?? "").localeCompare(b.full_name ?? b.email ?? ""));
  }, [accounts.data, search]);

  const has = (userId: string, factoryId: string) =>
    (access.data ?? []).some((r) => r.user_id === userId && r.factory_id === factoryId);
  const isSwitcher = (userId: string, email: string | null) =>
    roles.data?.has(userId) ||
    ["elimwaters09@gmail.com", "sbjoel160@gmail.com"].includes((email ?? "").toLowerCase());

  const active = (accounts.data ?? []).filter((a) => a.status !== "pending");

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {(factoryCodes.data ?? [])
          .slice()
          .sort((a, b) => (a.code === "water" ? -1 : b.code === "water" ? 1 : 0))
          .map((f) => {
            const name = factories.data?.find((x) => x.id === f.id)?.name ?? f.name;
            const count =
              f.code === "water"
                ? active.length
                : active.filter((a) => isSwitcher(a.id, a.email) || has(a.id, f.id)).length;
            return (
              <Card key={f.id} className="rounded-2xl">
                <CardHeader className="flex flex-row items-center flex-wrap justify-between gap-2 pb-2">
                  <CardTitle className="text-sm font-medium">{name}</CardTitle>
                  <Factory className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-semibold">{count}</div>
                  <p className="text-xs text-muted-foreground">users who can open this factory</p>
                </CardContent>
              </Card>
            );
          })}
      </div>

      {others.length > 0 && (
        <Card className="rounded-2xl">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Factory access</CardTitle>
              <p className="text-sm text-muted-foreground">
                Everyone works in Kubwa Factory. The Chairman and Admin can open every factory. Turn
                a switch on to let another account choose that factory from the Dashboard.
              </p>
            </div>
            <Input
              placeholder="Search name, email, department"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-xs"
            />
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Department</TableHead>
                  {others.map((f) => (
                    <TableHead key={f.id} className="text-center">
                      {f.name}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => {
                  const always = isSwitcher(a.id, a.email);
                  return (
                    <TableRow key={a.id}>
                      <TableCell>
                        <div className="font-medium">{a.full_name || a.email || "—"}</div>
                        <div className="text-xs text-muted-foreground">{a.email}</div>
                      </TableCell>
                      <TableCell>{a.department || "—"}</TableCell>
                      {others.map((f) => (
                        <TableCell key={f.id} className="text-center">
                          {always ? (
                            <span className="text-xs text-muted-foreground">Chairman / Admin</span>
                          ) : (
                            <Switch
                              checked={has(a.id, f.id)}
                              disabled={toggle.isPending || access.isLoading}
                              onCheckedChange={(granted) =>
                                toggle.mutate({ userId: a.id, factoryId: f.id, granted })
                              }
                            />
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
