/**
 * Today's sessions show only their time; older ones also show the day. The zone defaults to the
 * viewer's; tests pass one explicitly.
 */
export function sessionTime(
  timestamp: string,
  locale: string,
  now = new Date(),
  timeZone?: string,
) {
  // Stryker disable next-line ConditionalExpression: Intl treats an undefined zone as the viewer's.
  const zone = timeZone === undefined ? {} : { timeZone };
  const date = new Date(timestamp);
  const day = (value: Date) =>
    new Intl.DateTimeFormat(locale, { ...zone, day: "numeric", month: "short" }).format(value);
  const time = new Intl.DateTimeFormat(locale, {
    ...zone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  // Joined here: runtimes disagree on how a combined date and time format is punctuated.
  return sameYear && day(date) === day(now) ? time : `${day(date)}, ${time}`;
}
