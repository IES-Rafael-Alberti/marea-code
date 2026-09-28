/** Local calendar days chosen by the teacher; `to` is inclusive. */
export interface UsageRange {
  readonly from: string;
  readonly to: string;
}
export const MAX_USAGE_WINDOW_MS = 31 * 86_400_000;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localMidnight(day: string, offset: number): Date | undefined {
  const match = DAY.exec(day);
  if (match === null) return undefined;
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  // Overflowing days, months or two-digit years round-trip to a different calendar day.
  if (localDay(new Date(year, month, date)) !== day) return undefined;
  return new Date(year, month, date + offset);
}

/**
 * Converts local days to the protocol's UTC window (`until` exclusive). Ranges the server would
 * reject, including a 31-day span lengthened by a daylight-saving change, are refused here.
 */
export function usageWindow(range: UsageRange): { from: string; until: string } | undefined {
  const from = localMidnight(range.from, 0);
  const until = localMidnight(range.to, 1);
  if (from === undefined || until === undefined) return undefined;
  const span = until.getTime() - from.getTime();
  return span > 0 && span <= MAX_USAGE_WINDOW_MS
    ? { from: from.toISOString(), until: until.toISOString() }
    : undefined;
}

/** The last seven local days, including today. */
export function defaultUsageRange(now: Date): UsageRange {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  return { from: localDay(start), to: localDay(now) };
}
