import { Droplet, Layers, Check, ChevronsUpDown, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useActiveFactoryCode, setActiveFactoryCode } from "@/lib/factory-store";
import { useMyProductionScope } from "@/lib/permissions";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

const FACTORIES = [
  { code: "water" as const, name: "Water Factory", icon: Droplet },
  { code: "nylon" as const, name: "Nylon Factory", icon: Layers },
];

// Staff with a NYLON/WATER production_scope belong to exactly one
// department: they're locked to that factory everywhere in the app (not just
// the Production module) and never see the switcher, so there's no way to
// even attempt crossing into the other department's data. BOTH (the default)
// keeps the switcher for everyone else.
export function FactorySwitcher() {
  const active = useActiveFactoryCode();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const myScope = useMyProductionScope();
  const scope = myScope.data;
  const lockedCode = scope === "WATER" ? "water" : scope === "NYLON" ? "nylon" : null;

  useEffect(() => {
    if (lockedCode && active !== lockedCode) {
      setActiveFactoryCode(lockedCode);
      qc.invalidateQueries();
    }
  }, [lockedCode, active, qc]);

  const current = FACTORIES.find((f) => f.code === active) ?? FACTORIES[0];
  const Icon = current.icon;

  if (lockedCode) {
    const locked = FACTORIES.find((f) => f.code === lockedCode)!;
    const LockedIcon = locked.icon;
    return (
      <Button
        variant="outline"
        className="h-9 gap-2 min-w-[180px] justify-between"
        disabled
        title="Your account is restricted to this department"
      >
        <span className="flex items-center gap-2">
          <LockedIcon className="h-4 w-4 text-primary" />
          <span className="font-medium">{locked.name}</span>
        </span>
        <Lock className="h-4 w-4 opacity-60" />
      </Button>
    );
  }

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
