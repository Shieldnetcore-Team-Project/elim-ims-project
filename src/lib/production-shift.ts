// Production runs two shifts. The night shift's output is dated the night it
// was made, so when the production manager comes in each morning and records
// last night's batch, it belongs to yesterday; the day shift's output that
// she records later belongs to today.
export type Shift = "day" | "night";

export const SHIFT_LABEL: Record<Shift, string> = { day: "Day", night: "Night" };

// YYYY-MM-DD in the user's own timezone (the factory's working day).
export const localDay = (d: Date = new Date()) => d.toLocaleDateString("en-CA");

export const addDays = (day: string, days: number) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localDay(d);
};

// What a new entry most likely is: before noon, last night's batch
// (yesterday, night); from noon, today's day batch.
export function suggestedEntry(now: Date = new Date()): { date: string; shift: Shift } {
  const today = localDay(now);
  return now.getHours() < 12
    ? { date: addDays(today, -1), shift: "night" }
    : { date: today, shift: "day" };
}
