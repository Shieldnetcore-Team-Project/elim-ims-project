import { format } from "date-fns";

// One definition per figure, shared by the dashboards and the pages they
// summarise, so a card and the page it links to can never disagree.

export const dayKey = (d: Date) => format(d, "yyyy-MM-dd");

// PostgREST caps a single response (1000 rows by default), so any card that
// SUMs rows client-side must page through the whole result or it silently
// under-reports once a period passes that size.
export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
}

export const sum = <T>(rows: T[], pick: (r: T) => unknown) =>
  rows.reduce((s, r) => s + Number(pick(r) ?? 0), 0);

// ---------- stock ----------
// At or below the reorder level (a missing level counts as 0, so an item that
// has run out is always flagged). "Critical" is half of that level.
export const isLowStock = (stock: unknown, reorder: unknown) =>
  Number(stock) <= Number(reorder ?? 0);
export const isCriticalStock = (stock: unknown, reorder: unknown) =>
  Number(stock) <= Number(reorder ?? 0) * 0.5;

// ---------- money ----------
// Expenses and payroll only hit the books once approved; pending, rejected,
// cancelled and reversed rows never count.
export const COUNTED_STATUSES = ["approved", "posted"];
// A payment awaiting confirmation is money in hand; only a rejected one is not.
export const UNCOUNTED_PAYMENT_STATUS = "rejected";

// ---------- payment channels ----------
export const PAYMENT_CHANNELS = [
  { key: "cash", label: "Cash" },
  { key: "transfer", label: "Bank transfer" },
  { key: "pos", label: "POS" },
  { key: "card", label: "Card" },
  { key: "cheque", label: "Cheque" },
  { key: "credit", label: "Credit / other" },
] as const;

export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number]["key"];

// Payroll can be posted without a method recorded; those land here.
export const UNSPECIFIED_CHANNEL = "unspecified";

export const channelLabel = (key: string) =>
  key === UNSPECIFIED_CHANNEL
    ? "Not specified"
    : (PAYMENT_CHANNELS.find((c) => c.key === key)?.label ?? key);
