import { useQuery } from "@tanstack/react-query";
import { useMyRoles, usePermissions } from "@/lib/permissions";
import { generateCashRequisitionPdf, type CompanyLike } from "@/lib/pdf";
import { db } from "./shared";

// Maintenance › Requests as a Cash Requisition (user, 2026-11-21): items with
// qty x amount, Accounts accept/reject, then the Chairman
// (20261121110000_maintenance_cash_requisition.sql).

export type ReqItem = {
  id: string;
  line_no: number;
  item_name: string;
  description: string | null;
  quantity: number;
  unit_amount: number;
  amount: number;
};

export type DraftItem = {
  key: number;
  item_name: string;
  description: string;
  quantity: string;
  unit_amount: number;
};

export type RequisitionRow = {
  id: string;
  request_number: string;
  category: string;
  title: string;
  description: string | null;
  asset_name: string | null;
  priority: string;
  estimated_cost: number | null;
  status: string;
  requested_by: string | null;
  requested_by_name: string | null;
  created_at: string;
  decision_note: string | null;
  accounts_by_name?: string | null;
  accounts_at?: string | null;
  accounts_note?: string | null;
  chairman_by_name?: string | null;
  chairman_at?: string | null;
  chairman_note?: string | null;
  vehicles: { plate_number: string } | null;
};

export const REQUEST_CATEGORY_LABELS: Record<string, string> = {
  machine_purchase: "Machine purchase",
  machine_parts: "Machine parts",
  vehicle_repair: "Vehicle repair / maintenance",
  factory_maintenance: "Factory maintenance",
  other: "Other",
};

export const REQUEST_STATUS_LABELS: Record<string, string> = {
  pending_approval: "Waiting for Accounts",
  accounts_approved: "Waiting for Chairman",
  approved: "Approved — in progress",
  rejected: "Rejected",
  completed: "Completed",
  cancelled: "Cancelled",
};

let nextKey = 1;
export const blankItem = (): DraftItem => ({
  key: nextKey++,
  item_name: "",
  description: "",
  quantity: "1",
  unit_amount: 0,
});

const n0 = (v: unknown) => Number(v ?? 0) || 0;
export const draftLineTotal = (i: DraftItem) =>
  Math.round(n0(i.quantity) * i.unit_amount * 100) / 100;
// Lines with anything typed in; empty ones are skipped.
export const usedItems = (items: DraftItem[]) =>
  items.filter((i) => i.item_name.trim() || i.description.trim() || i.unit_amount > 0);
export const draftProblem = (items: DraftItem[]): string | null => {
  const used = usedItems(items);
  if (used.length === 0) return "Add at least one item";
  if (used.some((i) => !i.item_name.trim())) return "Every item needs a name";
  if (used.some((i) => n0(i.quantity) <= 0)) return "Every item needs a quantity";
  if (used.some((i) => i.unit_amount <= 0)) return "Every item needs an amount";
  return null;
};

export function useRequestItems(requestId: string | null | undefined) {
  return useQuery({
    queryKey: ["maintenance-request-items", requestId],
    enabled: !!requestId,
    queryFn: async () => {
      const { data, error } = await db
        .from("maintenance_request_items")
        .select("id,line_no,item_name,description,quantity,unit_amount,amount")
        .eq("request_id", requestId)
        .order("line_no");
      if (error) throw error;
      return (data ?? []) as ReqItem[];
    },
  });
}

// Who may act at which stage (the database checks it again).
export function useRequisitionRole() {
  const roles = useMyRoles().data ?? [];
  const { can } = usePermissions();
  const admin = roles.includes("super_admin");
  return {
    isAccounts: admin || roles.includes("accountant") || can("finance", "approve"),
    isChairman: admin || roles.includes("chairman"),
  };
}

// The stage a request is waiting at, and whether this user may decide it.
export function canDecide(
  r: Pick<RequisitionRow, "status" | "requested_by">,
  role: { isAccounts: boolean; isChairman: boolean },
  me: string | null | undefined,
  isAdmin: boolean,
) {
  if (r.requested_by && r.requested_by === me && !isAdmin) return null;
  if (r.status === "pending_approval" && role.isAccounts) return "accounts" as const;
  if (r.status === "accounts_approved" && role.isChairman) return "chairman" as const;
  return null;
}

const d = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("en-GB") : "");

export function printCashRequisition(
  r: RequisitionRow,
  items: ReqItem[],
  company: CompanyLike,
  printedBy: string | null | undefined,
) {
  const stage = (
    by: string | null | undefined,
    at: string | null | undefined,
    note: string | null | undefined,
    yes: string,
    rejected: boolean,
  ) => (by ? { decision: rejected ? "Rejected" : yes, by, at: d(at), note: note ?? "" } : null);
  const accountsRejected = r.status === "rejected" && !r.chairman_by_name;
  return generateCashRequisitionPdf({
    company,
    request: {
      number: r.request_number,
      date: d(r.created_at),
      requestedBy: r.requested_by_name ?? "",
      title: r.title,
      category: REQUEST_CATEGORY_LABELS[r.category] ?? r.category,
      for: r.vehicles?.plate_number ?? r.asset_name ?? "",
      priority: r.priority,
      purpose: r.description ?? "",
      status: REQUEST_STATUS_LABELS[r.status] ?? r.status,
    },
    items: items.map((i) => ({
      name: i.item_name,
      description: i.description ?? "",
      qty: n0(i.quantity),
      unit: n0(i.unit_amount),
      amount: n0(i.amount),
    })),
    total: items.length ? items.reduce((s, i) => s + n0(i.amount), 0) : n0(r.estimated_cost),
    accounts: stage(
      r.accounts_by_name,
      r.accounts_at,
      r.accounts_note,
      "Accepted",
      accountsRejected,
    ),
    chairman: stage(
      r.chairman_by_name,
      r.chairman_at,
      r.chairman_note,
      "Approved",
      r.status === "rejected" && !!r.chairman_by_name,
    ),
    printedBy,
  });
}
