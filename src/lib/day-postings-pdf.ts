import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { drawLogoHeader, pdfMoney, type PdfAction } from "./pdf";
import type { Database } from "@/integrations/supabase/types";

type Settings = Database["public"]["Tables"]["settings"]["Row"] | null | undefined;

type Line = {
  party_type: "marketer" | "retail" | "distributor";
  party: string;
  party_code: string | null;
  id: string;
  reference: string;
  day: string;
  at: string;
  status: string;
  product_name: string;
  unit: string;
  quantity: number;
  unit_price: number;
  line_total: number;
};

const SECTIONS: { type: Line["party_type"]; title: string }[] = [
  { type: "marketer", title: "Marketers" },
  { type: "distributor", title: "Distributors" },
  { type: "retail", title: "Retail Shop" },
];

// Everything the Warehouse posted on a day (or a range), to marketers,
// distributors and the Retail Shop, on one A4 report (user, 2026-11-04):
// products posted in total, then per group each party's products, then every
// posting with its number. Reversed / deleted postings are left out
// (day_postings, 20261104100000).
export async function printDayPostings(
  factoryId: string,
  from: string,
  to: string | null,
  settings: Settings,
  action: PdfAction,
) {
  const end = to && to >= from ? to : from;
  const { data, error } = await supabase.rpc(
    "day_postings" as never,
    { p_factory: factoryId, p_from: from, p_to: end } as never,
  );
  if (error) {
    toast.error(error.message);
    return;
  }
  const lines = ((data ?? []) as unknown as Line[]).map((l) => ({
    ...l,
    quantity: Number(l.quantity),
    unit_price: Number(l.unit_price),
    line_total: Number(l.line_total),
  }));
  if (lines.length === 0) {
    toast.info("Nothing was posted on those dates.");
    return;
  }

  const currency = settings?.currency ?? "NGN";
  const cash = (n: number) => pdfMoney(n, currency);
  const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const fmtDay = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  const period = from === end ? fmtDay(from) : `${fmtDay(from)} to ${fmtDay(end)}`;

  type Qty = { name: string; unit: string; qty: number; amount: number };
  const addQty = (m: Map<string, Qty>, l: Line) => {
    const q = m.get(l.product_name) ?? { name: l.product_name, unit: l.unit, qty: 0, amount: 0 };
    q.qty += l.quantity;
    q.amount += l.line_total;
    m.set(l.product_name, q);
  };

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const M = 40;
  let top = await drawLogoHeader(doc, settings?.logo_url, 40, 130, 60);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text((settings?.company_name ?? "Elim Table Water").toUpperCase(), pageW / 2, top, {
    align: "center",
  });
  top += 16;
  doc.setFontSize(11);
  doc.text("Warehouse Postings", pageW / 2, top, { align: "center" });
  top += 15;
  doc.text(period, pageW / 2, top, { align: "center" });
  top += 12;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text("Marketers, distributors and the Retail Shop. Reversed postings are left out.", M, top);
  top += 10;

  const table = (title: string, head: string[], body: string[][], foot?: string[]) => {
    const last = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
    let startY = last ? last.finalY + 22 : top + 8;
    if (startY > doc.internal.pageSize.getHeight() - 80) {
      doc.addPage();
      startY = 60;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(title, M, startY - 6);
    const right = head
      .map((_, i) => i)
      .filter((i) => i > 0 && /amount|price|qty|postings/i.test(head[i]));
    autoTable(doc, {
      startY,
      head: [head],
      body,
      foot: foot ? [foot] : undefined,
      theme: "grid",
      styles: { font: "helvetica", fontSize: 8.5, cellPadding: 3 },
      headStyles: { fillColor: [30, 41, 59] },
      footStyles: { fillColor: [226, 232, 240], textColor: [0, 0, 0], fontStyle: "bold" },
      columnStyles: Object.fromEntries(right.map((i) => [i, { halign: "right" as const }])),
      margin: { left: M, right: M, top: 40 },
    });
  };

  // 1. All products posted, every group together, and per group.
  const all = new Map<string, Qty>();
  const perGroup = new Map<Line["party_type"], Map<string, Qty>>();
  for (const l of lines) {
    addQty(all, l);
    if (!perGroup.has(l.party_type)) perGroup.set(l.party_type, new Map());
    addQty(perGroup.get(l.party_type)!, l);
  }
  const allRows = [...all.values()].sort((a, b) => a.name.localeCompare(b.name));
  const groupQty = (t: Line["party_type"], name: string) => perGroup.get(t)?.get(name)?.qty ?? 0;
  table(
    "All products posted",
    [
      "Product",
      "Unit",
      "Marketers qty",
      "Distributors qty",
      "Retail Shop qty",
      "Total qty",
      "Amount",
    ],
    allRows.map((p) => [
      p.name,
      p.unit,
      num(groupQty("marketer", p.name)),
      num(groupQty("distributor", p.name)),
      num(groupQty("retail", p.name)),
      num(p.qty),
      cash(p.amount),
    ]),
    ["Total", "", "", "", "", "", cash(allRows.reduce((t, p) => t + p.amount, 0))],
  );

  // 2. Per group: each party's products, then every posting.
  for (const { type, title } of SECTIONS) {
    const own = lines.filter((l) => l.party_type === type);
    if (own.length === 0) continue;

    const parties = new Map<
      string,
      { name: string; postings: Set<string>; qty: Map<string, Qty> }
    >();
    for (const l of own) {
      const key = `${l.party.toLowerCase()}|${l.party_code ?? ""}`;
      const p = parties.get(key) ?? {
        name: l.party_code ? `${l.party} (${l.party_code})` : l.party,
        postings: new Set<string>(),
        qty: new Map(),
      };
      p.postings.add(l.id);
      addQty(p.qty, l);
      parties.set(key, p);
    }
    const partyRows = [...parties.values()].sort((a, b) => a.name.localeCompare(b.name));
    const amountOf = (m: Map<string, Qty>) => [...m.values()].reduce((t, q) => t + q.amount, 0);
    table(
      `${title} — by ${type === "retail" ? "shop" : type}`,
      [type === "retail" ? "Shop" : title.replace(/s$/, ""), "Products", "Postings", "Amount"],
      partyRows.map((p) => [
        p.name,
        [...p.qty.values()].map((q) => `${q.name} × ${num(q.qty)} ${q.unit}`).join("\n"),
        num(p.postings.size),
        cash(amountOf(p.qty)),
      ]),
      [
        "Total",
        "",
        num(partyRows.reduce((t, p) => t + p.postings.size, 0)),
        cash(partyRows.reduce((t, p) => t + amountOf(p.qty), 0)),
      ],
    );

    table(
      `${title} — every posting`,
      ["Time", "Number", "Party", "Product", "Qty", "Price", "Amount"],
      own
        .slice()
        .sort((a, b) => a.at.localeCompare(b.at))
        .map((l) => [
          from === end
            ? new Date(l.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
            : `${l.day} ${new Date(l.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`,
          l.reference,
          l.party,
          l.product_name,
          `${num(l.quantity)} ${l.unit}`,
          cash(l.unit_price),
          cash(l.line_total),
        ]),
      ["Total", "", "", "", "", "", cash(own.reduce((t, l) => t + l.line_total, 0))],
    );
  }

  const printedAt = new Date().toLocaleString();
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text(printedAt, M, 24);
    doc.text(`Page ${p} of ${pages}`, pageW - M, 24, { align: "right" });
  }

  const file = `warehouse-postings-${from}${end !== from ? `-to-${end}` : ""}.pdf`;
  if (action === "download") {
    doc.save(file);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}
