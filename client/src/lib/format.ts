const MONEY_FIELDS = new Set(['amount', 'gross', 'net']);

export const naira = (n: number) => '₦' + Math.round(n).toLocaleString('en-NG');
export const number = (n: number) => Math.round(n).toLocaleString('en-NG');

/** Heuristic shared with the server's KPI aggregation: these column keys are currency. */
export function formatModuleNumber(key: string, value: number): string {
  return MONEY_FIELDS.has(key) ? naira(value) : number(value);
}

export const todayLagos = new Intl.DateTimeFormat('en-NG', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });
