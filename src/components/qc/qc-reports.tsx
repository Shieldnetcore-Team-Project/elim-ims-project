import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/shared/date-picker";
import { Label } from "@/components/ui/label";
import { rpc } from "@/components/preform/api";
import { splitBags } from "@/lib/preform-units";
import { localDay } from "@/lib/production-shift";
import { useFactorySettings } from "@/lib/use-factory";
import type { PdfAction } from "@/lib/pdf";
import { qcLetterheadPdf, type QcCompany, type QcPdfReport } from "./qc-report-pdf";

// Quality Control → Reports: pick Preform or Bottle, a From and To date (one
// day = the same date twice) and Print; the sheet prints as the factory's own
// (logo, address, contacts, title, blue header row). No on-screen preview.
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
type Which = "preform" | "bottle";
type Sheet = {
  title: string;
  columns: { key: string; label: string }[];
  rows: Record<string, string | number>[];
};

// As printed on the factory's sheets when Settings has no details yet.
const SHEET_DEFAULTS = {
  address:
    "Plot No. 188A, FCDA SchemeExtension III, Off Bwari/Dutse Road, By Power Station, Opp. KAS Guest House, Kubwa, FCT Abuja.",
  phone: "+2348166399794",
  email: "info@elimtablewater.com",
  website: "www.elimtablewater.com",
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

  const company: QcCompany = {
    logo_url: settings.data?.logo_url,
    address: settings.data?.address || SHEET_DEFAULTS.address,
    phone: settings.data?.phone || SHEET_DEFAULTS.phone,
    email: settings.data?.email || SHEET_DEFAULTS.email,
    website: settings.data?.website || SHEET_DEFAULTS.website,
  };
  const period = `FROM ${from} TO ${to}`;
  const sheets: Record<Which, Sheet> = {
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
  const current = which === "preform" ? preforms : bottles;
  const loading = current.isLoading;
  const error = current.error as Error | null;
  const fileBase = `qc-${which}-report-${from}-to-${to}`;

  const pdf = (action: PdfAction) => {
    const sheet = sheets[which];
    const reports: QcPdfReport[] = [
      {
        title: sheet.title,
        columns: sheet.columns.map((c) => ({ label: c.label })),
        rows: sheet.rows.map((r) => sheet.columns.map((c) => r[c.key] ?? "")),
      },
    ];
    void qcLetterheadPdf({ company, reports, filename: fileBase }, action);
  };

  const count = sheets[which].rows.length;
  const status = !ok
    ? "The To date is before the From date."
    : loading
      ? "Loading…"
      : error
        ? error.message
        : count === 0
          ? which === "preform"
            ? "No preforms received or blown in this period."
            : "No good bottles stocked or released in this period."
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
      {status && (
        <p className={`text-sm ${error || !ok ? "text-destructive" : "text-muted-foreground"}`}>
          {status}
        </p>
      )}
    </div>
  );
}

// Two-way switch (Preform / Bottle).
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
      <div className="flex rounded-md border p-0.5">
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
