import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronsUpDown, Loader2, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { num } from "@/lib/format";
import { cn } from "@/lib/utils";
import { logAudit } from "@/lib/audit";
import { useUnitsOfMeasure, UNIT_OPTIONS as UNIT_OPTIONS_FALLBACK } from "@/lib/units";

// Raw-material picker shared by the Store request form and the QC inspection
// form: search the list, or type a name that isn't there and add it. A new
// material is saved to the raw materials list straight away (via
// request_new_material, which reuses an existing material of the same name
// instead of duplicating it), so it is in the dropdown for every later entry.

export type PickerMaterial = { id: string; name: string; unit: string; current_stock?: number };

// "Name · stock 12 kg" when the caller loaded stock, else just the name.
const describe = (m: PickerMaterial) =>
  m.current_stock == null ? m.name : `${m.name} · stock ${num(Number(m.current_stock))} ${m.unit}`;

export function MaterialCombobox({
  value,
  materials,
  onChange,
  onAddNew,
  disabled,
}: {
  value: string;
  materials: PickerMaterial[];
  disabled?: boolean;
  onChange: (id: string) => void;
  onAddNew?: (query: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = materials.find((m) => m.id === value);
  const query = search.trim().toLowerCase();
  const filtered = query
    ? materials.filter((m) => m.name.toLowerCase().includes(query))
    : materials;
  const exactMatch = materials.some((m) => m.name.trim().toLowerCase() === query);

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
          <span className="truncate">{selected ? describe(selected) : "Select material…"}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search material…" value={search} onValueChange={setSearch} />
          <CommandList>
            {/* Always on top, so a material that isn't listed can be added
                without having to type its name first. Hidden only when the
                typed name is already on the list (select that instead). */}
            {onAddNew && !exactMatch && (
              <>
                <CommandGroup>
                  <CommandItem
                    value="__add_new__"
                    onSelect={() => {
                      onAddNew(search.trim());
                      setSearch("");
                      setOpen(false);
                    }}
                    className="font-medium text-primary"
                  >
                    <Plus className="h-4 w-4" />
                    <span>
                      {search.trim()
                        ? `Add "${search.trim()}" as a new material`
                        : "Add new material…"}
                    </span>
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            {filtered.length === 0 && <CommandEmpty>No material found.</CommandEmpty>}
            <CommandGroup heading={`All materials (${filtered.length})`}>
              {filtered.map((m) => (
                <CommandItem
                  key={m.id}
                  value={m.id}
                  onSelect={() => {
                    onChange(m.id);
                    setSearch("");
                    setOpen(false);
                  }}
                >
                  <Check className={cn("h-4 w-4", value === m.id ? "opacity-100" : "opacity-0")} />
                  <span className="flex-1 truncate">{describe(m)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function AddMaterialDialog({
  factoryId,
  initialName,
  canSetStock,
  onCreated,
}: {
  factoryId: string;
  initialName: string;
  canSetStock: boolean;
  onCreated: (material: PickerMaterial) => void;
}) {
  const qc = useQueryClient();
  const unitsOfMeasure = useUnitsOfMeasure();
  const unitOptions = unitsOfMeasure.data ?? UNIT_OPTIONS_FALLBACK;
  const [name, setName] = useState(initialName);
  const [unitChoice, setUnitChoice] = useState(unitOptions[0] ?? "kg");
  const [customUnit, setCustomUnit] = useState("");
  const unit = unitChoice === "__custom__" ? customUnit : unitChoice;
  const [openingStock, setOpeningStock] = useState(0);
  const [reorderLevel, setReorderLevel] = useState(0);
  const [unitCost, setUnitCost] = useState(0);

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Material name is required");
      if (!unit.trim()) throw new Error("Select or enter a unit of measurement");
      const { data, error } = await supabase.rpc("request_new_material", {
        payload: {
          factory_id: factoryId,
          name: name.trim(),
          unit: unit.trim(),
          unit_cost: canSetStock ? unitCost : 0,
          opening_stock: canSetStock ? openingStock : 0,
          reorder_level: reorderLevel,
        } as any,
      });
      if (error) throw error;
      return data as { id: string; existing?: boolean };
    },
    onSuccess: (data) => {
      // Refresh the materials list so the new material is in the dropdown for
      // every request from now on, not just this one.
      qc.invalidateQueries({ queryKey: ["raw-materials-brief"] });
      qc.invalidateQueries({ queryKey: ["raw-materials-list"] });
      qc.invalidateQueries({ queryKey: ["qc-materials"] });
      if (data.existing) {
        toast.success(`"${name.trim()}" is already in the materials list — selected it`);
      } else {
        toast.success(`"${name.trim()}" saved — it's now in the materials list for every request`);
        logAudit({
          action: "create",
          entity: "raw_materials",
          entityId: data.id,
          factoryId,
          newValue: { name: name.trim(), unit: unit.trim() },
        });
      }
      onCreated({
        id: data.id,
        name: name.trim(),
        unit: unit.trim(),
        current_stock: canSetStock ? openingStock : 0,
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Add New Material</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          The material is saved to the Store's raw materials list and added to this request. It will
          be in the dropdown for every request after this, so it only needs adding once.
          {!canSetStock && " The Store records its stock and cost when it arrives."}
        </p>
        <div>
          <Label>Raw material name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Unit of measurement</Label>
            <Select value={unitChoice} onValueChange={setUnitChoice}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {unitOptions.map((u) => (
                  <SelectItem key={u} value={u} className="capitalize">
                    {u}
                  </SelectItem>
                ))}
                <SelectItem value="__custom__">Other…</SelectItem>
              </SelectContent>
            </Select>
            {unitChoice === "__custom__" && (
              <Input
                className="mt-2"
                placeholder="Enter unit"
                value={customUnit}
                onChange={(e) => setCustomUnit(e.target.value)}
              />
            )}
          </div>
          <div>
            <Label>Reorder level</Label>
            <MoneyInput min={0} step="0.001" value={reorderLevel} onChange={setReorderLevel} />
          </div>
        </div>
        {canSetStock && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Opening stock</Label>
              <MoneyInput min={0} step="0.001" value={openingStock} onChange={setOpeningStock} />
            </div>
            <div>
              <Label>Unit cost</Label>
              <MoneyInput value={unitCost} onChange={setUnitCost} />
            </div>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()} className="gap-2">
          {save.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {save.isPending ? "Saving…" : "Save Material"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
