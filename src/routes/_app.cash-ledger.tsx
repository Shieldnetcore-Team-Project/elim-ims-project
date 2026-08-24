import { createFileRoute, Outlet, Link, useLocation } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/cash-ledger")({
  head: () => ({ meta: [{ title: "Cash & Receivables — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: CashLedgerLayout,
});

const TABS = [
  { to: "/cash-ledger", label: "Overview" },
  { to: "/cash-ledger/ledger", label: "Ledger" },
  { to: "/cash-ledger/debts", label: "Debts" },
];

function CashLedgerLayout() {
  const location = useLocation();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cash & Receivables</h1>
        <p className="text-sm text-muted-foreground">Receipts, payments, cash flow, and outstanding debts in one place.</p>
      </div>
      <div className="flex gap-1 border-b">
        {TABS.map((t) => {
          const active = location.pathname === t.to;
          return (
            <Link
              key={t.to}
              to={t.to}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                active ? "text-foreground border-primary" : "text-muted-foreground border-transparent hover:text-foreground"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
      <Outlet />
    </div>
  );
}
