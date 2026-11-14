import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { RequireAccess } from "@/components/layout/require-access";
import { useFactoryId } from "@/lib/use-factory";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Undo2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { QcJugRegister } from "@/components/qc/jug-register";
import { QcJugReturnsToCount } from "@/components/qc/jug-returns-to-count";
import { BottleTrackingPanel } from "@/components/qc/bottle-tracking";
import { ReceiveUnsoldDialog } from "@/components/jugs/dialogs";
import { JugAccountabilityPage } from "@/components/jugs/jug-accountability-page";
import { useMarketers } from "@/components/jugs/api";
import { GoodBottlesPanel } from "@/components/qc/good-bottles";
import { ReceivedFromStorePanel } from "@/components/qc/received-from-store";
import { QcPreformsPanel } from "@/components/qc/qc-preforms";
import { QcReportsTab } from "@/components/qc/qc-reports";
import { QcJugCollections } from "@/components/qc/jug-collections";
import { QcJugHolders } from "@/components/qc/jug-holders";
import { usePreformLive, useShiftReport, useStockings } from "@/components/preform/api";
import { localDay } from "@/lib/production-shift";
import { PAGES, usePageAccess } from "@/lib/page-access";

// Quality Control (2026-11-10: purchase orders, inspections and Record
// Inspection taken off -- "we dont need it"; old ?tab=orders / inspections
// links open Received from Store).
//
// Good bottles (blown bottles waiting to be stocked) and Bottle tracking
// (returnable containers) moved here from the Warehouse, which keeps track of
// finished products only. Each tab follows its own module and page access
// (src/lib/nav.ts → Quality Control), so e.g. a user with only distribution
// sees just Bottle tracking.
const QC_TABS = [
  "received",
  "preforms",
  "orders",
  "inspections",
  "jugs",
  "good-bottles",
  "bottle-tracking",
  // Dispenser & jugs, moved here from the Warehouse (2026-11-04).
  "dispenser-jugs",
  // Jugs collected from each marketer / distributor / the shop (2026-11-10).
  "jugs-collected",
  "reports",
] as const;
type QcTab = (typeof QC_TABS)[number];

export const Route = createFileRoute("/_app/quality-control")({
  head: () => ({
    meta: [{ title: "Quality Control — Elim Table Water" }, { name: "robots", content: "noindex" }],
  }),
  validateSearch: (s: Record<string, unknown>): { tab?: QcTab } => ({
    tab: QC_TABS.includes(s.tab as QcTab) ? (s.tab as QcTab) : undefined,
  }),
  component: () => (
    <RequireAccess module="goods-receiving" anyOf={["preform-production", "distribution"]}>
      <QualityControlPage />
    </RequireAccess>
  ),
});

function QualityControlPage() {
  const { data: factoryId } = useFactoryId();
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { canPage } = usePageAccess();
  const pageOk = (label: string) => {
    const p = PAGES.find((x) => x.entry === "Quality Control" && x.label === label);
    return !!p && canPage(p);
  };
  // QC's own work (the "Inspections" page access; purchase orders and
  // inspections themselves were taken off, user 2026-11-10).
  const qcWork = pageOk("Inspections");
  const tabs: QcTab[] = [
    // Received from Store comes first, for whoever works QC.
    ...(qcWork ? (["received"] as const) : []),
    // QC's preform store: what the Store issued her for blowing, blown, damages.
    ...(pageOk("Good bottles") ? (["preforms"] as const) : []),
    // Dispenser: QC's jug work and the dispenser tracking (2026-11-10, one tab).
    ...(qcWork || pageOk("Dispenser Jug") ? (["jugs"] as const) : []),
    ...(pageOk("Good bottles") ? (["good-bottles"] as const) : []),
    // The printed QC sheets, for whoever works QC.
    ...(qcWork || pageOk("Good bottles") ? (["reports"] as const) : []),
  ];
  const [unsoldOpen, setUnsoldOpen] = useState(false);
  const jugMarketers = useMarketers(qcWork ? (factoryId ?? undefined) : undefined);
  // Old links land on the tab that replaced theirs.
  const wanted =
    tab === "bottle-tracking" || tab === "dispenser-jugs" || tab === "jugs-collected"
      ? "jugs"
      : tab === "orders" || tab === "inspections"
        ? "received"
        : tab;
  const current = wanted && tabs.includes(wanted) ? wanted : tabs[0];
  const setTab = (t: QcTab) =>
    navigate({ search: { tab: t === tabs[0] ? undefined : t }, replace: true });
  usePreformLive();
  // Good bottles needing QC: shifts to inspect plus stockings to count in.
  const bottlesFactory = tabs.includes("good-bottles") ? factoryId : undefined;
  const waitingQc = useShiftReport(bottlesFactory, {
    from: "2000-01-01",
    to: localDay(),
    status: "awaiting_inspection",
  });
  const waitingStock = useStockings(bottlesFactory, "sent");
  const bottlesWaiting = (waitingQc.data?.length ?? 0) + (waitingStock.data?.length ?? 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Quality Control</h1>
        <p className="text-sm text-muted-foreground">
          Confirm what the Store issues, blow and stock good bottles, and collect returned dispenser
          jugs and post them to the Production Manager.
        </p>
      </div>

      {tabs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          None of the Quality Control tabs are open to your account.
        </p>
      )}
      <Tabs value={current} onValueChange={(v) => setTab(v as QcTab)}>
        <TabsList className="h-auto flex-wrap">
          {tabs.includes("received") && (
            <TabsTrigger value="received">Received from Store</TabsTrigger>
          )}
          {tabs.includes("preforms") && <TabsTrigger value="preforms">Preforms</TabsTrigger>}
          {tabs.includes("jugs") && <TabsTrigger value="jugs">Dispenser Jug</TabsTrigger>}
          {tabs.includes("good-bottles") && (
            <TabsTrigger value="good-bottles">
              Good bottles
              {bottlesWaiting > 0 && (
                <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 text-[10px]">
                  {bottlesWaiting}
                </Badge>
              )}
            </TabsTrigger>
          )}
          {tabs.includes("reports") && <TabsTrigger value="reports">Reports</TabsTrigger>}
        </TabsList>
        <TabsContent value="received">
          {factoryId && <ReceivedFromStorePanel factoryId={factoryId} />}
        </TabsContent>
        <TabsContent value="preforms">
          {factoryId && <QcPreformsPanel factoryId={factoryId} />}
        </TabsContent>
        <TabsContent value="good-bottles">
          {factoryId && <GoodBottlesPanel factoryId={factoryId} />}
        </TabsContent>
        <TabsContent value="reports">
          {factoryId && <QcReportsTab factoryId={factoryId} />}
        </TabsContent>
        <TabsContent value="jugs">
          {factoryId && current === "jugs" && (
            <DispenserJugsTab
              factoryId={factoryId}
              qcWork={qcWork}
              tracking={pageOk("Dispenser Jug")}
              onReceiveUnsold={() => setUnsoldOpen(true)}
            />
          )}
          {factoryId && unsoldOpen && (
            <ReceiveUnsoldDialog
              factoryId={factoryId}
              marketers={(jugMarketers.data ?? []).filter((m) => m.active)}
              onClose={() => setUnsoldOpen(false)}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Quality Control -> Dispenser (2026-11-10): the old "Dispenser", "Dispenser &
// jugs" and "Jugs collected" tabs in one, in sections so nothing shows twice:
//   Collect & post to PM  returns to count, jugs with QC -> Post to PM, what
//                         was collected from each marketer / distributor /
//                         the shop and who has not returned jugs (all time)
//   Jug Movement          where the jugs are, who holds them, Record movement
//   Accountability        who still holds jugs / owes them as sold (marketers,
//                         distributors, office delivery -- 2026-11-14), then
//                         the daily marketer / shop jug report and its tools
//   QC register           consignments from the Store, the register, postings
type JugSection = "collect" | "holders" | "accountability" | "register";
function DispenserJugsTab({
  factoryId,
  qcWork,
  tracking,
  onReceiveUnsold,
}: {
  factoryId: string;
  qcWork: boolean;
  tracking: boolean;
  onReceiveUnsold: () => void;
}) {
  const sections: [JugSection, string][] = [
    ["collect", "Collect & post to PM"],
    ...(tracking ? ([["holders", "Jug Movement"]] as [JugSection, string][]) : []),
    ["accountability", "Accountability"],
    ...(qcWork ? ([["register", "QC register"]] as [JugSection, string][]) : []),
  ];
  const [section, setSection] = useState<JugSection>("collect");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 rounded-md border p-0.5">
        {sections.map(([v, label]) => (
          <Button
            key={v}
            size="sm"
            variant={section === v ? "default" : "ghost"}
            className="h-8 px-4"
            onClick={() => setSection(v)}
          >
            {label}
          </Button>
        ))}
      </div>
      {section === "collect" && (
        <div className="space-y-6">
          {/* QC receives unsold dispensers from any marketer or distributor
              (user, 2026-11-04); with the Accountability report it is there. */}
          {qcWork && !tracking && (
            <div className="flex justify-end">
              <Button variant="secondary" className="gap-2" onClick={onReceiveUnsold}>
                <Undo2 className="h-4 w-4" /> Receive unsold dispensers
              </Button>
            </div>
          )}
          {qcWork && <QcJugReturnsToCount factoryId={factoryId} />}
          <QcJugCollections factoryId={factoryId} />
        </div>
      )}
      {section === "holders" && <BottleTrackingPanel />}
      {section === "accountability" && (
        <div className="space-y-6">
          <QcJugHolders factoryId={factoryId} />
          {tracking && <JugAccountabilityPage />}
        </div>
      )}
      {section === "register" && <QcJugRegister factoryId={factoryId} />}
    </div>
  );
}
