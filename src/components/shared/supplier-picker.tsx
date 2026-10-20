import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronsUpDown, Loader2, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

// Supplier dropdown for the Store and QC forms: search the list, or type a
// supplier that isn't there and add it on the spot (quick_add_supplier --
// same suppliers table as the Suppliers page, reused if the name already
// exists). `value` is a supplier id or "none".

export type PickerSupplier = { id: string; name: string };

export function SupplierPicker({
  factoryId,
  suppliers,
  value,
  onChange,
  disabled,
}: {
  factoryId: string | null | undefined;
  suppliers: PickerSupplier[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // A supplier added here shows straight away, before the list refetches.
  const [added, setAdded] = useState<PickerSupplier[]>([]);
  const all = [...suppliers, ...added.filter((a) => !suppliers.some((s) => s.id === a.id))];
  const selected = all.find((s) => s.id === value);
  const query = search.trim().toLowerCase();
  const filtered = query ? all.filter((s) => s.name.toLowerCase().includes(query)) : all;
  const exact = all.some((s) => s.name.trim().toLowerCase() === query);

  const add = useMutation({
    mutationFn: async (name: string) => {
      if (!factoryId) throw new Error("No factory selected");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC newer than the generated types
      const { data, error } = await (supabase as any).rpc("quick_add_supplier", {
        p_factory: factoryId,
        p_name: name,
      });
      if (error) throw error;
      return data as { id: string; name: string; existing: boolean };
    },
    onSuccess: (r) => {
      setAdded((prev) => [...prev, { id: r.id, name: r.name }]);
      onChange(r.id);
      setSearch("");
      setOpen(false);
      toast.success(
        r.existing ? `${r.name} was already a supplier — selected` : `Supplier ${r.name} added`,
      );
      qc.invalidateQueries({ queryKey: ["suppliers-brief"] });
      qc.invalidateQueries({ queryKey: ["suppliers"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{selected ? selected.name : "— None —"}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search or type a new supplier…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {filtered.length === 0 && !search.trim() && (
              <CommandEmpty>No suppliers yet.</CommandEmpty>
            )}
            <CommandGroup>
              {!query && (
                <CommandItem
                  value="__none__"
                  onSelect={() => {
                    onChange("none");
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn("h-4 w-4", value === "none" ? "opacity-100" : "opacity-0")}
                  />
                  <span className="text-muted-foreground">— None —</span>
                </CommandItem>
              )}
              {filtered.map((s) => (
                <CommandItem
                  key={s.id}
                  value={s.id}
                  onSelect={() => {
                    onChange(s.id);
                    setSearch("");
                    setOpen(false);
                  }}
                >
                  <Check className={cn("h-4 w-4", value === s.id ? "opacity-100" : "opacity-0")} />
                  <span className="flex-1 truncate">{s.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {search.trim() && !exact && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value={`__add__${search}`}
                    disabled={add.isPending}
                    onSelect={() => add.mutate(search.trim())}
                  >
                    {add.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                    <span>Add &quot;{search.trim()}&quot; as a new supplier</span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
