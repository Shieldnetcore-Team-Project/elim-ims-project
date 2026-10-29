import * as React from "react";

import { cn } from "@/lib/utils";

// Date-like fields open their picker when clicked anywhere, not only on the
// small calendar icon.
const PICKER_TYPES = new Set(["date", "datetime-local", "month", "week", "time"]);

// Number fields start empty and take over what is in them: a 0 shows as an
// empty box, and clicking in selects the figure, so typing replaces it -- no
// "0" or "1" to delete first (user, 2026-10-29: every box that takes a
// figure, across the system). MoneyInput does the same for its fields.
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, onClick, onFocus, value, ...props }, ref) => {
    const isNumber = type === "number";
    const shownValue = isNumber && (value === 0 || value === "0") ? "" : value;
    const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
      onFocus?.(e);
      if (isNumber && !e.currentTarget.readOnly) e.currentTarget.select();
    };
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
        onFocus={handleFocus}
        {...(value !== undefined ? { value: shownValue } : {})}
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
