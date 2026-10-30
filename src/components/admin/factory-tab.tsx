import { useAccountsAdmin } from "@/lib/use-accounts-admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Factory } from "lucide-react";

// Factories are a fixed 1-row table baked into migrations across this app
// (water), not a user-editable concept -- so this is a read-only summary
// rather than a CRUD screen.
export function FactoryTab() {
  const { accounts, factories } = useAccountsAdmin();
  const rows = accounts.data ?? [];

  // Water is the only factory, so every active user belongs to it, whatever
  // legacy production_scope (WATER/BOTH) their profile still carries.
  const cards = [
    {
      code: "water",
      label: "Water Factory",
      count: rows.filter((a) => a.status !== "pending").length,
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {cards.map((c) => {
        const factory = factories.data?.find((f) => f.code === c.code);
        return (
          <Card key={c.code} className="rounded-2xl">
            <CardHeader className="flex flex-row items-center flex-wrap justify-between gap-2 pb-2">
              <CardTitle className="text-sm font-medium">{factory?.name ?? c.label}</CardTitle>
              <Factory className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{c.count}</div>
              <p className="text-xs text-muted-foreground">users scoped to this factory</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
