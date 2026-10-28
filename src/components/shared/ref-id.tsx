import { Copy } from "lucide-react";
import { toast } from "sonner";
import { shortRef } from "@/lib/ref";
import { cn } from "@/lib/utils";

/**
 * A record's transaction ID (#A1B2C3D4). Click to copy — then paste it into
 * any search box, or Audit Logs, to trace the record.
 */
export function RefId({ id, className }: { id: string | null | undefined; className?: string }) {
  if (!id) return <span className="text-muted-foreground">—</span>;
  const ref = shortRef(id);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(ref);
      toast.success(`ID ${ref} copied`);
    } catch {
      toast.error("Couldn't copy — select the ID and copy it manually");
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={`Transaction ID ${ref} — click to copy`}
      className={cn(
        "group inline-flex items-center gap-1 whitespace-nowrap rounded px-1 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {ref}
      <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100" />
    </button>
  );
}
