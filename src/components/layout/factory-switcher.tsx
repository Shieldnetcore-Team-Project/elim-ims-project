import { Droplet, Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useActiveFactoryCode, setActiveFactoryCode } from "@/lib/factory-store";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useState } from "react";

const FACTORIES = [{ code: "water" as const, name: "Water Factory", icon: Droplet }];

// Kept as a switcher component (rather than inlining a static label) so a
// second factory can be reintroduced later without touching the top bar.
export function FactorySwitcher() {
  const active = useActiveFactoryCode();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const current = FACTORIES.find((f) => f.code === active) ?? FACTORIES[0];
  const Icon = current.icon;

  if (FACTORIES.length <= 1) {
    return (
      <span className="flex h-9 min-w-[180px] items-center gap-2 rounded-md border border-input px-3 text-sm font-medium">
        <Icon className="h-4 w-4 text-primary" />
        {current.name}
      </span>
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
