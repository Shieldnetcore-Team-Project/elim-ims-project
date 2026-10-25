import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { localDay } from "@/lib/production-shift";
import {
  useExceptions,
  useShiftReport,
  useStockings,
  useTransfers,
} from "@/components/preform/api";
import { ShiftsTab } from "@/components/preform/shifts";
import { QcTab } from "@/components/preform/qc";
import { StockingTab } from "@/components/preform/stocking";
import { TransfersTab } from "@/components/preform/transfers";
import { ExceptionsTab } from "@/components/preform/exceptions";
import { ReportsTab } from "@/components/preform/reports";
import { SetupTab } from "@/components/preform/setup";
import { usePermissions } from "@/lib/permissions";

type Step = "record" | "send" | "inspect" | "stock-in" | "exceptions" | "reports" | "setup";

// Blown bottles, end to end on the Quality Control page. QC is in charge of
// blowing: she accepts the preforms the Store issues her (Quality Control →
// Preforms, src/components/qc/qc-preforms.tsx), records each shift
// (preforms used, good bottles, damage) and submits it -- the good bottles go
// straight into stock, the damage is recorded only -- then sends the good
// bottles to production (PM), which confirms receipt
// (20261022100000_qc_records_blowing.sql, 20261022090000_*).
//
// A shift recorded by an operator without QC's stocking right still goes the
// old way (QC inspects, operator sends, QC stocks in); those two steps only
// show while something is waiting in them.
//
// Managers only (moved from the old Preform Production page, which now
// redirects here): Exceptions (resolve shortfalls), Reports (per grammage and
// session, bottle inventory, shifts, issues to PM, PM-stage rejections) and
// Setup (each preform's bottle product and pieces per bag). The printed QC
// sheets are on Quality Control → Reports (src/components/qc/qc-reports.tsx).
export function GoodBottlesPanel({ factoryId }: { factoryId: string }) {
  const { can } = usePermissions();
  const isManager = can("preform-production", "reverse");
  const canSetup = isManager || can("settings", "edit");
  const openExceptions = useExceptions(isManager ? factoryId : undefined, "open");
  const waitingQc = useShiftReport(factoryId, {
    from: "2000-01-01",
    to: localDay(),
    status: "awaiting_inspection",
  });
  const waitingStock = useStockings(factoryId, "sent");
  const transfers = useTransfers(factoryId);
  const inTransit = (transfers.data ?? []).filter((t) => t.status === "dispatched").length;
  const [step, setStep] = useState<Step>("record");

  const showInspect = (waitingQc.data?.length ?? 0) > 0 || step === "inspect";
  const showStockIn = (waitingStock.data?.length ?? 0) > 0 || step === "stock-in";

  const count = (n: number | undefined) =>
    n ? (
      <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 text-[10px]">
        {n}
      </Badge>
    ) : null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Accept the preforms the Store issues you on the Preforms tab → record each blowing shift,
        separating good bottles from damaged → good bottles go straight into stock (damage is
        recorded only) → send the good bottles to production, which confirms what it receives.
      </p>
      <Tabs value={step} onValueChange={(v) => setStep(v as Step)}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="record">1. Record blowing</TabsTrigger>
          <TabsTrigger value="send">2. Send to production{count(inTransit)}</TabsTrigger>
          {showInspect && (
            <TabsTrigger value="inspect">
              Operator shifts to inspect{count(waitingQc.data?.length)}
            </TabsTrigger>
          )}
          {showStockIn && (
            <TabsTrigger value="stock-in">
              Operator stockings{count(waitingStock.data?.length)}
            </TabsTrigger>
          )}
          {isManager && (
            <TabsTrigger value="exceptions">
              Exceptions{count(openExceptions.data?.length)}
            </TabsTrigger>
          )}
          {isManager && <TabsTrigger value="reports">Reports</TabsTrigger>}
          {canSetup && <TabsTrigger value="setup">Setup</TabsTrigger>}
        </TabsList>
        <TabsContent value="record">
          <ShiftsTab factoryId={factoryId} />
        </TabsContent>
        <TabsContent value="send">
          <TransfersTab factoryId={factoryId} />
        </TabsContent>
        <TabsContent value="inspect">
          <QcTab factoryId={factoryId} />
        </TabsContent>
        <TabsContent value="stock-in">
          <StockingTab factoryId={factoryId} />
        </TabsContent>
        {isManager && (
          <TabsContent value="exceptions">
            <ExceptionsTab factoryId={factoryId} />
          </TabsContent>
        )}
        {isManager && (
          <TabsContent value="reports">
            <ReportsTab factoryId={factoryId} />
          </TabsContent>
        )}
        {canSetup && (
          <TabsContent value="setup">
            <SetupTab factoryId={factoryId} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
