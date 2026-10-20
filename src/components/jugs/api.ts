import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { db, rpc } from "@/components/preform/api";
import { useRealtimeInvalidate } from "@/lib/realtime";
import type { JugRow } from "@/lib/jug-accountability";

// Data layer for Warehouse → Dispenser & Jugs. Every figure comes from the
// server (supabase/migrations/20261020200000_jug_accountability.sql, on the
// container ledger of 20260928140000_container_tracking.sql); nothing here
// changes a balance except through those functions. Newer than the
// generated Supabase types, hence the untyped client.

const n = (v: unknown) => (v == null ? 0 : Number(v));

export type ReportRow = JugRow & {
  report_date: string;
  sales_rep_id: string;
  rep_code: string | null;
  rep_name: string;
  rep_kind: string;
  container_type_id: string;
  container_name: string;
};

export type Overview = {
  container_type_id: string;
  container_name: string;
  in_circulation: number;
  in_warehouse: number;
  filled_in_warehouse: number;
  empty_in_warehouse: number;
  with_marketers: number;
  full_with_marketers: number;
  with_customers: number;
  written_off_total: number;
  pending_returns: number;
  produced_approved: number;
  issued: number;
  sold_with_water: number;
  empties_sold: number;
  refills_sold: number;
  received: number;
  empties_value: number;
  written_off: number;
};

export type JugReturn = {
  id: string;
  reference: string;
  sales_rep_id: string;
  container_type_id: string;
  quantity_claimed: number;
  quantity_received: number | null;
  status: "pending" | "verified" | "cancelled";
  notes: string | null;
  recorded_by: string;
  recorded_at: string;
  verified_by: string | null;
  verified_at: string | null;
  verify_note: string | null;
  cancel_reason: string | null;
};

export type Movement = {
  id: string;
  seq: number;
  created_at: string;
  container_type_id: string;
  product_id: string | null;
  from_type: string;
  from_id: string | null;
  to_type: string;
  to_id: string | null;
  quantity: number;
  source: string;
  reference: string | null;
  notes: string | null;
  created_by: string | null;
};

export type Named = { id: string; name: string; code?: string | null; kind?: string };
export type JugRole = "refill" | "with_water" | "empty";
export type ProductLink = {
  product_id: string;
  container_type_id: string;
  quantity_per_unit: number;
  jug_role: JugRole | null;
};

export const SOURCE_LABEL: Record<string, string> = {
  dispatch: "Loaded (dispatch)",
  dispatch_reversal: "Dispatch reversed",
  sale: "Sold",
  sale_reversal: "Sale deleted",
  rep_return: "Unsold stock returned",
  rep_return_cancelled: "Stock return cancelled",
  sales_return: "Customer returned product",
  sales_return_cancelled: "Customer return cancelled",
  return: "Empties received (verified)",
  issue: "Issued / opening balance",
  lost: "Written off (lost)",
  purchase: "Bought in",
  damaged: "Damaged (written off)",
};

export const ROLE_LABEL: Record<JugRole, string> = {
  refill: "Refill (customer swaps an empty)",
  with_water: "Jug + Water (customer keeps the jug)",
  empty: "Empty jug (sold for a price)",
};

// Lagos has no daylight saving: a day runs 00:00-24:00 at +01:00.
export const dayStart = (d: string) => `${d}T00:00:00+01:00`;
export const dayEnd = (d: string) => `${d}T23:59:59.999+01:00`;

export function useJugLive() {
  useRealtimeInvalidate(
    [
      "container_movements",
      "jug_returns",
      "container_types",
      "product_containers",
      "sales",
      "stock_dispatches",
    ],
    [["jug"]],
  );
}

export function useJugReport(
  factoryId: string | undefined,
  from: string | null,
  to: string | null,
  typeId: string | null,
) {
  return useQuery({
    queryKey: ["jug", "report", factoryId, from, to, typeId],
    enabled: !!factoryId && !!from && !!to,
    queryFn: async () =>
      (
        (await rpc<ReportRow[]>("jug_accountability_report", {
          p_factory: factoryId,
          p_from: from,
          p_to: to,
          p_container_type: typeId,
        })) ?? []
      ).map((r) => ({
        ...r,
        opening: n(r.opening),
        loaded: n(r.loaded),
        total: n(r.total),
        jug_water_sold: n(r.jug_water_sold),
        refills_sold: n(r.refills_sold),
        empties_sold: n(r.empties_sold),
        empties_value: n(r.empties_value),
        returned: n(r.returned),
        pending_claims: n(r.pending_claims),
        expected_empties: n(r.expected_empties),
        received: n(r.received),
        written_off: n(r.written_off),
        outstanding: n(r.outstanding),
      })),
  });
}

export function useJugOverview(
  factoryId: string | undefined,
  from: string | null,
  to: string | null,
) {
  return useQuery({
    queryKey: ["jug", "overview", factoryId, from, to],
    enabled: !!factoryId && !!from && !!to,
    queryFn: async () =>
      (
        (await rpc<Overview[]>("jug_overview", { p_factory: factoryId, p_from: from, p_to: to })) ??
        []
      ).map(
        (o) =>
          Object.fromEntries(
            Object.entries(o).map(([k, v]) => [
              k,
              k.endsWith("_id") || k.endsWith("_name") ? v : n(v),
            ]),
          ) as Overview,
      ),
  });
}

export function useJugTypes(factoryId: string | undefined) {
  return useQuery({
    queryKey: ["jug", "types", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await db
        .from("container_types")
        .select("id,name,active")
        .eq("factory_id", factoryId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string; active: boolean }[];
    },
  });
}

export function useMarketers(factoryId: string | undefined) {
  return useQuery({
    queryKey: ["jug", "reps", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await db
        .from("sales_reps")
        .select("id,full_name,code,kind,status")
        .eq("factory_id", factoryId)
        .order("full_name");
      if (error) throw error;
      return (
        (data ?? []) as {
          id: string;
          full_name: string;
          code: string | null;
          kind: string;
          status: string;
        }[]
      ).map((r) => ({
        id: r.id,
        name: r.full_name,
        code: r.code,
        kind: r.kind,
        active: r.status === "active",
      }));
    },
  });
}

export function useJugReturns(
  factoryId: string | undefined,
  from: string | null,
  to: string | null,
) {
  return useQuery({
    queryKey: ["jug", "returns", factoryId, from, to],
    enabled: !!factoryId && !!from && !!to,
    queryFn: async () => {
      // Pending returns always show, whatever the dates.
      const { data, error } = await db
        .from("jug_returns")
        .select("*")
        .eq("factory_id", factoryId)
        .or(
          `status.eq.pending,and(recorded_at.gte.${dayStart(from!)},recorded_at.lte.${dayEnd(to!)})`,
        )
        .order("recorded_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as JugReturn[]).map((r) => ({
        ...r,
        quantity_claimed: n(r.quantity_claimed),
        quantity_received: r.quantity_received == null ? null : n(r.quantity_received),
      }));
    },
  });
}

export function useJugMovements(
  factoryId: string | undefined,
  from: string | null,
  to: string | null,
  repId?: string | null,
) {
  return useQuery({
    queryKey: ["jug", "movements", factoryId, from, to, repId ?? null],
    enabled: !!factoryId && !!from && !!to,
    queryFn: async () => {
      let q = db
        .from("container_movements")
        .select(
          "id,seq,created_at,container_type_id,product_id,from_type,from_id,to_type,to_id,quantity,source,reference,notes,created_by",
        )
        .eq("factory_id", factoryId)
        .gte("created_at", dayStart(from!))
        .lte("created_at", dayEnd(to!))
        .order("seq", { ascending: false })
        .limit(1000);
      if (repId) q = q.or(`from_id.eq.${repId},to_id.eq.${repId}`);
      const { data, error } = await q;
      if (error) throw error;
      return ((data ?? []) as Movement[]).map((m) => ({ ...m, quantity: n(m.quantity) }));
    },
  });
}

export function useProductLinks(factoryId: string | undefined) {
  return useQuery({
    queryKey: ["jug", "links", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const [{ data: products, error: e1 }, { data: links, error: e2 }] = await Promise.all([
        db.from("products").select("id,name,active").eq("factory_id", factoryId).order("name"),
        db
          .from("product_containers")
          .select("product_id,container_type_id,quantity_per_unit,jug_role"),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      return {
        products: (products ?? []) as { id: string; name: string; active: boolean }[],
        links: ((links ?? []) as ProductLink[]).map((l) => ({
          ...l,
          quantity_per_unit: n(l.quantity_per_unit),
        })),
      };
    },
  });
}

// A server action with a success toast and a refresh of every jug view and
// the stock pages it touches.
export function useJugAction<A>(
  fn: (args: A) => Promise<unknown>,
  success: string | ((r: unknown) => string),
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      toast.success(typeof success === "function" ? success(r) : success);
      for (const key of [
        ["jug"],
        ["container-balances"],
        ["container-movements"],
        ["product-containers"],
      ])
        qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
