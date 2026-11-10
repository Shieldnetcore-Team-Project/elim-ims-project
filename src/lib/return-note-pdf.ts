import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { drawLogoHeader, type PdfAction } from "./pdf";
import type { Database } from "@/integrations/supabase/types";

type Settings = Database["public"]["Tables"]["settings"]["Row"] | null | undefined;

// A return on the Accountant page as a printed note (user, 2026-11-10): the
// products taken back and their quantities -- returns are counted in
// products, not money. `items` is the row's text, "Name × 2 Piece · ...".
export type ReturnNote = {
  reference: string;
  date: string;
  party: string;
  partyType: string;
  items: string;
  status: string;
};

export function parseReturnItems(items: string): { name: string; qty: number; unit: string }[] {
  return items
    .split(" · ")
    .map((part) => /^(.*?) × ([\d,.]+)(?: (.+))?$/.exec(part.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ name: m[1], qty: Number(m[2].replace(/,/g, "")), unit: m[3] ?? "" }));
}

// "−2 Piece" / "−5 Pack · −2 Piece": what came back, per unit.
export function returnedQtyText(items: string | undefined): string {
  const byUnit = new Map<string, number>();
  for (const l of parseReturnItems(items ?? ""))
    byUnit.set(l.unit, (byUnit.get(l.unit) ?? 0) + l.qty);
  return [...byUnit]
    .map(([u, q]) => `−${q.toLocaleString("en-US")}${u ? ` ${u}` : ""}`)
    .join(" · ");
}

export async function printReturnNote(note: ReturnNote, settings: Settings, action: PdfAction) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const M = 40;
  let top = await drawLogoHeader(doc, settings?.logo_url, 40, 130, 60);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text((settings?.company_name ?? "Elim Table Water").toUpperCase(), pageW / 2, top, {
    align: "center",
  });
  top += 18;
  doc.setFontSize(12);
  doc.text("RETURN NOTE", pageW / 2, top, { align: "center" });
  top += 24;

  doc.setFontSize(10);
  const row = (label: string, value: string) => {
    doc.setFont("helvetica", "bold");
    doc.text(label, M, top);
    doc.setFont("helvetica", "normal");
    doc.text(value, M + 90, top);
    top += 15;
  };
  row("Return No:", note.reference);
  row("Date:", new Date(note.date).toLocaleDateString("en-GB"));
  row(note.partyType === "customer" ? "Customer:" : "Account:", note.party);
  row("Status:", note.status.replace(/_/g, " "));

  const lines = parseReturnItems(note.items);
  autoTable(doc, {
    startY: top + 6,
    margin: { left: M, right: M },
    head: [["S/N", "Product", "Quantity returned", "Unit"]],
    body: lines.map((l, i) => [String(i + 1), l.name, l.qty.toLocaleString("en-US"), l.unit]),
    foot: [["", "Total", returnedQtyText(note.items).replace(/−/g, ""), ""]],
    styles: { fontSize: 10, cellPadding: 5 },
    headStyles: { fillColor: [11, 61, 145] },
    footStyles: { fillColor: [240, 240, 240], textColor: 20, fontStyle: "bold" },
    columnStyles: { 0: { cellWidth: 40 }, 2: { halign: "right" } },
  });

  const end =
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? top;
  doc.setFontSize(9);
  doc.text("Received by: ______________________", M, end + 50);
  doc.text("Signature: ______________________", pageW - M - 200, end + 50);

  const file = `return-${note.reference}.pdf`;
  if (action === "download") {
    doc.save(file);
  } else {
    if (action === "print") doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  }
}
