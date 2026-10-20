import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { db, rpc } from "@/components/preform/api";
import { useRealtimeInvalidate } from "@/lib/realtime";

// Data layer for Store → Preform Inventory. Every figure comes from the
// server functions in supabase/migrations/20261020190000_preform_inventory.sql
// (and the receipt / issue / adjustment functions they build on); nothing
// here changes stock. Those functions are newer than the generated Supabase
// types, hence the untyped client from the preform module.

const n = (v: unknown) => (v == null ? 0 : Number(v));
const nn = (v: unknown) => (v == null ? null : Number(v));

export type LinkedSupplier = {
  id: string;
  name: string;
  preferred: boolean;
  active: boolean;
  // This supplier's own bag size for the preform; null = the specification's.
  pieces_per_bag: number | null;
};

export type PreformRow = {
  id: string;
  material_code: string | null;
  name: string;
  specification: string | null;
  unit: string;
  pieces_per_bag: number | null;
  current_stock: number;
  current_value: number;
  avg_unit_cost: number;
  last_purchase_cost: number | null;
  reorder_level: number;
  active: boolean;
  approval_status: string;
  storage_location: string | null;
  production_department: string | null;
  remarks: string | null;
  category_id: string | null;
  pending_receipt_qty: number;
  pending_receipt_count: number;
  awaiting_ack_qty: number;
  production_held_qty: number;
  issued_since_qty: number;
  suppliers: LinkedSupplier[];
  last_movement_at: string | null;
  last_movement_type: string | null;
  updated_at: string;
};

export type Receipt = {
  id: string;
  receipt_number: string;
  material_id: string;
  material_name: string;
  material_code: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  po_number: string | null;
  delivery_reference: string | null;
  supplier_invoice: string | null;
  batch_number: string | null;
  delivery_date: string;
  submitted_at: string;
  confirmed_at: string | null;
  bags: number | null;
  pieces_per_bag: number | null;
  loose_pieces: number | null;
  quantity: number;
  accepted_quantity: number;
  damaged_quantity: number;
  rejection_reason: string | null;
  rejected_disposition: string | null;
  unit_cost: number | null;
  accepted_value: number;
  status: string;
  storage_location: string | null;
  remarks: string | null;
  submitted_by_name: string | null;
  confirmed_by_name: string | null;
  submitted_by: string;
};

export type LedgerLine = {
  id: string;
  created_at: string;
  movement_type: string;
  quantity: number;
  quantity_before: number | null;
  quantity_after: number | null;
  unit_cost: number | null;
  reference: string | null;
  reason: string | null;
  user_name: string | null;
  supplier_name: string | null;
};

export type Adjustment = {
  id: string;
  reference_number: string;
  material_id: string;
  material_name: string;
  adjustment_kind: "count" | "opening_balance" | null;
  movement_type: string;
  system_quantity: number | null;
  counted_quantity: number | null;
  quantity_delta: number;
  unit_cost: number | null;
  reason: string | null;
  supporting_reference: string | null;
  status: string;
  submitted_at: string;
  submitted_by_name: string | null;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  submitted_by: string;
  counted_bags: number | null;
  counted_loose: number | null;
  counted_pieces_per_bag: number | null;
};

export type ReconRow = {
  check_code: string;
  severity: "error" | "warning" | "info";
  material_id: string | null;
  material_name: string | null;
  reference: string | null;
  detail: string;
  expected: number | null;
  actual: number | null;
};

export const CHECK_LABEL: Record<string, string> = {
  negative_balance: "Negative balance",
  ledger_mismatch: "Stock ≠ ledger",
  ledger_gap: "Ledger gap",
  ambiguous_movement: "Ambiguous movement",
  missing_reference: "Missing reference",
  duplicate_receipt_posting: "Receipt posted twice",
  receipt_without_movement: "Receipt without movement",
  issue_without_movement: "Issue without movement",
  duplicate_material: "Possible duplicate material",
  missing_bag_factor: "No pieces per bag",
  factor_changed: "Bag size changed",
  unit_not_pieces: "Unit is not pieces",
  supplier_looks_like_material: "Supplier named like a material",
  stale_pending_receipt: "Delivery awaiting Store",
};

export const DISPOSITION_LABEL: Record<string, string> = {
  write_off: "Written off",
  return_to_supplier: "Return to supplier",
  held_for_review: "Held for review",
};

export const MOVEMENT_LABEL: Record<string, string> = {
  received: "Receipt",
  issued: "Issue",
  transferred: "Issue to production",
  returned: "Return to store",
  return_from_production: "Return from production",
  adjusted: "Count adjustment",
  opening_balance: "Opening balance",
  damaged: "Damaged",
  correction: "Correction",
  used_for_production: "Used in production",
};

// One subscription for the page: any posting anywhere refreshes every view.
export function usePreformInventoryLive() {
  useRealtimeInvalidate(
    [
      "raw_materials",
      "raw_material_movements",
      "goods_receipts",
      "material_suppliers",
      "stock_adjustment_requests",
      "preform_issues",
      "preform_holdings",
    ],
    [["pinv"]],
  );
}

export function usePreformOverview(factoryId: string | undefined, since?: string) {
  return useQuery({
    queryKey: ["pinv", "overview", factoryId, since ?? null],
    enabled: !!factoryId,
    queryFn: async () => {
      const rows = await rpc<PreformRow[]>("preform_inventory_overview", {
        p_factory: factoryId,
        p_since: since ?? null,
      });
      return (rows ?? []).map((r) => ({
        ...r,
        pieces_per_bag: nn(r.pieces_per_bag),
        current_stock: n(r.current_stock),
        current_value: n(r.current_value),
        avg_unit_cost: n(r.avg_unit_cost),
        last_purchase_cost: nn(r.last_purchase_cost),
        reorder_level: n(r.reorder_level),
        pending_receipt_qty: n(r.pending_receipt_qty),
        pending_receipt_count: n(r.pending_receipt_count),
        awaiting_ack_qty: n(r.awaiting_ack_qty),
        production_held_qty: n(r.production_held_qty),
        issued_since_qty: n(r.issued_since_qty),
        suppliers: r.suppliers ?? [],
      }));
    },
  });
}

export type ReceiptFilters = {
  material?: string | null;
  supplier?: string | null;
  from?: string | null;
  to?: string | null;
};

export function usePreformReceipts(factoryId: string | undefined, f: ReceiptFilters = {}) {
  return useQuery({
    queryKey: ["pinv", "receipts", factoryId, f],
    enabled: !!factoryId,
    queryFn: async () => {
      const rows = await rpc<Receipt[]>("preform_receipts", {
        p_factory: factoryId,
        p_material: f.material || null,
        p_supplier: f.supplier || null,
        p_from: f.from || null,
        p_to: f.to || null,
      });
      return (rows ?? []).map((r) => ({
        ...r,
        bags: nn(r.bags),
        pieces_per_bag: nn(r.pieces_per_bag),
        loose_pieces: nn(r.loose_pieces),
        quantity: n(r.quantity),
        accepted_quantity: n(r.accepted_quantity),
        damaged_quantity: n(r.damaged_quantity),
        unit_cost: nn(r.unit_cost),
        accepted_value: n(r.accepted_value),
      }));
    },
  });
}

export function useMaterialLedger(materialId: string | undefined, from?: string, to?: string) {
  return useQuery({
    queryKey: ["pinv", "ledger", materialId, from ?? null, to ?? null],
    enabled: !!materialId,
    queryFn: async () => {
      const rows = await rpc<LedgerLine[]>("preform_material_ledger", {
        p_material: materialId,
        p_from: from || null,
        p_to: to || null,
      });
      return (rows ?? []).map((r) => ({
        ...r,
        quantity: n(r.quantity),
        quantity_before: nn(r.quantity_before),
        quantity_after: nn(r.quantity_after),
        unit_cost: nn(r.unit_cost),
      }));
    },
  });
}

export function usePreformAdjustments(factoryId: string | undefined, from?: string, to?: string) {
  return useQuery({
    queryKey: ["pinv", "adjustments", factoryId, from ?? null, to ?? null],
    enabled: !!factoryId,
    queryFn: async () => {
      const rows = await rpc<Adjustment[]>("preform_adjustments", {
        p_factory: factoryId,
        p_from: from || null,
        p_to: to || null,
      });
      return (rows ?? []).map((r) => ({
        ...r,
        system_quantity: nn(r.system_quantity),
        counted_quantity: nn(r.counted_quantity),
        quantity_delta: n(r.quantity_delta),
        unit_cost: nn(r.unit_cost),
      }));
    },
  });
}

export function useReconciliation(factoryId: string | undefined, preformsOnly = true) {
  return useQuery({
    queryKey: ["pinv", "recon", factoryId, preformsOnly],
    enabled: !!factoryId,
    queryFn: async () =>
      (
        (await rpc<ReconRow[]>("inventory_reconciliation", {
          p_factory: factoryId,
          p_preforms_only: preformsOnly,
        })) ?? []
      ).map((r) => ({ ...r, expected: nn(r.expected), actual: nn(r.actual) })),
  });
}

export type IssueLine = {
  id: string;
  reference: string;
  material_id: string;
  operator_id: string;
  bags: number;
  pieces_per_bag: number;
  loose_pieces: number;
  pieces: number;
  unit_cost: number;
  issue_date: string;
  status: string;
  issued_by: string | null;
  notes: string | null;
};

// Store issues to production in a date range (any status).
export function useIssueLines(
  factoryId: string | undefined,
  from: string,
  to: string,
  materialId?: string | null,
) {
  return useQuery({
    queryKey: ["pinv", "issues", factoryId, from, to, materialId ?? null],
    enabled: !!factoryId,
    queryFn: async () => {
      let q = db
        .from("preform_issues")
        .select(
          "id,reference,material_id,operator_id,bags,pieces_per_bag,loose_pieces,pieces,unit_cost,issue_date,status,issued_by,notes",
        )
        .eq("factory_id", factoryId)
        .gte("issue_date", from)
        .lte("issue_date", to)
        .order("issue_date", { ascending: false });
      if (materialId) q = q.eq("material_id", materialId);
      const { data, error } = await q;
      if (error) throw error;
      return ((data ?? []) as IssueLine[]).map((i) => ({
        ...i,
        bags: n(i.bags),
        pieces_per_bag: n(i.pieces_per_bag),
        loose_pieces: n(i.loose_pieces),
        pieces: n(i.pieces),
        unit_cost: n(i.unit_cost),
      }));
    },
  });
}

export const USAGE_TYPES = [
  "good_bottles",
  "damaged_preforms",
  "damaged_bottles",
  "other_losses",
  "usage_reversed",
] as const;

// Preforms used on the blowing line (operator holdings ledger), by type.
export function useConsumption(factoryId: string | undefined, from: string, to: string) {
  return useQuery({
    queryKey: ["pinv", "consumption", factoryId, from, to],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await db
        .from("preform_movements")
        .select("material_id,movement_type,quantity")
        .eq("factory_id", factoryId)
        .gte("effective_date", from)
        .lte("effective_date", to)
        .in("movement_type", USAGE_TYPES as unknown as string[]);
      if (error) throw error;
      return (
        (data ?? []) as { material_id: string; movement_type: string; quantity: number }[]
      ).map((r) => ({ ...r, quantity: n(r.quantity) }));
    },
  });
}

export function useFactorySuppliers(factoryId: string | undefined) {
  return useQuery({
    queryKey: ["suppliers-brief", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await db
        .from("suppliers")
        .select("id,name")
        .eq("factory_id", factoryId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });
}

// A server action with a success toast and a refresh of every view that
// shows preform stock (this page, Preform Production, Raw Materials, QC).
export function usePinvAction<A>(
  fn: (args: A) => Promise<unknown>,
  success: string | ((r: unknown) => string),
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      toast.success(typeof success === "function" ? success(r) : success);
      for (const key of [
        ["pinv"],
        ["pf"],
        ["raw-materials-list"],
        ["goods-receipts"],
        ["qc-inspections"],
        ["qc-materials"],
        ["stock-adjustment-requests"],
        ["material-movements"],
      ])
        qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export {
  STOCK_STATUS_LABEL,
  isPieceUnit,
  receiptPieces,
  stockStatus,
  summarize,
  type InventorySummary,
  type StockStatus,
} from "@/lib/preform-inventory";
