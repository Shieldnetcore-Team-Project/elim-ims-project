import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown } from "lucide-react";
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
} from "@/components/ui/command";
import { num } from "@/lib/format";
import { cn } from "@/lib/utils";

// Brand dropdown for the Store's material form: the brands on Store → Brands
// (20261023100000_brands.sql), searchable by brand, dealer, pack or grammage.
// `value` is a brand id or "none".

export type PickerBrand = {
  id: string;
  name: string;
  category: string;
  grammage: string | null;
  pack_quantity: number;
  supplier_id: string | null;
  suppliers: { name: string } | null;
};

export function useBrands(factoryId: string | null | undefined) {
  return useQuery({
    queryKey: ["brands-brief", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("brands")
        .select("id,name,category,grammage,pack_quantity,supplier_id,suppliers(name)")
        .eq("factory_id", factoryId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as PickerBrand[];
    },
  });
}

// "Prima · 14.8g · Bag": tells apart materials of the same name.
export const brandDetail = (
  b: { name: string; grammage?: string | null; category?: string | null } | null | undefined,
) => (b ? [b.name, b.grammage, b.category].filter(Boolean).join(" · ") : null);

const describe = (b: PickerBrand) =>
  [brandDetail(b), b.pack_quantity > 1 ? `${num(b.pack_quantity)} pcs` : null, b.suppliers?.name]
    .filter(Boolean)
    .join(" · ");

export function BrandPicker({
  brands,
  value,
  onChange,
  disabled,
}: {
  brands: PickerBrand[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = brands.find((b) => b.id === value);
  const query = search.trim().toLowerCase();
  const filtered = query ? brands.filter((b) => describe(b).toLowerCase().includes(query)) : brands;

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
          <span className="truncate">{selected ? describe(selected) : "— None —"}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search brand, dealer, grammage…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {filtered.length === 0 && <CommandEmpty>No brand found.</CommandEmpty>}
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
              {filtered.map((b) => (
                <CommandItem
                  key={b.id}
                  value={b.id}
                  onSelect={() => {
                    onChange(b.id);
                    setSearch("");
                    setOpen(false);
                  }}
                >
                  <Check className={cn("h-4 w-4", value === b.id ? "opacity-100" : "opacity-0")} />
                  <span className="flex-1 truncate">{describe(b)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
