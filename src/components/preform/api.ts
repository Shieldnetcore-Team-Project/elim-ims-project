import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";

// Data layer for the Preform Production page. Every write is a server
// function in supabase/migrations/20261020130000_preform_production_workflow.sql
// (which also does every calculation); these tables and functions are newer
// than the generated Supabase types, hence the untyped client.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tables/RPCs newer than the generated types
export const db = supabase as any;

export async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

const n = (v: unknown) => (v == null ? 0 : Number(v));
const nn = (v: unknown) => (v == null ? null : Number(v));

export type Shift = "day" | "night";

export type PreformMaterial = {
  id: string;
  name: string;
  current_stock: number;
  pieces_per_bag: number | null;
  output_product_id: string | null;
  output_product: { id: string; name: string; current_stock: number } | null;
};

export type Operator = { id: string; full_name: string };

export type Issue = {
  id: string;
  reference: string;
  material_id: string;
  operator_id: string;
  bags: number;
  pieces_per_bag: number;
  loose_pieces: number;
  pieces: number;
  issue_date: string;
  notes: string | null;
  status: "issued" | "accepted" | "rejected" | "cancelled" | "reversed";
  issued_by: string | null;
  issued_at: string;
  responded_at: string | null;
  response_note: string | null;
  shift_record_id: string | null;
  reversal_reason: string | null;
};

export type ShiftRow = {
  id: string;
  reference: string;
  production_date: string;
  shift: Shift;
  operator_id: string;
  operator: string;
  material: string;
  machine: string | null;
  status: "draft" | "awaiting_inspection" | "awaiting_stocking" | "completed" | "reversed";
  opening_qty: number | null;
  issued_qty: number | null;
  available_qty: number | null;
  good_bottles: number;
  damaged_preforms: number;
  damaged_bottles: number;
  other_losses: number;
  usage_qty: number | null;
  expected_remaining: number | null;
  qc_good: number | null;
  qc_rejected: number | null;
  stocked: number;
  pending_stock: number;
  exception_qty: number;
  variance: number | null;
  open_exceptions: number;
  submitted_at: string | null;
};

export type ShiftRecord = {
  id: string;
  reference: string;
  material_id: string;
  operator_id: string;
  production_date: string;
  shift: Shift;
  machine: string | null;
  status: ShiftRow["status"];
  good_bottles: number;
  damaged_preforms: number;
  damaged_bottles: number;
  other_losses: number;
  other_loss_reason: string | null;
  notes: string | null;
};

export type Stocking = {
  id: string;
  reference: string;
  shift_record_id: string;
  product_id: string;
  expected_qty: number;
  counted_qty: number;
  received_qty: number | null;
  accepted_qty: number | null;
  status: "sent" | "accepted" | "rejected" | "cancelled" | "reversed";
  sent_by: string | null;
  sent_at: string;
  send_note: string | null;
  received_by: string | null;
  received_at: string | null;
  receive_note: string | null;
  reversal_reason: string | null;
  record: { reference: string; production_date: string; shift: Shift; operator_id: string } | null;
  product: { name: string } | null;
};

export type Transfer = {
  id: string;
  reference: string;
  product_id: string;
  from_location: string;
  to_department: string;
  quantity_sent: number;
  quantity_received: number | null;
  status: "dispatched" | "received" | "discrepancy" | "cancelled" | "reversed";
  notes: string | null;
  sent_by: string | null;
  sent_at: string;
  received_by: string | null;
  received_at: string | null;
  receive_note: string | null;
  reversal_reason: string | null;
  product: { name: string } | null;
};

export type PreformException = {
  id: string;
  reference: string;
  kind: "stock_shortfall" | "count_mismatch" | "transfer_shortfall";
  shift_record_id: string | null;
  stocking_id: string | null;
  transfer_id: string | null;
  expected_qty: number;
  actual_qty: number;
  difference_qty: number;
  note: string | null;
  status: "open" | "resolved" | "voided";
  resolution: "written_off" | "returned_to_stock" | null;
  resolution_note: string | null;
  raised_by: string | null;
  raised_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  product: { name: string } | null;
  record: { reference: string } | null;
  transfer: { reference: string; to_department: string } | null;
};

export type DaySummary = {
  opening: number;
  received: number;
  good_bottles: number;
  damaged_preforms: number;
  damaged_bottles: number;
  other_losses: number;
  usage_reversed: number;
  closing: number;
  held_now: number;
  received_unused: number;
  pending_issues: number;
  pending_pieces: number;
  qc_rejected: number;
  stocked: number;
  to_stock: number;
  open_exceptions: number;
  drafts: number;
  awaiting_qc: number;
};

export type DailyRow = {
  day: string;
  operator_id: string;
  operator: string;
  material_id: string;
  material: string;
  pieces_per_bag: number | null;
  opening: number;
  received: number;
  good_bottles: number;
  damaged_preforms: number;
  damaged_bottles: number;
  other_losses: number;
  reversed: number;
  usage: number;
  closing: number;
  shifts: number;
  pending_shifts: number;
  qc_good: number;
  qc_rejected: number;
  stocked: number;
};

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  awaiting_inspection: "Awaiting QC",
  awaiting_stocking: "Awaiting stocking",
  completed: "Completed",
  reversed: "Reversed",
  issued: "Awaiting operator",
  accepted: "Accepted",
  rejected: "Rejected",
  cancelled: "Cancelled",
  sent: "Awaiting Warehouse",
  dispatched: "Awaiting receipt",
  received: "Received",
  discrepancy: "Received short",
  open: "Open",
  resolved: "Resolved",
  voided: "Voided",
};

export const EXCEPTION_LABEL: Record<PreformException["kind"], string> = {
  stock_shortfall: "Good bottles not stocked",
  count_mismatch: "Warehouse count short",
  transfer_shortfall: "Transfer received short",
};

export function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (["completed", "accepted", "received", "resolved"].includes(s)) return "default";
  if (["rejected", "discrepancy", "open"].includes(s)) return "destructive";
  if (["reversed", "cancelled", "voided"].includes(s)) return "outline";
  return "secondary";
}

// ------------------------------------------------------------------ hooks

export function useMyUserId() {
  return useQuery({
    queryKey: ["my-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });
}

// One subscription for the whole page: any posting refreshes every view.
export function usePreformLive() {
  useRealtimeInvalidate(
    [
      "preform_issues",
      "preform_shift_records",
      "preform_qc_inspections",
      "preform_stockings",
      "preform_holdings",
      "bottle_transfers",
      "department_stock",
      "preform_exceptions",
    ],
    [["pf"]],
  );
}

export function usePreformMaterials(factoryId: string | undefined) {
  return useQuery({
    queryKey: ["pf", "materials", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await db
        .from("raw_materials")
        .select(
          "id,name,current_stock,pieces_per_bag,output_product_id,output_product:products!raw_materials_output_product_id_fkey(id,name,current_stock)",
        )
        .eq("factory_id", factoryId)
        .or("name.ilike.%preform%,pieces_per_bag.not.is.null")
        .order("name");
      if (error) throw error;
      return ((data ?? []) as PreformMaterial[]).map((m) => ({
        ...m,
        current_stock: n(m.current_stock),
        pieces_per_bag: nn(m.pieces_per_bag),
        output_product: m.output_product
          ? { ...m.output_product, current_stock: n(m.output_product.current_stock) }
          : null,
      }));
    },
  });
}

export function usePreformOperators(factoryId: string | undefined) {
  return useQuery({
    queryKey: ["pf", "operators", factoryId],
    enabled: !!factoryId,
    queryFn: async () => rpc<Operator[]>("preform_operators", { p_factory: factoryId }),
    staleTime: 60_000,
  });
}

// Names for user ids shown in tables (issued by, sent by, ...).
export function useUserNames(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter(Boolean) as string[])].sort();
  return useQuery({
    queryKey: ["pf", "names", unique.join(",")],
    enabled: unique.length > 0,
    queryFn: async () => {
      const pairs = await Promise.all(
        unique.map(async (id) => [
          id,
          (await rpc<string | null>("_pf_name", { p_user: id })) ?? "—",
        ]),
      );
      return Object.fromEntries(pairs) as Record<string, string>;
    },
    staleTime: 5 * 60_000,
  });
}

export function useDaySummary(operatorId: string, materialId: string, date: string) {
  return useQuery({
    queryKey: ["pf", "summary", operatorId, materialId, date],
    enabled: !!operatorId && !!materialId && !!date,
    queryFn: async () => {
      const r = await rpc<Record<string, unknown>>("preform_day_summary", {
        p_operator: operatorId,
        p_material: materialId,
        p_date: date,
      });
      return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, n(v)])) as DaySummary;
    },
  });
}

export function useIssues(
  factoryId: string | undefined,
  opts: { operatorId?: string; status?: string; limit?: number } = {},
) {
  return useQuery({
    queryKey: ["pf", "issues", factoryId, opts],
    enabled: !!factoryId,
    queryFn: async () => {
      let q = db
        .from("preform_issues")
        .select("*")
        .eq("factory_id", factoryId)
        .order("issued_at", { ascending: false })
        .limit(opts.limit ?? 200);
      if (opts.operatorId) q = q.eq("operator_id", opts.operatorId);
      if (opts.status) q = q.eq("status", opts.status);
      const { data, error } = await q;
      if (error) throw error;
      return ((data ?? []) as Issue[]).map((i) => ({
        ...i,
        bags: n(i.bags),
        pieces_per_bag: n(i.pieces_per_bag),
        loose_pieces: n(i.loose_pieces),
        pieces: n(i.pieces),
      }));
    },
  });
}

export type ShiftFilters = {
  from: string;
  to: string;
  operatorId?: string | null;
  materialId?: string | null;
  shift?: Shift | null;
  status?: string | null;
};

export function useShiftReport(factoryId: string | undefined, f: ShiftFilters) {
  return useQuery({
    queryKey: ["pf", "shifts", factoryId, f],
    enabled: !!factoryId && !!f.from && !!f.to,
    queryFn: async () => {
      const rows = await rpc<ShiftRow[]>("preform_shift_report", {
        p_factory: factoryId,
        p_from: f.from,
        p_to: f.to,
        p_operator: f.operatorId || null,
        p_material: f.materialId || null,
        p_shift: f.shift || null,
        p_status: f.status || null,
      });
      const numKeys = [
        "opening_qty",
        "issued_qty",
        "available_qty",
        "usage_qty",
        "expected_remaining",
        "qc_good",
        "qc_rejected",
        "variance",
      ] as const;
      return rows.map((r) => {
        const out = { ...r } as ShiftRow;
        for (const k of numKeys) (out as Record<string, unknown>)[k] = nn(r[k]);
        for (const k of [
          "good_bottles",
          "damaged_preforms",
          "damaged_bottles",
          "other_losses",
          "stocked",
          "pending_stock",
          "exception_qty",
          "open_exceptions",
        ] as const)
          (out as Record<string, unknown>)[k] = n(r[k]);
        return out;
      });
    },
  });
}

export function useShiftRecord(id: string | null) {
  return useQuery({
    queryKey: ["pf", "record", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await db
        .from("preform_shift_records")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data as ShiftRecord;
    },
  });
}

export function useDailyReport(
  factoryId: string | undefined,
  from: string,
  to: string,
  operatorId?: string | null,
  materialId?: string | null,
) {
  return useQuery({
    queryKey: ["pf", "daily", factoryId, from, to, operatorId, materialId],
    enabled: !!factoryId && !!from && !!to && from <= to,
    queryFn: async () => {
      const rows = await rpc<DailyRow[]>("preform_daily_report", {
        p_factory: factoryId,
        p_from: from,
        p_to: to,
        p_operator: operatorId || null,
        p_material: materialId || null,
      });
      return rows.map((r) => {
        const out = { ...r } as DailyRow;
        for (const [k, v] of Object.entries(r))
          if (!["day", "operator_id", "operator", "material_id", "material"].includes(k))
            (out as Record<string, unknown>)[k] = k === "pieces_per_bag" ? nn(v) : n(v);
        return out;
      });
    },
  });
}

export function useStockings(factoryId: string | undefined, status?: string) {
  return useQuery({
    queryKey: ["pf", "stockings", factoryId, status],
    enabled: !!factoryId,
    queryFn: async () => {
      let q = db
        .from("preform_stockings")
        .select(
          "*, record:preform_shift_records(reference,production_date,shift,operator_id), product:products(name)",
        )
        .eq("factory_id", factoryId)
        .order("sent_at", { ascending: false })
        .limit(300);
      if (status) q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return ((data ?? []) as Stocking[]).map((s) => ({
        ...s,
        expected_qty: n(s.expected_qty),
        counted_qty: n(s.counted_qty),
        received_qty: nn(s.received_qty),
        accepted_qty: nn(s.accepted_qty),
      }));
    },
  });
}

// Every preform from the Store to the good bottles, one line each, with its
// brand, grammage and supplier (qc_preform_overview, 20261024010000).
export type PreformOverview = {
  material_id: string;
  material: string;
  brand: string | null;
  grammage: string | null;
  supplier: string | null;
  pieces_per_bag: number | null;
  in_store: number;
  issued: number;
  waiting: number;
  received: number;
  blown: number;
  damages: number;
  good: number;
  qc_holds: number;
  last_issue: string | null;
};

export function usePreformOverview(factoryId: string | undefined) {
  return useQuery({
    queryKey: ["pf", "overview", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const rows = await rpc<PreformOverview[]>("qc_preform_overview", { p_factory: factoryId });
      return rows.map((r) => {
        const out = { ...r };
        for (const k of [
          "in_store",
          "issued",
          "waiting",
          "received",
          "blown",
          "damages",
          "good",
          "qc_holds",
        ] as const)
          out[k] = n(r[k]);
        out.pieces_per_bag = nn(r.pieces_per_bag);
        return out;
      });
    },
  });
}

// "Prima-16.5g · Prima Plastics": a preform's brand, grammage and supplier.
export const preformDetail = (o: PreformOverview | undefined) =>
  o
    ? [o.brand ? `${o.brand}${o.grammage ? `-${o.grammage}` : ""}` : o.grammage, o.supplier]
        .filter(Boolean)
        .join(" · ")
    : "";

export function useTransfers(factoryId: string | undefined) {
  return useQuery({
    queryKey: ["pf", "transfers", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await db
        .from("bottle_transfers")
        .select("*, product:products(name)")
        .eq("factory_id", factoryId)
        .order("sent_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return ((data ?? []) as Transfer[]).map((t) => ({
        ...t,
        quantity_sent: n(t.quantity_sent),
        quantity_received: nn(t.quantity_received),
      }));
    },
  });
}

export function useDepartmentStock(factoryId: string | undefined) {
  return useQuery({
    queryKey: ["pf", "dept-stock", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await db
        .from("department_stock")
        .select("id,department,quantity,updated_at,product:products(name)")
        .eq("factory_id", factoryId)
        .order("department");
      if (error) throw error;
      return (
        (data ?? []) as {
          id: string;
          department: string;
          quantity: number;
          updated_at: string;
          product: { name: string } | null;
        }[]
      ).map((d) => ({ ...d, quantity: n(d.quantity) }));
    },
  });
}

export function useExceptions(factoryId: string | undefined, status?: string) {
  return useQuery({
    queryKey: ["pf", "exceptions", factoryId, status],
    enabled: !!factoryId,
    queryFn: async () => {
      let q = db
        .from("preform_exceptions")
        .select(
          "*, product:products(name), record:preform_shift_records(reference), transfer:bottle_transfers(reference,to_department)",
        )
        .eq("factory_id", factoryId)
        .order("raised_at", { ascending: false })
        .limit(300);
      if (status) q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return ((data ?? []) as PreformException[]).map((e) => ({
        ...e,
        expected_qty: n(e.expected_qty),
        actual_qty: n(e.actual_qty),
        difference_qty: n(e.difference_qty),
      }));
    },
  });
}

// A server action with a success toast and a refresh of every preform view.
export function usePfAction<A>(
  fn: (args: A) => Promise<unknown>,
  success: string | ((r: unknown) => string),
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      toast.success(typeof success === "function" ? success(r) : success);
      qc.invalidateQueries({ queryKey: ["pf"] });
      // Store / Warehouse stock shown elsewhere in the app.
      qc.invalidateQueries({ queryKey: ["pinv"] });
      qc.invalidateQueries({ queryKey: ["raw-materials-list"] });
      qc.invalidateQueries({ queryKey: ["finished-goods"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
