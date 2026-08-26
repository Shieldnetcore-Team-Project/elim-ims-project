import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { RequireAccess } from "@/components/layout/require-access";
import { MODULE_LABELS, useIsSuperAdmin, type ModuleKey } from "@/lib/permissions";
import {
  WORKFLOW_ACTION_LABELS,
  WORKFLOW_STATUS_LABELS,
  type WorkflowStatus,
} from "@/lib/workflow";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Workflow, History } from "lucide-react";

export const Route = createFileRoute("/_app/approval-workflows")({
  head: () => ({
    meta: [{ title: "Approval Workflows — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="users">
      <ApprovalWorkflowsPage />
    </RequireAccess>
  ),
});

type ConfigRow = {
  module: ModuleKey;
  transaction_type: string;
  maker_label: string;
  checker_label: string;
  final_status: WorkflowStatus;
  required_approvals: number;
  description: string | null;
};

function ApprovalWorkflowsPage() {
  const isSuperAdmin = useIsSuperAdmin();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Record<string, number>>({});

  const configs = useQuery({
    queryKey: ["workflow-configs-all"],
    queryFn: async () => {
      const { data, error } = await supabase.from("workflow_configs").select("*").order("module");
      if (error) throw error;
      return (data ?? []) as ConfigRow[];
    },
  });

  const save = useMutation({
    mutationFn: async ({
      module,
      required_approvals,
    }: {
      module: string;
      required_approvals: number;
    }) => {
      const { error } = await supabase
        .from("workflow_configs")
        .update({ required_approvals })
        .eq("module", module);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success("Updated — takes effect on the next approval for this module");
      setEditing((e) => {
        const n = { ...e };
        delete n[vars.module];
        return n;
      });
      qc.invalidateQueries({ queryKey: ["workflow-configs-all"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const history = useQuery({
    queryKey: ["workflow-history-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("workflow_approval_history")
        .select("id,module,action,actor,to_status,comment,created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      const rows = data ?? [];
      const actorIds = Array.from(new Set(rows.map((r) => r.actor)));
      let names: Record<string, string> = {};
      if (actorIds.length > 0) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id,full_name")
          .in("id", actorIds);
        names = Object.fromEntries(
          (profiles ?? []).map((p: any) => [p.id, p.full_name ?? "Unknown"]),
        );
      }
      return rows.map((r) => ({ ...r, actorName: names[r.actor] ?? "Unknown" }));
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Approval Workflows</h1>
        <p className="text-sm text-muted-foreground">
          Section 6 of the redesign: one configurable engine behind every maker-checker flow — not
          per-page approval logic.
        </p>
      </div>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Workflow className="h-4 w-4" /> Configured transaction types
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>Transaction Type</TableHead>
                <TableHead>Maker</TableHead>
                <TableHead>Checker</TableHead>
                <TableHead>Final Status</TableHead>
                <TableHead className="text-center">Required Approvers</TableHead>
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(configs.data ?? []).map((c) => (
                <TableRow key={c.module}>
                  <TableCell className="font-medium">
                    {MODULE_LABELS[c.module] ?? c.module}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{c.transaction_type}</Badge>
                  </TableCell>
                  <TableCell>{c.maker_label}</TableCell>
                  <TableCell>{c.checker_label}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {WORKFLOW_STATUS_LABELS[c.final_status] ?? c.final_status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-center">
                    {isSuperAdmin.data ? (
                      <div className="flex items-center justify-center gap-1">
                        <Input
                          type="number"
                          min={1}
                          className="w-16 text-center"
                          value={editing[c.module] ?? c.required_approvals}
                          onChange={(e) =>
                            setEditing((s) => ({ ...s, [c.module]: Number(e.target.value) }))
                          }
                        />
                        {editing[c.module] !== undefined &&
                          editing[c.module] !== c.required_approvals && (
                            <Button
                              size="sm"
                              disabled={save.isPending}
                              onClick={() =>
                                save.mutate({
                                  module: c.module,
                                  required_approvals: editing[c.module],
                                })
                              }
                            >
                              Save
                            </Button>
                          )}
                      </div>
                    ) : (
                      c.required_approvals
                    )}
                  </TableCell>
                  <TableCell className="max-w-[240px] text-xs text-muted-foreground">
                    {c.description ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-4 w-4" /> Recent approval activity — all modules
          </CardTitle>
        </CardHeader>
        <CardContent>
          {(history.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No workflow activity recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Module</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Resulting Status</TableHead>
                  <TableHead>Comment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.data!.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(h.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell>{MODULE_LABELS[h.module as ModuleKey] ?? h.module}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {WORKFLOW_ACTION_LABELS[h.action as keyof typeof WORKFLOW_ACTION_LABELS] ??
                          h.action}
                      </Badge>
                    </TableCell>
                    <TableCell>{h.actorName}</TableCell>
                    <TableCell>
                      {WORKFLOW_STATUS_LABELS[h.to_status as WorkflowStatus] ?? h.to_status}
                    </TableCell>
                    <TableCell className="max-w-[240px] truncate text-xs text-muted-foreground">
                      {h.comment ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
