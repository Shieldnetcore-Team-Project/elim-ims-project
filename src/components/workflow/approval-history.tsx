import { useWorkflowConfig, useWorkflowHistory, WORKFLOW_ACTION_LABELS, WORKFLOW_STATUS_LABELS } from "@/lib/workflow";
import type { ModuleKey } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import { History } from "lucide-react";

const ACTION_TONE: Record<string, string> = {
  submit: "bg-blue-100 text-blue-700",
  approve: "bg-emerald-100 text-emerald-700",
  confirm: "bg-emerald-100 text-emerald-700",
  post: "bg-emerald-100 text-emerald-700",
  reject: "bg-red-100 text-red-700",
  cancel: "bg-slate-100 text-slate-700",
  reverse: "bg-amber-100 text-amber-700",
};

// Reusable maker->checker trail for any workflow-engine entity — same
// component works for expenses, debt write-offs, payments, payroll, stock
// write-offs, and role grants, since they all write to the one generic
// workflow_approval_history table (Section 6: workflow/approval engine).
export function ApprovalHistory({ module, entityId }: { module: ModuleKey; entityId: string | null | undefined }) {
  const config = useWorkflowConfig(module);
  const history = useWorkflowHistory(module, entityId);

  if (!entityId) return null;

  return (
    <div className="space-y-3 rounded-xl border bg-muted/30 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <History className="h-4 w-4" /> Approval History
        </div>
        {config.data && (
          <span className="text-xs text-muted-foreground">
            {config.data.maker_label} → {config.data.checker_label}
            {config.data.required_approvals > 1 ? ` (${config.data.required_approvals} approvers required)` : ""}
          </span>
        )}
      </div>

      {history.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading history…</p>
      ) : (history.data ?? []).length === 0 ? (
        <p className="text-xs text-muted-foreground">No history recorded yet.</p>
      ) : (
        <ol className="space-y-2 border-l pl-4">
          {(history.data ?? []).map((h) => (
            <li key={h.id} className="relative text-xs">
              <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-primary" />
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className={ACTION_TONE[h.action] ?? ""}>
                  {WORKFLOW_ACTION_LABELS[h.action] ?? h.action}
                </Badge>
                <span className="font-medium">{h.actorName}</span>
                <span className="text-muted-foreground">
                  {h.from_status && h.from_status !== h.to_status
                    ? `${WORKFLOW_STATUS_LABELS[h.from_status]} → ${WORKFLOW_STATUS_LABELS[h.to_status]}`
                    : WORKFLOW_STATUS_LABELS[h.to_status]}
                </span>
                <span className="text-muted-foreground">{new Date(h.created_at).toLocaleString()}</span>
              </div>
              {h.comment && <p className="mt-0.5 text-muted-foreground">"{h.comment}"</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
