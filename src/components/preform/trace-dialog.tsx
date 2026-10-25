import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { num } from "@/lib/format";
import { formatBags, formatPieces } from "@/lib/preform-units";
import { SHIFT_LABEL } from "@/lib/production-shift";
import { useRecordTrace } from "./api";
import { StatusBadge, fmtDate, fmtDateTime } from "./shared";

const MOVE_LABEL: Record<string, string> = {
  good_bottles: "Blown into good bottles",
  damaged_preforms: "Damaged preforms (blowing)",
  damaged_bottles: "Damaged during blowing",
  other_losses: "Other loss",
  usage_reversed: "Reversed back to holding",
};

// Drill-down from a grammage report row: the Store issues the session took
// up, its preform ledger lines (processed and blowing damage), QC, the good
// bottles stocked, exceptions, and PM issues of that bottle type
// (preform_record_trace, 20261025090000).
export function TraceDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const trace = useRecordTrace(id);
  const t = trace.data;
  const r = t?.record;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {r
              ? `${r.reference} — ${r.material}${r.grammage ? ` (${r.grammage})` : ""}`
              : "Loading…"}
          </DialogTitle>
          {r && (
            <DialogDescription>
              {fmtDate(r.production_date)} · {SHIFT_LABEL[r.shift]} shift · {r.operator} ·{" "}
              {r.bottle ?? "no bottle"} {r.capacity ? `(${r.capacity})` : ""}
            </DialogDescription>
          )}
        </DialogHeader>
        {trace.isError && (
          <p className="text-sm text-destructive">{(trace.error as Error).message}</p>
        )}
        {t && r && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={r.status} />
              {r.reversal_reason && (
                <span className="text-xs text-muted-foreground">Reversed: {r.reversal_reason}</span>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md bg-muted/40 p-3 sm:grid-cols-4">
              {[
                ["Opening", r.opening_qty],
                ["Received", r.issued_qty],
                ["Available", r.available_qty],
                ["Processed", r.usage_qty],
                ["Good bottles", Number(r.good_bottles)],
                ["Blowing damage", Number(r.damaged_preforms) + Number(r.damaged_bottles)],
                ["Other losses", Number(r.other_losses)],
                ["Unprocessed (closing)", r.expected_remaining],
              ].map(([k, v]) => (
                <div key={k as string}>
                  <dt className="text-[11px] text-muted-foreground">{k}</dt>
                  <dd className="font-medium">{v == null ? "—" : num(Number(v))}</dd>
                </div>
              ))}
            </dl>

            <Section
              count={t.issues.length}
              title="1. Preform issues from the Store"
              empty="No Store issue was taken up by this session (it used the opening balance)."
            >
              {t.issues.map((i) => (
                <Line key={i.reference}>
                  <span className="font-mono text-xs">{i.reference}</span> · {fmtDate(i.issue_date)}{" "}
                  · {formatBags({ bags: Number(i.bags), pieces: Number(i.loose_pieces) })} ×{" "}
                  {num(Number(i.pieces_per_bag))} = <b>{num(Number(i.pieces))}</b> pcs · issued by{" "}
                  {i.issued_by ?? "—"}, received by {i.received_by ?? "—"}
                </Line>
              ))}
            </Section>

            <Section
              count={t.movements.length}
              title="2. Processing and blowing damage (preform ledger)"
              empty="Nothing posted."
            >
              {t.movements.map((m, k) => (
                <Line key={k}>
                  {MOVE_LABEL[m.type] ?? m.type}: <b>{num(Number(m.quantity))}</b> (
                  {num(Number(m.before))} → {num(Number(m.after))}) · {fmtDateTime(m.at)} ·{" "}
                  {m.by ?? ""}
                </Line>
              ))}
            </Section>

            <Section
              count={t.inspections.length}
              title="3. Quality Control"
              empty="Not inspected yet."
            >
              {t.inspections.map((q, k) => (
                <Line key={k}>
                  {q.decision === "approved" ? "Approved" : "Returned"}: {num(Number(q.good))} good,{" "}
                  {num(Number(q.rejected))} rejected · {q.by ?? ""} · {fmtDateTime(q.at)}
                  {(q.reason || q.notes) && (
                    <span className="text-muted-foreground"> · {q.reason ?? q.notes}</span>
                  )}
                </Line>
              ))}
            </Section>

            <Section
              count={t.stockings.length}
              title="4. Good bottles into bottle stock"
              empty="No good bottles stocked from this session."
            >
              {t.stockings.map((s) => (
                <Line key={s.reference}>
                  <span className="font-mono text-xs">{s.reference}</span> · {s.product} ·{" "}
                  <b>{s.accepted == null ? "—" : num(Number(s.accepted))}</b> accepted of{" "}
                  {num(Number(s.counted))} · <StatusBadge status={s.status} /> {s.received_by ?? ""}{" "}
                  {fmtDateTime(s.received_at)}
                  {s.reversal_reason && (
                    <span className="text-muted-foreground"> · {s.reversal_reason}</span>
                  )}
                </Line>
              ))}
            </Section>

            {t.exceptions.length > 0 && (
              <Section count={t.exceptions.length} title="Exceptions" empty="">
                {t.exceptions.map((e) => (
                  <Line key={e.reference}>
                    <span className="font-mono text-xs">{e.reference}</span> ·{" "}
                    {num(Number(e.difference))} · <StatusBadge status={e.status} /> {e.note ?? ""}{" "}
                    {e.resolution_note ?? ""}
                  </Line>
                ))}
              </Section>
            )}

            <Section
              count={t.pm_issues.length}
              title={`5. Issues of ${r.bottle ?? "this bottle"} to PM from ${fmtDate(r.production_date)}`}
              empty="Not issued to PM yet."
            >
              {t.pm_issues.map((p) => (
                <Line key={p.reference}>
                  <span className="font-mono text-xs">{p.reference}</span> ·{" "}
                  {fmtDateTime(p.sent_at)} · to {p.to}: {num(Number(p.sent))} issued,{" "}
                  {p.received == null ? "not received yet" : `${num(Number(p.received))} received`}
                  {Number(p.rejected) > 0 && (
                    <span className="text-destructive">
                      {" "}
                      · {num(Number(p.rejected))} rejected at PM
                    </span>
                  )}
                  {p.production_reference && ` · ${p.production_reference}`}{" "}
                  <StatusBadge status={p.status} />
                </Line>
              ))}
            </Section>
            <p className="text-[11px] text-muted-foreground">
              Once stocked, bottles of one type are pooled, so section 5 lists the PM issues of that
              bottle type from this session&rsquo;s date, not bottles traced one by one.
              {r.expected_remaining != null &&
                ` Unprocessed after this session: ${formatPieces(Number(r.expected_remaining), null)}.`}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({
  title,
  empty,
  count,
  children,
}: {
  title: string;
  empty: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{title}</div>
      {count > 0 ? (
        <div className="space-y-1">{children}</div>
      ) : (
        <p className="text-xs text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

const Line = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded border px-2 py-1 text-xs">{children}</div>
);
