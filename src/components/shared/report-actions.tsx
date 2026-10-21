import { Download, FileSpreadsheet, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { useCurrentUserName } from "@/lib/use-current-user";
import { exportCsv, exportExcel, type ReportColumn } from "@/lib/export";
import { generateReportPdf } from "@/lib/pdf";

// Print / Excel / CSV for whatever list a page is showing: the same rows, in
// the same order, with the company logo and who printed it on the PDF. Pages
// pass exactly what is on screen (after their own filters), so the printout
// always matches the screen.
export function ReportActions({
  title,
  fileName,
  columns,
  rows,
  subtitle = [],
  size = "default",
}: {
  title: string;
  fileName: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  subtitle?: string[];
  size?: "default" | "sm";
}) {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const me = useCurrentUserName();
  const empty = rows.length === 0;
  const print = () =>
    generateReportPdf(
      title,
      columns,
      rows,
      "print",
      { name: settings.data?.company_name, logo_url: settings.data?.logo_url },
      [...subtitle, `${rows.length} row(s)`, `Printed by: ${me.data ?? "—"}`],
    );
  return (
    <div className="flex gap-1">
      <Button
        type="button"
        variant="outline"
        size={size}
        className="gap-2"
        disabled={empty}
        onClick={print}
      >
        <Printer className="h-4 w-4" /> Print
      </Button>
      <Button
        type="button"
        size="icon"
        variant="outline"
        title="Excel"
        className={size === "sm" ? "h-9 w-9" : undefined}
        disabled={empty}
        onClick={() => exportExcel(fileName, columns, rows)}
      >
        <FileSpreadsheet className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="outline"
        title="CSV"
        className={size === "sm" ? "h-9 w-9" : undefined}
        disabled={empty}
        onClick={() => exportCsv(fileName, columns, rows)}
      >
        <Download className="h-4 w-4" />
      </Button>
    </div>
  );
}
