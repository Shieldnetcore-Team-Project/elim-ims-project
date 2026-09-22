import { Droplet, Layers, Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useActiveFactoryCode, setActiveFactoryCode } from "@/lib/factory-store";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useState } from "react";

const FACTORIES = [
  { code: "water" as const, name: "Water Factory", icon: Droplet },
  { code: "nylon" as const, name: "Nylon Factory", icon: Layers },
];

// Every user can switch freely between the two factories everywhere in the
// app -- Sales, Customers, Expenses, etc. are shared across both. A
// NYLON/WATER production_scope only isolates the Production module itself
// (enforced there by ProductionFactoryGate in src/routes/_app.production.tsx,
// which auto-corrects the active factory back to the user's own scope the
// moment they land on that page, plus has_production_scope_access() at the
// RLS/RPC layer) -- it used to also lock this switcher for the whole app,
// which meant a scoped sales user could never see the other factory's data
// anywhere, not just in Production.
export function FactorySwitcher() {
  const active = useActiveFactoryCode();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const current = FACTORIES.find((f) => f.code === active) ?? FACTORIES[0];
  const Icon = current.icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-9 gap-2 min-w-[180px] justify-between">
          <span className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-primary" />
            <span className="font-medium">{current.name}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-1">
        {FACTORIES.map((f) => {
          const FIcon = f.icon;
          const selected = f.code === active;
          return (
            <button
              key={f.code}
              onClick={() => {
                setActiveFactoryCode(f.code);
                qc.invalidateQueries();
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors",
                selected ? "bg-accent text-accent-foreground" : "hover:bg-white hover:text-primary",
              )}
            >
              <FIcon className="h-4 w-4" />
              <span className="flex-1 text-left">{f.name}</span>
              {selected && <Check className="h-4 w-4" />}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
