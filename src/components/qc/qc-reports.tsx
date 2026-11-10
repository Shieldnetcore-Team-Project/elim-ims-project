import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/shared/date-picker";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { rpc } from "@/components/preform/api";
import { splitBags } from "@/lib/preform-units";
import { localDay } from "@/lib/production-shift";
import { useFactorySettings } from "@/lib/use-factory";
import type { PdfAction } from "@/lib/pdf";
import { qcLetterheadPdf, sheetCompany, type QcPdfReport } from "./qc-report-pdf";

// Quality Control → Reports: pick Preform or Bottle, a From and To date (one
// day = the same date twice) and Print; the sheet prints as the factory's own
// (logo, address, contacts, title, blue header row). The same table shows on
// screen first (2026-11-04).
//   Preform report  qc_preform_report  From Store, Pieces, Opening, Total,
//                   Blown, Damages, Expected Bottles (= Blown − Damages),
//                   Balance (= Total − Blown)
//   Bottles report  qc_bottle_report   Opening, Quantity In (good bottles
//                   stocked), Total, Released (sent to production), Balance
// (20261023210000).

type PreformRow = {
  material_id: string;
  material: string;
  brand: string | null;
  grammage: string | null;
  pieces_per_bag: number | null;
  received: number;
  opening: number;
  total: number;
  blown: number;
  damages: number;
  expected_bottles: number;
  balance: number;
};
type BottleRow = {
  product_id: string;
  product: string;
  opening: number;
  quantity_in: number;
  total: number;
  released: number;
  balance: number;
};
// Jugs (user, 2026-11-04), on the same letterhead:
//   Jugs posted & returned  jug_accountability_report  per marketer / the
//                   shop and day: Opening, Loaded, Total, Jug Water sold,
//                   Returned, Expected empties, Received, Outstanding
//   Where the jugs are      jug_locations (20261104120000), at the end of
//                   the To date: Store, QC, Production, Warehouse,
//                   marketers, customers, walk-in, total
type JugReportRow = {
  report_date: string;
  rep_code: string | null;
  rep_name: string;
  container_name: string;
  opening: number;
  loaded: number;
  total: number;
  jug_water_sold: number;
  returned: number;
  expected_empties: number;
  received: number;
  outstanding: number;
};
type JugPlaceRow = {
  container_name: string;
  store: number;
  qc: number;
  production: number;
  warehouse: number;
  marketers: number;
  customers: number;
  walk_in: number;
  total: number;
};
// The same functions as the pages (2026-11-10), so the reports never
// disagree with them:
//   Jugs collected      qc_jug_collections   (QC -> Dispenser Jug -> Collect)
//   Jugs posted to PM   qc_pm_jug_postings   (QC register / Production page)
type CollectedRow = {
  holder_name: string;
  holder_code: string | null;
  holder_kind: string;
  collected: number;
  awaiting_count: number;
  at_qc: number;
  posted_to_pm: number;
  received_by_pm: number;
  damaged: number;
  not_returned: number;
  last_collected: string | null;
};
type PostingRow = {
  posting: string;
  posted_at: string;
  posted_by: string | null;
  total: number;
  good: number;
  damaged: number;
  sources: string | null;
  status: string;
  received_at: string | null;
};
const KIND: Record<string, string> = {
  rep: "Marketer",
  customer: "Distributor / customer",
  walk_in: "Walk-in",
  outlet: "Retail Shop",
};
type Which = "preform" | "bottle" | "jugs" | "jug_places" | "jugs_collected" | "jug_postings";
type Sheet = {
  title: string;
  columns: { key: string; label: string }[];
  rows: Record<string, string | number>[];
  // Columns added up on a Total row.
  sum?: string[];
};

const n = (v: unknown) => Number(v ?? 0);
// "Preform 29mm(Prima-16.5g)", as on the printed report.
const preformLabel = (r: PreformRow) =>
  r.brand ? `${r.material}(${r.brand}${r.grammage ? `-${r.grammage}` : ""})` : r.material;
// "40 Bags", "0 Bag", "50 Pieces", "2 Bags + 300 Pieces": whole bags when
// they divide, pieces otherwise -- a remainder is never rounded away.
const fromStore = (r: PreformRow) => {
  const pcs = n(r.received);
  const s = splitBags(pcs, r.pieces_per_bag);
  const plural = (x: number, one: string) =>
    `${x.toLocaleString("en-US")} ${one}${Math.abs(x) === 1 ? "" : "s"}`;
  if (!s) return plural(pcs, "Piece");
  if (s.pieces === 0)
    return `${s.bags.toLocaleString("en-US")} ${Math.abs(s.bags) > 1 ? "Bags" : "Bag"}`;
  if (s.bags === 0) return plural(s.pieces, "Piece");
  return `${plural(s.bags, "Bag")} + ${plural(s.pieces, "Piece")}`;
};

export function QcReportsTab({ factoryId }: { factoryId: string }) {
  const settings = useFactorySettings(factoryId);
  const today = localDay();
  const [which, setWhich] = useState<Which>("preform");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const ok = !!from && !!to && from <= to;

  const preforms = useQuery({
    queryKey: ["qc-reports", "preform", factoryId, from, to],
    enabled: ok && which === "preform",
    queryFn: () =>
      rpc<PreformRow[]>("qc_preform_report", { p_factory: factoryId, p_from: from, p_to: to }),
  });
  const bottles = useQuery({
    queryKey: ["qc-reports", "bottle", factoryId, from, to],
    enabled: ok && which === "bottle",
    queryFn: () =>
      rpc<BottleRow[]>("qc_bottle_report", { p_factory: factoryId, p_from: from, p_to: to }),
  });

  const jugs = useQuery({
    queryKey: ["qc-reports", "jugs", factoryId, from, to],
    enabled: ok && which === "jugs",
    queryFn: () =>
      rpc<JugReportRow[]>("jug_accountability_report", {
        p_factory: factoryId,
        p_from: from,
        p_to: to,
        p_container_type: null,
      }),
  });
  const jugPlaces = useQuery({
    queryKey: ["qc-reports", "jug-places", factoryId, to],
    enabled: ok && which === "jug_places",
    queryFn: () => rpc<JugPlaceRow[]>("jug_locations", { p_factory: factoryId, p_at: to }),
  });

  const collected = useQuery({
    queryKey: ["qc-reports", "jugs-collected", factoryId, from, to],
    enabled: ok && which === "jugs_collected",
    queryFn: () =>
      rpc<CollectedRow[]>("qc_jug_collections", { p_factory: factoryId, p_from: from, p_to: to }),
  });
  const postings = useQuery({
    queryKey: ["qc-reports", "jug-postings", factoryId, from, to],
    enabled: ok && which === "jug_postings",
    queryFn: () =>
      rpc<PostingRow[]>("qc_pm_jug_postings", { p_factory: factoryId, p_from: from, p_to: to }),
  });

  const company = sheetCompany(settings.data);
  const period = `FROM ${from} TO ${to}`;
  const sheets: Partial<Record<Which, Sheet>> & Record<"preform" | "bottle", Sheet> = {
    preform: {
      title: `Quality Control Department: Preform Report ${period}`,
      columns: [
        { key: "sn", label: "S/N" },
        { key: "material", label: "Material" },
        { key: "fromStore", label: "From Store" },
        { key: "pieces", label: "Pieces" },
        { key: "opening", label: "Opening" },
        { key: "total", label: "Total" },
        { key: "blown", label: "Blown" },
        { key: "damages", label: "Damages" },
        { key: "expected", label: "Expected Bottles" },
        { key: "balance", label: "Balance" },
      ],
      // A preform with nothing in the period (e.g. only cleared test data,
      // which nets to zero) is not listed.
      rows: (preforms.data ?? [])
        .filter((r) => n(r.opening) || n(r.received) || n(r.blown) || n(r.balance))
        .map((r, i) => ({
          sn: i + 1,
          material: preformLabel(r),
          fromStore: fromStore(r),
          pieces: r.pieces_per_bag ? n(r.pieces_per_bag) : "—",
          opening: n(r.opening),
          total: n(r.total),
          blown: n(r.blown),
          damages: n(r.damages),
          expected: n(r.expected_bottles),
          balance: n(r.balance),
        })),
    },
    bottle: {
      title: `Quality Control Department: Bottles Report ${period}`,
      columns: [
        { key: "sn", label: "S/N" },
        { key: "material", label: "Material" },
        { key: "opening", label: "Opening" },
        { key: "in", label: "Quantity In" },
        { key: "total", label: "Total" },
        { key: "released", label: "Released" },
        { key: "balance", label: "Balance" },
      ],
      rows: (bottles.data ?? [])
        .filter((r) => n(r.opening) || n(r.quantity_in) || n(r.released) || n(r.balance))
        .map((r, i) => ({
          sn: i + 1,
          material: r.product,
          opening: n(r.opening),
          in: n(r.quantity_in),
          total: n(r.total),
          released: n(r.released),
          balance: n(r.balance),
        })),
    },
  };
  // Old and New Jug together, as "Dispenser" (user, 2026-11-04: not split
  // into new and old on the report): one row per marketer / shop and day.
  const dispenser = (name: string) => (/jug|dispenser/i.test(name) ? "Dispenser" : name);
  const jugRows = [
    ...(jugs.data ?? [])
      .reduce((m, r) => {
        const key = `${r.report_date}|${r.rep_name}|${r.rep_code ?? ""}|${dispenser(r.container_name)}`;
        const g = m.get(key) ?? {
          ...r,
          container_name: dispenser(r.container_name),
          opening: 0,
          loaded: 0,
          total: 0,
          jug_water_sold: 0,
          returned: 0,
          expected_empties: 0,
          received: 0,
          outstanding: 0,
        };
        for (const k of [
          "opening",
          "loaded",
          "total",
          "jug_water_sold",
          "returned",
          "expected_empties",
          "received",
          "outstanding",
        ] as const)
          g[k] = n(g[k]) + n(r[k]);
        return m.set(key, g);
      }, new Map<string, JugReportRow>())
      .values(),
  ].filter(
    (r) => n(r.opening) || n(r.loaded) || n(r.returned) || n(r.received) || n(r.outstanding),
  );
  sheets.jugs = {
    title: `Quality Control Department: Jugs Posted & Returned ${period}`,
    columns: [
      { key: "sn", label: "S/N" },
      { key: "date", label: "Date" },
      { key: "name", label: "Marketer / Shop" },
      { key: "jug", label: "Dispenser" },
      { key: "opening", label: "Opening" },
      { key: "loaded", label: "Loaded" },
      { key: "total", label: "Total" },
      { key: "sold", label: "Jug Water Sold" },
      { key: "returned", label: "Returned" },
      { key: "expected", label: "Expected Empties" },
      { key: "received", label: "Received" },
      { key: "outstanding", label: "Outstanding" },
    ],
    sum: ["loaded", "sold", "returned", "expected", "received"],
    rows: jugRows.map((r, i) => ({
      sn: i + 1,
      date: r.report_date,
      name: r.rep_code ? `${r.rep_name} (${r.rep_code})` : r.rep_name,
      jug: r.container_name,
      opening: n(r.opening),
      loaded: n(r.loaded),
      total: n(r.total),
      sold: n(r.jug_water_sold),
      returned: n(r.returned),
      expected: n(r.expected_empties),
      received: n(r.received),
      outstanding: n(r.outstanding),
    })),
  };
  sheets.jug_places = {
    title: `Quality Control Department: Where the Jugs Are AT ${to}`,
    columns: [
      { key: "sn", label: "S/N" },
      { key: "jug", label: "Dispenser" },
      { key: "store", label: "Store" },
      { key: "qc", label: "QC" },
      { key: "production", label: "Production" },
      { key: "warehouse", label: "Warehouse" },
      { key: "marketers", label: "Marketers / Shop" },
      { key: "customers", label: "Customers" },
      { key: "walk_in", label: "Walk-in" },
      { key: "total", label: "Total" },
    ],
    sum: ["store", "qc", "production", "warehouse", "marketers", "customers", "walk_in", "total"],
    rows: [
      ...(jugPlaces.data ?? [])
        .reduce((m, r) => {
          const name = dispenser(r.container_name);
          const g = m.get(name) ?? {
            ...r,
            container_name: name,
            store: 0,
            qc: 0,
            production: 0,
            warehouse: 0,
            marketers: 0,
            customers: 0,
            walk_in: 0,
            total: 0,
          };
          for (const k of [
            "store",
            "qc",
            "production",
            "warehouse",
            "marketers",
            "customers",
            "walk_in",
            "total",
          ] as const)
            g[k] = n(g[k]) + n(r[k]);
          return m.set(name, g);
        }, new Map<string, JugPlaceRow>())
        .values(),
    ].map((r, i) => ({
      sn: i + 1,
      jug: r.container_name,
      store: n(r.store),
      qc: n(r.qc),
      production: n(r.production),
      warehouse: n(r.warehouse),
      marketers: n(r.marketers),
      customers: n(r.customers),
      walk_in: n(r.walk_in),
      total: n(r.total),
    })),
  };
  // Marketers and distributors first, the Retail Shop on its own at the end.
  sheets.jugs_collected = {
    title: `Quality Control Department: Empty Jugs Collected ${period}`,
    columns: [
      { key: "sn", label: "S/N" },
      { key: "name", label: "Name" },
      { key: "kind", label: "Type" },
      { key: "collected", label: "Collected" },
      { key: "awaiting", label: "Waiting QC Count" },
      { key: "at_qc", label: "With QC" },
      { key: "posted", label: "Posted to PM" },
      { key: "received", label: "Received by PM" },
      { key: "damaged", label: "Damaged" },
      { key: "not_returned", label: "Not Returned" },
      { key: "last", label: "Last Returned" },
    ],
    sum: ["collected", "awaiting", "at_qc", "posted", "received", "damaged", "not_returned"],
    rows: [...(collected.data ?? [])]
      .sort(
        (a, b) =>
          Number(a.holder_kind === "outlet") - Number(b.holder_kind === "outlet") ||
          a.holder_kind.localeCompare(b.holder_kind) ||
          a.holder_name.localeCompare(b.holder_name),
      )
      .map((r, i) => ({
        sn: i + 1,
        name: r.holder_code ? `${r.holder_name} (${r.holder_code})` : r.holder_name,
        kind: KIND[r.holder_kind] ?? r.holder_kind,
        collected: n(r.collected),
        awaiting: n(r.awaiting_count),
        at_qc: n(r.at_qc),
        posted: n(r.posted_to_pm),
        received: n(r.received_by_pm),
        damaged: n(r.damaged),
        not_returned: n(r.not_returned),
        last: r.last_collected ?? "—",
      })),
  };
  sheets.jug_postings = {
    title: `Quality Control Department: Jugs Posted to PM ${period}`,
    columns: [
      { key: "sn", label: "S/N" },
      { key: "date", label: "Date" },
      { key: "posting", label: "Posting" },
      { key: "from", label: "From" },
      { key: "total", label: "Jugs" },
      { key: "good", label: "Good" },
      { key: "damaged", label: "Damaged" },
      { key: "status", label: "PM" },
    ],
    sum: ["total", "good", "damaged"],
    rows: (postings.data ?? []).map((r, i) => ({
      sn: i + 1,
      date: (r.posted_at ?? "").slice(0, 10),
      posting: r.posting,
      from: r.sources ?? "—",
      total: n(r.total),
      good: n(r.good),
      damaged: n(r.damaged),
      status:
        r.status === "received"
          ? `Received ${(r.received_at ?? "").slice(0, 10)}`
          : "Waiting for PM",
    })),
  };
  const current = {
    preform: preforms,
    bottle: bottles,
    jugs,
    jug_places: jugPlaces,
    jugs_collected: collected,
    jug_postings: postings,
  }[which];
  const loading = current.isLoading;
  const error = current.error as Error | null;
  const fileBase = `qc-${which}-report-${from}-to-${to}`;

  // The same rows on screen and on paper (user, 2026-11-04: QC sees the
  // period's figures before printing).
  const sheet = sheets[which];
  const fmt = (v: string | number) => (typeof v === "number" ? v.toLocaleString("en-US") : v);
  const foot = sheet?.sum
    ? sheet.columns.map((c, i) =>
        i === 1
          ? "Total"
          : sheet.sum!.includes(c.key)
            ? fmt(sheet.rows.reduce((t, r) => t + n(r[c.key]), 0))
            : "",
      )
    : undefined;
  const cells = (r: Record<string, string | number>) =>
    (sheet?.columns ?? []).map((c) => (c.key === "sn" ? (r.sn ?? "") : fmt(r[c.key] ?? "")));

  const pdf = (action: PdfAction) => {
    if (!sheet) return;
    const reports: QcPdfReport[] = [
      {
        title: sheet.title,
        columns: sheet.columns.map((c) => ({ label: c.label })),
        rows: sheet.rows.map(cells),
        foot,
      },
    ];
    void qcLetterheadPdf({ company, reports, filename: fileBase }, action);
  };

  const count = sheets[which]?.rows.length ?? 0;
  const status = !ok
    ? "The To date is before the From date."
    : loading
      ? "Loading…"
      : error
        ? error.message
        : count === 0
          ? {
              preform: "No preforms received or blown in this period.",
              bottle: "No good bottles stocked or released in this period.",
              jugs: "No jugs posted to or returned by marketers or the shop in this period.",
              jug_places: "No jug types are set up.",
              jugs_collected: "No empty jugs collected or held in this period.",
              jug_postings: "QC has not posted any jugs to the PM in this period.",
            }[which]
          : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-4">
        <Choice
          label="Report"
          value={which}
          onChange={setWhich}
          options={[
            ["preform", "Preform"],
            ["bottle", "Bottle"],
            ["jugs", "Jugs posted & returned"],
            ["jug_places", "Where the jugs are"],
            ["jugs_collected", "Jugs collected"],
            ["jug_postings", "Jugs posted to PM"],
          ]}
        />
        <div>
          <Label htmlFor="qc-report-from" className="text-xs">
            From
          </Label>
          <DatePicker id="qc-report-from" value={from} max={to} onChange={setFrom} />
        </div>
        <div>
          <Label htmlFor="qc-report-to" className="text-xs">
            To
          </Label>
          <DatePicker id="qc-report-to" value={to} min={from} max={today} onChange={setTo} />
        </div>
        <Button className="gap-2" disabled={!!status} onClick={() => pdf("print")}>
          <Printer className="h-4 w-4" /> Print
        </Button>
        <Button
          variant="outline"
          className="gap-2"
          disabled={!!status}
          onClick={() => pdf("download")}
        >
          <Download className="h-4 w-4" /> Download
        </Button>
      </div>
      {!status && sheet && (
        <div className="overflow-x-auto rounded-xl border">
          <p className="border-b px-3 py-2 text-sm font-semibold uppercase">{sheet.title}</p>
          <Table>
            <TableHeader>
              <TableRow>
                {sheet.columns.map((c) => (
                  <TableHead key={c.key} className={c.key === "sn" ? "w-12" : undefined}>
                    {c.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sheet.rows.map((r, i) => (
                <TableRow key={i}>
                  {cells(r).map((v, j) => (
                    <TableCell key={j} className="whitespace-nowrap">
                      {v}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
            {foot && (
              <TableFooter>
                <TableRow>
                  {foot.map((v, j) => (
                    <TableCell key={j} className="whitespace-nowrap font-semibold">
                      {v}
                    </TableCell>
                  ))}
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
      )}
      {status && (
        <p className={`text-sm ${error || !ok ? "text-destructive" : "text-muted-foreground"}`}>
          {status}
        </p>
      )}
    </div>
  );
}

// Report switch (Preform / Bottle / the two jug reports).
function Choice<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: [T, string][];
}) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <div className="flex flex-wrap rounded-md border p-0.5">
        {options.map(([v, text]) => (
          <Button
            key={v}
            size="sm"
            variant={value === v ? "default" : "ghost"}
            className="h-8 px-4"
            onClick={() => onChange(v)}
          >
            {text}
          </Button>
        ))}
      </div>
    </div>
  );
}
