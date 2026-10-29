import { useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// Printer icon for the Warehouse's slim receipts: asks how many copies (1 by
// default) and prints them all in one go, one after the other, each ending
// with a "cut here" line (printRollReceipt). Leave the print window's own
// copies at 1.
export function PrintCopiesButton({
  onPrint,
  title = "Print",
}: {
  onPrint: (copies: number) => void | Promise<void>;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [copies, setCopies] = useState(1);
  const go = () => {
    const n = Math.min(Math.max(Math.floor(copies) || 1, 1), 20);
    setOpen(false);
    void onPrint(n);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" title={title} aria-label={title}>
          <Printer className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-52" align="end">
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <Label htmlFor="print-copies" className="text-xs">
            Copies
          </Label>
          <Input
            id="print-copies"
            type="number"
            min={1}
            max={20}
            value={copies}
            autoFocus
            onChange={(e) => setCopies(Number(e.target.value))}
          />
          {copies > 1 && (
            <p className="text-[11px] text-muted-foreground">
              All copies print together, one after the other — cut along each &quot;cut here&quot;
              line.
            </p>
          )}
          <Button type="submit" size="sm" className="gap-1">
            <Printer className="h-3.5 w-3.5" /> Print
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
