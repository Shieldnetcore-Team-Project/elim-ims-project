// Production runs two shifts. The night shift's output is dated the night it
// was made, so when the production manager comes in each morning and records
// last night's batch, it belongs to yesterday; the day shift's output that
// she records later belongs to today.
export type Shift = "day" | "night";
// Production's batches also take Over-Time (user, 2026-11-02): work outside
// the normal shifts, e.g. Sunday. QC's preform shifts stay Day / Night.
export type ProductionShift = Shift | "overtime";

export const SHIFT_LABEL: Record<ProductionShift, string> = {
  day: "Day",
  night: "Night",
  overtime: "Over-Time",
};

// YYYY-MM-DD in the user's own timezone (the factory's working day).
export const localDay = (d: Date = new Date()) => d.toLocaleDateString("en-CA");

export const addDays = (day: string, days: number) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localDay(d);
};

// Anything produced on a Sunday is overtime (user, 2026-11-09), whichever way
// it is entered; it is usually keyed in on Monday.
export const isSunday = (day: string) => !!day && new Date(`${day}T12:00:00`).getDay() === 0;

// The Sunday to enter overtime for: today if it is Sunday, else the last one.
export const lastSunday = (now: Date = new Date()) => addDays(localDay(now), -now.getDay());

// What a new entry most likely is: before noon, last night's batch
// (yesterday, night); from noon, today's day batch.
export function suggestedEntry(now: Date = new Date()): { date: string; shift: Shift } {
  const today = localDay(now);
  return now.getHours() < 12
    ? { date: addDays(today, -1), shift: "night" }
    : { date: today, shift: "day" };
}
