import { useRef, type ChangeEvent, type CSSProperties } from 'react';

function meaningfulCountBefore(str: string, idx: number): number {
  let n = 0;
  for (let i = 0; i < idx && i < str.length; i++) if (str[i] !== ',') n++;
  return n;
}

function caretForMeaningfulCount(str: string, count: number): number {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    if (n === count) return i;
    if (str[i] !== ',') n++;
  }
  return str.length;
}

/** Strips a formatted display value down to a plain numeric string (digits, one leading
 *  minus if allowed, one decimal point if allowed) — this is the shape every caller's
 *  state already stored before comma-formatting existed, so it's a drop-in replacement. */
function sanitize(input: string, allowDecimal: boolean, allowNegative: boolean): string {
  let s = input;
  let sign = '';
  if (allowNegative && s.trim().startsWith('-')) sign = '-';
  s = s.replace(/[^\d.]/g, '');
  if (allowDecimal) {
    const firstDot = s.indexOf('.');
    if (firstDot !== -1) s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, '');
  } else {
    s = s.replace(/\./g, '');
  }
  return sign + s;
}

function format(raw: string): string {
  if (!raw) return '';
  let sign = '';
  let rest = raw;
  if (rest.startsWith('-')) { sign = '-'; rest = rest.slice(1); }
  const dotIdx = rest.indexOf('.');
  const intPart = dotIdx === -1 ? rest : rest.slice(0, dotIdx);
  const decPart = dotIdx === -1 ? undefined : rest.slice(dotIdx + 1);
  const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + formattedInt + (decPart !== undefined ? '.' + decPart : '');
}

/** A text input that displays its numeric value with thousands separators (145,784) while
 *  storing/emitting the plain unformatted numeric string, so it's a drop-in replacement for
 *  `<input type="number">` wherever amounts or quantities are entered. */
export function NumberInput({
  id, value, onChange, allowDecimal = true, allowNegative = false,
  required, autoFocus, placeholder, ariaLabel, style, disabled, className,
}: {
  id?: string;
  value: string;
  onChange: (raw: string) => void;
  allowDecimal?: boolean;
  allowNegative?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  style?: CSSProperties;
  disabled?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const el = e.target;
    const displayed = el.value;
    const caret = el.selectionStart ?? displayed.length;
    const meaningfulBefore = meaningfulCountBefore(displayed, caret);

    const raw = sanitize(displayed, allowDecimal, allowNegative);
    onChange(raw);

    requestAnimationFrame(() => {
      if (!ref.current) return;
      const formatted = format(raw);
      const newCaret = caretForMeaningfulCount(formatted, meaningfulBefore);
      ref.current.setSelectionRange(newCaret, newCaret);
    });
  }

  return (
    <input
      ref={ref}
      id={id}
      type="text"
      inputMode={allowDecimal ? 'decimal' : 'numeric'}
      className={className}
      value={format(value)}
      onChange={handleChange}
      required={required}
      autoFocus={autoFocus}
      placeholder={placeholder}
      aria-label={ariaLabel}
      style={style}
      disabled={disabled}
    />
  );
}
