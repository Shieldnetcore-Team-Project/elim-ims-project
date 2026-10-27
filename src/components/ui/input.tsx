import * as React from "react";

import { cn } from "@/lib/utils";

// Date-like fields open their picker when clicked anywhere, not only on the
// small calendar icon.
const PICKER_TYPES = new Set(["date", "datetime-local", "month", "week", "time"]);

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, onClick, ...props }, ref) => {
    const handleClick = (e: React.MouseEvent<HTMLInputElement>) => {
      onClick?.(e);
      const el = e.currentTarget;
      if (type && PICKER_TYPES.has(type) && !el.disabled && !el.readOnly) {
        try {
          el.showPicker?.();
        } catch {
          // Older browsers, or no user gesture: the icon still opens it.
        }
      }
    };
    return (
      <input
        type={type}
        onClick={handleClick}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
