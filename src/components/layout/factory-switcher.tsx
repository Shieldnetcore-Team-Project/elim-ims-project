import { Factory, Check, ChevronsUpDown, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  useActiveFactoryCode,
  setActiveFactoryCode,
  useMyFactories,
  type FactoryCode,
} from "@/lib/factory-store";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useState } from "react";

const FALLBACK_NAME: Record<FactoryCode, string> = {
  water: "Kubwa Factory",
  lugbe: "Lugbe Factory",
};

// Factory dropdown beside the Dashboard title (user, 2026-11-21). The
// Chairman and Admin pick Kubwa or Lugbe; every page then works in that
// factory. Anyone else sees it greyed out and locked on their factory until
// an Admin allows them another (Admin → Factory).
export function FactorySwitcher() {
  const active = useActiveFactoryCode();
  const mine = useMyFactories();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const list = mine.data ?? [];
  const canSwitch = list.length > 1;
  const currentName = list.find((f) => f.code === active)?.name ?? FALLBACK_NAME[active];

  if (!canSwitch) {
    return (
      <Button
        variant="outline"
        disabled
        className="h-9 gap-2 min-w-[180px] justify-between"
        title="Only the Chairman and Admin can switch factory"
      >
        <span className="flex items-center gap-2">
          <Factory className="h-4 w-4" />
          <span className="font-medium">{currentName}</span>
        </span>
        <Lock className="h-3.5 w-3.5 opacity-60" />
      </Button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-9 gap-2 min-w-[180px] justify-between">
          <span className="flex items-center gap-2">
            <Factory className="h-4 w-4 text-primary" />
            <span className="font-medium">{currentName}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-1">
        {list.map((f) => {
          const selected = f.code === active;
          return (
            <button
              key={f.id}
              onClick={() => {
                if (!selected) {
                  setActiveFactoryCode(f.code as FactoryCode);
                  qc.invalidateQueries();
                }
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors",
                selected ? "bg-accent text-accent-foreground" : "hover:bg-white hover:text-primary",
              )}
            >
              <Factory className="h-4 w-4" />
              <span className="flex-1 text-left">{f.name}</span>
              {selected && <Check className="h-4 w-4" />}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

// Top-bar reminder of which factory the pages show, for accounts that can be
// in more than one. The switching itself is on the Dashboard dropdown.
export function ActiveFactoryLabel() {
  const active = useActiveFactoryCode();
  const mine = useMyFactories();
  const list = mine.data ?? [];
  if (list.length <= 1) return null;
  const name = list.find((f) => f.code === active)?.name ?? FALLBACK_NAME[active];
  return (
    <span
      className={cn(
        "hidden sm:inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium",
        active === "water" ? "text-muted-foreground" : "border-primary/50 text-primary",
      )}
      title="Change factory from the Dashboard"
    >
      <Factory className="h-3.5 w-3.5" />
      {name}
    </span>
  );
}
