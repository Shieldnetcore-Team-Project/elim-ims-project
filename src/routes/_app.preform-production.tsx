import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { SectionTabs } from "@/components/layout/section-tabs";
import { useFactoryId } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useExceptions,
  usePreformLive,
  useShiftReport,
  useStockings,
} from "@/components/preform/api";
import { DashboardTab, type PreformTab } from "@/components/preform/dashboard";
import { IssuesTab } from "@/components/preform/issues";
import { ShiftsTab } from "@/components/preform/shifts";
import { QcTab } from "@/components/preform/qc";
import { StockingTab } from "@/components/preform/stocking";
import { TransfersTab } from "@/components/preform/transfers";
import { ExceptionsTab } from "@/components/preform/exceptions";
import { ReportsTab } from "@/components/preform/reports";
import { SetupTab } from "@/components/preform/setup";
import { localDay } from "@/lib/production-shift";

const TABS: PreformTab[] = [
  "dashboard",
  "issues",
  "shifts",
  "qc",
  "stocking",
  "transfers",
  "exceptions",
  "reports",
  "setup",
];

export const Route = createFileRoute("/_app/preform-production")({
  head: () => ({
    meta: [
      { title: "Preform Production — Elim Table Water" },
      { name: "robots", content: "noindex" },
    ],
  }),
  // ?tab= opens a step directly (Store → Issue preforms, Warehouse → Good
  // bottles link here).
  validateSearch: (s: Record<string, unknown>): { tab?: PreformTab } => ({
    tab: TABS.includes(s.tab as PreformTab) ? (s.tab as PreformTab) : undefined,
  }),
  component: () => (
    <>
      <SectionTabs section="Production" />
      <RequireAccess module="preform-production">
        <PreformProductionPage />
      </RequireAccess>
    </>
  ),
});

// Preform blowing, end to end: Store issues preforms to an operator, the
// operator records each shift, QC approves the good bottles, the Warehouse
// counts them into stock, and the Warehouse transfers them to PM. Every
// figure comes from the server (supabase/migrations/20261020130000_*).
function PreformProductionPage() {
  const { data: factoryId } = useFactoryId();
  const { can } = usePermissions();
  usePreformLive();
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  // Where each role starts.
  const home: PreformTab = can("preform-production", "submit")
    ? "dashboard"
    : can("preform-production", "approve")
      ? "qc"
      : can("preform-production", "confirm")
        ? "stocking"
        : can("preform-production", "post")
          ? "issues"
          : "dashboard";
  const current = tab ?? home;
  const goTo = (t: PreformTab) =>
    navigate({ search: { tab: t === home ? undefined : t }, replace: true, state: (p) => p });

  const canSetup = can("preform-production", "reverse") || can("settings", "edit");
  const waitingQc = useShiftReport(factoryId, {
    from: "2000-01-01",
    to: localDay(),
    status: "awaiting_inspection",
  });
  const waitingStock = useStockings(factoryId, "sent");
  const openExc = useExceptions(factoryId, "open");
  const count = (n: number | undefined) =>
    n ? (
      <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 text-[10px]">
        {n}
      </Badge>
    ) : null;

  if (!factoryId) return null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Preform Production</h1>
        <p className="text-sm text-muted-foreground">
          Store issue → shift production → QC → Warehouse stocking → transfer to PM. Usage,
          remaining stock and variances are calculated by the system from posted transactions.
        </p>
      </div>
      <Tabs value={current} onValueChange={(v) => goTo(v as PreformTab)}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="issues">Store issues</TabsTrigger>
          <TabsTrigger value="shifts">Shift records</TabsTrigger>
          <TabsTrigger value="qc">QC{count(waitingQc.data?.length)}</TabsTrigger>
          <TabsTrigger value="stocking">Stocking{count(waitingStock.data?.length)}</TabsTrigger>
          <TabsTrigger value="transfers">Transfers to PM</TabsTrigger>
          <TabsTrigger value="exceptions">Exceptions{count(openExc.data?.length)}</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
          {canSetup && <TabsTrigger value="setup">Setup</TabsTrigger>}
        </TabsList>
        <TabsContent value="dashboard">
          <DashboardTab factoryId={factoryId} goTo={goTo} />
        </TabsContent>
        <TabsContent value="issues">
          <IssuesTab factoryId={factoryId} />
        </TabsContent>
        <TabsContent value="shifts">
          <ShiftsTab factoryId={factoryId} />
        </TabsContent>
        <TabsContent value="qc">
          <QcTab factoryId={factoryId} />
        </TabsContent>
        <TabsContent value="stocking">
          <StockingTab factoryId={factoryId} />
        </TabsContent>
        <TabsContent value="transfers">
          <TransfersTab factoryId={factoryId} />
        </TabsContent>
        <TabsContent value="exceptions">
          <ExceptionsTab factoryId={factoryId} />
        </TabsContent>
        <TabsContent value="reports">
          <ReportsTab factoryId={factoryId} />
        </TabsContent>
        {canSetup && (
          <TabsContent value="setup">
            <SetupTab factoryId={factoryId} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
