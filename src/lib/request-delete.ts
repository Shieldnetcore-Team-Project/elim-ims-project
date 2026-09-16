import { supabase } from "@/integrations/supabase/client";

// Keep in sync with the table_name CHECK constraint on public.delete_requests
// (supabase/migrations/20260920090000_delete_request_approval.sql).
export type DeleteRequestTable =
  | "employees"
  | "employee_documents"
  | "sales_reps"
  | "vehicles"
  | "drivers"
  | "expenses"
  | "cash_transactions"
  | "product_units";

// Every delete on these tables is RLS-blocked at the database level now —
// this submits a request for an admin to approve instead of deleting
// directly. See request_delete() in the migration above.
export async function requestDelete(
  tableName: DeleteRequestTable,
  entityId: string,
  reason: string,
) {
  const { error } = await supabase.rpc("request_delete", {
    p_table_name: tableName,
    p_entity_id: entityId,
    p_reason: reason,
  });
  if (error) throw error;
}
