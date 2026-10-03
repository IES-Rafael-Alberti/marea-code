/** The value a `datetime-local` input shows for an instant, in the viewer's zone. */
export function localTime(time: number): string {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
