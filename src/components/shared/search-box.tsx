import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** A page's search box. Matches any field, or a transaction ID (#A1B2C3D4). */
export function SearchBox({
  value,
  onChange,
  placeholder = "Search or paste #ID…",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative w-full sm:w-64", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
      <Input
        placeholder={placeholder}
        className="h-9 pl-8"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Search"
      />
    </div>
  );
}
