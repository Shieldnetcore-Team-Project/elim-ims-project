import * as React from "react";
import { Input } from "@/components/ui/input";

// Digits and at most one decimal point -- everything else (commas, letters,
// a second ".") is dropped rather than rejected, so pasting a formatted
// number ("1,234.50") just works.
function sanitize(raw: string): string {
  let out = "";
  let seenDot = false;
  for (const ch of raw) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === "." && !seenDot) {
      out += ch;
      seenDot = true;
    }
  }
  return out;
}

function formatWithCommas(raw: string): string {
  const [intPart, decPart] = raw.split(".");
  const withCommas = (intPart || "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decPart !== undefined ? `${withCommas}.${decPart}` : withCommas;
}

// A plain number input forces a "0" placeholder the user has to delete
// before typing, and can't show thousands separators at all (the HTML spec
// only allows digits/./- in a type="number" value). This renders as text,
// shows nothing at 0 so typing starts clean, live-formats with commas, and
// keeps the caret where the user left it instead of bouncing it to the end
// every keystroke.
export const MoneyInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentPropsWithoutRef<typeof Input>, "value" | "onChange" | "type"> & {
    value: number;
    onChange: (value: number) => void;
  }
>(({ value, onChange, onFocus, onBlur, ...props }, forwardedRef) => {
  const innerRef = React.useRef<HTMLInputElement | null>(null);
  const [display, setDisplay] = React.useState(() => (value ? formatWithCommas(String(value)) : ""));
  const [focused, setFocused] = React.useState(false);
  const pendingCaret = React.useRef<number | null>(null);

  // Only resync from the external value while the user isn't actively
  // typing -- otherwise a parent re-render (e.g. from a totals recompute)
  // would stomp on an in-progress edit.
  React.useEffect(() => {
    if (focused) return;
    setDisplay(value ? formatWithCommas(String(value)) : "");
  }, [value, focused]);

  React.useLayoutEffect(() => {
    if (pendingCaret.current === null || !innerRef.current) return;
    innerRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [display]);

  return (
    <Input
      ref={(node) => {
        innerRef.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }}
      type="text"
      inputMode="decimal"
      value={display}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        setDisplay(value ? formatWithCommas(String(value)) : "");
        onBlur?.(e);
      }}
      onChange={(e) => {
        const input = e.target;
        const caret = input.selectionStart ?? input.value.length;
        const digitsBeforeCaret = sanitize(input.value.slice(0, caret)).length;
        const raw = sanitize(input.value);
        const formatted = formatWithCommas(raw);

        // Re-find the caret by counting the same number of digits back in,
        // skipping over commas -- keeps the cursor sitting where the user
        // was typing instead of jumping to the end when a comma is inserted.
        let remaining = digitsBeforeCaret;
        let pos = 0;
        while (remaining > 0 && pos < formatted.length) {
          if (formatted[pos] !== ",") remaining--;
          pos++;
        }
        pendingCaret.current = pos;

        setDisplay(formatted);
        const num = raw === "" || raw === "." ? 0 : parseFloat(raw);
        onChange(Number.isNaN(num) ? 0 : num);
      }}
      {...props}
    />
  );
});
MoneyInput.displayName = "MoneyInput";
