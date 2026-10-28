import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// The maintenance tables and RPCs are newer than the generated Supabase types
// (20261027090000_maintenance_module.sql, 20261027100000_maintenance_inventory.sql).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db = supabase as any;

export const PART_CATEGORY_LABELS: Record<string, string> = {
  machine_part: "Machine part",
  vehicle_part: "Vehicle part",
  electrical: "Electrical",
  plumbing: "Plumbing",
  tools: "Tools",
  lubricants: "Oils & lubricants",
  consumables: "Consumables",
  other: "Other",
};

export const MOVEMENT_LABELS: Record<string, string> = {
  opening: "Opening stock",
  received: "Received",
  purchased: "Bought",
  issued: "Issued / used",
  returned: "Returned to store",
  adjustment: "Adjustment",
};

export const LOG_TYPE_LABELS: Record<string, string> = {
  vehicle_repair: "Vehicle repair",
  vehicle_service: "Vehicle servicing",
  machine_repair: "Machine repair",
  machine_service: "Machine servicing",
  part_repair: "Part repair",
  part_replacement: "Part replacement",
  factory_maintenance: "Factory maintenance",
  other: "Other",
};

export type PartRow = {
  id: string;
  name: string;
  part_number: string | null;
  category: string;
  unit: string;
  location: string | null;
  reorder_level: number;
  quantity_on_hand: number;
  last_unit_cost: number | null;
  notes: string | null;
  is_active: boolean;
};

export type MovementRow = {
  id: string;
  part_id: string;
  movement_type: string;
  quantity: number;
  unit_cost: number | null;
  balance_after: number;
  movement_date: string;
  source: string | null;
  reference: string | null;
  notes: string | null;
  request_id: string | null;
  purchase_id: string | null;
  log_id: string | null;
  recorded_by_name: string | null;
  created_at: string;
  maintenance_parts: { name: string; unit: string } | null;
};

export type LogRow = {
  id: string;
  log_number: string;
  log_type: string;
  title: string;
  description: string | null;
  vehicle_id: string | null;
  asset_name: string | null;
  service_date: string;
  performed_by: string | null;
  odometer: number | null;
  labour_cost: number;
  other_cost: number;
  next_service_date: string | null;
  request_id: string | null;
  recorded_by_name: string | null;
  created_at: string;
  vehicles: { plate_number: string } | null;
  maintenance_requests: { request_number: string } | null;
};

export const isLowStock = (p: PartRow) =>
  Number(p.reorder_level) > 0 && Number(p.quantity_on_hand) <= Number(p.reorder_level);

// Cost of a movement: issued rows carry the part's cost at the time.
export const movementValue = (m: MovementRow) =>
  Math.abs(Number(m.quantity)) * Number(m.unit_cost ?? 0);

export function useMaintenanceParts(factoryId: string | null | undefined) {
  return useQuery({
    queryKey: ["maintenance-parts", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await db
        .from("maintenance_parts")
        .select("*")
        .eq("factory_id", factoryId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as PartRow[];
    },
  });
}

export function useMaintenanceMovements(factoryId: string | null | undefined) {
  return useQuery({
    queryKey: ["maintenance-movements", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await db
        .from("maintenance_stock_movements")
        .select("*, maintenance_parts(name, unit)")
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as MovementRow[];
    },
  });
}

export function useMaintenanceLogs(factoryId: string | null | undefined) {
  return useQuery({
    queryKey: ["maintenance-logs", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await db
        .from("maintenance_logs")
        .select("*, vehicles(plate_number), maintenance_requests(request_number)")
        .eq("factory_id", factoryId!)
        .order("service_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as LogRow[];
    },
  });
}

export type IssueRow = {
  id: string;
  issue_number: string;
  kind: "issue" | "adjustment";
  part_id: string;
  quantity: number;
  movement_date: string;
  issued_to: string | null;
  reference: string | null;
  notes: string | null;
  log_id: string | null;
  status: string;
  requested_by: string | null;
  requested_by_name: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  maintenance_parts: {
    name: string;
    unit: string;
    quantity_on_hand: number;
    last_unit_cost: number | null;
  } | null;
};

export const ISSUE_STATUS_LABELS: Record<string, string> = {
  pending_approval: "Awaiting approval",
  approved: "Approved — issued",
  rejected: "Rejected",
  cancelled: "Withdrawn",
};

// Taking stock out (issue, downward adjustment) waits for approval
// (20261028090000_maintenance_issue_approval.sql).
export function useMaintenanceIssues(factoryId: string | null | undefined) {
  return useQuery({
    queryKey: ["maintenance-issues", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await db
        .from("maintenance_issue_requests")
        .select("*, maintenance_parts(name, unit, quantity_on_hand, last_unit_cost)")
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as IssueRow[];
    },
  });
}

// Quantity per part already asked for by pending issue requests.
export function pendingOutByPart(issues: IssueRow[] | undefined) {
  const m = new Map<string, number>();
  for (const i of issues ?? []) {
    if (i.status === "pending_approval") {
      m.set(i.part_id, (m.get(i.part_id) ?? 0) + Number(i.quantity));
    }
  }
  return m;
}

export const MAINTENANCE_QUERY_KEYS = [
  ["maintenance-issues"],
  ["maintenance-parts"],
  ["maintenance-movements"],
  ["maintenance-logs"],
  ["maintenance-requests"],
  ["maintenance-purchases"],
];
