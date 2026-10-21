import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { db, rpc } from "@/components/preform/api";
import { useRealtimeInvalidate } from "@/lib/realtime";

// Old & New Jugs: Warehouse sends to QC → QC accepts (counts) → QC verifies
// (good / damaged) → good ones posted to the Production Manager, who confirms
// receipt. Every step and every register figure is server-side
// (supabase/migrations/20261021100000_qc_jug_register.sql).

export type JugKind = "old" | "new";
export const KIND_NAME: Record<JugKind, string> = { old: "Old Jug", new: "New Jug" };

export type JugBatch = {
  id: string;
  reference: string;
  jug_kind: JugKind;
  status: "sent" | "accepted" | "verified" | "received" | "cancelled";
  quantity_sent: number;
  send_notes: string | null;
  sent_by: string;
  sent_at: string;
  quantity_accepted: number | null;
  accept_note: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  quantity_good: number | null;
  quantity_damaged: number | null;
  damage_reason: string | null;
  verified_by: string | null;
  verified_at: string | null;
  received_by: string | null;
  received_at: string | null;
  cancel_reason: string | null;
};

export type JugRegisterRow = {
  report_date: string;
  jug_kind: JugKind;
  jug_name: string;
  balance_bf: number;
  quantity_in: number;
  total: number;
  quantity_good: number;
  quantity_damaged: number;
  quantity_out: number;
  balance: number;
};

export const STATUS_LABEL: Record<JugBatch["status"], string> = {
  sent: "Awaiting QC",
  accepted: "At QC — to verify",
  verified: "Posted to PM",
  received: "Received by PM",
  cancelled: "Cancelled",
};

const n = (v: unknown) => (v == null ? 0 : Number(v));
const nn = (v: unknown) => (v == null ? null : Number(v));

export function useQcJugLive() {
  useRealtimeInvalidate(["qc_jug_batches"], [["qc-jugs"]]);
}

// Open consignments (any date) plus everything sent in the period.
export function useQcJugBatches(factoryId: string | undefined, from: string, to: string) {
  return useQuery({
    queryKey: ["qc-jugs", "batches", factoryId, from, to],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await db
        .from("qc_jug_batches")
        .select("*")
        .eq("factory_id", factoryId)
        .or(
          `status.in.(sent,accepted,verified),and(sent_at.gte.${from}T00:00:00+01:00,sent_at.lte.${to}T23:59:59.999+01:00)`,
        )
        .order("sent_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as JugBatch[]).map((b) => ({
        ...b,
        quantity_sent: n(b.quantity_sent),
        quantity_accepted: nn(b.quantity_accepted),
        quantity_good: nn(b.quantity_good),
        quantity_damaged: nn(b.quantity_damaged),
      }));
    },
  });
}

export function useQcJugReport(factoryId: string | undefined, from: string, to: string) {
  return useQuery({
    queryKey: ["qc-jugs", "report", factoryId, from, to],
    enabled: !!factoryId,
    queryFn: async () =>
      (
        (await rpc<JugRegisterRow[]>("qc_jug_report", {
          p_factory: factoryId,
          p_from: from,
          p_to: to,
        })) ?? []
      ).map((r) => ({
        ...r,
        balance_bf: n(r.balance_bf),
        quantity_in: n(r.quantity_in),
        total: n(r.total),
        quantity_good: n(r.quantity_good),
        quantity_damaged: n(r.quantity_damaged),
        quantity_out: n(r.quantity_out),
        balance: n(r.balance),
      })),
  });
}

export function useQcJugAction<A>(
  fn: (args: A) => Promise<unknown>,
  success: string | ((r: unknown) => string),
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      toast.success(typeof success === "function" ? success(r) : success);
      qc.invalidateQueries({ queryKey: ["qc-jugs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
