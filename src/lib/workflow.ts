import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Action, ModuleKey } from "@/lib/permissions";

// Section 6 of the redesign spec: a reusable workflow/approval engine
// instead of per-page approval logic. workflow_configs + workflow_approval_history
// (supabase/migrations/20260816090000_workflow_engine_core.sql) are the
// single source of truth — this file just reads them for the UI.

export type WorkflowStatus =
  | "draft"
  | "submitted"
  | "pending_review"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "processing"
  | "completed"
  | "pending_confirmation"
  | "confirmed"
  | "posted"
  | "cancelled"
  | "reversed";

export type WorkflowConfig = {
  module: ModuleKey;
  transaction_type: string;
  maker_label: string;
  checker_label: string;
  final_status: WorkflowStatus;
  required_approvals: number;
  description: string | null;
};

export type WorkflowHistoryEntry = {
  id: string;
  action: Action;
  actor: string;
  actorName: string;
  from_status: WorkflowStatus | null;
  to_status: WorkflowStatus;
  comment: string | null;
  created_at: string;
};

export function useWorkflowConfig(module: ModuleKey) {
  return useQuery({
    queryKey: ["workflow-config", module],
    queryFn: async (): Promise<WorkflowConfig | null> => {
      const { data, error } = await supabase
        .from("workflow_configs")
        .select("*")
        .eq("module", module)
        .maybeSingle();
      if (error) throw error;
      return data as WorkflowConfig | null;
    },
    staleTime: 5 * 60_000,
  });
}

// One entity's full maker->checker trail, across submit/approve/reject/
// confirm/post/cancel/reverse — regardless of which flow-specific RPC wrote
// each step, since they all go through record_workflow_action().
export function useWorkflowHistory(module: ModuleKey, entityId: string | null | undefined) {
  return useQuery({
    queryKey: ["workflow-history", module, entityId],
    enabled: !!entityId,
    queryFn: async (): Promise<WorkflowHistoryEntry[]> => {
      const { data, error } = await supabase
        .from("workflow_approval_history")
        .select("id,action,actor,from_status,to_status,comment,created_at")
        .eq("module", module)
        .eq("entity_id", entityId as string)
        .order("created_at", { ascending: true });
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
      return rows.map((r: any) => ({
        id: r.id,
        action: r.action as Action,
        actor: r.actor,
        actorName: names[r.actor] ?? "Unknown",
        from_status: r.from_status,
        to_status: r.to_status,
        comment: r.comment,
        created_at: r.created_at,
      }));
    },
  });
}

export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  pending_review: "Pending Review",
  pending_approval: "Pending Approval",
  approved: "Approved",
  rejected: "Rejected",
  processing: "Processing",
  completed: "Completed",
  pending_confirmation: "Pending Confirmation",
  confirmed: "Confirmed",
  posted: "Posted",
  cancelled: "Cancelled",
  reversed: "Reversed",
};

export const WORKFLOW_ACTION_LABELS: Record<Action, string> = {
  view: "Viewed",
  create: "Created",
  edit: "Edited",
  submit: "Submitted",
  approve: "Approved",
  reject: "Rejected",
  confirm: "Confirmed",
  post: "Posted",
  reverse: "Reversed",
  cancel: "Cancelled",
  export: "Exported",
  print: "Printed",
  delete: "Deleted",
};
